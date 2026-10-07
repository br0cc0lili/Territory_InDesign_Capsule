// datamerge.js — turns a finished client layout (the document currently
// open/active in InDesign, e.g. DANIS_Template.indd / SERVICE_Template.indd)
// into a Data-Merge-ready template, i.e. the same result as manually doing
// Window > Utilities > Data Merge > Select Data Source… and dragging each
// field onto its frame. Frames are identified by the client's layers:
//
//   layer "text"   : exactly one TextFrame
//                      1st non-empty paragraph -> <<DANIS + SERVICE HEADLINE +PRODUCT NAMING>>
//                      2nd non-empty paragraph -> <<DANIS SUBLINE>> or <<SERVICE SUBLINE>>
//   layer "footer" : zero or one TextFrame     -> <<DANIS ADD ON>> (whenever the data source has
//                                                 that column, even if every row is empty)
//   layer "Image"  : exactly one graphic frame -> <<MainImage>>    (CSV column "@MainImage";
//                                                 sample image placed or empty frame)
//   other layers (e.g. "shadow") are left alone.
//
// Lookup priority per role: a frame explicitly named <<Headline>> /
// <<Footer>> / <<MainImage>> on the page wins, then the role's layer (name
// matched case-insensitively). Nothing is ever chosen by size, font size,
// area, image size or position: if a layer holds the wrong number of frames
// the page is reported as an error instead of being repaired by guessing.
// A missing "text" or "Image" layer is an error, a missing "footer" layer
// only a warning.
//
// Paragraphs are real InDesign paragraphs, so visual line wrapping inside the
// headline never shifts the subline, and empty paragraphs are skipped.
//
// The client's own text formatting, frame geometry and styles are kept —
// only the content is swapped for placeholders. Frames are also named
// <<Headline>> / <<Footer>> / <<MainImage>> so render.js (and a re-run) can
// find them by name.
//
// InDesign's Data Merge only reads CSV/TXT, so an .xlsx is first converted
// to a merge CSV (excelToDataSource) written next to the Excel file.
//
// The client's file is never edited: prepareActiveDocument() first saves a
// copy next to it (<name>_DataMerge.indd, never overwriting an existing
// file), opens that copy, prepares and saves it, and leaves it open.

/* global require, XLSX */
// See render.js for why this re-requires instead of trusting a cached
// snapshot: the bridge can still be mid-attach on the first call or two.
let _id = null;
function indesign() {
    if (!_id || !_id.app) _id = require("indesign");
    return _id;
}

// Data source column(s) per role, matched case-insensitively, ignoring a
// leading "@" (InDesign's image-field marker), trailing "*" and extra spaces.
// First entry wins; later ones are accepted for older CSVs.
const FIELD_NAMES = {
    headline: ["DANIS + SERVICE HEADLINE +PRODUCT NAMING", "DANIS + SERVICE HEADLINE"],
    denis: ["DANIS SUBLINE"],
    service: ["SERVICE SUBLINE"],
    footer: ["DANIS ADD ON"],
    image: ["MAINIMAGE"],
};
const REQUIRED_ROLES = ["headline", "denis", "service", "image"];

// Client layer names (matched case-insensitively).
const LAYERS = { text: "text", footer: "footer", image: "image" };
const REQUIRED_LAYERS = [LAYERS.text, LAYERS.image];

// Explicit frame names; checked before the layers.
const FRAME_NAMES = { text: "<<Headline>>", footer: "<<Footer>>", image: "<<MainImage>>" };

// Same page-label convention as render.js's PAGE_CONFIG.
const LABEL_SUBTYPE = {
    "top_service": "service",
    "top_denis": "denis",
    "bottom_denis": "denis",
    "9x16_top_service": "service",
};

const FRAME_TYPES = ["Rectangle", "Polygon", "Oval"];

// Excel -> merge CSV
const SHEET_NAME = "AOZ+AOT";
const CSV_COLUMNS = [
    { header: "DANIS + SERVICE HEADLINE +PRODUCT NAMING", from: "DANIS + SERVICE HEADLINE +PRODUCT NAMING" },
    { header: "DANIS SUBLINE", from: "DANIS SUBLINE" },
    { header: "SERVICE SUBLINE", from: "SERVICE SUBLINE" },
    { header: "DANIS ADD ON", from: "DANIS ADD ON", optional: true },
    { header: "PICTURE NAME", from: "PICTURE NAME" },
];
const IMAGE_EXTS = [".jpg", ".jpeg", ".png", ".tif", ".tiff", ".psd"];

