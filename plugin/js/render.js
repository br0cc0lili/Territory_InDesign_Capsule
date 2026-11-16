// render.js — fills the templates prepared by datamerge.js (step 1,
// <name>_DataMerge.indd) with each product from the panel's manifest rows
// (matcher.js) and exports every page as a JPG.
//
// Template contract (written by datamerge.js's Prepare step):
//   <<Headline>>  : 1st non-empty paragraph = headline,
//                   2nd non-empty paragraph = DANIS or SERVICE subline
//   <<Footer>>    : optional, whole text = DANIS ADD ON
//   <<MainImage>> : product image
// Pages need no labels: size comes from the page itself, DANIS vs Service
// from the template's file name (same rule as datamerge.js). The layouts are
// discovered from the template's own pages (planPages — no fixed inventory:
// every page with the placeholders is generated and exported); each product's
// populated document is saved once to InDesign/<type>/ and its JPGs are
// exported to output/<type>/<WxH>/. Two steps: generateIndds() builds and
// saves the populated INDDs; exportFromIndds() exports the JPGs from them
// (Preview / Commit all), so edits made in the INDDs reach the JPGs.
//
// require("indesign") is called lazily (inside functions, not at module top)
// so that if it's ever unavailable, only render actions fail — the rest of
// the panel (matching, file pickers) keeps working instead of the whole
// script aborting silently before any button gets wired up.
//
// IMPORTANT: this InDesign version's require("indesign") module does NOT
// export the classic ExtendScript File/Folder classes (confirmed empirically
// via debugModuleShape() — both come back MISSING). app.open()/frame.place()/
// doc.exportFile()/doc.save() all accept plain native path strings directly
// instead, so no File() wrapper is used anywhere below. Folder creation and
// log writing go through require("uxp").storage.localFileSystem instead,
// since there's no Folder(path).create() equivalent either.
//
// The template files are never saved over: each product opens its own copy
// of each template, which is saved-as into that product's output folder and
// then closed.

/* global require */
// Not just lazy but self-healing: on the very first call(s) after panel load,
// InDesign's UXP bridge can still be mid-attach, so require("indesign") comes
// back with "app" missing (observed directly — same code, same reload button,
// produced app=object{} once and app=MISSING another time). Re-requiring
// instead of trusting a possibly-incomplete first snapshot lets it self-correct
// once the bridge finishes initializing.
let _id = null;
function indesign() {
    if (!_id || !_id.app) _id = require("indesign");
    return _id;
}

function fileUrl(path) {
    // NOT encodeURI(path): confirmed empirically that this host bakes the
    // percent-encoding in literally as the folder/file name on disk instead
    // of decoding it back (e.g. "Grundträger" became "Grundtr%C3%A4ger") —
    // raw Unicode/spaces round-trip correctly, percent-encoding does not.
    return "file:" + path;
}

// Resolves once a folder exists at `path` (creating it if needed) and
// returns its UXP Entry (has .nativePath).
async function ensureFolder(path) {
    const lfs = require("uxp").storage.localFileSystem;
    const types = require("uxp").storage.types;
    const url = fileUrl(path);
    try {
        return await lfs.getEntryWithUrl(url);
    } catch (e) {
        return await lfs.createEntryWithUrl(url, { type: types.folder });
    }
}

async function pathExists(path) {
    try {
        await require("uxp").storage.localFileSystem.getEntryWithUrl(fileUrl(path));
        return true;
    } catch (e) {
        return false;
    }
}

const AUDI_FONT_NAME = "Audi Type\tExtended Bold";

// Output file name prefix and folder per template type: templatetype.js
// templateTypeInfo() — known types (DANIS_Herbst / Service_Herbst, DANIS /
// Service), generic types use their own name for both.

// Frame names written by datamerge.js's Prepare step.
const FRAME_NAMES = { text: "<<Headline>>", footer: "<<Footer>>", image: "<<MainImage>>" };

// Folder names per template type, used under the selected output root:
//   output/<DANIS|Service>/<WxH>/<…>.jpg       (exported JPGs)
//   InDesign/<DANIS|Service>/<…>.indd           (one populated INDD per product)
const TYPE_FOLDER = { danis: "DANIS", service: "Service" }; // known types only — use typeFolder()

// Template layouts are DISCOVERED from the template itself (describePage /
// planPages): every page with the placeholders is a layout, whatever its
// size, and is generated + exported. There is no required inventory — a
// DANIS template with one 1200x1200 page, a Service template with two
// layouts or a new page size are all valid. Only structural problems are
// errors (see describePage).
//
// Variant of a page (the last part of its JPG name):
//   footer — the page has a <<Footer>> frame (optional: removed from the
//            product's working document when DANIS ADD ON is empty, so the
//            INDD matches the JPGs)
//   a known name override (templatetype.js variantNames), e.g. the Service 250x250
//            page is historically "thumbnail"
//   up / bottom — from the headline frame's position (upper / lower half)
// Known layouts can still have specific placement rules (placement.js
// PLACEMENT_CONFIG.layoutPolicies) — optional overrides; unknown layouts use
// the generic geometry fallback.

// Temporary diagnostic: dumps the top-level keys of require("indesign") so we
// can confirm the real names/shape of enums like FontStatuses, SaveOptions,
// etc. in this InDesign version, instead of guessing blind.
function debugModuleShape() {
    try {
        const mod = indesign();
        const names = [
            "app", "App", "Application", "File", "Folder",
            "FontStatuses", "SaveOptions", "FitOptions", "ExportFormat",
            "ExportRangeOrAllPages", "JpegColorSpaceEnum", "JPEGOptionsQuality",
            "LocationOptions",
        ];
        return names.map((n) => {
            const v = mod[n];
            if (v === undefined) return `${n}=MISSING`;
            if (typeof v === "object" || typeof v === "function") {
                try {
                    return `${n}=${typeof v}{${Object.keys(v).slice(0, 10).join(",")}}`;
                } catch (e) {
                    return `${n}=${typeof v}`;
                }
            }
            return `${n}=${typeof v}:${v}`;
        }).join("\n");
    } catch (e) {
        return "require(\"indesign\") threw: " + e;
    }
}

// ---------- font check ----------

// Returns { ok: boolean, message: string } for the panel's startup warning banner.
function checkAudiFont() {
    try {
        const { app } = indesign();
        const font = app.fonts.itemByName(AUDI_FONT_NAME);
        // Compare against the string form rather than a FontStatuses enum
        // constant — this session already confirmed (via the classic
        // ExtendScript engine) that font.status.toString() yields a readable
        // name like "INSTALLED"/"NOT_AVAILABLE"/"SUBSTITUTED", and FontStatuses
        // is confirmed MISSING from this indesign module (see debugModuleShape).
        const status = String(font.status);
        if (status !== "INSTALLED") {
            return {
                ok: false,
                message: `Audi Type font not installed (status=${status}) — install ` +
                    "Audi Type Extended Bold, then reopen this panel.",
            };
        }
        return { ok: true, message: "" };
    } catch (e) {
        return {
            ok: false,
            message: "Could not verify Audi Type font (" + e + ").",
        };
    }
}

// ---------- helpers ----------

