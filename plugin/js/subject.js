// subject.js — SUBJECT DETECTION (bounding box) for the PLACEMENT stage.
//
// Finds the main subject of a product photo via the territory-app App
// Builder actions (Photoshop API remove-background, mode "mask"):
//   subject-upload-url → PUT the photo to App Builder Files (presigned)
//   subject-mask       → backend shrinks it, submits the mask job
//   subject-status     → polled until done; returns subjectBox
//                        { x, y, width, height } as shares (0..1) of the photo
// The box only feeds placement.js (where the ORIGINAL image goes). Image
// Extension never sees it — it works from the final placed geometry.
//
// Never blocks Generate: any problem (backend not configured, unsupported
// file type, network, timeout, empty mask) returns { box: null, reason } and
// placement falls back to its normal behaviour. One detection per photo per
// run (cached), shared by every page and template of the product.
//
// Choose Subject (below): detectSubjectObjects() finds every object of a
// photo separately; the designer's pick (subject_choices.json) replaces the
// automatic box for that photo.

/* global require, fetch */

const CONFIG = {
    pollIntervalMs: 2000,
    timeoutMs: 90000,
    contentTypes: { jpg: "image/jpeg", jpeg: "image/jpeg", png: "image/png" },
};

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// POSTs JSON to one territory-app action (same gate as Image Extension).
async function post(cfg, action, body) {
    const res = await fetch(`${cfg.baseUrl}/${action}`, {
        method: "POST",
        headers: { "Content-Type": "application/json", "x-plugin-key": cfg.pluginKey },
        body: JSON.stringify(body),
    });
    let json = null;
    try { json = await res.json(); } catch (e) {}
    if (!res.ok) throw new Error(`${action}: ${(json && json.error) || "HTTP " + res.status}`);
    return json;
}

// The subject box of one photo, or { box: null, reason }.
//   cfg: { baseUrl, pluginKey } (plugin/backend.config.json)
async function detectSubjectBox(imagePath, cfg) {
    const started = Date.now();
    const ext = String(imagePath).split(".").pop().toLowerCase();
    const contentType = CONFIG.contentTypes[ext];
    if (!contentType) return { box: null, reason: `unsupported image type .${ext} for subject detection` };
    const target = await post(cfg, "subject-upload-url", { contentType });
    const storage = require("uxp").storage;
    const entry = await storage.localFileSystem.getEntryWithUrl("file:" + imagePath);
    const bytes = await entry.read({ format: storage.formats.binary });
    const put = await fetch(target.uploadUrl, { method: "PUT", headers: target.uploadHeaders, body: bytes });
    if (!put.ok) throw new Error(`photo upload failed (HTTP ${put.status})`);
    const job = await post(cfg, "subject-mask", { storagePath: target.storagePath, contentType });
    for (;;) {
        const st = await post(cfg, "subject-status", { jobId: job.jobId, statusUrl: job.statusUrl });
        if (st.status === "succeeded") {
            if (!st.subjectBox) return { box: null, reason: st.boxError || "no subject box returned", jobId: job.jobId };
            const b = st.subjectBox;
            return { box: { x: b.x, y: b.y, width: b.width, height: b.height }, coverage: b.coverage,
                source: "photoshop-mask", jobId: job.jobId, seconds: Math.round((Date.now() - started) / 1000) };
        }
        if (st.status === "failed" || st.status === "canceled" || st.status === "cancelled") {
            return { box: null, reason: `mask job ${st.status}: ${st.error || "no details"}`, jobId: job.jobId };
        }
        if (Date.now() - started > CONFIG.timeoutMs) return { box: null, reason: "subject detection timed out", jobId: job.jobId };
        await sleep(CONFIG.pollIntervalMs);
    }
}