// See render.js: some collections need .item(i), others are plain arrays.
function itemAt(collection, i) {
    return typeof collection.item === "function" ? collection.item(i) : collection[i];
}

function normalizeField(name) {
    return String(name).trim().replace(/^@/, "").replace(/\*+$/, "").replace(/\s+/g, " ").trim().toUpperCase();
}

function findField(fields, candidates) {
    for (const wanted of candidates) {
        for (let i = 0; i < fields.length; i++) {
            const f = itemAt(fields, i);
            if (normalizeField(f.fieldName) === wanted) return f;
        }
    }
    return null;
}

function typeName(item) {
    try { return item.constructor.name; } catch (e) { return ""; }
}

function layerName(item) {
    try { return String(item.itemLayer.name).trim().toLowerCase(); } catch (e) { return ""; }
}

function findLayer(doc, name) {
    for (let i = 0; i < doc.layers.length; i++) {
        const l = doc.layers.item(i);
        if (String(l.name).trim().toLowerCase() === name) return l;
    }
    return null;
}

// Page items on `page` that sit on layer `name` and pass `filter`.
function itemsOnLayer(page, name, filter) {
    const out = [];
    const items = page.allPageItems;
    for (let i = 0; i < items.length; i++) {
        const it = itemAt(items, i);
        if (layerName(it) === name && filter(it)) out.push(it);
    }
    return out;
}

// Same, but for items the page shows from its parent (master) page —
// client templates often keep footers there. These can't be edited in place,
// so callers override them onto the page first (see overrideOnto).
function parentItemsOnLayer(page, name, filter) {
    const out = [];
    let items;
    try { items = page.masterPageItems; } catch (e) { return out; }
    for (let i = 0; i < (items ? items.length : 0); i++) {
        const it = itemAt(items, i);
        if (layerName(it) === name && filter(it)) out.push(it);
    }
    return out;
}

// One-line description of a candidate frame for the report:
// type, object name if any, and its text or placed image.
function describeFrame(f) {
    const parts = [typeName(f) || "PageItem"];
    try { if (f.name) parts.push(`named "${f.name}"`); } catch (e) {}
    if (isTextFrame(f)) {
        let t = "";
        try { t = String(f.contents).trim().replace(/\s+/g, " "); } catch (e) {}
        parts.push(t ? `"${t.slice(0, 30)}${t.length > 30 ? "…" : ""}"` : "(empty)");
    } else {
        let img = "";
        try {
            const g = f.allGraphics;
            if (g.length) {
                const first = itemAt(g, 0);
                try { img = first.itemLink.name; } catch (e) { img = typeName(first) || "graphic"; }
            }
        } catch (e) {}
        parts.push(img ? `(image: ${img})` : "(empty)");
    }
    return parts.join(" ");
}

// Strict per-layer lookup, used for every role: the template contract is a
// fixed number of frames per layer, so a frame is never chosen by size,
// font size, area, image size or position. The page's own items are checked
// first, then its parent page's.
// Returns { frame, via, error } — error is set when 2+ frames qualify.
function exactlyOneOnLayer(page, name, filter, kind) {

    for (const [frames, via] of [
        [itemsOnLayer(page, name, filter), "layer"],
        [parentItemsOnLayer(page, name, filter), "layer (parent page)"],
    ]) {
        if (frames.length === 1) return { frame: frames[0], via };
        if (frames.length > 1) {
            return {
                frame: null, via,
                error: `${frames.length} ${kind} frames on layer "${name}"${via === "layer" ? "" : " of the parent page"} ` +
                    `(expected one): ${frames.map(describeFrame).join("; ")}`,
            };
        }
    }
    return { frame: null, via: "layer", error: null };
}

// Makes a parent-page item editable on this page (InDesign's "Override").
function overrideOnto(found, page) {
    if (found.via !== "layer (parent page)") return found.frame;
    return step("override parent-page item", () => found.frame.override(page));
}

