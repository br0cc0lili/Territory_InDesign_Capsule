// capsule.js — SUBJECT DETECTION from an imported Adobe Capsule JSON.
//
// An alternative SOURCE of the subject box — not a placement engine. Adobe
// Capsule ("Detect Focal Point") runs outside the plugin; the designer
// downloads its JSON and imports it here. This file turns that JSON into the
// SAME subject result subject.js produces for the backend API:
//     { box: { x, y, width, height } (shares 0..1 of the photo), source, wholePhoto, reason? }
// so render.js populateDocument → placeProductImage → placement.js run
// exactly as for the API box (occupancy, text avoidance, Fill / Extend
// policies, red subject frames, warnings — all unchanged).
//
// Capsule JSON (normalized, top-left origin — the same convention as the
// subject box, so no coordinate maths):
//   { "focalPoint":  { "x": 0.53, "y": 0.65, "normalized": true },
//     "boundingBox": { "x": 0.07, "y": 0.30, "width": 0.93, "height": 0.70, "normalized": true } }
// The focal point is stored, shown and editable, but NOT used by placement
// (the existing placement centres the subject box; using the focal point
// would change that logic).
//
// Persistence: <output>/capsule_subjects.json, one entry per photo (keyed by
// its path), shared by every product, template and layout using that photo:
//   { imagePath, photo: { size, modified }, pixelSize, exifOrientation,
//     auto:   { boundingBox, focalPoint, sourceFile, importedAt, warnings },   ← what Capsule detected
//     manual: { boundingBox, focalPoint, editedAt } | null,                    ← the designer's edit (all layouts)
//     layouts: { [layoutId]: { boundingBox, focalPoint, editedAt } } }         ← edit for one layout only
// The imported values are never overwritten by an edit; Reset to Auto
// removes the edits. A photo whose size / modification time changed since
// the import is "stale": its data is not applied until re-imported or
// confirmed.
//
// No network, no backend: Capsule mode never calls the subject API.

/* global require */

const CAPSULE = {
    file: "capsule_subjects.json",
    version: 1,
    tolerance: 1e-4,          // rounding slack for values just outside 0..1
    maxJsonBytes: 1024 * 1024,
    edgeTouch: 0.002,         // a box side this close to the photo edge "touches" it
    wholePhotoSpan: 0.95,     // same limit as subject.js isWholePhotoBox / placement.js maxInformativeSpan
};

const STATUS_TEXT = {
    missing: "Missing Detection Data — no Capsule JSON imported for this photo",
    stale: "Capsule data belongs to an earlier version of this photo (file changed) — re-import the JSON or keep the data for the changed photo",
};

// ---------- pure helpers (tested offline) ----------

const isNum = (v) => typeof v === "number" && isFinite(v);
const round = (v) => Math.round(v * 1e6) / 1e6;

// One normalized value: in 0..1 (± tolerance, then clamped), or an error.
function unitValue(v, name, errors) {
    if (!isNum(v)) { errors.push(`${name} must be a number (got ${v === undefined ? "nothing" : JSON.stringify(v)})`); return null; }
    if (v < -CAPSULE.tolerance || v > 1 + CAPSULE.tolerance) { errors.push(`${name} = ${v} is outside 0..1`); return null; }
    return round(Math.min(1, Math.max(0, v)));
}

// Validates a box { x, y, width, height } (shares 0..1). Returns the clean
// box or null (errors pushed). `label` prefixes the messages.
function validateBox(b, label, errors) {
    if (!b || typeof b !== "object" || Array.isArray(b)) { errors.push(`${label} is missing`); return null; }
    const n = errors.length;
    const x = unitValue(b.x, `${label}.x`, errors), y = unitValue(b.y, `${label}.y`, errors);
    const width = unitValue(b.width, `${label}.width`, errors), height = unitValue(b.height, `${label}.height`, errors);
    if (errors.length > n) return null;
    if (!(width > 0)) errors.push(`${label}.width must be greater than 0`);
    if (!(height > 0)) errors.push(`${label}.height must be greater than 0`);
    if (x + width > 1 + CAPSULE.tolerance) errors.push(`${label}.x + width = ${round(x + width)} is greater than 1`);
    if (y + height > 1 + CAPSULE.tolerance) errors.push(`${label}.y + height = ${round(y + height)} is greater than 1`);
    if (errors.length > n) return null;
    return { x, y, width: round(Math.min(width, 1 - x)), height: round(Math.min(height, 1 - y)) };
}