// Connection from plugin/backend.config.json (the same file Image Extension
// uses): { config: { baseUrl, pluginKey } | null, reason }. Off when the file
// is missing / disabled, or "subjectDetection": false.
//   options.forObjects: Choose Subject (object detection) — not switched off
//   by "subjectDetection": false, which only concerns the automatic box
async function loadSubjectConfig(options) {
    try {
        const folder = await require("uxp").storage.localFileSystem.getPluginFolder();
        const cfg = JSON.parse(await (await folder.getEntry("backend.config.json")).read());
        if (!cfg || cfg.enabled === false) return { config: null, reason: "backend disabled in backend.config.json" };
        if (cfg.subjectDetection === false && !(options && options.forObjects)) return { config: null, reason: "subject detection disabled in backend.config.json" };
        if (!/^https:\/\//.test(String(cfg.baseUrl || "")) || !cfg.pluginKey) return { config: null, reason: "backend.config.json needs an https baseUrl and a pluginKey" };
        return { config: { baseUrl: String(cfg.baseUrl).replace(/\/+$/, ""), pluginKey: String(cfg.pluginKey) }, reason: "" };
    } catch (e) {
        return { config: null, reason: "backend not configured (plugin/backend.config.json missing)" };
    }
}

// ---------- Choose Subject: several objects per photo ----------
//
// remove-background keeps EVERYTHING in front as one mask — with a person
// next to a car, or a product filling the photo, the box is the whole photo.
// mask-objects (backend: subject-objects / subject-objects-status) finds
// each object separately with a label and a box; the designer ticks the
// one(s) that should go into the red subject frame (⋯ → Choose Subject).
// The choice is stored per photo in <output>/subject_choices.json and used
// by every page and template of that product, instead of the automatic box.

const CHOICES = { file: "subject_choices.json", version: 1, objectsTimeoutMs: 120000 };

// A box spanning (nearly) the whole photo on BOTH axes says nothing about
// where the subject is (same limit as placement.js maxInformativeSpan).
function isWholePhotoBox(box, span) {
    const s = span || 0.95;
    return !!box && Number(box.width) >= s && Number(box.height) >= s;
}

// PURE. The smallest box around the chosen objects (shares 0..1), or null.
//   objects: [{ id, box: { x, y, width, height } }]; ids: chosen ids
function unionBox(objects, ids) {
    const chosen = (objects || []).filter((o) => o && o.box && (ids || []).indexOf(o.id) !== -1);
    if (!chosen.length) return null;
    const x0 = Math.min(...chosen.map((o) => o.box.x));
    const y0 = Math.min(...chosen.map((o) => o.box.y));
    const x1 = Math.max(...chosen.map((o) => o.box.x + o.box.width));
    const y1 = Math.max(...chosen.map((o) => o.box.y + o.box.height));
    const r = (v) => Math.round(Math.min(1, Math.max(0, v)) * 10000) / 10000;
    return { x: r(x0), y: r(y0), width: r(x1 - x0), height: r(y1 - y0) };
}

// Every object of one photo: { objects: [{ id, label, score, box }], debug, seconds }.
// Throws on backend / network problems (the picker shows the message).
async function detectSubjectObjects(imagePath, cfg) {
    const started = Date.now();
    const ext = String(imagePath).split(".").pop().toLowerCase();
    const contentType = CONFIG.contentTypes[ext];
    if (!contentType) throw new Error(`.${ext} photos can't be analysed — use JPG or PNG`);
    const target = await post(cfg, "subject-upload-url", { contentType });
    const storage = require("uxp").storage;
    const entry = await storage.localFileSystem.getEntryWithUrl("file:" + imagePath);
    const bytes = await entry.read({ format: storage.formats.binary });
    const put = await fetch(target.uploadUrl, { method: "PUT", headers: target.uploadHeaders, body: bytes });
    if (!put.ok) throw new Error(`photo upload failed (HTTP ${put.status})`);
    const job = await post(cfg, "subject-objects", { storagePath: target.storagePath, contentType });
    for (;;) {
        const st = await post(cfg, "subject-objects-status",
            { jobId: job.jobId, statusUrl: job.statusUrl, workPath: job.workPath, sentSize: job.sentSize });
        if (st.status === "succeeded") {
            // debug: the response's shape when no object could be read (no URLs).
            return { objects: Array.isArray(st.objects) ? st.objects : [], debug: st.debug || "",
                seconds: Math.round((Date.now() - started) / 1000) };
        }
        if (st.status === "failed" || st.status === "canceled" || st.status === "cancelled") {
            throw new Error(`object detection ${st.status}: ${st.error || "no details"}`);
        }
        if (Date.now() - started > CHOICES.objectsTimeoutMs) throw new Error("object detection timed out");
        await sleep(CONFIG.pollIntervalMs);
    }
}

// Photo identity for the choices file: path + size + modification time, so a
// replaced photo (same name, new content) doesn't reuse an old choice.
async function photoKey(imagePath) {
    let size = "", modified = "";
    try {
        const entry = await require("uxp").storage.localFileSystem.getEntryWithUrl("file:" + imagePath);
        const meta = await entry.getMetadata();
        size = meta.size || "";
        modified = meta.dateModified ? new Date(meta.dateModified).getTime() : "";
    } catch (e) {}
    return `${String(imagePath).toLowerCase()}|${size}|${modified}`;
}

// <output>/subject_choices.json → { path, items: { [photoKey]: entry } }
//   entry: { imagePath, objects, selected: [ids] | null, detectedAt, chosenAt }
async function loadSubjectChoices(outputRoot) {
    const path = String(outputRoot).replace(/[\/\\]+$/, "") + "/" + CHOICES.file;
    try {
        const entry = await require("uxp").storage.localFileSystem.getEntryWithUrl("file:" + path);
        const json = JSON.parse(await entry.read());
        if (json && json.version === CHOICES.version && json.items && typeof json.items === "object") return { path, items: json.items };
    } catch (e) {}
    return { path, items: {} };
}

async function saveSubjectChoices(store) {
    const storage = require("uxp").storage;
    const file = await storage.localFileSystem.createEntryWithUrl("file:" + store.path, { type: storage.types.file, overwrite: true });
    await file.write(JSON.stringify({ version: CHOICES.version, items: store.items }, null, 1));
}

// PURE. The chosen box of a stored entry: { box, labels } or null.
function chosenSubject(entry) {
    if (!entry || !Array.isArray(entry.selected) || !entry.selected.length) return null;
    const box = unionBox(entry.objects, entry.selected);
    if (!box) return null;
    const labels = (entry.objects || []).filter((o) => entry.selected.indexOf(o.id) !== -1).map((o) => o.label);
    return { box, labels };
}

// A detector for one run: caches per photo, never throws.
//   cfg: backend config or null (→ every automatic detection returns { box: null, reason })
//   choices: loadSubjectChoices() result or null — a photo with a choice uses
//            it (source "chosen") and is not sent to remove-background
// Results: { box, source: "photoshop-mask"|"chosen", wholePhoto, labels?, reason? }
function createSubjectDetector(cfg, reasonIfOff, choices) {
    const cache = new Map();
    const hasChoices = !!(choices && choices.items && Object.keys(choices.items).some((k) => chosenSubject(choices.items[k])));
    async function run(imagePath) {
        if (hasChoices) {
            const picked = chosenSubject(choices.items[await photoKey(imagePath)]);
            if (picked) return { box: picked.box, source: "chosen", labels: picked.labels, wholePhoto: isWholePhotoBox(picked.box) };
        }
        if (!cfg) return { box: null, reason: reasonIfOff || "subject detection off" };
        const r = await detectSubjectBox(imagePath, cfg);
        if (r.box) r.wholePhoto = isWholePhotoBox(r.box);
        return r;
    }
    return {
        enabled: !!cfg,
        hasChoices,
        detect(imagePath) {
            const key = String(imagePath).toLowerCase();
            if (!cache.has(key)) {
                cache.set(key, run(imagePath).catch((e) => ({ box: null, reason: String((e && e.message) || e) })));
            }
            return cache.get(key);
        },
    };
}

module.exports = {
    CONFIG, loadSubjectConfig, detectSubjectBox, createSubjectDetector,
    CHOICES, isWholePhotoBox, unionBox, chosenSubject, detectSubjectObjects, photoKey, loadSubjectChoices, saveSubjectChoices,
};