function paragraphText(para) {
    return String(para.contents).replace(/[\r\n\u2028\u2029]/g, "").trim();
}

// Indices of the frame's non-empty paragraphs.
function nonEmptyParagraphs(frame) {
    const out = [];
    const paras = frame.paragraphs;
    for (let i = 0; i < paras.length; i++) {
        if (paragraphText(paras.item(i)) !== "") out.push(i);
    }
    return out;
}

function isTextFrame(it) { return typeName(it) === "TextFrame"; }
function isGraphicFrame(it) { return FRAME_TYPES.indexOf(typeName(it)) !== -1; }

// A frame on `page` explicitly named `name` (any layer), or null.
function namedItem(page, name, filter) {
    const items = page.allPageItems;
    for (let i = 0; i < items.length; i++) {
        const it = itemAt(items, i);
        try { if (it.name === name && filter(it)) return it; } catch (e) {}
    }
    return null;
}

// Returns { frame, via, error } — via is "name", "layer" or
// "layer (parent page)" for the report; error is set when the layer doesn't
// hold exactly one text frame.
// <<Headline>>, else the single text frame on the "text" layer.
function findMainTextFrame(page) {
    const named = namedItem(page, FRAME_NAMES.text, isTextFrame);
    if (named) return { frame: named, via: "name" };
    return exactlyOneOnLayer(page, LAYERS.text, isTextFrame, "text");
}

// <<Footer>>, else the single text frame on the "footer" layer — an empty
// frame is fine, since the footer may be blank in the client file.
function findFooterFrame(page) {
    const named = namedItem(page, FRAME_NAMES.footer, isTextFrame);
    if (named) return { frame: named, via: "name" };
    return exactlyOneOnLayer(page, LAYERS.footer, isTextFrame, "text");
}

// <<MainImage>>, else the single graphic frame (Rectangle/Polygon/Oval) on
// the "Image" layer — with a sample image placed or empty, both are valid.
function findImageFrame(page) {
    const named = namedItem(page, FRAME_NAMES.image, isGraphicFrame);
    if (named) return { frame: named, via: "name" };
    return exactlyOneOnLayer(page, LAYERS.image, isGraphicFrame, "graphic");
}

// Which subline field a page uses: page label first (render.js convention),
// then the document's file name ("DANIS_Template.indd" /
// "SERVICE_Template.indd"), then the subline text itself.
function detectSubType(page, docName, sublineText) {
    if (LABEL_SUBTYPE[page.label]) return { subType: LABEL_SUBTYPE[page.label], source: "page label" };
    const n = String(docName).toLowerCase();
    if (n.indexOf("service") !== -1) return { subType: "service", source: "file name" };
    if (n.indexOf("denis") !== -1 || n.indexOf("danis") !== -1) return { subType: "denis", source: "file name" };
    if (/service/i.test(sublineText || "")) return { subType: "service", source: "subline text" };
    return { subType: "denis", source: "default" };
}

// Wraps one DOM call so an InDesign error names the operation that failed
// (a bare "Object is invalid" otherwise gives no clue which call it was).
function step(label, fn) {
    try {
        return fn();
    } catch (e) {
        throw new Error(`${label}: ${e}`);
    }
}

function endsWithReturn(text) {
    try {
        const chars = text.characters;
        return chars.length > 0 && String(chars.item(chars.length - 1).contents) === "\r";
    } catch (e) {
        return false;
    }
}

// All text edits work on story offsets rather than ranges/paragraph objects:
// characters.itemByRange(n, m) and paragraph references held across an edit
// both came back "Object is invalid" in this UXP DOM.
//
// Deletes `count` characters starting at story offset `start` (always the
// char now at `start`, since the rest shifts left after each removal).
function removeChars(story, start, count) {
    for (let k = 0; k < count; k++) story.characters.item(start).remove();
}

function insertPlaceholder(doc, story, offset, field) {
    try {
        doc.dataMergeTextPlaceholders.add(story, story.insertionPoints.item(offset), field);
    } catch (e) {
        // Some DOM builds only take a numeric story offset.
        doc.dataMergeTextPlaceholders.add(story, offset, field);
    }
}

