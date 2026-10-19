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
// from the template's file name (same rule as datamerge.js). Which pages are
// exported is fixed by the DANIS/Service output rules below; each product's
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

// Output file name prefix per subline type.
const PROJECT_PREFIX = {
    danis: "DANIS_Herbst",
    service: "Service_Herbst",
};

// Frame names written by datamerge.js's Prepare step.
const FRAME_NAMES = { text: "<<Headline>>", footer: "<<Footer>>", image: "<<MainImage>>" };

// Folder names per template type, used under the selected output root:
//   output/<DANIS|Service>/<WxH>/<…>.jpg       (exported JPGs)
//   InDesign/<DANIS|Service>/<…>.indd           (one populated INDD per product)
const TYPE_FOLDER = { danis: "DANIS", service: "Service" };

// Output rules — the exact layouts each template must contain, per page
// size. Every page must fill exactly one slot: a missing required layout, a
// duplicate, an unexpected size or variant is a template error (no guessing).
//
//   DANIS   1200x1200 : up, bottom     always exported
//                       footer         only when DANIS ADD ON has real content;
//                                      otherwise that page is removed from the
//                                      product's working document, so the
//                                      INDD matches the JPGs   -> 2 or 3 JPGs
//   Service 250x250   : thumbnail
//           800x600   : up, bottom
//           1080x1920 : up, bottom
//           1200x1200 : up, bottom                              -> 7 JPGs
//
// Variants: footer = DANIS page with a <<Footer>> frame; thumbnail = the
// Service 250x250 page (historical name, kept); otherwise up/bottom from the
// headline frame's position (upper / lower half of the page).
const OUTPUT_RULES = {
    danis: {
        "1200x1200": { required: ["up", "bottom"], optional: ["footer"] },
    },
    service: {
        "250x250": { required: ["thumbnail"], optional: [] },
        "800x600": { required: ["up", "bottom"], optional: [] },
        "1080x1920": { required: ["up", "bottom"], optional: [] },
        "1200x1200": { required: ["up", "bottom"], optional: [] },
    },
};
const SERVICE_THUMBNAIL_SIZE = "250x250";

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
        PROJECT_PREFIX[layout.subType],
        rec.year,
        productToken(rec.headline),
        layout.size,
        layout.position,
    ].join("_") + ".jpg";
}