function validatePoint(p, label, errors) {
    if (!p || typeof p !== "object" || Array.isArray(p)) { errors.push(`${label} is missing`); return null; }
    const n = errors.length;
    const x = unitValue(p.x, `${label}.x`, errors), y = unitValue(p.y, `${label}.y`, errors);
    return errors.length > n ? null : { x, y };
}

// Which photo edges the box touches (the subject is probably cut off there).
function edgesTouched(box) {
    const e = CAPSULE.edgeTouch;
    return {
        left: box.x <= e, top: box.y <= e,
        right: box.x + box.width >= 1 - e, bottom: box.y + box.height >= 1 - e,
    };
}

function edgeList(edges) {
    return ["left", "top", "right", "bottom"].filter((k) => edges && edges[k]);
}

function isWholePhotoBox(box) {
    return !!box && box.width >= CAPSULE.wholePhotoSpan && box.height >= CAPSULE.wholePhotoSpan;
}

function pointInBox(p, b) {
    return p.x >= b.x - 1e-9 && p.x <= b.x + b.width + 1e-9 && p.y >= b.y - 1e-9 && p.y <= b.y + b.height + 1e-9;
}

// Notes about valid data (not errors): focal point outside the box,
// cropped subject, box covering the whole photo.
function detectionWarnings(box, focal) {
    const w = [];
    if (focal && box && !pointInBox(focal, box)) w.push("the focal point lies outside the bounding box");
    const edges = edgeList(edgesTouched(box));
    if (edges.length) w.push(`the bounding box touches the photo's ${edges.join(" / ")} edge — the subject may be cut off in the photo`);
    if (isWholePhotoBox(box)) w.push("the bounding box covers (nearly) the whole photo — placement treats it like any whole-photo box (no subject shift, no red-frame placement)");
    return w;
}

// Parses + validates Capsule JSON text.
// Returns { ok: true, detection: { boundingBox, focalPoint }, warnings }
//      or { ok: false, errors: [..] }.
function parseCapsuleJson(text) {
    const errors = [];
    if (typeof text !== "string") return { ok: false, errors: ["the file could not be read as text"] };
    if (text.length > CAPSULE.maxJsonBytes) return { ok: false, errors: [`the file is too large for a Capsule JSON (${text.length} bytes)`] };
    let json;
    try {
        json = JSON.parse(text.replace(/^﻿/, ""));
    } catch (e) {
        return { ok: false, errors: ["not valid JSON: " + String((e && e.message) || e)] };
    }
    if (!json || typeof json !== "object" || Array.isArray(json)) return { ok: false, errors: ["the JSON must be an object with focalPoint and boundingBox"] };
    for (const key of ["boundingBox", "focalPoint"]) {
        const v = json[key];
        if (v && typeof v === "object" && v.normalized !== true) {
            errors.push(`${key}.normalized must be true — only normalized (0..1) coordinates are supported`);
        }
    }
    const boundingBox = validateBox(json.boundingBox, "boundingBox", errors);
    const focalPoint = validatePoint(json.focalPoint, "focalPoint", errors);
    if (errors.length) return { ok: false, errors };
    return { ok: true, detection: { boundingBox, focalPoint }, warnings: detectionWarnings(boundingBox, focalPoint) };
}

// Layout identity for per-layout edits: "<subType>/<size>/<position>".
function layoutId(layout) {
    if (!layout) return "";
    return [layout.subType, layout.size, layout.position].map((v) => String(v || "").toLowerCase()).join("/");
}

function storeKey(imagePath) {
    return String(imagePath || "").toLowerCase();
}

function sameBox(a, b) {
    return !!a && !!b && ["x", "y", "width", "height"].every((k) => Math.abs(a[k] - b[k]) < 1e-6);
}

function samePoint(a, b) {
    return !!a && !!b && Math.abs(a.x - b.x) < 1e-6 && Math.abs(a.y - b.y) < 1e-6;
}