// Replaces paragraph `paraIndex` of `frame` with `field`'s placeholder. The
// paragraph's own return is kept, so the paragraph (and its style)
// survives and the placeholder inherits its formatting.
function placeholderIntoParagraph(doc, frame, paraIndex, field) {
    const para = step("read paragraph", () => frame.paragraphs.item(paraIndex));
    const story = step("read story", () => para.parentStory);
    const start = step("read paragraph offset", () => para.index);
    const count = step("count paragraph chars", () => para.characters.length - (endsWithReturn(para) ? 1 : 0));
    step("clear paragraph text", () => removeChars(story, start, count));
    step("add text placeholder", () => insertPlaceholder(doc, story, start, field));
}

// Footer: the frame's whole text (from its first non-empty paragraph on)
// becomes one placeholder, keeping that paragraph's formatting. An empty
// frame gets the placeholder at its first insertion point.
function placeholderIntoWholeFrame(doc, frame, field) {
    const story = step("read story", () => frame.parentStory);
    const idx = step("read paragraphs", () => nonEmptyParagraphs(frame));
    if (!idx.length) {
        const offset = step("read frame offset", () => frame.insertionPoints.item(0).index);
        step("add text placeholder", () => insertPlaceholder(doc, story, offset, field));
        return;
    }
    const start = step("read paragraph offset", () => frame.paragraphs.item(idx[0]).index);
    const end = step("read frame end", () => {
        const paras = frame.paragraphs;
        const last = paras.item(paras.length - 1);
        return last.index + last.characters.length - (endsWithReturn(last) ? 1 : 0);
    });
    step("clear footer text", () => removeChars(story, start, end - start));
    step("add text placeholder", () => insertPlaceholder(doc, story, start, field));
}

// Empties the frame (geometry untouched), sets fill + centre fitting, names
// it and makes it the image placeholder. Returns a short note for the report.
function prepareImageFrame(doc, frame, field) {
    const { EmptyFrameFittingOptions, AnchorPoint } = indesign();
    // Drop the client's sample photo so the frame is a clean placeholder.
    const removed = step("remove sample image", () => {
        const graphics = frame.allGraphics;
        const n = graphics.length;
        for (let i = n - 1; i >= 0; i--) itemAt(graphics, i).remove();
        return n;
    });
    // Merged images fill + center, same as render.js's placeImageFill().
    let fitting = "fill + centre";
    try {
        frame.frameFittingOptions.fittingOnEmptyFrame = EmptyFrameFittingOptions.FILL_PROPORTIONALLY;
        frame.frameFittingOptions.fittingAlignment = AnchorPoint.CENTER_ANCHOR;
    } catch (e) {
        fitting = "⚠ frame fitting not set (" + e + ")";
    }
    step("name frame", () => { frame.name = FRAME_NAMES.image; });
    step("add image placeholder", () => doc.dataMergeImagePlaceholders.add(frame, field));
    return `${removed ? "sample image removed" : "empty frame"}, ${fitting}`;
}

// Client layers/items may be locked; unlock while editing, restore after.
function unlockAll(doc) {
    const restore = [];
    for (let i = 0; i < doc.layers.length; i++) {
        const l = doc.layers.item(i);
        if (l.locked) { l.locked = false; restore.push(() => { l.locked = true; }); }
    }
    const items = doc.allPageItems;
    for (let i = 0; i < items.length; i++) {
        const it = itemAt(items, i);
        try {
            if (it.locked) { it.locked = false; restore.push(() => { it.locked = true; }); }
        } catch (e) {}
    }
    return () => { for (const fn of restore.reverse()) { try { fn(); } catch (e) {} } };
}

// ---------- page preparation ----------