// <DANIS_Herbst|Service_Herbst>_<year>_<product>.indd — one per product and
// type; never contains a resolution or variant.
function buildInddFileName(rec, subType) {
    return [PROJECT_PREFIX[subType], rec.year, productToken(rec.headline)].join("_") + ".indd";
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

// { subType, w, h, size, position, key } for one page (variants: see
// OUTPUT_RULES). key is the rule name, e.g. "danis_up", "service_thumbnail".
function pageLayout(page, subType) {
    const b = page.bounds; // [y1, x1, y2, x2]
    const w = Math.round(Number(b[3]) - Number(b[1]));
    const h = Math.round(Number(b[2]) - Number(b[0]));
    let position;
    if (subType === "danis" && findFooterFrame(page)) {
        position = "footer";
    } else if (subType === "service" && `${w}x${h}` === SERVICE_THUMBNAIL_SIZE) {
        position = "thumbnail";
    } else {
        const g = findHeadlineFrame(page).geometricBounds;
        const frameMid = (Number(g[0]) + Number(g[2])) / 2;
        const pageMid = (Number(b[0]) + Number(b[2])) / 2;
        position = frameMid < pageMid ? "up" : "bottom";
    }
    return { subType, w, h, size: `${w}x${h}`, position, key: `${subType}_${position}` };
}

// Detected size -> variants of a document, e.g. "250x250: thumbnail |
// 800x600: up, bottom | …" — for the log and error messages.
function describeMapping(pages) {
    const bySize = {};
    for (const pg of pages) (bySize[pg.layout.size] = bySize[pg.layout.size] || []).push(pg.layout.position);
    return Object.keys(bySize).map((sz) => `${sz}: ${bySize[sz].join(", ")}`).join(" | ") || "(no pages)";
}

// Classifies every page (fresh references) and checks the result against
// OUTPUT_RULES. Every valid page is exported. Returns { pages: [{index,
// layout, export}], mapping, problems: string[] }.
function planPages(doc, subType) {
    const pages = [];
    for (let p = 0; p < doc.pages.length; p++) {
        pages.push({ index: p, layout: pageLayout(doc.pages.item(p), subType), export: true });
    }
    const rules = OUTPUT_RULES[subType];
    const problems = [];
    const seen = {};
    for (const pg of pages) {
        const { size, position } = pg.layout;
        const rule = rules[size];
        if (!rule) {
            problems.push(`page ${pg.index + 1}: unexpected size ${size} (expected ${Object.keys(rules).join(", ")})`);
        } else if (rule.required.concat(rule.optional).indexOf(position) === -1) {
            problems.push(`page ${pg.index + 1}: ${size} has no "${position}" variant ` +
                `(expected ${rule.required.concat(rule.optional).join(", ")})`);
        } else if (seen[size + position]) {
            problems.push(`page ${pg.index + 1}: second ${size} "${position}" page`);
        }
        seen[size + position] = true;
    }
    for (const size of Object.keys(rules)) {
        for (const position of rules[size].required) {
            if (!seen[size + position]) problems.push(`missing ${size} "${position}" page`);
        }
    }
    if (problems.length) problems.push(`detected: ${describeMapping(pages)}`);
    return { pages, mapping: describeMapping(pages), problems };
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

// Headline + subline into <<Headline>>: 1st / 2nd non-empty paragraph of the
// same frame. Returns a diagnostics string ("" when TEXT_DIAGNOSTICS is off).
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
        if (after.length > 1) writeParagraph(doc, frame, after[1], subline, "subline");
    } catch (e) {
        throw new Error(`${e}${before ? ` || ${before} || AFTER ${textSnapshot(frame)}` : ""}`);
    }

    if (!TEXT_DIAGNOSTICS) return "";
    const diag = `${before} || AFTER ${textSnapshot(frame)} placeholders=${placeholderSnapshot(doc, frame)}`;
    try { console.log("[setHeadlineText] " + diag); } catch (e) {}
    return diag;
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
function placeProductImage(frame, imagePath, layout) {
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
    if (policy.placementMode === "extend") {
        return { mode: "extend", allowExtension: true, policy,
            note: placement.placeImageForExtension(frame, imagePath, indesign(), policy).note };
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
        if (actualSubline !== String(subline || "").trim()) errors.push(`subline is ${JSON.stringify(actualSubline)}`);
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
function populateDocument(doc, t, rec) {
    const errors = [];
    const reports = [];
    const subline = t.subType === "danis" ? rec.danis_subline : rec.service_subline;

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

    // Optional DANIS footer layout: not applicable -> page removed, so the
    // INDD holds exactly the exported layouts.
    if (t.subType === "danis" && !hasAddOn(rec)) {
        for (let p = doc.pages.length - 1; p >= 0; p--) {
            const page = doc.pages.item(p);
            if (pageLayout(page, t.subType).position === "footer") {
                page.remove();
                reports.push(`danis_footer page removed (DANIS ADD ON empty)`);
            }
        }
    }

    const plan = planPages(doc, t.subType);
    if (plan.problems.length) return { plan, reports, errors: plan.problems };

    // Fill every page. Each page resolves its OWN frames — nothing is cached
    // or reused across pages.
    for (const pg of plan.pages) {
        const page = doc.pages.item(pg.index);
        const where = `${pg.layout.key} ${pg.layout.size} (page ${pg.index + 1})`;
        try {
            const textDiag = setHeadlineText(doc, findHeadlineFrame(page), rec.headline, subline);
            const footerFrame = findFooterFrame(page);
            const footerDiag = footerFrame ? setFooterText(doc, footerFrame, rec.danis_addon || "") : "";
            const imageFrame = findImageFrame(page);
            if (!imageFrame) throw new Error(`no ${FRAME_NAMES.image} frame`);
            const placed = placeProductImage(imageFrame, rec.imagePath, pg.layout);
            pg.fitNote = placed.note;
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
    const summary = {
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
// can be told apart as DANIS / Service (one template per type), and that its
// pages satisfy the output rules. Throws with every problem found, before
// anything is rendered.
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
            problems.push(`${name}: more than one ${TYPE_FOLDER[subType]} template selected (one INDD per product and type)`);
            continue;
        }
        let doc = null;
        try {
            doc = await openTemplateCopy(path);
            usePoints(doc);
            let framesOk = true;
            for (let p = 0; p < doc.pages.length; p++) {
                const page = doc.pages.item(p);
                const missing = [];
                if (!findHeadlineFrame(page)) missing.push(FRAME_NAMES.text);
                if (!findImageFrame(page)) missing.push(FRAME_NAMES.image);
                if (missing.length) {
                    framesOk = false;
                    problems.push(`${name} page ${p + 1}: no ${missing.join(" / ")} frame`);
                }
            }
            if (framesOk) {
                const plan = planPages(doc, subType);
                for (const pr of plan.problems) problems.push(`${name}: ${pr}`);
                templates.push({ path, name, subType, mapping: plan.mapping });
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
    const inddPath = [outputRootPath.replace(/\/+$/, ""), "InDesign", TYPE_FOLDER[subType],
        buildInddFileName(rec, subType)].join("/");
    return { subType, inddPath };
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
async function generateIndds(manifestRows, templatePaths, outputRootPath, onProgress) {
    if (!templatePaths || !templatePaths.length) {
        throw new Error("No templates — prepare the client template in step 2 first.");
    }
    const templates = await inspectTemplates(templatePaths);
    const root = outputRootPath.replace(/\/+$/, "");
    const inddFolder = {};
    for (const t of templates) inddFolder[t.subType] = await ensureFolders(root, ["InDesign", TYPE_FOLDER[t.subType]]);

    const matchedRows = manifestRows.filter((r) => r.status === "matched");
    const run = makeRun(matchedRows.length * templates.length, onProgress);
    for (const t of templates) run.line("", `${t.name} layouts`, "", "info", t.mapping);

    const generated = [];
    const failed = [];
    const imageChecks = [];
    const imageReports = [];
    // One registry per run: identical extension plans (same source, anchor,
    // expansion and working request) are shared — one Firefly call each.
    let planRegistry = null;
    try { planRegistry = imageExt().createPlanRegistry(); } catch (e) {}
    const usedIndd = new Set();
    for (const rec of matchedRows) {
        const headline = rec.headline;
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

                const result = populateDocument(doc, t, rec);
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
                await saveWhenIdle(doc, inddPath);
                const warnings = result.reports.filter((r) => /^WARNING /.test(r)).concat(image.warnings);
                run.success(headline, label, inddPath, "populated + validated" +
                    (warnings.length ? ` (${warnings.length} warning(s))` : ""));
                generated.push({ rec, subType: t.subType, inddPath, warnings, image: image.summary });
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
    return ensureFolders(root, ["preview", TYPE_FOLDER[subType], productToken(rec.headline)]);
}

// The production folder of a template type: <root>/output/<DANIS|Service>.
function outputFolderFor(outputRootPath, subType) {
    return [outputRootPath.replace(/\/+$/, ""), "output", TYPE_FOLDER[subType]].join("/");
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
// (OUTPUT_RULES), so a DANIS INDD without a footer page yields no footer JPG.
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
            if (plan.problems.length) throw new Error("INDD layouts don't match the output rules: " + plan.problems.join(" / "));

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
                        : await ensureFolders(root, ["output", TYPE_FOLDER[subType], pg.layout.size]);
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
    if (plan.problems.length) throw new Error("INDD layouts don't match the output rules: " + plan.problems.join(" / "));

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
    const todo = pages.filter((p) => p.record.status === "extension_required");
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
    const naming = { templateType: item.subType, prefix: PROJECT_PREFIX[item.subType], year: rec.year, product: headline };
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
        units = ext.groupIntoMasterPlans(eligible.map((p) => ({ plan: p.plan, graphicBounds: p.record.graphicBounds, ref: p })))
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
    const check = checkProductPages(doc, plan);
    const appliedAny = pages.some((p) => p.applied);
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
        batchMode, warnings: check.warnings, image, newGenerations, prompt, saved: appliedAny, logLines,
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

// "danis" / "service" for a prepared template path (same rule as Render).
function typeOfTemplate(path) {
    return subTypeFromPath(path);
}

async function writeLog(logLines, logPath) {
    const lfs = require("uxp").storage.localFileSystem;
    const types = require("uxp").storage.types;
    const fileEntry = await lfs.createEntryWithUrl(fileUrl(logPath), { type: types.file, overwrite: true });
    await fileEntry.write(logLines.join("\n") + "\n");
}

module.exports = {
    checkAudiFont, generateIndds, exportFromIndds, openIndd, inddPathFor, pathExists,
    isInddOpen, closeIndd, activeDocumentPath, extendProductImage, setExtensionVisible,
    outputFolderFor, typeOfTemplate, TYPE_FOLDER, writeLog, debugModuleShape,
};