// "missing" | "stale" | "auto" | "manual" for a stored entry and the
// photo's current fingerprint ({ size, modified } or null = unknown).
function entryStatus(entry, fingerprint) {
    if (!entry || !entry.auto || !entry.auto.boundingBox) return "missing";
    if (entry.photo && fingerprint && (String(entry.photo.size) !== String(fingerprint.size) ||
        String(entry.photo.modified) !== String(fingerprint.modified))) return "stale";
    const edited = (entry.manual && (entry.manual.boundingBox || entry.manual.focalPoint)) ||
        Object.keys(entry.layouts || {}).length > 0;
    return edited ? "manual" : "auto";
}

// The values in force for one layout (or for all, lid = ""):
//   layout edit → image-level edit → imported (each of box / focal point on its own).
function effectiveValues(entry, lid) {
    const auto = entry.auto;
    const manual = entry.manual || {};
    const layout = (lid && entry.layouts && entry.layouts[lid]) || null;
    const pick = (key) => {
        if (layout && layout[key]) return { value: layout[key], source: "layout" };
        if (manual[key]) return { value: manual[key], source: "manual" };
        return { value: auto[key], source: "auto" };
    };
    const box = pick("boundingBox"), focal = pick("focalPoint");
    return { boundingBox: box.value, focalPoint: focal.value, boxSource: box.source, focalSource: focal.source };
}

// The subject result for render.js (same shape as subject.js).
//   source "capsule" (imported) / "capsule-manual" (edited). Neither is
//   "chosen", so the existing whole-photo rules apply exactly as for the API box.
function subjectFromValues(v, extra) {
    const box = Object.assign({}, v.boundingBox);
    return Object.assign({
        box,
        source: v.boxSource === "auto" ? "capsule" : "capsule-manual",
        wholePhoto: isWholePhotoBox(box),
        focalPoint: v.focalPoint ? Object.assign({}, v.focalPoint) : null,
    }, extra || {});
}

// Subject result of one stored entry for render.js, or { box: null, reason }.
// The result has forLayout(layout): the result for one page (a per-layout
// edit replaces the box there; every other page gets the shared result).
function subjectFromEntry(entry, fingerprint) {
    const status = entryStatus(entry, fingerprint);
    if (status === "missing" || status === "stale") {
        return { box: null, reason: STATUS_TEXT[status], source: "capsule", capsule: { status } };
    }
    const base = effectiveValues(entry, "");
    const info = (v) => ({
        status,
        boxSource: v.boxSource, focalSource: v.focalSource,
        edges: edgesTouched(v.boundingBox),
        file: entry.auto.sourceFile || "", importedAt: entry.auto.importedAt || "",
        layoutEdits: Object.keys(entry.layouts || {}),
    });
    const result = subjectFromValues(base, { capsule: info(base) });
    const layouts = entry.layouts || {};
    result.forLayout = (layout) => {
        const lid = layoutId(layout);
        if (!lid || !layouts[lid]) return result;
        const v = effectiveValues(entry, lid);
        const own = subjectFromValues(v, { capsule: Object.assign(info(v), { layout: lid }) });
        own.forLayout = result.forLayout;
        return own;
    };
    return result;
}

// Stores an import for a photo. Pure on the store object.
//   detection: parseCapsuleJson().detection
//   meta: { sourceFile, fingerprint, pixelSize, exifOrientation, warnings, now }
//   keepEdits: keep the designer's earlier edits (asked on re-import)
// Returns { entry, replaced: bool, hadEdits: bool }.
function importDetection(store, imagePath, detection, meta, keepEdits) {
    const key = storeKey(imagePath);
    const old = store.items[key] || null;
    const hadEdits = !!old && entryStatus(old, null) === "manual";
    const m = meta || {};
    const entry = {
        imagePath: String(imagePath),
        photo: m.fingerprint || null,
        pixelSize: m.pixelSize || null,
        exifOrientation: m.exifOrientation || 1,
        auto: {
            boundingBox: Object.assign({}, detection.boundingBox),
            focalPoint: Object.assign({}, detection.focalPoint),
            sourceFile: m.sourceFile || "",
            importedAt: m.now || new Date().toISOString(),
            warnings: (m.warnings || []).slice(),
        },
        manual: keepEdits && old && old.manual ? old.manual : null,
        layouts: keepEdits && old && old.layouts ? old.layouts : {},
    };
    store.items[key] = entry;
    return { entry, replaced: !!old, hadEdits };
}