function prepareText(doc, page, field, entry) {
    const found = findMainTextFrame(page);
    if (found.error) throw new Error(found.error + ` — or name the headline frame ${FRAME_NAMES.text}`);
    if (!found.frame) throw new Error(`no text frame named ${FRAME_NAMES.text} or on layer "${LAYERS.text}"`);
    const via = found.via;
    const frame = overrideOnto(found, page);

    const idx = step("read paragraphs", () => nonEmptyParagraphs(frame));
    if (!idx.length) throw new Error(`main text frame (found by ${via}) is empty`);
    const headlineIdx = idx[0];
    const sublineIdx = idx.length > 1 ? idx[1] : -1;

    const headlineText = step("read headline", () => paragraphText(frame.paragraphs.item(headlineIdx)));
    const sublineText = sublineIdx !== -1
        ? step("read subline", () => paragraphText(frame.paragraphs.item(sublineIdx)))
        : "";
    const { subType, source } = detectSubType(page, doc.name, sublineText);
    const sublineField = field[subType];

    // Subline first: it sits later in the story, so doing it first keeps
    // the headline's paragraph index valid.
    if (sublineIdx !== -1) {
        placeholderIntoParagraph(doc, frame, sublineIdx, sublineField);
        entry.notes.push(`subline "${sublineText}" → <<${sublineField.fieldName}>> (${subType}, from ${source})`);
    } else {
        entry.notes.push("⚠ only one non-empty paragraph — subline placeholder not added");
    }

    placeholderIntoParagraph(doc, frame, headlineIdx, field.headline);
    step("name frame", () => { frame.name = FRAME_NAMES.text; });
    entry.notes.push(`headline "${headlineText}" → <<${field.headline.fieldName}>> (frame by ${via})`);
}

// Zero or one footer frame is valid; 2+ is a structure error for the page.
// Row values are irrelevant — only whether the column exists.
function prepareFooter(doc, page, field, entry) {
    if (!field.footer) {
        entry.notes.push(`footer left as-is (data source has no "${FIELD_NAMES.footer[0]}" column)`);
        return;
    }
    const found = findFooterFrame(page);
    if (found.error) throw new Error(found.error + ` — or name the footer frame ${FRAME_NAMES.footer}`);
    if (!found.frame) {
        // Zero footer frames is a valid template structure.
        entry.notes.push(`no footer frame on this page — no <<${field.footer.fieldName}>> placeholder needed`);
        return;
    }
    const via = found.via;
    const frame = overrideOnto(found, page);
    const before = step("read footer", () => String(frame.contents).trim().replace(/\s+/g, " "));
    placeholderIntoWholeFrame(doc, frame, field.footer);
    step("name frame", () => { frame.name = FRAME_NAMES.footer; });
    entry.notes.push(`footer "${before.slice(0, 40)}${before.length > 40 ? "…" : ""}" → ` +
        `<<${field.footer.fieldName}>> (frame by ${via})`);
}

function prepareImage(doc, page, field, entry) {
    const found = findImageFrame(page);
    if (found.error) throw new Error(found.error + ` — or name the image frame ${FRAME_NAMES.image}`);
    if (!found.frame) throw new Error(`no graphic frame named ${FRAME_NAMES.image} or on layer "${LAYERS.image}"`);
    const via = found.via;
    const frame = overrideOnto(found, page);
    const desc = describeFrame(frame);
    const how = prepareImageFrame(doc, frame, field.image);
    entry.notes.push(`image ${desc} → <<${field.image.fieldName}>> (frame by ${via}; ${how})`);
}

// csvPath: native path to the data source CSV (header row defines the fields)
// prepareDocument returns: { docName, fields: string[], warnings: string[],
//                            pages: [{page, label, ok, notes: string[]}] }
// ---------- source path detection ----------
//
// What the copy-first flow needs is a usable filesystem path for the active
// document (to put the copy next to it) — not doc.saved, which can be false
// for a file opened from disk. fullName / filePath come back in different
// shapes depending on the DOM build (string, File-like object, URL, "~/…",
// even a Promise), so every shape is tried and each candidate must actually
// exist on disk before it is used.

// Short human-readable description of whatever a DOM property returned.
function describe(v) {
    if (v === undefined) return "undefined";
    if (v === null) return "null";
    if (typeof v !== "object" && typeof v !== "function") return `${typeof v} ${JSON.stringify(v)}`;
    let ctor = "", str = "", keys = "";
    try { ctor = v.constructor && v.constructor.name; } catch (e) {}
    try { str = String(v); } catch (e) {}
    try { keys = Object.keys(v).slice(0, 12).join(","); } catch (e) {}
    return `${typeof v} ${ctor || "?"} "${str}" keys{${keys}}`;
}