// Product token used in BOTH JPG and INDD file names (one rule, no
// per-example tweaks):
//   - trim; drop characters illegal in file names, and "_" (the field
//     separator in our names)
//   - name already contains a hyphen -> spaces become hyphens, repeated
//     hyphens collapse to one
//   - otherwise spaces are removed
//   - existing hyphens and numeric suffixes are kept
//   "Audi Airport Service"      -> "AudiAirportService"
//   "Ski- und Snowboardhalter1" -> "Ski-und-Snowboardhalter1"
function productToken(headline) {
    let s = String(headline).trim().replace(/[\/\\:\*\?"<>\|_]/g, "");
    if (s.indexOf("-") !== -1) {
        s = s.replace(/\s+/g, "-").replace(/-{2,}/g, "-");
    } else {
        s = s.replace(/\s+/g, "");
    }
    return s;
}

// <DANIS_Herbst|Service_Herbst>_<year>_<product>_<WxH>_<up|bottom|footer|thumbnail>.jpg
function buildOutputFileName(rec, layout) {
    return [
        typeInfo(layout.subType).prefix,
        rec.year,
        productToken(rec.headline),
        layout.size,
        layout.position,
    ].join("_") + ".jpg";
}

// <DANIS_Herbst|Service_Herbst>_<year>_<product>.indd — one per product and
// type; never contains a resolution or variant.
function buildInddFileName(rec, subType) {
    return [typeInfo(subType).prefix, rec.year, productToken(rec.headline)].join("_") + ".indd";
}

// DANIS ADD ON counts only with real content ("n/a" is already "" from
// matcher.js; checked again here so the footer rule never depends on it).
function hasAddOn(rec) {
    const v = String(rec.danis_addon || "").trim();
    return v !== "" && v.toLowerCase() !== "n/a";
}

// NOTE: InDesign's Collection-like objects are NOT consistent in this UXP DOM
// — `.pages` needs `.item(i)` (plain `[i]` silently returns undefined), but
// `page.allPageItems` has no `.item()` at all (it's a plain array — `[i]` is
// correct there). Both confirmed empirically, the hard way. This helper picks
// whichever access style the collection actually supports instead of
// hardcoding one and guessing wrong again for the next collection type.
function itemAt(collection, i) {
    return typeof collection.item === "function" ? collection.item(i) : collection[i];
}

function findItemByName(items, name) {
    for (let i = 0; i < items.length; i++) {
        try {
            const it = itemAt(items, i);
            if (it.name === name) return it;
        } catch (e) {}
    }
    return null;
}

function findNamed(page, name, filter) {
    const items = page.allPageItems;
    for (let i = 0; i < items.length; i++) {
        try {
            const it = itemAt(items, i);
            if (it.name === name && filter(it)) return it;
        } catch (e) {}
    }
    return null;
}

function isTextFrame(it) {
    try { return it.constructor.name === "TextFrame"; } catch (e) { return false; }
}

function findHeadlineFrame(page) { return findNamed(page, FRAME_NAMES.text, isTextFrame); }
function findFooterFrame(page) { return findNamed(page, FRAME_NAMES.footer, isTextFrame); }
function findImageFrame(page) { return findNamed(page, FRAME_NAMES.image, (it) => !isTextFrame(it)); }

// The area of a text frame the subject should stay clear of (Auto
// Placement): only the part its text actually uses — the lines' bounds
// (placement.js textBoundsFromLines), not the empty rest of the frame. The
// whole frame when it has a visible fill (a coloured band), is rotated /
// sheared, or the lines can't be measured. null = no visible text.
// Returns { bounds, trimmed }.
function textAvoidBounds(frame) {
    const whole = Array.from(frame.geometricBounds, Number);
    try {
        const pl = placementModule();
        if (!pl.PLACEMENT_CONFIG.text || !pl.PLACEMENT_CONFIG.text.trimToLines) return { bounds: whole, trimmed: false };
        let filled = false;
        try { filled = !!frame.fillColor && frame.fillColor.name !== "None" && Number(frame.fillTint) !== 0; } catch (e) {}
        const angle = Math.abs(Number(frame.absoluteRotationAngle) || 0) + Math.abs(Number(frame.absoluteShearAngle) || 0);
        if (filled || angle > 0.01) return { bounds: whole, trimmed: false };
        const lines = frame.lines;
        const boxes = [];
        for (let i = 0; i < lines.length; i++) {
            const ln = lines.item(i);
            if (!String(ln.contents || "").trim()) continue;
            const base = Number(ln.baseline), x0 = Number(ln.horizontalOffset), x1 = Number(ln.endHorizontalOffset);
            boxes.push({ top: base - Number(ln.ascent), bottom: base + Number(ln.descent), left: Math.min(x0, x1), right: Math.max(x0, x1) });
        }
        if (!boxes.length) return { bounds: null, trimmed: true };
        const b = pl.textBoundsFromLines(boxes, whole);
        return b ? { bounds: b, trimmed: true } : { bounds: whole, trimmed: false };
    } catch (e) {
        return { bounds: whole, trimmed: false };
    }
}

// Shared DANIS/Service rule (templatetype.js). Loaded lazily, module-relative
// path first, plugin-root path second: no other module here loads a sibling
// yet, and index.js documents root-anchored require() resolution for itself,
// so both are tried. If neither loads, only template classification fails —
// with a clear error — not the whole module.
let _templateType = null;
function templateType() {
    if (_templateType) return _templateType;
    const errors = [];
    for (const path of ["./templatetype.js", "./js/templatetype.js"]) {
        try {
            const mod = require(path);
            if (mod && typeof mod.detectTemplateType === "function") return (_templateType = mod);
            errors.push(`${path}: no detectTemplateType`);
        } catch (e) {
            errors.push(`${path}: ${e}`);
        }
    }
    throw new Error("Could not load templatetype.js (" + errors.join("; ") + ")");
}

// Image Extension (imageextension.js) — loaded the same defensive way: if it
// can't load, image checks are skipped with a note, Generate still works.
let _imageExt = null;
function imageExt() {
    if (_imageExt) return _imageExt;
    const errors = [];
    for (const path of ["./imageextension.js", "./js/imageextension.js"]) {
        try {
            const mod = require(path);
            if (mod && typeof mod.analyzeImageCoverage === "function") return (_imageExt = mod);
            errors.push(`${path}: no analyzeImageCoverage`);
        } catch (e) {
            errors.push(`${path}: ${e}`);
        }
    }
    throw new Error("Could not load imageextension.js (" + errors.join("; ") + ")");
}

// Subject detection (subject.js, bounding box for the placement stage) —
// loaded the same way; if it can't load, placement simply runs without it.
let _subject = null;
function subjectModule() {
    if (_subject) return _subject;
    for (const path of ["./subject.js", "./js/subject.js"]) {
        try {
            const mod = require(path);
            if (mod && typeof mod.createSubjectDetector === "function") return (_subject = mod);
        } catch (e) {}
    }
    return null;
}

// Capsule JSON (capsule.js) — the alternative subject source: imported
// Adobe Capsule detections instead of the backend API. Loaded the same way;
// if it can't load, Capsule mode has no data (it never falls back to the API).
let _capsule = null;
function capsuleModule() {
    if (_capsule) return _capsule;
    for (const path of ["./capsule.js", "./js/capsule.js"]) {
        try {
            const mod = require(path);
            if (mod && typeof mod.createCapsuleDetector === "function") return (_capsule = mod);
        } catch (e) {}
    }
    return null;
}

// Red subject frame (subjectzone.js) — loaded the same way; if it can't
// load, pages simply have no zone.
let _zone = null;
function zoneModule() {
    if (_zone) return _zone;
    for (const path of ["./subjectzone.js", "./js/subjectzone.js"]) {
        try {
            const mod = require(path);
            if (mod && typeof mod.zoneForPage === "function") return (_zone = mod);
        } catch (e) {}
    }
    return null;
}

function zoneForPage(page) {
    const mod = zoneModule();
    try { return mod ? mod.zoneForPage(page) : null; } catch (e) { return null; }
}

// Placement stage (placement.js) — loaded the same way. Swappable: a
// bounding-box placement system replaces this module; Image Extension never
// calls it.
let _placement = null;
function placementModule() {
    if (_placement) return _placement;
    const errors = [];
    for (const path of ["./placement.js", "./js/placement.js"]) {
        try {
            const mod = require(path);
            if (mod && typeof mod.getLayoutPolicy === "function") return (_placement = mod);
            errors.push(`${path}: no getLayoutPolicy`);
        } catch (e) {
            errors.push(`${path}: ${e}`);
        }
    }
    throw new Error("Could not load placement.js (" + errors.join("; ") + ")");
}

// Template type ("danis" -> output/DANIS + InDesign/DANIS, "service" ->
// output/Service + InDesign/Service) from the template's file name, via the
// rule shared with datamerge.js. Throws if the name has neither or both.
// The name of the opened copy can't be used: OPEN_COPY makes it "Untitled-N".
function subTypeFromPath(path) {
    return templateType().detectTemplateType(path);
}

// How a template type is handled (templatetype.js templateTypeInfo):
// { type, known, folder, prefix, sublineColumns, sublineKey, variantNames }.
function typeInfo(subType) {
    return templateType().templateTypeInfo(subType);
}

// "DANIS" / "Service" / a generic type's own name — under output/, InDesign/, preview/.
function typeFolder(subType) {
    return typeInfo(subType).folder;
}

// The subline text a product row has for this template type, or null when
// the type has no subline source (generic type without a "<TYPE> SUBLINE" /
// "SUBLINE" column) — then the template's own subline text is kept.
function sublineFor(rec, subType) {
    const info = typeInfo(subType);
    const cols = rec.columns || {};
    if (info.sublineKey) {
        // Known type: its column — unless the sheet doesn't have it at all.
        if (rec.columns && !info.sublineColumns.some((c) => Object.prototype.hasOwnProperty.call(cols, c))) return null;
        return rec[info.sublineKey] || "";
    }
    for (const c of info.sublineColumns) if (Object.prototype.hasOwnProperty.call(cols, c)) return cols[c];
    return null;
}

// Our working copy only: unlock layers and items so frames can be filled.
function unlockAll(doc) {
    for (let i = 0; i < doc.layers.length; i++) {
        try { doc.layers.item(i).locked = false; } catch (e) {}
    }
    const items = doc.allPageItems;
    for (let i = 0; i < items.length; i++) {
        try { itemAt(items, i).locked = false; } catch (e) {}
    }
}

// Reads geometry in points (= px at the 72 dpi JPG export).
function usePoints(doc) {
    const { MeasurementUnits } = indesign();
    try {
        doc.viewPreferences.horizontalMeasurementUnits = MeasurementUnits.POINTS;
        doc.viewPreferences.verticalMeasurementUnits = MeasurementUnits.POINTS;
    } catch (e) {}
}

// Every item on a page with this name (filtered) — to detect ambiguity.
function allNamed(page, name, filter) {
    const out = [];
    const items = page.allPageItems;
    for (let i = 0; i < items.length; i++) {
        try {
            const it = itemAt(items, i);
            if (it.name === name && (!filter || filter(it))) out.push(it);
        } catch (e) {}
    }
    return out;
}

function boundsOf(it) {
    try { return Array.from(it.geometricBounds, (v) => Math.round(Number(v) * 100) / 100); } catch (e) { return null; }
}

function layerOf(it) {
    try { return String(it.itemLayer.name); } catch (e) { return ""; }
}

// Dynamic layout descriptor of ONE page, from the document itself:
//   { index, pageName, label, w, h, size, frames: { image, text, footer },
//     position, key, generatable, known, errors: [], notes: [] }
// generatable — has the placeholders a product page needs (one <<MainImage>>
//   image frame + one <<Headline>> text frame). A page with NO placeholders
//   is not generated (kept in the INDD as-is, info only).
// errors — structural problems only: a placeholder missing on a page that
//   has the other one, more than one of a placeholder (ambiguous), a
//   <<MainImage>> that is a text frame.
function describePage(page, index, subType) {
    const b = page.bounds; // [y1, x1, y2, x2]
    const w = Math.round(Number(b[3]) - Number(b[1]));
    const h = Math.round(Number(b[2]) - Number(b[0]));
    const d = { index, pageName: "", label: "", w, h, size: `${w}x${h}`, frames: {}, position: "", key: "",
        generatable: false, known: false, errors: [], notes: [] };
    try { d.pageName = String(page.name || ""); } catch (e) {}
    try { d.label = String(page.label || ""); } catch (e) {}
    const images = allNamed(page, FRAME_NAMES.image, (it) => !isTextFrame(it));
    const imageAsText = allNamed(page, FRAME_NAMES.image, isTextFrame);
    const texts = allNamed(page, FRAME_NAMES.text, isTextFrame);
    const footers = allNamed(page, FRAME_NAMES.footer, isTextFrame);
    const describe = (list) => ({ count: list.length, bounds: list[0] ? boundsOf(list[0]) : null, layer: list[0] ? layerOf(list[0]) : "" });
    d.frames = { image: describe(images), text: describe(texts), footer: describe(footers) };
    const where = `page ${index + 1} (${d.size})`;
    if (imageAsText.length) d.errors.push(`${where}: ${FRAME_NAMES.image} is a text frame — it must be a graphic frame`);
    if (images.length > 1) d.errors.push(`${where}: ${images.length} ${FRAME_NAMES.image} frames — ambiguous`);
    if (texts.length > 1) d.errors.push(`${where}: ${texts.length} ${FRAME_NAMES.text} frames — ambiguous`);
    if (footers.length > 1) d.errors.push(`${where}: ${footers.length} ${FRAME_NAMES.footer} frames — ambiguous`);
    const hasAny = images.length || texts.length || footers.length || imageAsText.length;
    if (!hasAny) {
        d.notes.push(`${where}: no placeholders — kept, not generated`);
        return d;
    }
    if (!images.length && !imageAsText.length) d.errors.push(`${where}: no ${FRAME_NAMES.image} image frame`);
    if (!texts.length) d.errors.push(`${where}: no ${FRAME_NAMES.text} text frame`);
    if (d.errors.length) return d;

    if (footers.length) {
        d.position = "footer";
    } else if (typeInfo(subType).variantNames[d.size]) {
        d.position = typeInfo(subType).variantNames[d.size];
    } else {
        const g = texts[0].geometricBounds;
        d.position = (Number(g[0]) + Number(g[2])) / 2 < (Number(b[0]) + Number(b[2])) / 2 ? "up" : "bottom";
    }
    d.key = `${subType}_${d.position}`;
    d.generatable = true;
    // Red subject frame: read fresh from the page every time (never stored).
    const zone = zoneForPage(page);
    d.zone = zone ? { bounds: zone.bounds, via: zone.via, count: zone.count } : null;
    if (zone && zone.count > 1) d.notes.push(`${where}: ${zone.count} red subject frames — the largest is used`);
    try {
        d.known = placementModule().getLayoutPolicy({ subType, size: d.size, position: d.position }).known;
    } catch (e) {}
    if (!d.known) d.notes.push(`${where}: new layout ${d.size} ${d.position} — generic geometry-based placement`);
    return d;
}

// { subType, w, h, size, position, key, pageName } for one page — the layout
// identity used for placement policies, logs and JPG names.
function pageLayout(page, subType) {
    const d = describePage(page, 0, subType);
    return { subType, w: d.w, h: d.h, size: d.size, position: d.position, key: d.key || `${subType}_page`, pageName: d.pageName };
}

// Layouts of a document, e.g. "1200x1200: up, bottom | 800x600: up" — for the
// log and messages.
function describeMapping(pages) {
    const bySize = {};
    for (const pg of pages) (bySize[pg.layout.size] = bySize[pg.layout.size] || []).push(pg.layout.position);
    return Object.keys(bySize).map((sz) => `${sz}: ${bySize[sz].join(", ")}`).join(" | ") || "(no pages)";
}

// Discovers the document's layouts (fresh references). Every generatable
// page is a layout and is generated/exported — no required inventory.
// Returns { pages: [{index, layout, export, descriptor}], skipped: [descriptor],
//           mapping, problems: string[] (structural errors only),
//           notes: string[] (info: new layouts, pages without placeholders,
//           duplicates) }.
function planPages(doc, subType) {
    const pages = [];
    const skipped = [];
    const problems = [];
    const notes = [];
    const seen = {};
    for (let p = 0; p < doc.pages.length; p++) {
        const d = describePage(doc.pages.item(p), p, subType);
        problems.push(...d.errors);
        notes.push(...d.notes);
        if (!d.generatable) { if (!d.errors.length) skipped.push(d); continue; }
        const id = d.size + " " + d.position;
        if (seen[id]) notes.push(`page ${p + 1}: second ${id} layout — its JPG gets a -2 suffix`);
        seen[id] = true;
        pages.push({
            index: p, export: true, descriptor: d,
            layout: { subType, w: d.w, h: d.h, size: d.size, position: d.position, key: d.key, pageName: d.pageName, known: d.known },
        });
    }
    if (!pages.length && !problems.length) {
        problems.push(`no generatable page — no page has a ${FRAME_NAMES.image} image frame and a ${FRAME_NAMES.text} text frame`);
    }
    return { pages, skipped, mapping: describeMapping(pages), problems, notes };
}

// "✓ Template detected: 3 valid layouts (1200x1200 up, 800x600 bottom, 400x500 up)"
function describeTemplateLayouts(plan) {
    const n = plan.pages.length;
    const zones = plan.pages.filter((pg) => pg.descriptor && pg.descriptor.zone).length;
    return `✓ Template detected: ${n} valid layout${n === 1 ? "" : "s"}` +
        (n ? ` (${plan.pages.map((pg) => `${pg.layout.size} ${pg.layout.position}${pg.descriptor && pg.descriptor.zone ? " ▣" : ""}`).join(", ")})` : "") +
        (n ? `\n${zones ? "▣" : "·"} Red subject frame on ${zones} of ${n} layout${n === 1 ? "" : "s"}` : "");
}

// ---------- text replacement ----------
//
// Headline, subline and footer are all written by replacing whole
// paragraphs (see "headline + subline" below for why character-level edits
// are not used).
//
// All reading and writing goes through the frame's STORY, never the frame
// itself: frame.paragraphs / frame.contents only cover the text that is
// VISIBLE in the frame. In the prepared templates the long placeholder
// <<DANIS + SERVICE HEADLINE +PRODUCT NAMING>> oversets the frame, so the
// subline paragraph is hidden in the overset part — the frame showed 1
// paragraph, and writing a short headline pulled the subline back in
// (1 -> 2), a long one pushed it out (2 -> 1). The story always holds the
// whole text, so paragraph indices and counts stay stable.

function paragraphText(para) {
    return String(para.contents).replace(/[\r\n\u2028\u2029]/g, "").trim();
}

// Non-empty paragraph indices of `text` — a Story (always pass the story,
// see above), or any object with .paragraphs.
function nonEmptyParagraphs(text) {
    const out = [];
    const paras = text.paragraphs;
    for (let i = 0; i < paras.length; i++) {
        if (paragraphText(paras.item(i)) !== "") out.push(i);
    }
    return out;
}

// ---------- headline + subline ----------
//
// The prepared templates hold native Data Merge placeholders
// (<<DANIS + SERVICE HEADLINE +PRODUCT NAMING>>, <<SERVICE SUBLINE>> …).
// The previous replaceRange() edited character by character — overwrite the
// first char, then delete the rest one at a time — and inside a placeholder
// that is unreliable: the output kept placeholder tails ("Audi Airport Service>",
// "Audi Original ServiceE>>") or the whole placeholder ("<<SERVICE SUBLINE>>").
//
// So each paragraph is replaced as a whole (paragraph.contents covers the
// complete placeholder, never part of it), every Paragraph reference is
// re-resolved after each story change, and the result is read back and
// verified. Formatting: the new text takes the formatting of the replaced
// paragraph's first character, i.e. the template's headline/subline style.

// Temporary: writes before/after text + placeholder diagnostics for every
// headline frame into the generation log (and the UXP console).
const TEXT_DIAGNOSTICS = true;

// Whole story text + paragraphs, plus whether the frame oversets.
function textSnapshot(frame) {
    const story = frame.parentStory;
    let contents = "?";
    try { contents = JSON.stringify(String(story.contents)); } catch (e) { contents = "ERR " + e; }
    const paras = [];
    try {
        const n = story.paragraphs.length;
        for (let i = 0; i < n; i++) paras.push(`[${i}]` + JSON.stringify(String(story.paragraphs.item(i).contents)));
    } catch (e) {
        paras.push("ERR " + e);
    }
    let overset = "?";
    try { overset = String(frame.overflows); } catch (e) {}
    return `story=${contents} paragraphs=${paras.length} ${paras.join(" ")} overset=${overset}`;
}

// Native Data Merge text placeholders in the frame's story: "FIELD@offset".
function placeholderSnapshot(doc, frame) {
    const out = [];
    try {
        const storyId = frame.parentStory.id;
        const phs = doc.dataMergeTextPlaceholders;
        for (let i = 0; i < phs.length; i++) {
            const ph = itemAt(phs, i);
            try {
                if (ph.parentStory.id !== storyId) continue;
                const off = ph.storyOffset;
                const at = typeof off === "number" ? off : off.index;
                out.push(`${ph.field.fieldName}@${at}`);
            } catch (e) {
                out.push("ERR " + e);
            }
        }
    } catch (e) {
        out.push("ERR " + e);
    }
    return out.length ? out.join(" ") : "none";
}

// Removes the native placeholders in the frame's story (our working copy
// only — the template file is never saved). Fallback when a whole-paragraph
// replace still left placeholder text behind.
function removePlaceholders(doc, frame) {
    const storyId = frame.parentStory.id;
    const phs = doc.dataMergeTextPlaceholders;
    for (let i = phs.length - 1; i >= 0; i--) {
        const ph = itemAt(phs, i);
        try { if (ph.parentStory.id === storyId) ph.remove(); } catch (e) {}
    }
}

// Replaces paragraph `paraIndex` of the frame's STORY with `text`, keeping
// exactly the paragraph return it had. Returns true if the read-back text
// matches.
function replaceParagraph(frame, paraIndex, text) {
    const story = frame.parentStory;
    const countBefore = story.paragraphs.length;
    const para = story.paragraphs.item(paraIndex);
    const hadReturn = String(para.contents).endsWith("\r");
    // The paragraph's range includes its own return, so writing text + "\r"
    // keeps the headline/subline boundary even if the setter replaces the
    // whole range.
    para.contents = hadReturn ? text + "\r" : text;

    // Re-resolve: if this DOM kept the original return as well, there is now
    // one extra empty paragraph right after — remove only that return.
    if (story.paragraphs.length === countBefore + 1) {
        const extra = story.paragraphs.item(paraIndex + 1);
        if (paragraphText(extra) === "") story.characters.item(extra.index).remove();
    }
    // Emptying the LAST paragraph (no return of its own) leaves nothing to
    // count as a paragraph — expected for an empty subline/footer ("n/a").
    const emptiedLast = !hadReturn && String(text) === "" && paraIndex === countBefore - 1;
    if (emptiedLast && story.paragraphs.length === countBefore - 1) return true;
    if (story.paragraphs.length !== countBefore) {
        throw new Error(`paragraph count changed ${countBefore} -> ${story.paragraphs.length} ` +
            `while writing paragraph ${paraIndex}`);
    }
    return paragraphText(story.paragraphs.item(paraIndex)) === String(text).trim();
}

function writeParagraph(doc, frame, paraIndex, text, what) {
    if (replaceParagraph(frame, paraIndex, text)) return;
    // Placeholder text survived the replace: drop the native placeholders and
    // write once more.
    removePlaceholders(doc, frame);
    if (replaceParagraph(frame, paraIndex, text)) return;
    throw new Error(`${what} not written correctly: got ` +
        JSON.stringify(paragraphText(frame.parentStory.paragraphs.item(paraIndex))) +
        ` expected ${JSON.stringify(String(text).trim())}`);
}

// ---------- stale optional placeholders ----------
//
// A template prepared from an older sheet may still hold an optional subline
// placeholder (<<SERVICE SUBLINE>>, <<WINTER SUBLINE>> …) although the
// current sheet has no such column. That token is stale prepared state, not
// client copy: it is replaced silently by the client's original subline
// (Prepare's label, or recovered from the client INDD), else removed — it
// never reaches an INDD/JPG. Only subline tokens; required placeholders
// (<<Headline>>, <<MainImage>>) are never touched by this.
const ORIGINAL_SUBLINE_LABEL = "posterBatch.originalSubline"; // same key as datamerge.js
const OPTIONAL_SUBLINE_TOKEN = /^<<[^<>]*SUBLINE[^<>]*>>$/i;

// PURE. What a subline paragraph becomes when the sheet has NO subline
// source: null = real text, keep it; otherwise the replacement for a stale
// token — the original text if known, else "" (token removed).
function staleSublineReplacement(currentText, original) {
    if (!OPTIONAL_SUBLINE_TOKEN.test(String(currentText || "").trim())) return null;
    const o = String(original || "").trim();
    return o && !/^<<[^<>]*>>$/.test(o) ? o : "";
}

function readOriginalSubline(frame) {
    try { return String(frame.extractLabel(ORIGINAL_SUBLINE_LABEL) || ""); } catch (e) { return ""; }
}

// The client's subline per page, read from the client INDD next to a
// prepared template ("<client>_DataMerge[_N].indd" → "<client>.indd") — for
// templates prepared before Prepare stored the original. Opened as a copy,
// never changed. Returns { [pageIndex]: text } or null.
async function recoverClientSublines(templatePath, pageCount) {
    const clientPath = String(templatePath).replace(/_DataMerge(_\d+)?(\.indd)$/i, "$2");
    if (clientPath === templatePath || !(await pathExists(clientPath))) return null;
    let doc = null;
    try {
        doc = await openTemplateCopy(clientPath);
        if (doc.pages.length !== pageCount) return null; // can't map pages safely
        const out = {};
        for (let p = 0; p < doc.pages.length; p++) {
            const page = doc.pages.item(p);
            let frame = findHeadlineFrame(page);
            if (!frame) {
                const onText = [];
                const items = page.allPageItems;
                for (let i = 0; i < items.length; i++) {
                    try {
                        const it = itemAt(items, i);
                        if (isTextFrame(it) && String(it.itemLayer.name).toLowerCase() === "text") onText.push(it);
                    } catch (e) {}
                }
                if (onText.length === 1) frame = onText[0];
            }
            if (!frame) continue;
            const idx = nonEmptyParagraphs(frame.parentStory);
            if (idx.length > 1) out[p] = paragraphText(frame.parentStory.paragraphs.item(idx[1]));
        }
        return out;
    } catch (e) {
        return null;
    } finally {
        closeWithoutSaving(doc);
        await settle(250);
    }
}

// Per page of an open prepared template: does its subline hold a stale-able
// token with no stored original? (Then recovery from the client is worth it.)
function needsSublineRecovery(doc) {
    for (let p = 0; p < doc.pages.length; p++) {
        const frame = findHeadlineFrame(doc.pages.item(p));
        if (!frame || readOriginalSubline(frame)) continue;
        const idx = nonEmptyParagraphs(frame.parentStory);
        if (idx.length > 1 && OPTIONAL_SUBLINE_TOKEN.test(paragraphText(frame.parentStory.paragraphs.item(idx[1])))) return true;
    }
    return false;
}

// Headline + subline into <<Headline>>: 1st / 2nd non-empty paragraph of the
// same frame. subline null = the sheet has no subline source: real template
// text is kept; a stale optional token is cleaned (staleSublineReplacement).
// Returns a diagnostics string ("" when TEXT_DIAGNOSTICS is off).
function setHeadlineText(doc, frame, headline, subline) {
    const before = TEXT_DIAGNOSTICS
        ? `BEFORE ${textSnapshot(frame)} placeholders=${placeholderSnapshot(doc, frame)}`
        : "";

    const idx = nonEmptyParagraphs(frame.parentStory);
    if (!idx.length) throw new Error(FRAME_NAMES.text + " is empty — re-run Prepare (step 2)");

    try {
        writeParagraph(doc, frame, idx[0], headline, "headline");
        // Re-resolve after the story changed: never reuse a paragraph index or
        // reference from before the headline write.
        const after = nonEmptyParagraphs(frame.parentStory);
        if (after.length > 1 && subline !== null) {
            writeParagraph(doc, frame, after[1], subline, "subline");
        } else if (after.length > 1) {
            const current = paragraphText(frame.parentStory.paragraphs.item(after[1]));
            const replacement = staleSublineReplacement(current, readOriginalSubline(frame));
            if (replacement !== null) writeParagraph(doc, frame, after[1], replacement, "subline");
        }
    } catch (e) {
        throw new Error(`${e}${before ? ` || ${before} || AFTER ${textSnapshot(frame)}` : ""}`);
    }

    if (!TEXT_DIAGNOSTICS) return "";
    const diag = `${before} || AFTER ${textSnapshot(frame)} placeholders=${placeholderSnapshot(doc, frame)}`;
    try { console.log("[setHeadlineText] " + diag); } catch (e) {}
    return diag;
}

// ---------- headline + subline: fit to the fixed frame ----------
//
// Generated Headline/Subline text is never hyphenated (whole-word wrapping
// only) and the frame keeps its geometry (auto-sizing off). The template's
// font sizes stay whenever the text fits. Only when it doesn't, the HEADLINE
// (1st non-empty paragraph) is scaled down — the subline always keeps its
// template size. One factor for every run of the headline (fixed leading
// scaled with it, auto leading stays auto) — the LARGEST factor that fits,
// found by a binary search. Font, style, alignment and tracking are never
// touched. "Fits" = no overset and no word broken across two lines.
const TEXT_FIT = { minScale: 0.25, precisionPt: 0.1, maxSteps: 14 };

// PURE. The largest scale in [minScale, 1] for which fitsAt(scale) is true,
// assuming fitsAt is monotonic (smaller text never fits worse). 1 when the
// text already fits; null when it doesn't fit even at minScale.
//   maxSize: the largest original font size — the search stops once the
//   remaining interval is below precisionPt of it.
function largestFittingScale(fitsAt, maxSize, opts) {
    const o = Object.assign({}, TEXT_FIT, opts || {});
    if (fitsAt(1)) return 1;
    if (!fitsAt(o.minScale)) return null;
    let lo = o.minScale, hi = 1;
    for (let i = 0; i < o.maxSteps && (hi - lo) * maxSize > o.precisionPt; i++) {
        const mid = (lo + hi) / 2;
        if (fitsAt(mid)) lo = mid; else hi = mid;
    }
    return lo;
}

// PURE. True if a word is broken across two lines: a line ending in a letter
// or digit followed by a line starting with one (a break at a space, an
// existing hyphen/dash or a paragraph end is a normal whole-word break).
// (Explicit Latin/Cyrillic letter ranges incl. umlauts and ß — no \p{…}, which
// not every UXP engine supports.)
const WORD_END = /[0-9A-Za-zÀ-ɏЀ-ӿ]$/;
const WORD_START = /^[0-9A-Za-zÀ-ɏЀ-ӿ]/;
function wordSplitAcrossLines(lineTexts) {
    for (let i = 0; i + 1 < lineTexts.length; i++) {
        if (WORD_END.test(String(lineTexts[i])) && WORD_START.test(String(lineTexts[i + 1]))) return true;
    }
    return false;
}

// PURE. The lines of `text` (a story's contents) from the story indices where
// each line starts — independent of what a Line's own .contents returns (an
// automatic hyphen is never part of the text, so "Snowboard" + "halter1"
// shows up as a broken word).
function linesFromStarts(text, starts) {
    const s = String(text);
    const sorted = starts.filter((n) => Number.isInteger(n) && n >= 0 && n <= s.length).sort((a, b) => a - b);
    return sorted.map((start, i) => s.slice(start, i + 1 < sorted.length ? sorted[i + 1] : s.length));
}

const round1 = (n) => Math.round(n * 10) / 10;

// Hyphenation off, auto-sizing off, then the largest font size that fits.
// Returns { scale, fits, from, to, note } — never throws: if the DOM refuses
// a step, the template sizes are restored and the note says why.
function fitHeadlineToFrame(frame) {
    let restore = null;
    try {
        return fitHeadlineToFrameUnsafe(frame, (fn) => { restore = fn; });
    } catch (e) {
        try { if (restore) restore(); } catch (err) {}
        return { scale: 1, fits: !oversets(frame), note: "text fitting unavailable (" + String((e && e.message) || e).replace(/,/g, ";") + ") — template size kept" };
    }
}

function fitHeadlineToFrameUnsafe(frame, onRestore) {
    const { Leading, AutoSizingTypeEnum } = indesign();
    const story = frame.parentStory;
    // Hyphenation off on every level the DOM offers (story, its text, each
    // paragraph) — then read back, so the log shows what InDesign really has.
    try { story.hyphenation = false; } catch (e) {}
    try { story.texts.item(0).hyphenation = false; } catch (e) {}
    for (let i = 0; i < story.paragraphs.length; i++) {
        try { story.paragraphs.item(i).hyphenation = false; } catch (e) {}
    }
    let stillHyphenated = 0;
    for (let i = 0; i < story.paragraphs.length; i++) {
        try { if (story.paragraphs.item(i).hyphenation !== false) stillHyphenated++; } catch (e) { stillHyphenated++; }
    }
    const hyphenNote = stillHyphenated ? ` · ⚠ hyphenation still on in ${stillHyphenated} paragraph(s)` : " · hyphenation off";
    try {
        const prefs = frame.textFramePreferences;
        if (AutoSizingTypeEnum && prefs.autoSizingType !== AutoSizingTypeEnum.OFF) prefs.autoSizingType = AutoSizingTypeEnum.OFF;
    } catch (e) {}

    // Original size + leading of every style run of the HEADLINE paragraph,
    // by character range (story indices). The subline is never resized.
    const runs = [];
    const idx = nonEmptyParagraphs(story);
    if (!idx.length) return { scale: 1, fits: !oversets(frame), note: "no headline text" };
    const tsr = story.paragraphs.item(idx[0]).textStyleRanges;
    for (let i = 0; i < tsr.length; i++) {
        const r = itemAt(tsr, i);
        const n = r.characters.length;
        if (!n) continue;
        const leading = r.leading;
        const auto = (Leading && leading === Leading.AUTO) || typeof leading !== "number" || leading > 5000;
        runs.push({ start: r.characters.item(0).index, end: r.characters.item(n - 1).index, size: Number(r.pointSize), leading: auto ? null : Number(leading) });
    }
    const maxSize = Math.max(...runs.map((r) => r.size).filter(isFinite), 0);
    if (!runs.length || !maxSize) return { scale: 1, fits: !oversets(frame), note: "no headline text runs" };

    let applied = 1;
    const apply = (scale) => {
        if (scale === applied) return;
        for (const r of runs) {
            const range = story.characters.itemByRange(r.start, r.end);
            // scale 1 = the exact template values (no rounding)
            range.pointSize = scale === 1 ? r.size : round1(r.size * scale);
            if (r.leading !== null) range.leading = scale === 1 ? r.leading : round1(r.leading * scale);
        }
        applied = scale;
    };
    onRestore(() => { applied = null; apply(1); });
    // The frame's lines, cut from the story text at each line's start index
    // (null = the lines couldn't be read — then breaks can't be checked).
    const readLines = () => {
        try {
            const lines = frame.lines;
            const starts = [];
            for (let i = 0; i < lines.length; i++) {
                const ln = itemAt(lines, i);
                let at = NaN;
                try { at = Number(ln.characters.item(0).index); } catch (e) {}
                if (!Number.isInteger(at)) at = Number(ln.index);
                starts.push(at);
            }
            if (!starts.length) return null;
            return linesFromStarts(String(story.contents), starts);
        } catch (e) {
            return null;
        }
    };
    let linesChecked = true;
    const fitsNow = () => {
        try { story.recompose(); } catch (e) {}
        if (oversets(frame)) return false;
        const lines = readLines();
        if (!lines) { linesChecked = false; return true; }
        return !wordSplitAcrossLines(lines);
    };
    const fitsAt = (scale) => { apply(scale); return fitsNow(); };

    const best = largestFittingScale(fitsAt, maxSize);
    const from = round1(maxSize);
    // Diagnostics for the log: hyphenation read-back + the final line breaks.
    const tail = () => {
        const lines = readLines();
        const split = lines ? wordSplitAcrossLines(lines) : false;
        return hyphenNote + (lines
            ? ` · lines ${JSON.stringify(lines.map((l) => l.replace(/\s+$/, "")))}` + (split ? " · ⚠ a word is broken across lines" : "")
            : " · ⚠ line breaks couldn't be read — not checked") + (linesChecked ? "" : " (during fitting too)");
    };
    if (best === null) {
        apply(1); // doesn't fit even at the minimum: keep the template size, Review flags it
        try { story.recompose(); } catch (e) {}
        return { scale: 1, fits: false, from, to: from,
            note: `text doesn't fit its frame even at ${round1(maxSize * TEXT_FIT.minScale)} pt — template size kept` + tail() };
    }
    apply(best);
    try { story.recompose(); } catch (e) {}
    if (best === 1) return { scale: 1, fits: true, from, to: from, note: `fits at the template size (${from} pt)` + tail() };
    return { scale: best, fits: true, from, to: round1(maxSize * best),
        note: `reduced ${from} → ${round1(maxSize * best)} pt (${Math.round(best * 100)} %) to fit the frame` + tail() };
}

// ---------- footer ----------

// Whole <<Footer>> text (from its first non-empty paragraph on) -> `text`,
// with the same whole-paragraph strategy as the headline: later paragraphs
// are removed as whole paragraphs (back to front, re-resolved each time),
// then the first one is replaced as a whole — so a <<DANIS ADD ON>>
// placeholder is never edited partially. `text` may be "" (n/a in the sheet).
// Returns a diagnostics string ("" when TEXT_DIAGNOSTICS is off).
function setFooterText(doc, frame, text) {
    const before = TEXT_DIAGNOSTICS
        ? `BEFORE ${textSnapshot(frame)} placeholders=${placeholderSnapshot(doc, frame)}`
        : "";

    const story = frame.parentStory;
    try {
        const idx = nonEmptyParagraphs(story);
        if (!idx.length) {
            // Empty footer frame: nothing to replace, so no placeholder either.
            if (text) story.insertionPoints.item(0).contents = text;
        } else {
            const first = idx[0];
            for (let k = story.paragraphs.length - 1; k > first; k--) {
                story.paragraphs.item(k).remove();
            }
            // Removing the last paragraph can leave the previous return (an
            // empty paragraph) behind — harmless; any remaining TEXT is not.
            const leftover = nonEmptyParagraphs(story).filter((i) => i > first);
            if (leftover.length) {
                throw new Error(`could not clear footer paragraphs ${leftover.join(", ")}`);
            }
            writeParagraph(doc, frame, first, text, "footer");
        }
        const expected = String(text).trim();
        const got = nonEmptyParagraphs(story).map((i) => paragraphText(story.paragraphs.item(i))).join(" ");
        if (got !== expected) {
            throw new Error(`footer not written correctly: got ${JSON.stringify(got)} expected ${JSON.stringify(expected)}`);
        }
    } catch (e) {
        throw new Error(`${e}${before ? ` || ${before} || AFTER ${textSnapshot(frame)}` : ""}`);
    }

    if (!TEXT_DIAGNOSTICS) return "";
    const diag = `${before} || AFTER ${textSnapshot(frame)} placeholders=${placeholderSnapshot(doc, frame)}`;
    try { console.log("[setFooterText] " + diag); } catch (e) {}
    return diag;
}

// Places the image and frames it with InDesign's Content-Aware Fit (Adobe
// Sensei picks the main subject and scales/positions around it). Falls back
// to the old fill + center when Content-Aware Fit isn't available in this
// InDesign version or fails on a particular image.
// Returns a short note for the generation log.
function placeImageFill(frame, imagePath) {
    const { FitOptions } = indesign();
    frame.place(imagePath);
    try {
        if (FitOptions.CONTENT_AWARE_FIT === undefined) throw new Error("not supported");
        frame.fit(FitOptions.CONTENT_AWARE_FIT);
        return "fit=content-aware";
    } catch (e) {
        frame.fit(FitOptions.FILL_PROPORTIONALLY);
        frame.fit(FitOptions.CENTER_CONTENT);
        return "fit=fill-center (content-aware failed: " + String(e).replace(/,/g, ";") + ")";
    }
}

// PLACEMENT stage for one page — the only place render.js decides where the
// image goes. Uses the layout's placement policy (placement.js
// PLACEMENT_CONFIG.layoutPolicies / defaultPolicy):
//   "fill"   — placeImageFill() above, unchanged (covers the frame by
//              enlarging/cropping)
//   "extend" — Preserve Composition: whole image, aspect kept, no crop / no
//              fill-zoom; any remaining strip is detected afterwards and
//              handled by Image Extension.
// If placement.js can't load, falls back to "fill".
//   layout: pageLayout() result (subType, size, position, key)
// Returns the placement contract Image Extension relies on:
//   { mode, allowExtension, policy, note }
// (a future bounding-box placement only has to return the same shape).
//   subjectBox: the photo's subject box from subject.js (shares 0..1) or
//               null — used by "extend" placement only; null = as before
//   avoidBounds: bounds of the page's text frames (headline / footer) — with a
//               subject box, the subject is centred in the area outside them
//   zoneBounds: the page's red subject frame (subjectzone.js) or null — with a
//               subject box, the subject is placed inside it (placement.js
//               planZonePlacement); result.zone / result.warnings then set
function placeProductImage(frame, imagePath, layout, subjectBox, avoidBounds, zoneBounds) {
    let placement = null;
    try { placement = placementModule(); } catch (e) {
        return { mode: "fill", allowExtension: false, policy: { id: "fallback", placementMode: "fill", anchor: null },
            note: placeImageFill(frame, imagePath) + " (placement.js unavailable)" };
    }
    // Known layout → its configured policy; unknown layout → generic
    // geometry-based fallback (needs the image's proportions: placed once).
    let policy = placement.getLayoutPolicy(layout);
    if (!policy.known) {
        try {
            policy = placement.resolvePlacementPolicy(layout, frame.geometricBounds, placement.probeSourceSize(frame, imagePath));
        } catch (e) {
            policy = Object.assign({}, policy, { id: "unknown (geometry unavailable — default policy)" });
        }
    }
    if (zoneBounds && subjectBox && typeof placement.placeImageInZone === "function") {
        const inZone = placement.placeImageInZone(frame, imagePath, policy, subjectBox, zoneBounds);
        if (inZone) {
            const plan = inZone.placementPlan;
            return { mode: plan.mode, allowExtension: plan.mode === "extend", policy, subject: subjectBox, zone: plan.zoneRect,
                note: inZone.note, warnings: plan.warnings, notes: plan.notes };
        }
        // Zone outside the image frame: normal placement below, but say so.
        const normal = placeProductImage(frame, imagePath, layout, subjectBox, avoidBounds, null);
        return Object.assign(normal, { warnings: (normal.warnings || []).concat(["the red subject frame lies outside the image frame — normal placement used"]) });
    }
    if (policy.placementMode === "extend") {
        const placed = placement.placeImageForExtension(frame, imagePath, indesign(), policy, subjectBox || null, avoidBounds || null);
        return { mode: "extend", allowExtension: true, policy,
            subject: subjectBox || null,
            note: placed.note, notes: placed.notes || [] };
    }
    return { mode: "fill", allowExtension: false, policy, note: placeImageFill(frame, imagePath) + ` (policy ${policy.id}` +
        (policy.gap ? `; ${policy.gap.axis} gap ${Math.round(policy.gap.ratio * 100)}% > limit` : "") + ")" };
}

// The placement contract is stored on the Image frame, so a later Extend
// Image on the saved INDD knows whether this page may be extended without
// re-running (or knowing) placement. Script label only — nothing visible.
const PLACEMENT_LABEL = "posterBatch.placement";

function writePlacementLabel(frame, placed) {
    try {
        frame.insertLabel(PLACEMENT_LABEL, JSON.stringify({
            mode: placed.mode, allowExtension: placed.allowExtension === true,
            policy: placed.policy && placed.policy.id, anchor: (placed.policy && placed.policy.anchor) || null,
            known: !!(placed.policy && placed.policy.known), gap: (placed.policy && placed.policy.gap) || null,
            subject: placed.subject || null, zone: placed.zone || null,
        }));
    } catch (e) {}
}

// The stored contract, or — for INDDs generated before it was stored — the
// layout's current placement policy.
function readPlacement(frame, layout) {
    try {
        const raw = frame.extractLabel(PLACEMENT_LABEL);
        if (raw) return JSON.parse(raw);
    } catch (e) {}
    try {
        const placement = placementModule();
        let policy = placement.getLayoutPolicy(layout);
        if (!policy.known) {
            // Unknown layout: same geometry fallback, from the placed graphic's proportions.
            const graphics = frame.allGraphics;
            const g = graphics && graphics.length ? itemAt(graphics, 0).geometricBounds : null;
            if (g) {
                policy = placement.resolvePlacementPolicy(layout, frame.geometricBounds,
                    { width: Number(g[3]) - Number(g[1]), height: Number(g[2]) - Number(g[0]) });
            }
        }
        return { mode: policy.placementMode, allowExtension: policy.placementMode === "extend", policy: policy.id, anchor: policy.anchor };
    } catch (e) {
        return { mode: "unknown", allowExtension: false, policy: "-", anchor: null };
    }
}

// Final JPGs: 72 dpi (page points = output pixels). Preview JPGs use a lower
// resolution — they only need to be looked at, not delivered.
const FINAL_RESOLUTION = 72;
const PREVIEW_RESOLUTION = 36;

function exportPageAsJPEG(doc, page, outputPath, resolution) {
    const { app, ExportFormat, ExportRangeOrAllPages, JpegColorSpaceEnum, JPEGOptionsQuality } = indesign();
    app.jpegExportPreferences.exportResolution = resolution || FINAL_RESOLUTION;
    app.jpegExportPreferences.jpegQuality = JPEGOptionsQuality.MAXIMUM;
    app.jpegExportPreferences.jpegColorSpace = JpegColorSpaceEnum.RGB;
    app.jpegExportPreferences.jpegExportRange = ExportRangeOrAllPages.EXPORT_RANGE;
    app.jpegExportPreferences.pageString = String(page.documentOffset + 1);

    doc.exportFile(ExportFormat.JPG, outputPath, false);
}

// ---------- per-product document lifecycle ----------

// Lets InDesign finish tearing down the previously closed document before the
// next app.open() lands. Back-to-back open/close cycles without a pause are
// what produced the intermittent "Object is invalid" errors noted below.
function settle(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
}

// Opens a fresh, independent working copy of a template. Prefers
// OpenOptions.OPEN_COPY (an untitled doc with no link back to the template
// file, so even an accidental doc.save() can't touch it); falls back to a
// normal open if that enum isn't exposed in this InDesign version — the
// workflow below only ever save-as's to a new path, so the template is still
// never written either way.
async function openTemplateCopy(templatePath) {
    const { app, OpenOptions } = indesign();
    const openCopy = OpenOptions && OpenOptions.OPEN_COPY;
    let lastErr = null;
    // One retry: the very first open after a close is the one most likely to
    // hit a half-torn-down previous document.
    for (let attempt = 0; attempt < 2; attempt++) {
        try {
            return openCopy ? app.open(templatePath, false, openCopy) : app.open(templatePath, false);
        } catch (e) {
            lastErr = e;
            await settle(500);
        }
    }
    throw lastErr;
}

// doc.save() straight after a batch of edits can fail with "Cannot save
// document because there are open transactions in process on the database":
// InDesign is still committing those edits. Yield and retry until it's done.
async function saveWhenIdle(doc, path) {
    let lastErr = null;
    for (let attempt = 0; attempt < 20; attempt++) {
        await new Promise((resolve) => setTimeout(resolve, attempt ? 250 : 0));
        try {
            return path ? doc.save(path) : doc.save();
        } catch (e) {
            lastErr = e;
            if (!/transaction/i.test(String(e))) throw e;
        }
    }
    throw lastErr;
}

function closeWithoutSaving(doc) {
    const { SaveOptions } = indesign();
    try {
        if (doc && doc.isValid !== false) doc.close(SaveOptions.NO || SaveOptions.no);
    } catch (closeErr) {}
}

function samePath(a, b) {
    return String(a).replace(/\/+$/, "").toLowerCase() === String(b).replace(/\/+$/, "").toLowerCase();
}

// ---------- phase A: populate + validate ----------

function basename(path) {
    return String(path).split("/").pop();
}

function graphicInfo(frame) {
    const info = { count: 0, link: "", path: "" };
    try {
        const g = frame.allGraphics;
        info.count = g.length;
        if (g.length) {
            const link = itemAt(g, 0).itemLink;
            try { info.link = String(link.name); } catch (e) {}
            try { info.path = String(link.filePath); } catch (e) {}
        }
    } catch (e) {}
    return info;
}

function countPlaceholders(doc) {
    const n = { text: 0, image: 0 };
    try { n.text = doc.dataMergeTextPlaceholders.length; } catch (e) {}
    try { n.image = doc.dataMergeImagePlaceholders.length; } catch (e) {}
    return n;
}

// Data Merge placeholder objects can't always be removed in this UXP DOM:
// the image placeholders have no remove() ("itemAt(...).remove is not a
// function" in the real test). So removal is best-effort and never throws —
// the per-page validation (real image + real text) is what guards the save.
function tryRemove(obj) {
    try {
        if (typeof obj.remove === "function") { obj.remove(); return true; }
    } catch (e) {}
    try {
        if (typeof obj.getElements === "function") {
            const el = obj.getElements()[0];
            if (el && typeof el.remove === "function") { el.remove(); return true; }
        }
    } catch (e) {}
    return false;
}

function removeAll(collection) {
    try {
        for (let i = collection.length - 1; i >= 0; i--) tryRemove(itemAt(collection, i));
    } catch (e) {}
}

// Unbinds the native @MainImage placeholders in the working copy before
// images are placed (frames stay), where the DOM allows it.
function unbindImagePlaceholders(doc) {
    removeAll(doc.dataMergeImagePlaceholders);
}

// After all text is written: drop remaining placeholder bindings and the
// data source, so the saved INDD is a plain populated document, not a
// Data Merge template. Validation runs afterwards and checks everything.
function detachDataMerge(doc) {
    removeAll(doc.dataMergeTextPlaceholders);
    unbindImagePlaceholders(doc);
    try { doc.dataMergeProperties.removeDataSource(); } catch (e) {}
}

// Text that doesn't fit its frame is not visible in the JPG.
function oversets(frame) {
    try { return frame.overflows === true; } catch (e) { return false; }
}

// Per-page check of the populated document. Returns { report, errors,
// warnings }. Overset text is a warning, not an error: the story holds the
// right text, but the layout can't show all of it.
function validatePage(page, layout, rec, subline) {
    const errors = [];
    const warnings = [];
    const parts = [`${layout.key} ${layout.size}`];

    const imageFrame = findImageFrame(page);
    if (!imageFrame) {
        errors.push(`no ${FRAME_NAMES.image} frame`);
        parts.push("image frame: none");
    } else {
        const g = graphicInfo(imageFrame);
        parts.push(`image frame "${imageFrame.name}" graphics=${g.count} link=${g.link || "?"} path=${g.path || "?"}`);
        if (g.count < 1) errors.push("MainImage frame is empty (no placed image)");
        else if (g.link && basename(rec.imagePath).toLowerCase() !== g.link.toLowerCase()) {
            errors.push(`placed image is ${g.link}, expected ${basename(rec.imagePath)}`);
        }
    }

    const headlineFrame = findHeadlineFrame(page);
    if (!headlineFrame) {
        errors.push(`no ${FRAME_NAMES.text} frame`);
    } else {
        const story = headlineFrame.parentStory;
        const idx = nonEmptyParagraphs(story);
        const actualHeadline = idx.length ? paragraphText(story.paragraphs.item(idx[0])) : "";
        const actualSubline = idx.length > 1 ? paragraphText(story.paragraphs.item(idx[1])) : "";
        parts.push(`headline=${JSON.stringify(actualHeadline)} subline=${JSON.stringify(actualSubline)}`);
        if (actualHeadline !== String(rec.headline).trim()) errors.push(`headline is ${JSON.stringify(actualHeadline)}`);
        // Checked only where there is a subline: a source value AND a subline
        // paragraph in the template (a headline-only template has none).
        const hasSublinePara = idx.length > 1 || String(subline || "").trim() === "";
        if (subline !== null && hasSublinePara && actualSubline !== String(subline || "").trim()) {
            errors.push(`subline is ${JSON.stringify(actualSubline)}`);
        }
        // Safety net: an unresolved optional placeholder must never be exported.
        if (OPTIONAL_SUBLINE_TOKEN.test(actualSubline)) errors.push(`unresolved placeholder ${actualSubline} in the subline`);
        if (idx.length > 2) errors.push(`${idx.length} non-empty paragraphs in ${FRAME_NAMES.text} (expected 2)`);
        if (oversets(headlineFrame)) {
            warnings.push(`${FRAME_NAMES.text} text doesn't fit its frame — part of the headline/subline is hidden in the JPG`);
        }
    }

    const footerFrame = findFooterFrame(page);
    if (footerFrame) {
        const footerStory = footerFrame.parentStory;
        const actualFooter = nonEmptyParagraphs(footerStory)
            .map((i) => paragraphText(footerStory.paragraphs.item(i))).join(" ");
        parts.push(`footer=${JSON.stringify(actualFooter)}`);
        if (actualFooter !== String(rec.danis_addon || "").trim()) errors.push(`footer is ${JSON.stringify(actualFooter)}`);
        if (oversets(footerFrame)) {
            warnings.push(`${FRAME_NAMES.footer} text doesn't fit its frame — part of the footer is hidden in the JPG`);
        }
    }
    return { report: parts.join(" | "), errors, warnings };
}

// PHASE A for one product + template, on an already opened working copy:
// remove the footer page if not applicable, fill EVERY page (image, headline,
// subline, footer), detach Data Merge, validate every page.
// Returns { plan, reports: string[], errors: string[] } — the caller only
// saves and exports when errors is empty.
//   subject: optional subject detection result for rec.imagePath ({ box } from subject.js)
//   options.placementMode: "auto" (default) — the subject is centred in the
//     free area clear of the text; red subject frames in the template are
//     ignored. "frames" — Custom Subject Frames: each page's red frame decides
//     where (and how big) the subject goes; pages without one use "auto".
function populateDocument(doc, t, rec, subject, options) {
    const framesMode = !!(options && options.placementMode === "frames");
    const errors = [];
    const reports = [];
    const subline = sublineFor(rec, t.subType); // null = keep the template's subline text

    // Older prepared templates: the client's subline (recovered by
    // inspectTemplates) goes onto each headline frame BEFORE pages may be
    // removed, so it stays attached to the right page.
    if (t.recoveredSublines) {
        for (let p = 0; p < doc.pages.length; p++) {
            const text = t.recoveredSublines[p];
            const frame = text ? findHeadlineFrame(doc.pages.item(p)) : null;
            if (frame && !readOriginalSubline(frame)) {
                try { frame.insertLabel(ORIGINAL_SUBLINE_LABEL, text); } catch (e) {}
            }
        }
    }

    // Image frames per page before unbinding, so a lost frame is reported
    // instead of surfacing later as "no image".
    const framesBefore = [];
    for (let p = 0; p < doc.pages.length; p++) framesBefore.push(!!findImageFrame(doc.pages.item(p)));
    unbindImagePlaceholders(doc);
    for (let p = 0; p < doc.pages.length; p++) {
        if (framesBefore[p] && !findImageFrame(doc.pages.item(p))) {
            errors.push(`page ${p + 1}: ${FRAME_NAMES.image} frame disappeared when its Data Merge placeholder was unbound`);
        }
    }
    if (errors.length) return { plan: null, reports, errors };

    // Optional footer layout (any page with a <<Footer>> frame): not
    // applicable -> page removed, so the INDD holds exactly the exported layouts.
    if (!hasAddOn(rec)) {
        for (let p = doc.pages.length - 1; p >= 0; p--) {
            const page = doc.pages.item(p);
            const l = pageLayout(page, t.subType);
            if (l.position === "footer") {
                page.remove();
                reports.push(`${t.subType}_footer ${l.size} page removed (DANIS ADD ON empty)`);
            }
        }
    }

    const plan = planPages(doc, t.subType);
    if (plan.problems.length) return { plan, reports, errors: plan.problems };

    // Fill every page. Each page resolves its OWN frames — nothing is cached
    // or reused across pages.
    const productSubject = subject;
    for (const pg of plan.pages) {
        const page = doc.pages.item(pg.index);
        const where = `${pg.layout.key} ${pg.layout.size} (page ${pg.index + 1})`;
        // Capsule (capsule.js): a box edited for ONE layout replaces the
        // photo's box on that page only. Any other subject result has no
        // forLayout and is used unchanged, as before.
        subject = productSubject && typeof productSubject.forLayout === "function" ? productSubject.forLayout(pg.layout) : productSubject;
        if (subject !== productSubject) reports.push(`${where} subject: Capsule box adjusted for this layout only`);
        try {
            const textDiag = setHeadlineText(doc, findHeadlineFrame(page), rec.headline, subline);
            // No hyphenation; template size, or the largest size that fits.
            // Overset is flagged by validatePage(); a word broken across
            // lines (no overset) only here.
            const fit = fitHeadlineToFrame(findHeadlineFrame(page));
            const brokenWord = !fit.fits && !oversets(findHeadlineFrame(page));
            reports.push(`${brokenWord ? "WARNING " : ""}${where} text fit: ${fit.note}${brokenWord ? " (a word is broken across lines)" : ""}`);
            const footerFrame = findFooterFrame(page);
            const footerDiag = footerFrame ? setFooterText(doc, footerFrame, rec.danis_addon || "") : "";
            const imageFrame = findImageFrame(page);
            if (!imageFrame) throw new Error(`no ${FRAME_NAMES.image} frame`);
            // Text over the image (headline / footer): a subject is centred
            // outside it — outside the area the text actually uses.
            const textAreas = [findHeadlineFrame(page), footerFrame].filter(Boolean).map(textAvoidBounds);
            const avoid = textAreas.map((a) => a.bounds).filter(Boolean);
            // Red subject frame (read fresh from this page) — Custom Subject
            // Frames only. Used with a real subject box: a chosen one, or a
            // detected one that doesn't just cover the whole photo.
            const zone = framesMode ? (pg.descriptor && pg.descriptor.zone) : null;
            const usableBox = subject && subject.box && (subject.source === "chosen" || !subject.wholePhoto) ? subject.box : null;
            if (framesMode && !(pg.descriptor && pg.descriptor.zone)) {
                reports.push(`${where} subject: no red subject frame on this layout — Auto Placement used`);
            }
            if (zone && subject && subject.box && !usableBox) {
                reports.push(`WARNING ${where}: the detected subject covers the whole photo (busy image), so the red subject frame was not used — ` +
                    "position the image by hand in this INDD if needed, then Commit");
            } else if (zone && !(subject && subject.box)) {
                // Detection switched off / not configured: a note, not a Review
                // warning (else every product would land in Review). A failed
                // detection is a warning.
                const reason = subject && subject.reason ? String(subject.reason).replace(/,/g, ";") : "subject detection off";
                const off = !subject || /\b(off|disabled|not configured|missing)\b/i.test(reason);
                reports.push(`${off ? "" : "WARNING "}${where}: red subject frame not used — no subject found (${reason})`);
            }
            const placed = placeProductImage(imageFrame, rec.imagePath, pg.layout, usableBox || (subject && subject.box),
                avoid, zone && usableBox ? zone.bounds : null);
            for (const w of placed.warnings || []) reports.push(`WARNING ${where}: ${w}`);
            for (const n of placed.notes || []) reports.push(`${where} subject: ${n}`);
            pg.fitNote = placed.note + (textAreas.some((a) => a.trimmed) ? " [text area = its lines]" : "");
            pg.placement = placed;
            writePlacementLabel(imageFrame, placed);
            if (TEXT_DIAGNOSTICS) {
                reports.push(`${where} text: ${textDiag}${footerDiag ? " ### footer: " + footerDiag : ""}`);
            }
        } catch (e) {
            errors.push(`${where}: ${e}`);
        }
    }
    if (errors.length) return { plan, reports, errors };

    // The red subject frames are guides only: never in a product INDD / JPG.
    try {
        const zm = zoneModule();
        if (zm) {
            const z = zm.removeSubjectZones(doc);
            if (z.removed || z.hidden) reports.push(`red subject frame(s): ${z.removed} removed${z.hidden ? `, ${z.hidden} hidden` : ""}`);
        }
    } catch (e) {
        reports.push(`WARNING red subject frame could not be removed (${String(e).replace(/,/g, ";")}) — check the JPG`);
    }

    detachDataMerge(doc);

    // Validate every page of the finished document (fresh references again).
    for (const pg of plan.pages) {
        const v = validatePage(doc.pages.item(pg.index), pg.layout, rec, subline);
        reports.push(`page ${pg.index + 1} ${v.errors.length ? "INVALID" : "ok"}: ${v.report}`);
        for (const w of v.warnings) reports.push(`WARNING ${pg.layout.key} ${pg.layout.size} (page ${pg.index + 1}): ${w}`);
        for (const e of v.errors) errors.push(`${pg.layout.key} ${pg.layout.size} (page ${pg.index + 1}): ${e}`);
    }
    // Bindings this DOM can't remove are reported, not fatal: every page was
    // just validated to show the real image and text.
    const left = countPlaceholders(doc);
    if (left.text || left.image) {
        reports.push(`note: ${left.text} text / ${left.image} image Data Merge binding(s) could not be ` +
            "removed by this InDesign DOM — page content validated above");
    }

    return { plan, reports, errors };
}

// ---------- Image Extension (analysis during Generate) ----------

// Runs analyzeImageCoverage() on every planned page's Image frame. Each page
// resolves its own frame. Generate never calls Firefly and never changes
// the INDD for Image Extension — the designer decides per product (Extend
// Image in the panel). Cached generations of a plan are only looked up, so
// the panel can offer "Use existing extension".
// Returns { records: [...], warnings: ["WARNING page …: …"], summary }
// summary.status: "not_required" | "extension_available" | "needs_review" |
// "failed" (worst over all pages) — shown on the product in the panel.
async function checkDocumentImages(doc, plan, ctx, registry, outputRoot) {
    const records = [];
    const warnings = [];
    let ext;
    try {
        ext = imageExt();
    } catch (e) {
        return { records, warnings, summary: { status: "failed", text: "Image check unavailable: " + e.message } };
    }
    for (const pg of plan.pages) {
        const page = doc.pages.item(pg.index);
        // Image Extension gets the placement stage's decision as one neutral
        // flag + an opaque description for the logs — nothing it would
        // have to interpret.
        const placed = pg.placement || { mode: "unknown", allowExtension: false, policy: {} };
        const r = await ext.analyzeImageCoverage(findImageFrame(page), Object.assign({}, ctx, {
            page: pg.index + 1, layout: `${pg.layout.key} ${pg.layout.size}`,
            allowExtension: placed.allowExtension === true,
            placement: { policy: placed.policy.id, mode: placed.mode, anchor: placed.policy.anchor || "-" },
        }), registry);
        records.push(r);
    }
    // Existing generations of each plan (no Firefly call).
    for (const r of records) {
        if (r.status !== "extension_required" || !outputRoot) continue;
        try {
            const cached = await ext.latestValidGeneration(outputRoot, r.plan.id);
            if (cached) r.cachedVersion = cached.generationVersion;
        } catch (e) {}
    }
    for (const r of records) {
        try { console.log("[imageExtension] " + JSON.stringify(Object.assign({}, r, { snapshot: undefined }))); } catch (e) {}
        if (r.status !== "not_required") {
            warnings.push(`WARNING ${r.layout} (page ${r.page}): ${ext.describeCoverage(r)}`);
        }
    }
    const rank = { not_required: 0, extension_required: 1, needs_review: 2, failed: 3 };
    const worst = records.reduce((w, r) => (rank[r.status] > rank[w.status] ? r : w), { status: "not_required" });
    const toExtend = records.filter((r) => r.status === "extension_required");
    const plans = [];
    for (const r of toExtend) {
        if (!plans.some((p) => p.id === r.plan.id)) plans.push({ id: r.plan.id, cachedVersion: r.cachedVersion || null });
    }
    // Over the automatic limit only (soft limits): Extend Image stays
    // available by hand, after a warning in the panel.
    const review = records.filter((r) => r.status === "needs_review");
    const overridable = review.length > 0 && worst.status === "needs_review" && review.every((r) => r.overridable);
    const summary = {
        overridable,
        maxRatio: overridable ? Math.max(...review.map((r) => (r.plan && r.plan.ratio && r.plan.ratio.max) || 0)) : 0,
        status: worst.status === "extension_required" ? "extension_available" : worst.status,
        text: worst.status === "not_required" ? "Image covers its frame on every page"
            : worst.status === "extension_required"
                ? `Extension available — ${toExtend.length} page(s), ${plans.length} plan(s)` +
                    (plans.some((p) => p.cachedVersion) ? " · existing extension on disk" : "")
                : ext.describeCoverage(worst),
        pages: records.filter((r) => r.status !== "not_required").length,
        plans,
    };
    const report = records.map((r) => ext.formatCoverageReport(r)).join("\n\n");
    return { records, warnings, summary, report };
}

// ---------- main render loop ----------

// Creates root/seg1/seg2/… one level at a time; returns the last folder's path.
async function ensureFolders(root, segments) {
    let path = root.replace(/\/+$/, "");
    await ensureFolder(path);
    for (const seg of segments) {
        path += "/" + seg;
        await ensureFolder(path);
    }
    return path;
}

// Adds -2, -3… before the extension while `used` already holds the name.
function uniqueName(name, used) {
    let candidate = name;
    for (let n = 2; used.has(candidate.toLowerCase()); n++) {
        candidate = name.replace(/(\.[^.]+)$/, `-${n}$1`);
    }
    used.add(candidate.toLowerCase());
    return candidate;
}

// Opens each template once up front: checks it was prepared by datamerge.js,
// can be told apart as DANIS / Service (one template per type), and
// DISCOVERS its layouts (planPages). Only structural problems fail the run —
// there is no required set of layouts. Throws with every problem found,
// before anything is rendered.
async function inspectTemplates(templatePaths) {
    const templates = [];
    const problems = [];
    for (const path of templatePaths) {
        const name = basename(path);
        if (!(await pathExists(path))) { problems.push(`${name}: file not found`); continue; }
        let subType;
        try {
            subType = subTypeFromPath(path);
        } catch (e) {
            problems.push(`${name}: ${e.message}`);
            continue;
        }
        if (templates.some((t) => t.subType === subType)) {
            problems.push(`${name}: more than one ${typeFolder(subType)} template selected (one INDD per product and type)`);
            continue;
        }
        let doc = null;
        try {
            doc = await openTemplateCopy(path);
            usePoints(doc);
            const plan = planPages(doc, subType);
            for (const pr of plan.problems) problems.push(`${name}: ${pr}`);
            // Stale optional subline tokens without a stored original: recover
            // the client's text once per template (silently; null if not possible).
            const recoveredSublines = !plan.problems.length && needsSublineRecovery(doc)
                ? await recoverClientSublines(path, doc.pages.length) : null;
            if (!plan.problems.length) {
                templates.push({ path, name, subType, mapping: plan.mapping, notes: plan.notes, recoveredSublines,
                    detected: describeTemplateLayouts(plan),
                    layouts: plan.pages.map((pg) => ({ page: pg.index + 1, size: pg.layout.size, position: pg.layout.position, known: pg.layout.known })) });
            }
        } catch (e) {
            problems.push(`${name}: could not open (${e})`);
        } finally {
            closeWithoutSaving(doc);
            await settle(250);
        }
    }
    if (problems.length) {
        throw new Error(
            "Template check failed — select the <name>_DataMerge.indd files made by step 2 (Prepare):\n  " +
            problems.join("\n  ")
        );
    }
    return templates;
}

// ---------- run bookkeeping (log lines, counts, progress) ----------

function makeRun(totalOps, onProgress) {
    const run = {
        logLines: ["timestamp,headline,page_label,output_file,status,message"],
        failures: [],
        successCount: 0,
        errorCount: 0,
        done: 0,
        total: totalOps,
    };
    const csv = (v) => String(v == null ? "" : v).replace(/,/g, ";");
    run.line = (headline, label, outPath, status, message) => {
        run.logLines.push([new Date().toISOString(), csv(headline), csv(label), csv(outPath), status, csv(message)].join(","));
    };
    run.success = (headline, label, outPath, note) => {
        run.line(headline, label, outPath, "success", note || "");
        run.successCount++;
    };
    run.error = (headline, label, outPath, e) => {
        run.line(headline, label, outPath, "error", String(e));
        run.errorCount++;
        run.failures.push({ headline, label, message: String(e) });
    };
    run.tick = (message, n) => {
        run.done += n || 1;
        if (onProgress) onProgress(run.done, run.total, message);
    };
    run.result = (extra) => Object.assign({
        successCount: run.successCount, errorCount: run.errorCount,
        logLines: run.logLines, failures: run.failures,
    }, extra || {});
    return run;
}

// Where the product INDD for this template type lives:
// <root>/InDesign/<DANIS|Service>/<DANIS_Herbst|Service_Herbst>_<year>_<product>.indd
// (used to find INDDs generated in an earlier session or before a Reload).
// Returns { subType, inddPath }.
function inddPathFor(rec, templatePath, outputRootPath) {
    const subType = subTypeFromPath(templatePath);
    const inddPath = [outputRootPath.replace(/\/+$/, ""), "InDesign", typeFolder(subType),
        buildInddFileName(rec, subType)].join("/");
    return { subType, inddPath };
}

// ---------- Capsule subject source: status + Preview Placement ----------
//
// Capsule (capsule.js) only changes WHERE the subject box comes from; the
// placement below is the existing one. These helpers report Capsule status
// and let the editor preview the existing placement for an edited box.

// The Review warning for a photo without (valid) Capsule data, or "".
function capsuleMissingWarning(subject) {
    if (!subject || !subject.capsule || subject.box) return "";
    const why = subject.capsule.status === "stale"
        ? "the photo changed after its Capsule JSON was imported — re-import it, or keep the data for the changed photo"
        : "no Capsule JSON imported for this photo";
    return `WARNING Missing Detection Data: ${why} — the original default placement was used`;
}

// Capsule part of the product status (panel), or null.
function capsuleStatusRecord(subject) {
    const c = subject && subject.capsule;
    if (!c) return null;
    const edges = c.edges ? ["left", "top", "right", "bottom"].filter((k) => c.edges[k]) : [];
    return { status: c.status, boxSource: c.boxSource || "", focalSource: c.focalSource || "", file: c.file || "",
        importedAt: c.importedAt || "", edges, layoutEdits: c.layoutEdits || [], focalPoint: subject.focalPoint || null };
}

// PURE. The placement populateDocument + placeProductImage would make on one
// page for a subject result — computed with the SAME placement.js functions
// and the same decisions (red frame → extend → fill), without InDesign.
//   page: { layout, frameBounds, pageBounds, avoid, zone } (readPlacementGeometry)
//   subject: subject result (capsule.js) or null
//   pixelSize: { width, height } of the photo. placeImageInZone measures the
//     photo placed at 100% (pixels × 72 / ppi) and caps the scale at
//     ppi / 72 — the same as pixel size with a cap of 1.
//   framesMode: Custom Subject Frames
// Returns { kind: "zone"|"extend"|"fill", policyId, graphicBounds, subjectRect,
//           focal, stats, warnings, notes } (+ the page geometry).
function previewPlacementForPage(page, subject, pixelSize, framesMode) {
    const pl = placementModule();
    const s = subject && typeof subject.forLayout === "function" ? subject.forLayout(page.layout) : subject;
    const sourceSize = { width: pixelSize.width, height: pixelSize.height };
    const out = { layout: page.layout, frameBounds: page.frameBounds, pageBounds: page.pageBounds, avoid: page.avoid || [],
        zone: page.zone || null, kind: "fill", policyId: "", graphicBounds: null, subjectRect: null, focal: null,
        stats: {}, warnings: [], notes: [], boxSource: s && s.capsule ? s.capsule.boxSource : "" };
    const zone = framesMode ? page.zone : null;
    const usableBox = s && s.box && (s.source === "chosen" || !s.wholePhoto) ? s.box : null;
    const box = usableBox || (s && s.box) || null;
    if (framesMode && !page.zone) out.notes.push("no red subject frame on this layout — Auto Placement used");
    if (zone && s && s.box && !usableBox) out.warnings.push("the subject box covers the whole photo, so the red subject frame is not used");
    if (!(s && s.box)) out.warnings.push("no subject box — the original default placement is used");
    let policy = pl.getLayoutPolicy(page.layout);
    if (!policy.known) policy = pl.resolvePlacementPolicy(page.layout, page.frameBounds, sourceSize);
    out.policyId = policy.id;
    const finish = (graphicBounds) => {
        out.graphicBounds = graphicBounds;
        if (graphicBounds && box) {
            const [t, l, b, r] = graphicBounds, w = r - l, h = b - t;
            out.subjectRect = [t + box.y * h, l + box.x * w, t + (box.y + box.height) * h, l + (box.x + box.width) * w];
            if (s.focalPoint) out.focal = { y: t + s.focalPoint.y * h, x: l + s.focalPoint.x * w };
        }
        return out;
    };
    if (zone && usableBox) {
        const plan = pl.planZonePlacement({ frameBounds: page.frameBounds, zoneBounds: zone.bounds, sourceSize, subjectBounds: box, policy, maxScale: 1 });
        if (plan) {
            out.kind = "zone";
            out.stats = { scale: plan.scale, gaps: plan.gaps };
            out.warnings.push(...plan.warnings);
            out.notes.push(...plan.notes);
            return finish(plan.graphicBounds);
        }
        out.warnings.push("the red subject frame lies outside the image frame — normal placement used");
    }
    if (policy.placementMode === "extend") {
        const plan = pl.planImagePlacement({ frameBounds: page.frameBounds, sourceSize, policy, subjectBounds: box, avoidBounds: page.avoid || null });
        out.kind = "extend";
        const sh = plan.subjectShift;
        if (sh) out.stats = { frameFill: sh.frameFill, fill: sh.fill, zoom: sh.zoom, overText: sh.overText };
        if (sh && sh.overText) out.notes.push("the product overlaps the text area to reach its size (existing rule)");
        return finish(plan.graphicBounds);
    }
    out.notes.push("Fill layout: InDesign's Content-Aware Fit decides the crop (original behaviour) — no preview of the crop");
    return out;
}

// Page geometry for Preview Placement, read from fresh COPIES (nothing is
// changed or saved): the product INDD when it exists (real merged text),
// else the Template Set (its placeholder text — approximate). Red subject
// frames always come from the Template Set (product INDDs have them removed).
// Returns { source: "product"|"template", pages: [{ layout, layoutId, frameBounds, pageBounds, avoid, zone }] }.
async function readPlacementGeometry(productInddPath, templatePath) {
    const subType = subTypeFromPath(templatePath);
    const lid = (l) => [l.subType, l.size, l.position].map((v) => String(v || "").toLowerCase()).join("/");
    const readDoc = async (path) => {
        let doc = null;
        try {
            doc = await openTemplateCopy(path);
            usePoints(doc);
            const plan = planPages(doc, subType);
            const pages = [];
            for (const pg of plan.pages) {
                const page = doc.pages.item(pg.index);
                const frame = findImageFrame(page);
                if (!frame) continue;
                const avoid = [findHeadlineFrame(page), findFooterFrame(page)].filter(Boolean).map(textAvoidBounds).map((a) => a.bounds).filter(Boolean);
                pages.push({ layout: pg.layout, layoutId: lid(pg.layout), page: pg.index + 1,
                    frameBounds: Array.from(frame.geometricBounds, Number), pageBounds: Array.from(page.bounds, Number), avoid,
                    zone: pg.descriptor && pg.descriptor.zone ? { bounds: pg.descriptor.zone.bounds.slice() } : null });
            }
            return pages;
        } finally {
            closeWithoutSaving(doc);
            await settle(250);
        }
    };
    const templatePages = await readDoc(templatePath);
    if (productInddPath && await pathExists(productInddPath)) {
        try {
            const productPages = await readDoc(productInddPath);
            for (const p of productPages) {
                const t = templatePages.find((x) => x.layoutId === p.layoutId);
                p.zone = t ? t.zone : null;
            }
            if (productPages.length) return { source: "product", pages: productPages };
        } catch (e) {}
    }
    return { source: "template", pages: templatePages };
}

// ---------- generate the product INDDs (Generate All / Regenerate) ----------

// manifestRows: rows from matcher.js's buildManifest() — the whole batch
//   ("Generate All") or a single row ("Regenerate"); only "matched" rows are used
// templatePaths: absolute paths to the prepared <name>_DataMerge.indd files
// outputRootPath: the selected root folder; INDDs go to InDesign/<type>/ in it
// onProgress: optional callback(current, total, message)
// Returns: { successCount, errorCount, logLines, failures: [{headline, label, message}],
//            generated: [{rec, subType, inddPath, warnings: string[], image}],
//            failed: [{rec, subType, inddPath, error}],
//            imageChecks: [ Image Extension record per page — see imageextension.js ] }
//
// Per product and template, on ONE working copy: open a fresh copy of the
// template, populate every page (image, headline, subline, footer), detach
// Data Merge, validate every page, then save it as InDesign/<type>/<…>.indd —
// only if validation passed. No JPGs are exported here: they come from the
// saved INDDs via exportFromIndds() (Preview / Commit all), so any fixes made
// in the INDDs in between end up in the JPGs.
//
// Why images once went missing: the working copy still had its native
// @MainImage Data Merge placeholders bound to the image frames, and nothing
// checked the final document — an image placed into a still-bound
// placeholder frame could be lost before the INDD was saved. The
// placeholders are now unbound first, and every page is checked for a
// placed image before saving.
//   options.placementMode: "auto" | "frames" — see populateDocument(). With
//   "frames", a template that is open in InDesign with unsaved changes (the
//   designer just moved a red frame) is saved first, because Generate reads
//   the template from disk.
//   options.textColor: { swatches } — Auto Text Color with the selected palette swatches (optional)
//   options.subjectSource: "capsule" — subject boxes from the imported Capsule
//   JSON (capsule.js) instead of the backend API; the API is not called.
//   Placement itself is unchanged.
async function generateIndds(manifestRows, templatePaths, outputRootPath, onProgress, options) {
    if (!templatePaths || !templatePaths.length) {
        throw new Error("No templates — prepare the client template in step 2 first.");
    }
    const placementMode = options && options.placementMode === "frames" ? "frames" : "auto";
    const savedTemplates = [];
    if (placementMode === "frames") {
        for (const tp of templatePaths) {
            const open = findOpenTemplate(tp) || findOpenDocument(tp);
            let modified = false;
            try { modified = !!(open && open.modified); } catch (e) {}
            if (modified) {
                // Generate reads the template from disk: without this save the
                // moved red frames would be silently ignored — so stop instead.
                try { await saveWhenIdle(open); savedTemplates.push(basename(tp)); } catch (e) {
                    throw new Error(`Couldn't save your changes in ${basename(tp)} (${e}) — save the template yourself (Cmd+S), then generate again.`);
                }
            }
        }
    }
    const templates = await inspectTemplates(templatePaths);
    const root = outputRootPath.replace(/\/+$/, "");
    const inddFolder = {};
    for (const t of templates) inddFolder[t.subType] = await ensureFolders(root, ["InDesign", typeFolder(t.subType)]);

    const matchedRows = manifestRows.filter((r) => r.status === "matched");
    const run = makeRun(matchedRows.length * templates.length, onProgress);
    for (const t of templates) {
        run.line("", `${t.name} layouts`, "", "info", `${t.detected} — ${t.mapping}`);
        for (const n of t.notes) run.line("", `${t.name} layouts`, "", "info", n);
    }
    run.line("", "subject placement", "", "info", placementMode === "frames"
        ? "Custom Subject Frames (red frames in the template)" : "Auto Placement (centred, clear of the text)");
    for (const name of savedTemplates) run.line("", "subject placement", "", "info", `saved unsaved changes in ${name} first`);

    const generated = [];
    const failed = [];
    const imageChecks = [];
    const imageReports = [];
    // One registry per run: identical extension plans (same source, anchor,
    // expansion and working request) are shared — one Firefly call each.
    let planRegistry = null;
    try { planRegistry = imageExt().createPlanRegistry(); } catch (e) {}
    // Subject detection (bounding box → placement.js), once per photo. Off or
    // failing → no box → placement exactly as without it; never blocks Generate.
    let subjectDetector = null;
    // Capsule mode: subjects come ONLY from the imported Capsule JSON
    // (<output>/capsule_subjects.json). The backend API is never called —
    // a photo without data gets no box (Missing Detection Data, below).
    const capsuleSource = !!(options && options.subjectSource === "capsule");
    if (capsuleSource) {
        const cm = capsuleModule();
        let store = { items: {} };
        if (cm) {
            try { store = await cm.loadCapsuleStore(root); } catch (e) {}
            if (store.error) run.line("", "subject detection", store.path || "", "warning", store.error + " — every photo counts as Missing Detection Data");
        }
        subjectDetector = cm ? cm.createCapsuleDetector(store) : { enabled: true, hasChoices: false,
            detect: async () => ({ box: null, source: "capsule", reason: "capsule.js failed to load", capsule: { status: "missing" } }) };
        run.line("", "subject detection", "", "info", "Capsule JSON (capsule_subjects.json) — backend API not used");
    }
    if (!capsuleSource) try {
        const mod = subjectModule();
        if (mod) {
            const sc = await mod.loadSubjectConfig();
            // Objects the designer picked per photo (⋯ → Choose Subject),
            // stored in <output>/subject_choices.json.
            let choices = null;
            if (options && options.useChoices && typeof mod.loadSubjectChoices === "function") {
                try { choices = await mod.loadSubjectChoices(root); } catch (e) {}
            }
            subjectDetector = mod.createSubjectDetector(sc.config, sc.reason, choices);
        }
    } catch (e) {}
    const usedIndd = new Set();
    for (const rec of matchedRows) {
        const headline = rec.headline;
        let subject = null;
        if (subjectDetector && (subjectDetector.enabled || subjectDetector.hasChoices) && rec.imagePath) {
            subject = await subjectDetector.detect(rec.imagePath);
            run.line(headline, "subject", rec.imagePath, "info", subject.box
                ? `subject box x ${subject.box.x} y ${subject.box.y} w ${subject.box.width} h ${subject.box.height} (${subject.source}` +
                    (subject.labels && subject.labels.length ? `: ${subject.labels.join(" + ")}` : "") +
                    (subject.seconds != null ? `, ${subject.seconds}s` : "") + (subject.wholePhoto ? ", whole photo" : "") + ")" +
                    (subject.focalPoint ? ` focal point x ${subject.focalPoint.x} y ${subject.focalPoint.y} (metadata — not used by placement)` : "") +
                    (subject.capsule && subject.capsule.layoutEdits && subject.capsule.layoutEdits.length ? `; layout edits: ${subject.capsule.layoutEdits.join(" ")}` : "")
                : `no subject box — placement without it (${subject.reason})`);
        }
        for (const t of templates) {
            const inddName = uniqueName(buildInddFileName(rec, t.subType), usedIndd);
            const inddPath = inddFolder[t.subType] + "/" + inddName;
            const label = `${t.name} indd`;
            const fail = (e) => {
                run.error(headline, label, inddPath, e);
                failed.push({ rec, subType: t.subType, inddPath, error: String((e && e.message) || e) });
            };
            if (templatePaths.some((tp) => samePath(tp, inddPath))) {
                fail(new Error("Refusing to overwrite template: " + inddPath));
                run.tick(`${headline} — ${t.name} (skipped)`);
                continue;
            }
            // A product INDD the user has open (e.g. from a previous run)
            // can't be overwritten while open.
            if (findOpenDocument(inddPath)) {
                fail(new Error("this INDD is open in InDesign — close it, then generate again"));
                run.tick(`${headline} — ${inddName} (open)`);
                continue;
            }

            let doc = null;
            try {
                try {
                    doc = await openTemplateCopy(t.path);
                } catch (e) {
                    throw new Error("Could not open template: " + e);
                }
                usePoints(doc);
                unlockAll(doc);

                const result = populateDocument(doc, t, rec, subject, { placementMode });
                for (const r of result.reports) run.line(headline, `${t.name} check`, "", "info", r);
                if (result.errors.length) {
                    throw new Error("not saved — " + result.errors.join(" / "));
                }
                // Image Extension analysis: does each page's image cover its
                // frame? Never fails the product and never calls Firefly:
                // problems become Review warnings, extension is the
                // designer's choice per product (Extend Image).
                const image = await checkDocumentImages(doc, result.plan, { product: headline, indd: inddPath }, planRegistry, root);
                imageChecks.push(...image.records);
                if (image.report) imageReports.push(image.report);
                for (const r of image.records) run.line(headline, `${t.name} image`, "", "info", JSON.stringify(r));
                // Auto Text Color — AFTER the image-extension step: only pages
                // whose image already covers its frame; every other page (also
                // over the automatic limit) keeps the template colour until
                // Extend has run.
                let textColor = null;
                const tcSwatches = options && options.textColor && options.textColor.swatches;
                if (tcSwatches && tcSwatches.length) {
                    const waitForExtension = pagesAwaitingExtension(image.records);
                    const tc = await autoTextColorForDocument(doc, result.plan, tcSwatches, { waitForExtension });
                    for (const r of tc) run.line(headline, `${t.name} text colour`, "", "info", textColorLogLine(r));
                    textColor = summarizeTextColors(tc);
                    // Below the readability threshold: applied, but Review.
                    result.reports.push(...textColorWarnings(tc));
                }
                // Capsule mode without (valid) data for this photo: placed the
                // original default way, but the product goes to Review.
                const missingDetection = capsuleMissingWarning(subject);
                if (missingDetection) result.reports.push(missingDetection);
                await saveWhenIdle(doc, inddPath);
                const warnings = result.reports.filter((r) => /^WARNING /.test(r)).concat(image.warnings);
                run.success(headline, label, inddPath, "populated + validated" +
                    (warnings.length ? ` (${warnings.length} warning(s))` : ""));
                generated.push({ rec, subType: t.subType, inddPath, warnings, image: image.summary, textColor,
                    // for the panel's status line only (Subject ✓ Detected / — Default placement)
                    // (also without detection in frames mode, so "red frame not used" shows)
                    subject: subject || placementMode === "frames" ? { detected: !!(subject && subject.box),
                        reason: subject && subject.box ? "" : ((subject && subject.reason) || "subject detection off"),
                        source: (subject && subject.source) || "", chosen: !!(subject && subject.source === "chosen"), labels: (subject && subject.labels) || [],
                        wholePhoto: !!(subject && subject.box && subject.wholePhoto && subject.source !== "chosen"),
                        mode: placementMode,
                        capsule: capsuleStatusRecord(subject),
                        inFrame: result.plan ? result.plan.pages.filter((pg) => pg.placement && pg.placement.zone).length : 0,
                        zones: placementMode === "frames" && result.plan ? result.plan.pages.filter((pg) => pg.descriptor && pg.descriptor.zone).length : 0 } : null });
            } catch (e) {
                // Nothing saved for this product + template.
                fail(e);
            } finally {
                closeWithoutSaving(doc);
                await settle(250);
            }
            run.tick(`${headline} — ${inddName}`);
        }
    }
    let imagePlanSummary = null;
    let planText = "";
    try {
        imagePlanSummary = imageExt().summarizeExtensionPlans(imageChecks);
        planText = imageExt().formatPlanSummary(imagePlanSummary);
    } catch (e) {}
    const divider = "\n\n" + "-".repeat(60) + "\n\n";
    return run.result({
        generated, failed, imageChecks, imagePlanSummary,
        templates: templates.map((t) => ({ name: t.name, subType: t.subType, detected: t.detected, layouts: t.layouts, notes: t.notes })),
        imageReport: ["EXTENSION PLANS PER PRODUCT", planText, "PER PAGE"].concat(imageReports).join(divider),
    });
}

// ---------- export JPGs from the product INDDs (Preview / Commit) ----------

// Native path of an open document (fullName comes back as a string or a
// File-like object depending on the DOM build). "" for an unsaved document.
function documentPath(doc) {
    try {
        const f = doc.fullName;
        const p = typeof f === "string" ? f : (f && (f.nativePath || f.fsName)) || "";
        return String(p).replace(/^file:(\/\/)?/, "");
    } catch (e) {
        return "";
    }
}

// The open document saved at `path`, or null.
function findOpenDocument(path) {
    const { app } = indesign();
    try {
        for (let i = 0; i < app.documents.length; i++) {
            const doc = app.documents.item(i);
            if (samePath(documentPath(doc), path)) return doc;
        }
    } catch (e) {}
    return null;
}

// True if the product INDD at `path` is open in InDesign.
function isInddOpen(path) {
    return !!findOpenDocument(path);
}

// Closes an open product INDD WITHOUT saving (Regenerate after the user
// confirmed that manual edits will be discarded). No-op if it isn't open.
async function closeIndd(path) {
    const doc = findOpenDocument(path);
    if (!doc) return;
    closeWithoutSaving(doc);
    await settle(250);
}

// Path of InDesign's active (front) document, or "" — lets the panel show
// the actions of the product INDD the designer is working in.
function activeDocumentPath() {
    try {
        const { app } = indesign();
        if (!app || !app.documents.length) return "";
        return documentPath(app.activeDocument);
    } catch (e) {
        return "";
    }
}

// Opens a product INDD in InDesign (with a window), or brings it to the
// front if it's already open. Returns the document's name.
async function openIndd(path) {
    const { app } = indesign();
    if (!(await pathExists(path))) throw new Error("INDD not found: " + path);
    const open = findOpenDocument(path);
    if (open) {
        try { app.activeDocument = open; } catch (e) {}
        return open.name;
    }
    return app.open(path, true).name;
}

// What would make this page's JPG wrong: an empty image frame, an image
// that doesn't cover its frame (original Image + any extendImage frames),
// or text that doesn't fit its frame. Text is NOT compared with the Excel
// here — it may have been edited on purpose in the INDD.
//   imageStates: optional array — receives this page's coverage state
//                ({ state, extension, … } from checkExtendedCoverage)
function pageWarnings(page, imageStates) {
    const warnings = [];
    const imageFrame = findImageFrame(page);
    if (!imageFrame || graphicInfo(imageFrame).count < 1) {
        warnings.push("MainImage frame is empty");
    } else {
        // Image Extension (geometry only): coverage by the original image
        // PLUS the generated extension frames on extendImage. An image moved
        // by hand during review is caught here too.
        try {
            const ext = imageExt();
            const c = ext.checkExtendedCoverage(page, imageFrame);
            if (imageStates) imageStates.push(c);
            if (c.state === "underfilled" && !c.extension) {
                const found = ext.getPlacedGraphic(imageFrame);
                const d = ext.detectImageUnderfill(imageFrame.geometricBounds, found.graphic.geometricBounds);
                const where = Object.keys(d.missing).filter((k) => d.missing[k] > 0)
                    .map((k) => `${k} ${d.missing[k]} pt`).join(", ");
                warnings.push(`image doesn't cover its frame (${where})`);
            } else if (c.state === "underfilled") {
                warnings.push("image + extension don't cover its frame — re-extend");
            } else if (c.state === "extension_hidden") {
                warnings.push("image extension is hidden (extendImage layer off) — the JPG would show the uncovered strip");
            } else if (c.state === "misaligned") {
                warnings.push("image extension doesn't line up: " + c.text);
            }
        } catch (e) {}
    }
    const headlineFrame = findHeadlineFrame(page);
    if (headlineFrame && oversets(headlineFrame)) warnings.push("headline/subline doesn't fit its frame");
    // Auto Text Color below the readability threshold (stored at Generate /
    // Extend) stays a warning until the text is regenerated or recoloured.
    if (headlineFrame) {
        try { warnings.push(...lowContrastWarnings(JSON.parse(headlineFrame.extractLabel(TEXT_COLOR_LABEL) || "null"))); } catch (e) {}
    }
    const footerFrame = findFooterFrame(page);
    if (footerFrame && oversets(footerFrame)) warnings.push("footer doesn't fit its frame");
    return warnings;
}

// Product-level Image status from the pages' coverage states (worst wins):
//   misaligned → needs_review · underfilled → extension_available ·
//   extension_hidden → extension_hidden · extended → extended ·
//   covered → not_required. The panel keeps its own flavour of "extended"
//   (cached / re-extended) from the action that applied it.
function summarizeImageStates(states) {
    const count = (fn) => states.filter(fn).length;
    const ext = states.find((c) => c.extension);
    const extension = ext ? ext.extension : null;
    const notExtended = count((c) => c.state === "underfilled" && !c.extension);
    const short = count((c) => c.state === "underfilled" && c.extension);
    const rest = notExtended ? ` · ${notExtended} page(s) not extended yet` : "";
    if (count((c) => c.state === "misaligned")) {
        return { status: "needs_review", text: states.find((c) => c.state === "misaligned").text, extension };
    }
    // Hidden is reported first: it's a deliberate, reversible state the
    // designer must notice before Commit.
    if (count((c) => c.state === "extension_hidden")) return { status: "extension_hidden", text: "Extension hidden" + rest, extension };
    if (short) return { status: "extension_available", text: `Image + extension don't cover the frame on ${short} page(s) — re-extend` + rest, extension };
    if (notExtended) {
        return { status: "extension_available", extension,
            text: extension ? `Extended on ${count((c) => c.state === "extended")} page(s)` + rest + " — Extend Image"
                : "Image doesn't cover its frame — extension available" };
    }
    if (count((c) => c.state === "extended")) return { status: "extended", text: "Extended", extension };
    return { status: "not_required", text: "Image covers its frame on every page", extension: null };
}

// Preview JPGs of one product: <root>/preview/<DANIS|Service>/<product>/
// (same folder every time, so previewing again overwrites the old preview).
function previewFolderFor(root, rec, subType) {
    return ensureFolders(root, ["preview", typeFolder(subType), productToken(rec.headline)]);
}

// The production folder of a template type: <root>/output/<DANIS|Service>.
function outputFolderFor(outputRootPath, subType) {
    return [outputRootPath.replace(/\/+$/, ""), "output", typeFolder(subType)].join("/");
}

// items: [{rec, subType, inddPath}] — ONE product (row Preview / Commit) or
//   many ("Commit All Ready"); same code path either way
// outputRootPath: the selected root folder
// onProgress: optional callback(current, total, message)
// options.preview: true  -> low-res JPGs into preview/<type>/<product>/ — for
//                           looking only; output/ untouched, nothing saved
//                  false -> final JPGs into output/<type>/<WxH>/ (Commit)
// options.skipIfWarnings: true -> check every page first and do nothing for a
//   product with warnings (it becomes "Review" instead — never commit or
//   export a problem file silently)
// options.checkOnly: true -> "Commit": save unsaved edits of an open INDD and
//   check every page, but export NO JPGs (outcome.committed)
// Returns: { successCount, errorCount, logLines, failures,
//            items: [{inddPath, exported, committed, warnings: string[], error, folder}] }
//
// Exports from the INDD as it is now: an INDD the user has open is exported
// including their edits — on Commit it's saved first, so INDD and JPGs stay
// identical — and left open; an INDD that isn't open is opened without a
// window and closed again. Pages are re-classified from the INDD itself
// (planPages discovers them), so an INDD without a footer page yields no footer JPG.
async function exportFromIndds(items, outputRootPath, onProgress, options) {
    const preview = !!(options && options.preview);
    const skipIfWarnings = !!(options && options.skipIfWarnings);
    const checkOnly = !!(options && options.checkOnly);
    const root = outputRootPath.replace(/\/+$/, "");
    const run = makeRun(items.length, onProgress);
    const usedJpg = new Set();
    const outcomes = [];

    for (const item of items) {
        const { rec, subType, inddPath } = item;
        const headline = rec.headline;
        const label = basename(inddPath);
        const outcome = { inddPath, exported: false, committed: false, warnings: [], error: "", folder: "", image: null };
        outcomes.push(outcome);
        let doc = null;
        let openedHere = false;
        try {
            if (!(await pathExists(inddPath))) throw new Error("INDD not found — generate it first");
            doc = findOpenDocument(inddPath);
            if (!doc) {
                doc = indesign().app.open(inddPath, false);
                openedHere = true;
            }
            usePoints(doc);

            const plan = planPages(doc, subType);
            if (plan.problems.length) throw new Error("INDD structure problem: " + plan.problems.join(" / "));

            // Check every page before exporting anything.
            const imageStates = [];
            for (const pg of plan.pages) {
                for (const w of pageWarnings(doc.pages.item(pg.index), imageStates)) {
                    outcome.warnings.push(`${pg.layout.key} ${pg.layout.size}: ${w}`);
                }
            }
            outcome.image = summarizeImageStates(imageStates);
            if (skipIfWarnings && outcome.warnings.length) {
                run.line(headline, label, inddPath, "skipped", "needs review — " + outcome.warnings.join(" / "));
                run.tick(`${headline} — needs review (skipped)`);
                continue;
            }

            if (!preview && !openedHere && doc.modified) {
                await saveWhenIdle(doc);
                run.line(headline, label, inddPath, "info", "open INDD had unsaved edits — saved");
            }
            if (checkOnly) {
                outcome.committed = true;
                run.success(headline, label, inddPath, "saved + checked" +
                    (outcome.warnings.length ? " — WARNING: " + outcome.warnings.join(" / ") : ""));
                run.tick(`${headline} — ${label}`);
                continue;
            }
            outcome.folder = preview ? await previewFolderFor(root, rec, subType) : outputFolderFor(root, subType);

            let pageErrors = 0;
            for (const pg of plan.pages) {
                const page = doc.pages.item(pg.index);
                const pageLabel = `${label} ${pg.layout.key} ${pg.layout.size}`;
                let outPath = "";
                try {
                    const dir = preview
                        ? outcome.folder
                        : await ensureFolders(root, ["output", typeFolder(subType), pg.layout.size]);
                    outPath = dir + "/" + uniqueName(buildOutputFileName(rec, pg.layout), usedJpg);
                    exportPageAsJPEG(doc, page, outPath, preview ? PREVIEW_RESOLUTION : FINAL_RESOLUTION);
                    const notes = pageWarnings(page).map((w) => "WARNING: " + w);
                    run.success(headline, pageLabel, outPath, notes.join(" / "));
                } catch (e) {
                    pageErrors++;
                    run.error(headline, pageLabel, outPath, e);
                }
            }
            outcome.exported = pageErrors === 0;
            if (pageErrors) outcome.error = `${pageErrors} page(s) failed to export`;
        } catch (e) {
            outcome.error = String((e && e.message) || e);
            run.error(headline, label, inddPath, e);
        } finally {
            if (openedHere) {
                closeWithoutSaving(doc);
                await settle(250);
            }
        }
        run.tick(`${headline} — ${label}`);
    }
    return run.result({ items: outcomes });
}

// ---------- Image Extension: Extend / Re-extend / Show / Hide (panel) ----------

// Opens a product INDD WITH a window (the designer compares the result in
// InDesign) or brings it to the front. Returns the document.
async function openForExtension(inddPath) {
    const { app } = indesign();
    if (!(await pathExists(inddPath))) throw new Error("INDD not found — generate it first");
    let doc = findOpenDocument(inddPath);
    if (doc) {
        try { app.activeDocument = doc; } catch (e) {}
    } else {
        doc = app.open(inddPath, true);
    }
    usePoints(doc);
    return doc;
}

// Every page's warnings + coverage state of an open product document.
function checkProductPages(doc, plan) {
    const warnings = [];
    const states = [];
    for (const pg of plan.pages) {
        for (const w of pageWarnings(doc.pages.item(pg.index), states)) warnings.push(`${pg.layout.key} ${pg.layout.size}: ${w}`);
    }
    return { warnings, image: summarizeImageStates(states), states };
}

// Phase 3 + 4 for ONE product INDD, started by the designer in the panel.
//   item: { rec, subType, inddPath }
//   mode: "extend"       — Extend image: NEW Firefly generation(s)
//         "regenerate"   — Re-extend image: NEW Firefly generation(s) — a new
//                          batch version
//         "use_existing" — Use existing extension: stored versions only, no Firefly
// Batch mode (CONFIG.batchMode / backend.config.json "batchMode"):
//   "consistent" (default) — ONE master generation for the product batch;
//     every eligible page clips its strip from that same result. More than
//     one master only when one is impossible (groupIntoMasterPlans).
//   "independent" — one generation per page (deliberate API testing).
// Stored versions are never reused automatically — only via "Use existing".
// Bounded: generations happen only on a click, at most one per unit.
// The ORIGINAL Image frames are only read. Generated content goes into
// extension-only frames on the `extendImage` layer. The INDD is saved and
// left open.
//   options.prompt: optional designer text sent with every NEW generation
// Returns { pages, generations, warnings, image, newGenerations, prompt, logLines }.
//   options.background: open the INDD without a window and close it again
//     after saving, if it wasn't open already (Extend All Images)
async function extendProductImage(item, outputRootPath, mode, onProgress, options) {
    const background = !!(options && options.background);
    const wasOpen = !!findOpenDocument(item.inddPath);
    let doc;
    if (background && !wasOpen) {
        if (!(await pathExists(item.inddPath))) throw new Error("INDD not found — generate it first");
        doc = indesign().app.open(item.inddPath, false);
        usePoints(doc);
    } else {
        doc = await openForExtension(item.inddPath);
    }
    try {
        return await extendOpenProduct(doc, item, outputRootPath, mode, onProgress, options);
    } finally {
        if (background && !wasOpen) {
            closeWithoutSaving(doc); // saved already when anything was applied
            await settle(250);
        }
    }
}

async function extendOpenProduct(doc, item, outputRootPath, mode, onProgress, options) {
    const prompt = mode === "use_existing" ? "" : String((options && options.prompt) || "").trim().slice(0, 1024);
    const ext = imageExt();
    const id = indesign();
    const root = outputRootPath.replace(/\/+$/, "");
    const headline = item.rec.headline;
    let cfg = null;
    const backend = await ext.loadBackendConfig();
    if (mode !== "use_existing") {
        if (!backend.config) throw new Error(backend.reason);
        cfg = backend.config;
    }
    const plan = planPages(doc, item.subType);
    if (plan.problems.length) throw new Error("INDD structure problem: " + plan.problems.join(" / "));

    // 1. Analysis from the FINAL placed geometry, page by page.
    const registry = ext.createPlanRegistry();
    const pages = [];
    for (const pg of plan.pages) {
        const page = doc.pages.item(pg.index);
        const frame = findImageFrame(page);
        const placed = frame ? readPlacement(frame, pg.layout) : { allowExtension: false };
        const r = await ext.analyzeImageCoverage(frame, {
            product: headline, indd: item.inddPath, page: pg.index + 1, layout: `${pg.layout.key} ${pg.layout.size}`,
            allowExtension: placed.allowExtension === true,
            placement: { policy: placed.policy, mode: placed.mode, anchor: placed.anchor || "-" },
        }, registry);
        pages.push({ pg, record: r, plan: null, meta: null, cacheHit: false, applied: null, error: "" });
    }

    // 2. Generation units (one Firefly generation — or one stored version — each):
    //    consistent batch (default): ONE master plan for all eligible pages of
    //      this product, split only when a shared master is impossible;
    //    independent: one unit per page.
    const batchMode = (backend.config && backend.config.batchMode) || ext.CONFIG.batchMode;
    // allowLarge (a manual Extend after the panel's warning): pages that are
    // only over the soft limits (extension ratio / resolution) are extended too.
    const allowLarge = !!(options && options.allowLarge);
    const todo = pages.filter((p) => p.record.status === "extension_required" ||
        (allowLarge && p.record.status === "needs_review" && p.record.overridable && p.record.plan));
    for (const p of todo) p.plan = registry.get(p.record.plan.key).plan;
    let eligible = todo;
    if (cfg && cfg.onlyPlanId) {
        // Test limiter: only pages whose own plan is onlyPlanId take part.
        for (const p of todo) if (p.plan.id !== cfg.onlyPlanId) p.error = `skipped — test limit onlyPlanId = ${cfg.onlyPlanId}`;
        eligible = todo.filter((p) => !p.error);
    }
    // Readable names for the stored generations — the SAME naming as the
    // normal output (buildOutputFileName / buildInddFileName, productToken,
    // uniqueName): one page → "<JPG name>_extended"; a master shared by
    // several pages → "<product INDD name>_extension_master".
    const rec = item.rec;
    const usedNames = new Set();
    const unique = (base) => uniqueName(base + ".x", usedNames).replace(/\.x$/, "");
    const pageInfo = (p) => ({ layout: p.record.layout, page: p.record.page, size: p.pg.layout.size,
        width: p.pg.layout.w, height: p.pg.layout.h, variant: p.pg.layout.position, planId: p.plan.id });
    const naming = { templateType: item.subType, prefix: typeInfo(item.subType).prefix, year: rec.year, product: headline };
    const usedForPages = (pages) => {
        if (pages.length === 1) {
            const pi = pageInfo(pages[0]);
            return Object.assign({}, naming, {
                layout: pi.layout, page: pi.page, width: pi.width, height: pi.height, variant: pi.variant, pages: [pi],
                baseName: unique(buildOutputFileName(rec, pages[0].pg.layout).replace(/\.jpg$/i, "") + "_extended"),
            });
        }
        return Object.assign({}, naming, {
            layout: "batch", layouts: pages.map((p) => p.record.layout), pagePlans: pages.map((p) => p.plan.id), pages: pages.map(pageInfo),
            baseName: unique(buildInddFileName(rec, item.subType).replace(/\.indd$/i, "") + "_extension_master"),
        });
    };
    let units;
    if (batchMode === "independent") {
        units = eligible.map((p) => ({ plan: p.plan, pages: [p], usedFor: usedForPages([p]) }));
    } else {
        units = ext.groupIntoMasterPlans(eligible.map((p) => ({ plan: p.plan, graphicBounds: p.record.graphicBounds, ref: p })), { allowLarge })
            .map((g) => {
                const pages = g.pages.map((x) => x.ref);
                return { plan: g.master, pages, usedFor: usedForPages(pages) };
            });
    }
    let newGenerations = 0;
    let done = 0;
    for (const u of units) {
        const label = u.pages.length > 1 ? `${u.pages.length} pages` : u.pages[0].record.layout;
        if (onProgress) onProgress(done, units.length, `${headline} — ${label}`);
        let meta = null, cacheHit = false, error = "";
        try {
            if (cfg && cfg.maxPlansPerRun !== null && cfg.maxPlansPerRun !== undefined && newGenerations >= cfg.maxPlansPerRun) {
                throw new Error(`skipped — test limit maxPlansPerRun = ${cfg.maxPlansPerRun}`);
            }
            if (mode !== "use_existing") newGenerations++;
            const snapshots = {};
            for (const p of u.pages) snapshots[p.record.layout] = p.record.snapshot;
            const got = await ext.obtainExtension(cfg, root, u.plan, snapshots, mode, u.usedFor, { prompt });
            meta = got.meta;
            cacheHit = got.cacheHit;
        } catch (e) {
            error = String((e && e.message) || e);
        }
        for (const p of u.pages) { p.unitPlan = u.plan; p.meta = meta; p.cacheHit = cacheHit; p.error = error; }
        done++;
        if (onProgress) onProgress(done, units.length, `${headline} — ${label}`);
    }

    // Use existing: a page whose unit has no stored version of exactly that
    // plan falls back to any stored generation that can serve it (metadata:
    // same source, enough extension and resolution) — no Firefly.
    if (mode === "use_existing") {
        for (const p of todo) {
            if (p.meta || !/no existing extension/.test(p.error || "")) continue;
            try {
                const g = await ext.applicableGenerationFor(root, p.plan, p.record.graphicBounds, { product: headline, layout: p.record.layout });
                if (g) { p.meta = g; p.cacheHit = true; p.error = ""; }
            } catch (e) {}
        }
    }

    // 3. Each page clips ITS strip from its unit's (master) result on extendImage.
    for (const p of todo) {
        if (!p.meta) continue;
        try {
            const page = doc.pages.item(p.pg.index);
            p.applied = ext.applyExtensionToPage(doc, page, findImageFrame(page), p.record, p.meta, p.cacheHit, id);
            p.applied.cacheHit = p.cacheHit;
        } catch (e) {
            p.error = String((e && e.message) || e);
        }
    }

    // 4. Re-validate the whole product (original + extension), then save.
    let check = checkProductPages(doc, plan);
    const appliedAny = pages.some((p) => p.applied);
    // Auto Text Color on the new final composition — the step after Image
    // Extension for the pages that waited at Generate. A page that is still
    // not covered (its extension failed / wasn't possible) keeps waiting.
    let textColor = null;
    const tcSwatches = options && options.textColor && options.textColor.swatches;
    if (appliedAny && tcSwatches && tcSwatches.length) {
        const waitForExtension = pagesAwaitingExtension(pages.filter((p) => !p.applied).map((p) => p.record));
        try { textColor = summarizeTextColors(await autoTextColorForDocument(doc, plan, tcSwatches, { waitForExtension })); } catch (e) {}
        // The new colours (and any low-contrast warning) are part of the check.
        if (textColor) check = checkProductPages(doc, plan);
    }
    if (appliedAny) await saveWhenIdle(doc);

    const image = check.image;
    if (image.status === "extended") {
        image.status = mode === "regenerate" ? "re_extended" : mode === "use_existing" ? "extended_cached" : "extended";
        image.text = { re_extended: "Re-extended", extended_cached: "Extended (existing)", extended: "Extended" }[image.status];
    }
    const failed = todo.filter((p) => p.error);
    if (failed.length && image.status === "extension_available") {
        image.text += ` (${failed.length} page(s) not extended — see the message / image_extension_apply_log.jsonl)`;
    }
    image.versions = todo.filter((p) => p.applied).map((p) => ({ layout: p.record.layout, planId: p.meta.planId, version: p.meta.generationVersion, cacheHit: p.cacheHit }));
    image.plans = [];
    for (const p of todo) {
        if (!image.plans.some((x) => x.id === p.plan.id)) image.plans.push({ id: p.plan.id, cachedVersion: p.meta ? p.meta.generationVersion : null });
    }

    const logLines = pages.map((p) => JSON.stringify({
        product: headline, layout: p.record.layout, page: p.record.page, status: p.record.status, mode, prompt,
        plan: p.record.plan ? p.record.plan.id : null, generationPlan: p.meta ? p.meta.planId : null, batchMode, missing: p.record.missing,
        version: p.meta ? p.meta.generationVersion : null, fireflyJobId: p.meta ? p.meta.fireflyJobId : null,
        originalWorkingTarget: p.meta ? (p.meta.originalWorkingTarget || p.meta.fullResolutionTarget || null) : null,
        fireflyWorkingTarget: p.meta ? p.meta.target : null, workingScale: p.meta ? p.meta.workingScale : null,
        cacheHit: p.cacheHit, applied: p.applied, error: p.error || "",
    }));
    return {
        pages: pages.map((p) => ({ layout: p.record.layout, status: p.record.status, applied: p.applied, error: p.error })),
        generations: todo.map((p) => ({ layout: p.record.layout, planId: p.plan.id, generationPlan: p.meta ? p.meta.planId : null,
            version: p.meta ? p.meta.generationVersion : null,
            jobId: p.meta ? p.meta.fireflyJobId : null, cacheHit: p.cacheHit, asset: p.meta ? p.meta.generatedAssetPath : null, error: p.error })),
        units: units.map((u) => ({ planId: u.plan.id, kind: u.plan.kind || "page", pages: u.pages.map((p) => p.record.layout), name: u.usedFor.baseName,
            asset: u.pages[0].meta ? u.pages[0].meta.generatedAssetPath : null,
            expansionPixels: u.plan.expansionPixels, working: u.plan.working, version: u.pages[0].meta ? u.pages[0].meta.generationVersion : null,
            jobId: u.pages[0].meta ? u.pages[0].meta.fireflyJobId : null, error: u.pages[0].error })),
        batchMode, warnings: check.warnings, image, newGenerations, prompt, saved: appliedAny, logLines, textColor,
    };
}

// Show / Hide Extension: toggles the INDD's extendImage layer so the
// designer can compare the untouched original layout with the extended one.
// Saved only if the document had no other unsaved edits (so the panel's
// status matches the file); otherwise left for Commit to save.
// Returns { warnings, image, saved }.
async function setExtensionVisible(item, visible) {
    const ext = imageExt();
    const doc = await openForExtension(item.inddPath);
    let wasModified = true;
    try { wasModified = !!doc.modified; } catch (e) {}
    if (!ext.setExtendLayerVisible(doc, visible)) throw new Error("this INDD has no extendImage layer — extend the image first");
    const plan = planPages(doc, item.subType);
    const check = checkProductPages(doc, plan);
    let saved = false;
    if (!wasModified) { await saveWhenIdle(doc); saved = true; }
    return { warnings: check.warnings, image: check.image, saved };
}

// ---------- Auto Text Color (colorpalette.js + textcolor.js) ----------
//
// On the FINAL composition of each page (after placement and, later, after
// Image Extension): the Headline/Subline frame is hidden for a moment, the
// page is exported at low resolution to a temp JPG (image, Firefly
// extension, shadow/gradient and template artwork — exactly what the reader
// sees behind the text), the frame is shown again, and the area behind the
// actual text lines is measured. Of the designer's SELECTED palette swatches
// the one with the best readable contrast is applied to the Headline/Subline
// — per page, so layouts can differ. No Photoshop call.
// Never blocks: no palette / no selection / any failure → the template's own
// text colour stays and everything else carries on. Fully automatic: the
// only choice is which swatches are allowed (Step 1).

const TEXT_COLOR_LABEL = "posterBatch.textColor";
const TEXT_COLOR_RESOLUTION = 36; // dpi of the analysis render

let _textColorMods = null;
function textColorModules() {
    if (_textColorMods) return _textColorMods;
    const load = (name, check) => {
        for (const path of ["./" + name, "./js/" + name]) {
            try { const m = require(path); if (m && typeof m[check] === "function") return m; } catch (e) {}
        }
        return null;
    };
    const palette = load("colorpalette.js", "parseASE");
    const color = load("textcolor.js", "chooseTextColor");
    return (_textColorMods = palette && color ? { palette, color } : null);
}

// The glyph boxes ([t, l, b, r], page units) of the frame's VISIBLE lines that
// belong to story paragraph `paraIndex` — the area the reader actually sees
// behind that text (not the frame, not the gaps between lines). [] = none.
function roleLineBoxes(frame, paraIndex) {
    const boxes = [];
    try {
        const para = frame.parentStory.paragraphs.item(paraIndex);
        const start = Number(para.characters.item(0).index);
        const end = start + Number(para.characters.length) - 1;
        const lines = frame.lines;
        for (let i = 0; i < lines.length; i++) {
            const ln = itemAt(lines, i);
            if (!String(ln.contents || "").replace(/\s+/g, "")) continue; // \s covers \r, \n and the Unicode line/paragraph separators
            const at = Number(ln.characters.item(0).index);
            if (!(at >= start && at <= end)) continue;
            const base = Number(ln.baseline), asc = Number(ln.ascent), desc = Number(ln.descent);
            const x0 = Number(ln.horizontalOffset), x1 = Number(ln.endHorizontalOffset);
            if (![base, asc, desc, x0, x1].every(isFinite)) continue;
            if (base + desc > base - asc && Math.abs(x1 - x0) > 0) boxes.push([base - asc, Math.min(x0, x1), base + desc, Math.max(x0, x1)]);
        }
    } catch (e) {}
    return boxes;
}

// Renders ONE page with `hide` items hidden to a temporary low-resolution
// JPG (TEXT_COLOR_RESOLUTION dpi) — InDesign's own rendering, so image,
// extension, shadow/gradient and transparency appear exactly as exported —
// reads it, deletes it immediately and decodes the pixels.
// Returns { image, pageBounds } — restores visibility + JPG export settings.
async function renderPageBehindText(doc, page, hide) {
    const { app } = indesign();
    const mods = textColorModules();
    const st = require("uxp").storage;
    const tmp = await st.localFileSystem.getTemporaryFolder();
    const path = `${tmp.nativePath.replace(/\/+$/, "")}/textcolor_${Date.now()}_${Math.floor(Math.random() * 1e6)}.jpg`;
    const prefs = app.jpegExportPreferences;
    const saved = {};
    for (const k of ["exportResolution", "jpegQuality", "jpegColorSpace", "jpegExportRange", "pageString"]) {
        try { saved[k] = prefs[k]; } catch (e) {}
    }
    const wasVisible = hide.map((it) => { try { return it.visible; } catch (e) { return true; } });
    try {
        hide.forEach((it) => { try { it.visible = false; } catch (e) {} });
        exportPageAsJPEG(doc, page, path, TEXT_COLOR_RESOLUTION);
    } catch (e) {
        // A failed export may still have left a partial file — remove it.
        try { await (await st.localFileSystem.getEntryWithUrl("file:" + path)).delete(); } catch (err) {}
        throw e;
    } finally {
        hide.forEach((it, i) => { try { it.visible = wasVisible[i] !== false; } catch (e) {} });
        for (const k of Object.keys(saved)) { try { prefs[k] = saved[k]; } catch (e) {} }
    }
    // Read the temp JPG once, then delete it straight away — whatever happens.
    let bytes;
    let entry = null;
    try {
        entry = await st.localFileSystem.getEntryWithUrl("file:" + path);
        bytes = await entry.read({ format: st.formats.binary });
    } finally {
        try { if (entry) await entry.delete(); } catch (e) {}
    }
    return { image: mods.color.decodeJpeg(bytes), pageBounds: Array.from(page.bounds, Number) };
}

// Document colour for a palette swatch (created once, in its own model).
function documentColorFor(doc, swatch) {
    const { ColorModel, ColorSpace } = indesign();
    const name = swatch.name;
    try {
        const c = doc.colors.itemByName(name);
        if (c && c.isValid) return c;
    } catch (e) {}
    const spec = textColorModules().palette.inDesignColor(swatch);
    const space = spec.space === "CMYK" ? ColorSpace.CMYK : spec.space === "LAB" ? ColorSpace.LAB : ColorSpace.RGB;
    return doc.colors.add({ name, model: ColorModel.PROCESS, space, colorValue: spec.values });
}

// Applies one swatch to ONE paragraph (headline or subline) of the story.
function applyTextColor(doc, frame, paraIndex, swatch) {
    frame.parentStory.paragraphs.item(paraIndex).fillColor = documentColorFor(doc, swatch);
}

// The choice per role is recorded on the frame (script label): traceability,
// and pageWarnings() keeps flagging low contrast at Preview / Commit.
//   { v: 2, headline: { swatch, name, score, threshold, readable }, subline: … }
function writeTextColorLabel(frame, roles) {
    const label = { v: 2 };
    for (const r of roles) {
        if (r.swatch) label[r.role] = { swatch: r.swatchId, name: r.swatch, score: r.score, threshold: r.threshold, readable: r.readable };
    }
    try { frame.insertLabel(TEXT_COLOR_LABEL, JSON.stringify(label)); } catch (e) {}
}

// PURE. "low text contrast" warnings from a stored label (v2), [] otherwise.
function lowContrastWarnings(label) {
    if (!label || label.v !== 2) return [];
    return ["headline", "subline"].filter((k) => label[k] && label[k].readable === false)
        .map((k) => `low text contrast — ${k} ${label[k].name} reaches ${label[k].score}:1 in its weakest part (needs ${label[k].threshold}:1); best of the selected colours`);
}

// Auto Text Color for every planned page of an open document. Headline (1st
// non-empty paragraph) and subline (2nd) are decided SEPARATELY, each on its
// own visible glyph lines (roleLineBoxes), weakest-zone scoring
// (textcolor.js chooseTextColorByZones). The best selected colour is always
// applied; below the readability threshold it is ALSO reported (readable:
// false → a Review warning).
//   swatches: the designer's selected palette swatches (colorpalette.js)
//   options.waitForExtension: page indices (0-based) whose image still needs
//     Image Extension — skipped here; they get their colour after Extend
// Returns [{ layout, roles: [{ role, swatch, score, overall, threshold,
//   readable, weakest, ranking, error }], error, pending }] — never throws.
async function autoTextColorForDocument(doc, plan, swatches, options) {
    const waiting = (options && options.waitForExtension) || new Set();
    const results = [];
    const mods = textColorModules();
    if (!mods || !swatches || !swatches.length) return results;
    for (const pg of plan.pages) {
        const page = doc.pages.item(pg.index);
        const frame = findHeadlineFrame(page);
        const layout = `${pg.layout.key} ${pg.layout.size}`;
        if (!frame) continue;
        if (waiting.has(pg.index)) { results.push({ layout, pending: true }); continue; }
        try {
            const story = frame.parentStory;
            const idx = nonEmptyParagraphs(story);
            const roleDefs = [["headline", idx[0]], ["subline", idx[1]]].filter(([, i]) => i !== undefined);
            if (!roleDefs.length) { results.push({ layout, error: "no text" }); continue; }
            const { image, pageBounds } = await renderPageBehindText(doc, page, [frame]);
            const sx = image.width / (pageBounds[3] - pageBounds[1]), sy = image.height / (pageBounds[2] - pageBounds[0]);
            const toPx = (b) => ({ x: (b[1] - pageBounds[1]) * sx, y: (b[0] - pageBounds[0]) * sy, width: (b[3] - b[1]) * sx, height: (b[2] - b[0]) * sy });
            const roles = [];
            for (const [role, pi] of roleDefs) {
                try {
                    const zones = mods.color.sampleZones(image, roleLineBoxes(frame, pi).map(toPx));
                    let size = 0;
                    try { size = Number(story.paragraphs.item(pi).characters.item(0).pointSize); } catch (e) {}
                    const best = mods.color.chooseTextColorByZones(zones, swatches, mods.color.readabilityThreshold(size));
                    if (!best) { roles.push({ role, error: "no visible text lines" }); continue; }
                    applyTextColor(doc, frame, pi, best.swatch);
                    roles.push({ role, swatch: best.swatch.name, swatchId: best.swatch.id, score: best.score, overall: best.overall,
                        threshold: best.threshold, readable: best.readable, weakest: best.weakest, zones: zones.length,
                        ranking: best.ranking.slice(0, 3).map((x) => `${x.swatch.name} ${x.score}`) });
                } catch (e) {
                    roles.push({ role, error: String((e && e.message) || e) }); // template colour stays for this role
                }
            }
            writeTextColorLabel(frame, roles);
            results.push({ layout, roles });
        } catch (e) {
            results.push({ layout, error: String((e && e.message) || e) }); // template colour stays
        }
    }
    return results;
}

// One log line per page for autoTextColorForDocument() results.
function textColorLogLine(r) {
    if (r.pending) return `${r.layout}: waits for Image Extension`;
    if (r.error) return `${r.layout}: kept template colour (${r.error})`;
    return `${r.layout}: ` + r.roles.map((x) => x.error ? `${x.role} kept template colour (${x.error})`
        : `${x.role} ${x.swatch} (weakest-zone contrast ${x.score}; overall P10 ${x.overall}; needs ${x.threshold}` +
            `${x.readable ? "" : " — LOW"}; ranking ${x.ranking.join(" · ")})`).join(" | ");
}

// "WARNING <layout>: low text contrast …" for every role below its threshold.
function textColorWarnings(results) {
    const out = [];
    for (const r of results || []) {
        for (const x of r.roles || []) {
            if (x.swatch && !x.readable) out.push(`WARNING ${r.layout}: ${lowContrastWarnings({ v: 2, [x.role]: { name: x.swatch, score: x.score, threshold: x.threshold, readable: false } })[0]}`);
        }
    }
    return out;
}

// PURE. Page indices (0-based) whose image doesn't cover its frame yet —
// from analyzeImageCoverage() records. Auto Text Color waits there, so a
// colour is never judged against the uncovered strip (whatever the page's
// status: extension_required, over the limit, …).
function pagesAwaitingExtension(records) {
    return new Set((records || []).filter((r) => r && (r.needsExtension || r.status === "extension_required")).map((r) => r.page - 1));
}

// Short summary for logs / the panel: { names: [colours used], pages,
// lowContrast: roles below their threshold, waitingForExtension }.
function summarizeTextColors(results) {
    const coloured = (results || []).filter((r) => (r.roles || []).some((x) => x.swatch));
    const pending = (results || []).filter((r) => r.pending).length;
    if (!coloured.length && !pending) return null;
    const roles = coloured.flatMap((r) => r.roles.filter((x) => x.swatch));
    return { names: [...new Set(roles.map((x) => x.swatch))], pages: coloured.length,
        lowContrast: roles.filter((x) => !x.readable).length, waitingForExtension: pending };
}

// "danis" / "service" for a prepared template path (same rule as Render).
function typeOfTemplate(path) {
    return subTypeFromPath(path);
}

// Opens a working copy of a prepared template and discovers its layouts
// (for the panel after Prepare). Never changes the template.
// Returns { subType, detected, layouts, notes, problems }.
// ---------- the open Template Set (Custom Subject Frames) ----------
//
// doc.fullName comes back in different shapes depending on the InDesign
// build (string, File-like object, file: URL, %-encoded, "~/…"), so the open
// template is matched on every normalised spelling, and — if none matches —
// on the file name when exactly one open document has it.
function pathSpellings(v) {
    const out = [];
    if (!v) return out;
    if (typeof v === "string") out.push(v);
    else {
        for (const k of ["nativePath", "fsName", "fullName", "absoluteURI", "url"]) {
            try { if (typeof v[k] === "string" && v[k]) out.push(v[k]); } catch (e) {}
        }
        try { const s = String(v); if (/^(\/|~|file:)/.test(s)) out.push(s); } catch (e) {}
    }
    return out;
}

function normalisedPath(p) {
    let s = String(p || "").trim().replace(/^file:(\/\/)?/, "");
    if (/%[0-9a-f]{2}/i.test(s)) { try { s = decodeURIComponent(s); } catch (e) {} }
    try { s = s.normalize("NFC"); } catch (e) {}
    return s.replace(/\/+$/, "").toLowerCase();
}

function findOpenTemplate(templatePath) {
    const { app } = indesign();
    const want = normalisedPath(templatePath);
    const wantTail = want.replace(/^~/, "");
    const byName = [];
    try {
        for (let i = 0; i < app.documents.length; i++) {
            const doc = app.documents.item(i);
            let full = null;
            try { full = doc.fullName; } catch (e) {}
            const spellings = pathSpellings(full).map(normalisedPath);
            if (spellings.some((s) => s === want || (s.startsWith("~") && want.endsWith(s.slice(1))) || (want.startsWith("~") && s.endsWith(wantTail)))) return doc;
            let name = "";
            try { name = String(doc.name || ""); } catch (e) {}
            if (normalisedPath(name) === normalisedPath(basename(templatePath))) byName.push(doc);
        }
    } catch (e) {}
    return byName.length === 1 ? byName[0] : null;
}

// For the panel's poll: is the template open, does it have unsaved changes?
function templateState(templatePath) {
    const doc = findOpenTemplate(templatePath);
    let modified = false;
    try { modified = !!(doc && doc.modified); } catch (e) {}
    return { open: !!doc, modified };
}

// "Save Frame Changes": saves the open template so Generate (which reads it
// from disk) uses the moved red frames. Returns { open, saved, wasModified }.
async function saveTemplate(templatePath) {
    const doc = findOpenTemplate(templatePath);
    if (!doc) return { open: false, saved: false, wasModified: false };
    let wasModified = false;
    try { wasModified = !!doc.modified; } catch (e) {}
    if (wasModified) await saveWhenIdle(doc);
    return { open: true, saved: wasModified, wasModified };
}

// Custom Subject Frames: draws a default red subject frame on every layout
// of the prepared template (the Template Set) — where Auto Placement would
// put the subject: the image frame's free area clear of the text, with a
// small margin. The designer then moves / resizes them and saves.
// Opens the template in InDesign (visible) if it isn't open, saves it, and
// leaves it open in front.
//   options.reset: replace existing frames (otherwise layouts that already
//   have one keep it)
// Returns { name, pages: [{ page, layout, action: "added"|"kept"|"replaced" }], saved }.
async function addDefaultSubjectFrames(templatePath, options) {
    const reset = !!(options && options.reset);
    const zm = zoneModule();
    if (!zm || typeof zm.addZoneFrame !== "function") throw new Error("subjectzone.js is not available");
    const { app } = indesign();
    if (!(await pathExists(templatePath))) throw new Error("Template not found: " + templatePath);
    let doc = findOpenTemplate(templatePath) || findOpenDocument(templatePath);
    if (!doc) doc = app.open(templatePath, true);
    try { app.activeDocument = doc; } catch (e) {}
    // Unrelated unsaved edits in the template are not saved on the
    // designer's behalf — then the frames are added but not saved.
    let hadEdits = false;
    try { hadEdits = !!doc.modified; } catch (e) {}
    // Work in points, then give the designer their ruler units back.
    let units = null;
    try { units = [doc.viewPreferences.horizontalMeasurementUnits, doc.viewPreferences.verticalMeasurementUnits]; } catch (e) {}
    usePoints(doc);
    const subType = subTypeFromPath(templatePath);
    const plan = planPages(doc, subType);
    if (plan.problems.length) throw new Error("Template structure: " + plan.problems.join("; "));
    const layer = zm.ensureZoneLayer(doc);
    const colour = zm.zoneColour(doc);
    let none = null;
    try { none = doc.swatches.itemByName("None"); } catch (e) {}
    const placement = placementModule();
    const pages = [];
    for (const pg of plan.pages) {
        const page = doc.pages.item(pg.index);
        const label = `${pg.layout.size} ${pg.layout.position}`;
        const existing = zm.zoneForPage(page);
        if (existing && !reset) { pages.push({ page: pg.index + 1, layout: label, action: "kept" }); continue; }
        if (existing) {
            zm.removeOwnZones(page);
            // A frame on the parent (master) page can't be replaced here.
            if (zm.zoneForPage(page)) { pages.push({ page: pg.index + 1, layout: label, action: "kept", onParent: true }); continue; }
        }
        const imageFrame = findImageFrame(page);
        if (!imageFrame) continue;
        const avoid = [findHeadlineFrame(page), findFooterFrame(page)].filter(Boolean)
            .map((f) => Array.from(f.geometricBounds, Number));
        const bounds = placement.defaultSubjectZone(Array.from(imageFrame.geometricBounds, Number), Array.from(page.bounds, Number), avoid);
        zm.addZoneFrame(page, bounds, layer, colour, none);
        pages.push({ page: pg.index + 1, layout: label, action: existing ? "replaced" : "added" });
    }
    try {
        if (units) {
            doc.viewPreferences.horizontalMeasurementUnits = units[0];
            doc.viewPreferences.verticalMeasurementUnits = units[1];
        }
    } catch (e) {}
    let saved = false;
    if (!hadEdits) {
        try { await saveWhenIdle(doc); saved = true; } catch (e) { saved = false; }
    }
    return { name: basename(templatePath), pages, saved, hadEdits };
}

async function detectTemplateLayouts(templatePath) {
    const subType = subTypeFromPath(templatePath);
    let doc = null;
    try {
        doc = await openTemplateCopy(templatePath);
        usePoints(doc);
        const plan = planPages(doc, subType);
        return {
            subType, detected: plan.problems.length ? "" : describeTemplateLayouts(plan),
            layouts: plan.pages.map((pg) => ({ page: pg.index + 1, size: pg.layout.size, position: pg.layout.position, known: pg.layout.known })),
            notes: plan.notes, problems: plan.problems,
        };
    } finally {
        closeWithoutSaving(doc);
        await settle(250);
    }
}

async function writeLog(logLines, logPath) {
    const lfs = require("uxp").storage.localFileSystem;
    const types = require("uxp").storage.types;
    const fileEntry = await lfs.createEntryWithUrl(fileUrl(logPath), { type: types.file, overwrite: true });
    await fileEntry.write(logLines.join("\n") + "\n");
}

module.exports = {
    checkAudiFont, generateIndds, exportFromIndds, openIndd, inddPathFor, pathExists,
    isInddOpen, closeIndd, activeDocumentPath, extendProductImage, setExtensionVisible, detectTemplateLayouts,
    addDefaultSubjectFrames, templateState, saveTemplate, textAvoidBounds,
    outputFolderFor, typeOfTemplate, TYPE_FOLDER, typeFolder, writeLog, debugModuleShape,
    pagesAwaitingExtension, largestFittingScale, wordSplitAcrossLines, linesFromStarts, fitHeadlineToFrame,
    lowContrastWarnings, textColorWarnings, summarizeTextColors, textColorLogLine,
    capsuleMissingWarning, capsuleStatusRecord, previewPlacementForPage, readPlacementGeometry,
};