// Saves an edit. lid = "" → for every layout of this photo (replaces the
// per-layout edits); lid = a layoutId → for that layout only.
// Values equal to the imported ones are not stored (= Reset to Auto).
// Returns the entry, or null when the photo has no imported data.
function saveEdit(store, imagePath, values, lid, now) {
    const entry = store.items[storeKey(imagePath)];
    if (!entry || !entry.auto) return null;
    const errors = [];
    const box = values.boundingBox ? validateBox(values.boundingBox, "boundingBox", errors) : null;
    const focal = values.focalPoint ? validatePoint(values.focalPoint, "focalPoint", errors) : null;
    if (errors.length) throw new Error(errors.join("; "));
    const edit = {
        boundingBox: box && !sameBox(box, entry.auto.boundingBox) ? box : null,
        focalPoint: focal && !samePoint(focal, entry.auto.focalPoint) ? focal : null,
        editedAt: now || new Date().toISOString(),
    };
    const hasEdit = !!(edit.boundingBox || edit.focalPoint);
    if (lid) {
        entry.layouts = Object.assign({}, entry.layouts || {});
        // A layout edit holds the complete values for that layout.
        const full = { boundingBox: box || null, focalPoint: focal || null, editedAt: edit.editedAt };
        const base = effectiveValues(Object.assign({}, entry, { layouts: {} }), "");
        if (sameBox(full.boundingBox, base.boundingBox) && samePoint(full.focalPoint, base.focalPoint)) delete entry.layouts[lid];
        else entry.layouts[lid] = full;
    } else {
        entry.manual = hasEdit ? edit : null;
        entry.layouts = {};
    }
    return entry;
}

// Removes every edit of a photo (imported values only).
function resetToAuto(store, imagePath) {
    const entry = store.items[storeKey(imagePath)];
    if (!entry) return null;
    entry.manual = null;
    entry.layouts = {};
    return entry;
}

// The photo file changed but the designer says the data still fits.
function acceptChangedPhoto(store, imagePath, fingerprint) {
    const entry = store.items[storeKey(imagePath)];
    if (!entry) return null;
    entry.photo = fingerprint || null;
    return entry;
}

// "car_01.capsule.json" / "car_01_capsule.json" / "car_01.json" → "car_01"
function baseName(path) {
    const name = String(path || "").split(/[\/\\]/).pop();
    return name.replace(/\.[^.]*$/, "").replace(/[._\s-]*capsule$/i, "").trim().toLowerCase();
}

// Bulk import: pairs JSON files with photos by file name only.
//   jsonPaths: [path]; photoPaths: [path] (the matched products' photos)
// Returns { matched: [{ json, photo }], unmatched: [json],
//           ambiguous: [{ json, photos }], duplicates: [{ photo, jsons }] }
// Nothing ambiguous is ever applied.
function matchJsonFilesToPhotos(jsonPaths, photoPaths) {
    const photosByBase = new Map();
    for (const p of new Set((photoPaths || []).map(String))) {
        const b = baseName(p);
        if (!photosByBase.has(b)) photosByBase.set(b, []);
        if (photosByBase.get(b).map(storeKey).indexOf(storeKey(p)) === -1) photosByBase.get(b).push(p);
    }
    const out = { matched: [], unmatched: [], ambiguous: [], duplicates: [] };
    const perPhoto = new Map();
    for (const j of jsonPaths || []) {
        const photos = photosByBase.get(baseName(j)) || [];
        if (!photos.length) out.unmatched.push(j);
        else if (photos.length > 1) out.ambiguous.push({ json: j, photos });
        else {
            const k = storeKey(photos[0]);
            if (!perPhoto.has(k)) perPhoto.set(k, { photo: photos[0], jsons: [] });
            perPhoto.get(k).jsons.push(j);
        }
    }
    for (const { photo, jsons } of perPhoto.values()) {
        if (jsons.length === 1) out.matched.push({ json: jsons[0], photo });
        else out.duplicates.push({ photo, jsons });
    }
    return out;
}