// Reads a property that may throw or return a Promise.
// Returns { value, error }.
async function readProp(obj, name) {
    try {
        let v = obj[name];
        if (v && typeof v.then === "function") v = await v;
        return { value: v, error: null };
    } catch (e) {
        return { value: undefined, error: String(e) };
    }
}

function homeDir() {
    try { return require("os").homedir(); } catch (e) { return ""; }
}

// Turns one raw value (string or File-like object) into candidate path strings.
function pathStrings(v) {
    const out = [];
    if (!v) return out;
    if (typeof v === "string") {
        out.push(v);
    } else {
        for (const k of ["nativePath", "fsName", "fullName", "absoluteURI", "url"]) {
            try { if (typeof v[k] === "string" && v[k]) out.push(v[k]); } catch (e) {}
        }
        try {
            if (typeof v.path === "string" && typeof v.name === "string") out.push(v.path + "/" + v.name);
        } catch (e) {}
        try {
            const str = String(v);
            if (/^(\/|~|file:)/.test(str)) out.push(str);
        } catch (e) {}
    }
    return out;
}

// "file:///Users/…", "~/Desktop/HEX%20x%20Adobe/…" -> "/Users/…/HEX x Adobe/…"
function normalizePath(p) {
    p = String(p).trim().replace(/^file:(\/\/)?/, "");
    if (/%[0-9a-f]{2}/i.test(p)) {
        try { p = decodeURIComponent(p); } catch (e) {}
    }
    if (p.startsWith("~/")) {
        const home = homeDir();
        if (home) p = home.replace(/\/+$/, "") + p.slice(1);
    }
    return p.replace(/\/+$/, "");
}

// Returns { path, diagnostics: string[] } — path is "" if no candidate
// exists on disk (e.g. a new Untitled document).
async function resolveSourcePath(doc) {
    const diagnostics = [];
    const props = {};
    for (const name of ["name", "saved", "modified", "fullName", "filePath"]) {
        props[name] = await readProp(doc, name);
        const r = props[name];
        diagnostics.push(`doc.${name}: ` + (r.error ? `threw ${r.error}` : describe(r.value)));
    }

    const docName = String(props.name.value || "");
    const candidates = [];
    for (const p of pathStrings(props.fullName.value)) candidates.push(normalizePath(p));
    for (const dir of pathStrings(props.filePath.value)) {
        const d = normalizePath(dir);
        // filePath is the folder; tolerate builds that return the file itself.
        candidates.push(d.toLowerCase().endsWith(".indd") ? d : d + "/" + docName);
    }

    for (const c of candidates) {
        if (!c.startsWith("/") && !/^[a-z]:[\\/]/i.test(c)) continue;
        if (!/\.indd$/i.test(c)) continue;
        if (await pathExists(c)) {
            diagnostics.push("source path: " + c);
            return { path: c, diagnostics };
        }
    }
    diagnostics.push("source path candidates (none found on disk): " + (candidates.join(" | ") || "none"));
    return { path: "", diagnostics };
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

async function pathExists(path) {
    try {
        await require("uxp").storage.localFileSystem.getEntryWithUrl("file:" + path);
        return true;
    } catch (e) {
        return false;
    }
}

// <dir>/<name>_DataMerge.indd, or _DataMerge_2, _3… if that already exists.
async function copyPathFor(srcPath) {
    const base = srcPath.replace(/\.indd$/i, "") + "_DataMerge";
    let candidate = base + ".indd";
    for (let n = 2; await pathExists(candidate); n++) candidate = `${base}_${n}.indd`;
    return candidate;
}

// Prepares a COPY of the active (client) document — see the header comment.
// Returns prepareDocument()'s result plus { sourcePath, copyPath, saved, diagnostics }.
async function prepareActiveDocument(csvPath) {
    const { app } = indesign();
    if (!app) throw new Error("InDesign isn't ready yet (app unavailable) — wait a moment and click again.");

    let src;
    try { src = app.documents.length ? app.activeDocument : null; } catch (e) { src = null; }
    if (!src) throw new Error("No document is open — open the client .indd first.");

    // Check layers on the client file (read-only) before making any copy.
    checkLayers(src);

    // doc.saved is deliberately not consulted — see resolveSourcePath().
    const { path: sourcePath, diagnostics } = await resolveSourcePath(src);
    if (!sourcePath) {
        throw new Error(
            `${src.name} has no file on disk (e.g. a new Untitled document) — save it once, then try again.\n` +
            "Diagnostics:\n  " + diagnostics.join("\n  ")
        );
    }
    const copyPath = await copyPathFor(sourcePath);
    if (copyPath.toLowerCase() === sourcePath.toLowerCase()) {
        throw new Error("Refusing to overwrite the client file: " + sourcePath);
    }

    try {
        src.saveACopy(copyPath);
    } catch (e) {
        throw new Error("Could not save a copy to " + copyPath + ": " + e);
    }
    let doc;
    try {
        doc = app.open(copyPath, true);
    } catch (e) {
        throw new Error("Saved a copy to " + copyPath + " but could not open it: " + e);
    }

    const result = await prepareDocument(doc, csvPath);

    // Persist the prepared copy (in place — it is our file, not the client's).
    let saved = true;
    try {
        await saveWhenIdle(doc);
    } catch (e) {
        saved = false;
        result.warnings.push("could not save the prepared copy (" + e + ") — save it yourself with Cmd+S");
    }
    return Object.assign(result, { sourcePath, copyPath, saved, diagnostics });
}

function checkLayers(doc) {
    const missingLayers = REQUIRED_LAYERS.filter((n) => !findLayer(doc, n));
    if (missingLayers.length) {
        throw new Error(`Layer(s) not found in ${doc.name}: ${missingLayers.join(", ")}. ` +
            `Expected layers "text" (headline + subline), "Image" and optionally "footer".`);
    }
}

// The actual preparation, on whichever document it is given.
async function prepareDocument(doc, csvPath) {
    checkLayers(doc);
    const warnings = [];
    if (!findLayer(doc, LAYERS.footer)) {
        warnings.push(`no "${LAYERS.footer}" layer — footer placeholders only where a frame is named ${FRAME_NAMES.footer}`);
    }

    const dmp = doc.dataMergeProperties;
    try {
        dmp.selectDataSource(csvPath);
    } catch (e) {
        throw new Error("Could not attach data source " + csvPath + ": " + e);
    }

    const fields = dmp.dataMergeFields;
    const fieldNames = [];
    for (let i = 0; i < fields.length; i++) fieldNames.push(itemAt(fields, i).fieldName);

    const field = {};
    for (const role in FIELD_NAMES) field[role] = findField(fields, FIELD_NAMES[role]);
    const missing = REQUIRED_ROLES.filter((r) => !field[r]).map((r) => FIELD_NAMES[r][0]);
    if (missing.length) {
        throw new Error(
            `Data source is missing column(s): ${missing.join(", ")}. ` +
            `Found: ${fieldNames.join(", ")}. (The image column must be "@MainImage".)`
        );
    }

    // Merged images fill + center (doc-level merge option, where supported).
    try {
        const { Fitting } = indesign();
        doc.dataMergeOptions.fittingOption = Fitting.FILL_PROPORTIONAL;
        doc.dataMergeOptions.centerImage = true;
    } catch (e) {}

    const relock = unlockAll(doc);
    const report = [];
    try {
        for (let p = 0; p < doc.pages.length; p++) {
            const page = doc.pages.item(p);
            const entry = { page: page.name, label: page.label || "", ok: true, notes: [] };
            report.push(entry);

            for (const [what, step] of [["text", prepareText], ["footer", prepareFooter], ["image", prepareImage]]) {
                try {
                    step(doc, page, field, entry);
                } catch (e) {
                    entry.ok = false;
                    entry.notes.push(`⚠ ${what}: ${e}`);
                }
            }
        }
    } finally {
        relock();
    }

    return { docName: doc.name, fields: fieldNames, warnings, pages: report };
}

// ---------- Excel -> merge CSV ----------

function csvCell(v) {
    const s = String(v == null ? "" : v).replace(/[\r\n]+/g, " ").trim();
    return /[",]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

// UTF-16LE with BOM: the encoding InDesign's Data Merge reads most reliably
// (umlauts, ®, – etc. survive on every InDesign version).
function utf16le(text) {
    const buf = new ArrayBuffer(2 + text.length * 2);
    const view = new DataView(buf);
    view.setUint16(0, 0xfeff, true);
    for (let i = 0; i < text.length; i++) view.setUint16(2 + i * 2, text.charCodeAt(i), true);
    return buf;
}

async function walkImages(folder, out) {
    for (const e of await folder.getEntries()) {
        if (e.isFolder) await walkImages(e, out);
        else if (IMAGE_EXTS.some((x) => e.name.toLowerCase().endsWith(x)) && !e.name.startsWith(".")) out.push(e);
    }
    return out;
}

// Converts the Excel sheet into a Data Merge CSV next to the Excel file:
//   <excel name>_DataMerge.csv
// with the text columns plus "@MainImage". "n/a" cells become empty (same
// rule as matcher.js). The photos folder is optional: if given, @MainImage
// holds the full path of the file whose name (without extension) equals
// PICTURE NAME; otherwise it stays empty — template preparation only needs
// the column to exist, and image paths can be filled in later.
// Returns: { csvPath, rows, imagesResolved }
async function excelToDataSource(excelEntry, photosFolderEntry) {
    const uxpStorage = require("uxp").storage;
    const buffer = await excelEntry.read({ format: uxpStorage.formats.binary });
    const wb = XLSX.read(buffer, { type: "array" });
    const ws = wb.Sheets[SHEET_NAME];
    if (!ws) throw new Error(`Sheet "${SHEET_NAME}" not found in ${excelEntry.name}`);

    const raw = XLSX.utils.sheet_to_json(ws, { header: 1, defval: "" });
    if (!raw.length) throw new Error(`Sheet "${SHEET_NAME}" is empty`);

    const header = raw[0].map((h) => normalizeField(h));
    const colIdx = CSV_COLUMNS.map((c) => header.indexOf(normalizeField(c.from)));
    const missing = CSV_COLUMNS.filter((c, i) => colIdx[i] === -1 && !c.optional).map((c) => c.from);
    if (missing.length) throw new Error(`Column(s) not found in sheet "${SHEET_NAME}": ${missing.join(", ")}`);
    // Optional columns absent from the sheet are left out of the CSV
    // entirely, so the template doesn't get a placeholder for them.
    const columns = CSV_COLUMNS.filter((c, i) => colIdx[i] !== -1);
    const columnIdx = colIdx.filter((i) => i !== -1);

    const imagesByName = {};
    if (photosFolderEntry) {
        for (const f of await walkImages(photosFolderEntry, [])) {
            const base = f.name.replace(/\.[^.]+$/, "").toLowerCase();
            if (!imagesByName[base]) imagesByName[base] = f.nativePath;
        }
    }
    const pictureCol = columnIdx[columns.findIndex((c) => c.from === "PICTURE NAME")];

    const lines = [columns.map((c) => csvCell(c.header)).concat("@MainImage").join(",")];
    let rows = 0, imagesResolved = 0;
    for (let r = 1; r < raw.length; r++) {
        const row = raw[r];
        const cells = columnIdx.map((i) => {
            const v = String(row[i] == null ? "" : row[i]).trim();
            return v.toLowerCase() === "n/a" ? "" : v;
        });
        if (!cells[0]) continue; // no headline -> not a product row
        const picture = String(row[pictureCol] || "").trim().toLowerCase();
        const imagePath = imagesByName[picture] || "";
        if (imagePath) imagesResolved++;
        lines.push(cells.concat(imagePath).map(csvCell).join(","));
        rows++;
    }

    const csvPath = excelEntry.nativePath.replace(/\.[^./]+$/, "") + "_DataMerge.csv";
    const file = await uxpStorage.localFileSystem.createEntryWithUrl("file:" + csvPath,
        { type: uxpStorage.types.file, overwrite: true });
    await file.write(utf16le(lines.join("\r\n") + "\r\n"), { format: uxpStorage.formats.binary });

    return { csvPath, rows, imagesResolved };
}

module.exports = { prepareActiveDocument, excelToDataSource };