// Coverage over the matched products: { total, auto, manual, missing, stale }
//   photos: [imagePath]; fingerprints: Map(storeKey → fingerprint) (optional)
function coverage(store, photos, fingerprints) {
    const c = { total: 0, auto: 0, manual: 0, missing: 0, stale: 0 };
    for (const p of new Set((photos || []).map(storeKey))) {
        c.total++;
        c[entryStatus(store && store.items[p], fingerprints ? fingerprints.get(p) || null : null)]++;
    }
    return c;
}

// EXIF orientation of a JPEG (1 = upright; 2–8 = flipped / rotated), from
// the APP1 Exif block. 1 if absent or not a JPEG. A rotated photo may be
// shown upright by Capsule but placed differently — the import warns.
function jpegExifOrientation(bytes) {
    const b = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes || []);
    if (!(b.length > 4 && b[0] === 0xff && b[1] === 0xd8)) return 1;
    let i = 2;
    while (i + 4 < b.length) {
        if (b[i] !== 0xff) return 1;
        const marker = b[i + 1];
        const len = (b[i + 2] << 8) | b[i + 3];
        if (marker === 0xda || marker === 0xd9) return 1; // image data: no Exif before it
        if (marker === 0xe1 && b[i + 4] === 0x45 && b[i + 5] === 0x78 && b[i + 6] === 0x69 && b[i + 7] === 0x66) {
            const t = i + 10; // TIFF header
            const le = b[t] === 0x49;
            const u16 = (o) => (le ? b[t + o] | (b[t + o + 1] << 8) : (b[t + o] << 8) | b[t + o + 1]);
            const u32 = (o) => (le ? (b[t + o] | (b[t + o + 1] << 8) | (b[t + o + 2] << 16)) + b[t + o + 3] * 16777216
                : b[t + o] * 16777216 + ((b[t + o + 1] << 16) | (b[t + o + 2] << 8) | b[t + o + 3]));
            const ifd = u32(4);
            const count = u16(ifd);
            for (let k = 0; k < count; k++) {
                const e = ifd + 2 + k * 12;
                if (t + e + 10 > b.length) break;
                if (u16(e) === 0x0112) {
                    const v = u16(e + 8);
                    return v >= 1 && v <= 8 ? v : 1;
                }
            }
            return 1;
        }
        if (len < 2) return 1;
        i += 2 + len;
    }
    return 1;
}

function orientationWarning(orientation) {
    if (!orientation || orientation === 1) return "";
    const what = orientation >= 5 ? "rotated by 90°" : orientation === 3 ? "rotated by 180°" : "mirrored";
    return `the photo carries an EXIF orientation flag (${what}) — check in the editor that the Capsule box sits on the car`;
}

// ---------- UXP file access ----------

function lfs() {
    return require("uxp").storage;
}

async function readText(path) {
    const entry = await lfs().localFileSystem.getEntryWithUrl("file:" + path);
    return String(await entry.read());
}

// { size, modified } of a photo, or null if it can't be read.
async function photoFingerprint(imagePath) {
    try {
        const entry = await lfs().localFileSystem.getEntryWithUrl("file:" + imagePath);
        const meta = await entry.getMetadata();
        return { size: meta.size || 0, modified: meta.dateModified ? new Date(meta.dateModified).getTime() : 0 };
    } catch (e) {
        return null;
    }
}

// Pixel size + EXIF orientation of a photo (first 256 KB of the file).
async function photoHeaderInfo(imagePath) {
    const storage = lfs();
    const entry = await storage.localFileSystem.getEntryWithUrl("file:" + imagePath);
    const all = new Uint8Array(await entry.read({ format: storage.formats.binary }));
    const head = all.length > 262144 ? all.subarray(0, 262144) : all;
    let pixelSize = null;
    for (const p of ["./imageextension.js", "./js/imageextension.js"]) {
        try {
            const ext = require(p);
            if (ext && ext.parseImageHeader) { pixelSize = ext.parseImageHeader(head); break; }
        } catch (e) {}
    }
    return { pixelSize: pixelSize ? { width: pixelSize.width, height: pixelSize.height } : null, exifOrientation: jpegExifOrientation(head) };
}

function storePath(outputRoot) {
    return String(outputRoot).replace(/[\/\\]+$/, "") + "/" + CAPSULE.file;
}

// <output>/capsule_subjects.json → { path, items, error? }. A missing file is
// an empty store; an unreadable one is an empty store WITH an error (so it
// isn't silently overwritten — saveCapsuleStore refuses then).
async function loadCapsuleStore(outputRoot) {
    const path = storePath(outputRoot);
    let text = null;
    try { text = await readText(path); } catch (e) { return { path, items: {} }; }
    try {
        const json = JSON.parse(text);
        if (json && json.version === CAPSULE.version && json.items && typeof json.items === "object") return { path, items: json.items };
        return { path, items: {}, error: `${CAPSULE.file} has an unknown format (version ${json && json.version})` };
    } catch (e) {
        return { path, items: {}, error: `${CAPSULE.file} is not valid JSON` };
    }
}

async function saveCapsuleStore(store) {
    if (store.error) throw new Error(store.error + " — move or fix that file before saving Capsule data");
    const storage = lfs();
    const file = await storage.localFileSystem.createEntryWithUrl("file:" + store.path, { type: storage.types.file, overwrite: true });
    const clean = {};
    for (const [k, v] of Object.entries(store.items)) clean[k] = v;
    await file.write(JSON.stringify({ version: CAPSULE.version, items: clean }, null, 1));
}

// Reads, validates and stores one Capsule JSON for one photo (not saved —
// call saveCapsuleStore). Returns { ok, errors?, entry?, warnings, replaced, hadEdits }.
async function importFile(store, imagePath, jsonPath, keepEdits) {
    let text;
    try { text = await readText(jsonPath); } catch (e) { return { ok: false, errors: ["could not read the file: " + String((e && e.message) || e)] }; }
    const parsed = parseCapsuleJson(text);
    if (!parsed.ok) return parsed;
    const fingerprint = await photoFingerprint(imagePath);
    if (!fingerprint) return { ok: false, errors: ["the photo could not be read: " + imagePath] };
    let header = { pixelSize: null, exifOrientation: 1 };
    try { header = await photoHeaderInfo(imagePath); } catch (e) {}
    const warnings = parsed.warnings.slice();
    const ow = orientationWarning(header.exifOrientation);
    if (ow) warnings.push(ow);
    const r = importDetection(store, imagePath, parsed.detection, {
        sourceFile: String(jsonPath).split(/[\/\\]/).pop(), fingerprint,
        pixelSize: header.pixelSize, exifOrientation: header.exifOrientation, warnings,
    }, keepEdits);
    return Object.assign({ ok: true, warnings }, r);
}

// A detector for one Generate run with the same interface as
// subject.js createSubjectDetector(): { enabled, hasChoices, detect(path) }.
// Never throws and never calls the network. A photo without (valid) data
// returns { box: null, reason, capsule: { status: "missing" | "stale" } }.
//   fingerprintOf: async (imagePath) → fingerprint (default photoFingerprint)
function createCapsuleDetector(store, fingerprintOf) {
    const cache = new Map();
    const fp = fingerprintOf || photoFingerprint;
    async function run(imagePath) {
        const entry = store && store.items ? store.items[storeKey(imagePath)] : null;
        if (!entry) return subjectFromEntry(null, null);
        return subjectFromEntry(entry, await fp(imagePath));
    }
    return {
        enabled: true,
        hasChoices: false,
        source: "capsule",
        detect(imagePath) {
            const key = storeKey(imagePath);
            if (!cache.has(key)) {
                cache.set(key, run(imagePath).catch((e) => ({ box: null, reason: "Capsule data could not be read: " + String((e && e.message) || e),
                    source: "capsule", capsule: { status: "missing" } })));
            }
            return cache.get(key);
        },
    };
}

module.exports = {
    CAPSULE, STATUS_TEXT,
    parseCapsuleJson, validateBox, validatePoint, edgesTouched, edgeList, isWholePhotoBox, detectionWarnings,
    layoutId, storeKey, entryStatus, effectiveValues, subjectFromEntry,
    importDetection, saveEdit, resetToAuto, acceptChangedPhoto,
    baseName, matchJsonFilesToPhotos, coverage, jpegExifOrientation, orientationWarning,
    photoFingerprint, photoHeaderInfo, storePath, loadCapsuleStore, saveCapsuleStore, importFile, createCapsuleDetector,
};
