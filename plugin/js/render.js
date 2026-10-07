// render.js — fills the templates prepared by datamerge.js (step 0,
// <name>_DataMerge.indd) with each product from the panel's manifest rows
// (matcher.js) and exports every page as a JPG.
//
// Template contract (written by datamerge.js's Prepare step):
//   <<Headline>>  : 1st non-empty paragraph = headline,
//                   2nd non-empty paragraph = DANIS or SERVICE subline
//   <<Footer>>    : optional, whole text = DANIS ADD ON
//   <<MainImage>> : product image
// Pages need no labels: size comes from the page itself, DANIS vs Service
// from the template's file name (same rule as datamerge.js).
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
    denis: "DANIS_Herbst",
    service: "Service_Herbst",
};

// Frame names written by datamerge.js's Prepare step.
const FRAME_NAMES = { text: "<<Headline>>", footer: "<<Footer>>", image: "<<MainImage>>" };

// Pages up to this size (px at the 72 dpi export) are named "thumbnail".
const THUMBNAIL_MAX = 250;

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
                message: `Audi Type font not installed (status=${status}) — install from ` +
                    "01_Assets/_CI Assets/Audi-CI-Guide/ before rendering.",
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

// ---------- helpers (ported 1:1 from 02_generate_posters.jsx) ----------

function sanitizeHeadline(headline) {
    let s = headline.replace(/\s+/g, "_");
    s = s.replace(/[\/\\:\*\?"<>\|]/g, "");
    return s;
}

// Headline as used inside output file names: spaces removed (so "_" stays a
// clean field separator), trailing footnote digits dropped
// ("Ski- und Snowboardhalter1" -> "Ski-undSnowboardhalter").
function fileNameHeadline(headline) {
    let s = headline.replace(/\d+$/, "").replace(/\s+/g, "");
    s = s.replace(/[\/\\:\*\?"<>\|_]/g, "");
    return s;
}

// <DANIS_Herbst|Service_Herbst>_<year>_<headline>_<WxH>_<up|bottom|footer|thumbnail>.jpg
function buildOutputFileName(rec, layout) {
    return [
        PROJECT_PREFIX[layout.subType],
        rec.year,
        fileNameHeadline(rec.headline),
        `${layout.w}x${layout.h}`,
        layout.position,
    ].join("_") + ".jpg";
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

// "DANIS" vs "Service" from the template's file name (same rule as
// datamerge.js). The name of the opened copy can't be used: OPEN_COPY makes
// it "Untitled-N".
function subTypeFromPath(path) {
    const n = String(path).split("/").pop().toLowerCase();
    if (n.indexOf("service") !== -1) return "service";
    if (n.indexOf("denis") !== -1 || n.indexOf("danis") !== -1) return "denis";
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

// { subType, w, h, position } for one template page.
//   thumbnail : page no larger than THUMBNAIL_MAX
//   footer    : page has a <<Footer>> frame (layout with a top and a bottom part)
//   up/bottom : headline frame in the upper / lower half of the page
function pageLayout(page, subType) {
    const b = page.bounds; // [y1, x1, y2, x2]
    const w = Math.round(Number(b[3]) - Number(b[1]));
    const h = Math.round(Number(b[2]) - Number(b[0]));
    let position;
    if (w <= THUMBNAIL_MAX && h <= THUMBNAIL_MAX) {
        position = "thumbnail";
    } else if (findFooterFrame(page)) {
        position = "footer";
    } else {
        const g = findHeadlineFrame(page).geometricBounds;
        const frameMid = (Number(g[0]) + Number(g[2])) / 2;
        const pageMid = (Number(b[0]) + Number(b[2])) / 2;
        position = frameMid < pageMid ? "up" : "bottom";
    }
    return { subType, w, h, position };
}

// ---------- text replacement ----------
//
// Same story-offset approach as datamerge.js (ranges and paragraph objects
// held across an edit come back "Object is invalid" in this UXP DOM). The
// first old character is overwritten rather than deleted, so the new text
// keeps the template's formatting; the paragraph return is kept.

function endsWithReturn(text) {
    try {
        const chars = text.characters;
        return chars.length > 0 && String(chars.item(chars.length - 1).contents) === "\r";
    } catch (e) {
        return false;
    }
}

function paragraphText(para) {
    return String(para.contents).replace(/[\r\n\u2028\u2029]/g, "").trim();
}

function nonEmptyParagraphs(frame) {
    const out = [];
    const paras = frame.paragraphs;
    for (let i = 0; i < paras.length; i++) {
        if (paragraphText(paras.item(i)) !== "") out.push(i);
    }
    return out;
}

function replaceRange(story, start, count, text) {
    if (count > 0 && text) {
        story.characters.item(start).contents = text;
        for (let k = 1; k < count; k++) story.characters.item(start + text.length).remove();
    } else if (count > 0) {
        for (let k = 0; k < count; k++) story.characters.item(start).remove();
    } else if (text) {
        story.insertionPoints.item(start).contents = text;
    }
}

function setParagraphText(frame, paraIndex, text) {
    const para = frame.paragraphs.item(paraIndex);
    const count = para.characters.length - (endsWithReturn(para) ? 1 : 0);
    replaceRange(para.parentStory, para.index, count, text);
}

// Headline + subline into <<Headline>>. Subline first: it sits later in the
// story, so the headline's paragraph index stays valid.
function setHeadlineText(frame, headline, subline) {
    const idx = nonEmptyParagraphs(frame);
    if (!idx.length) throw new Error(FRAME_NAMES.text + " is empty — re-run Prepare (step 0)");
    if (idx.length > 1) setParagraphText(frame, idx[1], subline);
    setParagraphText(frame, idx[0], headline);
}

// Whole <<Footer>> text (from its first non-empty paragraph) -> `text`.
function setFooterText(frame, text) {
    const idx = nonEmptyParagraphs(frame);
    const story = frame.parentStory;
    if (!idx.length) {
        replaceRange(story, frame.insertionPoints.item(0).index, 0, text);
        return;
    }
    const start = frame.paragraphs.item(idx[0]).index;
    const paras = frame.paragraphs;
    const last = paras.item(paras.length - 1);
    const end = last.index + last.characters.length - (endsWithReturn(last) ? 1 : 0);
    replaceRange(story, start, end - start, text);
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

function exportPageAsJPEG(doc, page, outputPath) {
    const { app, ExportFormat, ExportRangeOrAllPages, JpegColorSpaceEnum, JPEGOptionsQuality } = indesign();
    app.jpegExportPreferences.exportResolution = 72;
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

function closeWithoutSaving(doc) {
    const { SaveOptions } = indesign();
    try {
        if (doc && doc.isValid !== false) doc.close(SaveOptions.NO || SaveOptions.no);
    } catch (closeErr) {}
}

function samePath(a, b) {
    return String(a).replace(/\/+$/, "").toLowerCase() === String(b).replace(/\/+$/, "").toLowerCase();
}

// ---------- main render loop ----------

// Opens each template once up front: checks it was prepared by datamerge.js
// and can be told apart as DANIS / Service, and counts its pages for the
// progress bar. Throws with every problem found, before anything is rendered.
async function inspectTemplates(templatePaths) {
    const templates = [];
    const problems = [];
    for (const path of templatePaths) {
        const name = path.split("/").pop();
        if (!(await pathExists(path))) { problems.push(`${name}: file not found`); continue; }
        const subType = subTypeFromPath(path);
        if (!subType) {
            problems.push(`${name}: file name must contain "Service" or "DANIS"/"Denis"`);
            continue;
        }
        let doc = null;
        try {
            doc = await openTemplateCopy(path);
            const pageCount = doc.pages.length;
            for (let p = 0; p < pageCount; p++) {
                const page = doc.pages.item(p);
                const missing = [];
                if (!findHeadlineFrame(page)) missing.push(FRAME_NAMES.text);
                if (!findImageFrame(page)) missing.push(FRAME_NAMES.image);
                if (missing.length) problems.push(`${name} page ${p + 1}: no ${missing.join(" / ")} frame`);
            }
            templates.push({ path, name, subType, pageCount });
        } catch (e) {
            problems.push(`${name}: could not open (${e})`);
        } finally {
            closeWithoutSaving(doc);
            await settle(250);
        }
    }
    if (problems.length) {
        throw new Error(
            "Template check failed — select the <name>_DataMerge.indd files made by step 0 (Prepare):\n  " +
            problems.join("\n  ")
        );
    }
    return templates;
}

// manifestRows: array from matcher.js's buildManifest() (only "matched" rows are rendered)
// templatePaths: absolute paths to the prepared <name>_DataMerge.indd files
// outputRootPath: absolute path to the chosen output folder
// onProgress: optional callback(current, total, message) for UI progress updates
// Returns: { successCount, errorCount, logLines: string[], failures: [{headline, label, message}] }
//
// Per product and template: a fresh copy of the template is opened, every
// page is filled and exported to JPG, the copy is saved as an editable
// <product>_<DANIS|Service>.indd into the product's output folder, then
// closed. The template files themselves are never saved.
async function renderAll(manifestRows, templatePaths, outputRootPath, onProgress) {
    const logLines = ["timestamp,headline,page_label,output_file,status,message"];
    const failures = [];
    if (!templatePaths || !templatePaths.length) {
        throw new Error("No templates selected — pick the <name>_DataMerge.indd files made by step 0.");
    }

    const templates = await inspectTemplates(templatePaths);
    await ensureFolder(outputRootPath);

    const matchedRows = manifestRows.filter((r) => r.status === "matched");
    // One op per page JPG plus one per template INDD save, per product.
    const opsPerProduct = templates.reduce((n, t) => n + t.pageCount + 1, 0);
    const totalOps = matchedRows.length * opsPerProduct;
    let done = 0;
    let successCount = 0;
    let errorCount = 0;

    const logSuccess = (headline, label, outPath, note) => {
        logLines.push([new Date().toISOString(), headline, label, outPath, "success", note || ""].join(","));
        successCount++;
    };
    const logError = (headline, label, outPath, e) => {
        logLines.push([new Date().toISOString(), headline, label, outPath, "error", String(e).replace(/,/g, ";")].join(","));
        errorCount++;
        failures.push({ headline, label, message: String(e) });
    };
    const tick = (message) => {
        done++;
        if (onProgress) onProgress(done, totalOps, message);
    };
    // Marks every remaining op of one template (its pages + the INDD) as failed.
    const skipTemplate = (headline, t, e) => {
        for (let p = 0; p < t.pageCount; p++) {
            logError(headline, `${t.name} p${p + 1}`, "", e);
            tick(`${headline} — ${t.name} p${p + 1} (skipped)`);
        }
        logError(headline, `${t.name} indd`, "", e);
        tick(`${headline} — ${t.name} indd (skipped)`);
    };

    for (const rec of matchedRows) {
        const headline = rec.headline;
        const sanitized = sanitizeHeadline(headline);

        let outDir;
        try {
            outDir = await ensureFolder(outputRootPath + "/" + sanitized);
        } catch (e) {
            // Can't create this product's output folder — skip it rather
            // than aborting the rest of the batch.
            for (const t of templates) skipTemplate(headline, t, e);
            continue;
        }

        const usedNames = new Set();
        for (const t of templates) {
            const subline = t.subType === "denis" ? rec.danis_subline : rec.service_subline;
            const inddPath = outDir.nativePath + "/" + sanitized + "_" +
                (t.subType === "denis" ? "DANIS" : "Service") + ".indd";
            if (templatePaths.some((tp) => samePath(tp, inddPath))) {
                skipTemplate(headline, t, new Error("Refusing to overwrite template: " + inddPath));
                continue;
            }

            let doc = null;
            try {
                try {
                    doc = await openTemplateCopy(t.path);
                } catch (e) {
                    skipTemplate(headline, t, new Error("Could not open template: " + e));
                    continue;
                }
                usePoints(doc);
                unlockAll(doc);

                for (let p = 0; p < doc.pages.length; p++) {
                    const label = `${t.name} p${p + 1}`;
                    let outPath = "";
                    try {
                        const page = doc.pages.item(p);
                        const layout = pageLayout(page, t.subType);

                        // Two pages with the same size + position get -2, -3…
                        let outFileName = buildOutputFileName(rec, layout);
                        for (let n = 2; usedNames.has(outFileName); n++) {
                            outFileName = buildOutputFileName(rec, { ...layout, position: `${layout.position}-${n}` });
                        }
                        usedNames.add(outFileName);
                        outPath = outDir.nativePath + "/" + outFileName;

                        setHeadlineText(findHeadlineFrame(page), headline, subline);
                        const footer = findFooterFrame(page);
                        if (footer) setFooterText(footer, rec.danis_addon || "");
                        const fitNote = placeImageFill(findImageFrame(page), rec.imagePath);

                        exportPageAsJPEG(doc, page, outPath);
                        logSuccess(headline, label, outPath, fitNote);
                    } catch (e) {
                        logError(headline, label, outPath, e);
                    }
                    tick(`${headline} — ${label}`);
                }

                // Save-as to the product folder: writes a new file and leaves
                // the template untouched.
                try {
                    doc.save(inddPath);
                    logSuccess(headline, `${t.name} indd`, inddPath);
                } catch (e) {
                    logError(headline, `${t.name} indd`, inddPath, e);
                }
                tick(`${headline} — ${t.name} indd`);
            } finally {
                closeWithoutSaving(doc);
                await settle(250);
            }
        }
    }

    return { successCount, errorCount, logLines, failures };
}

async function writeLog(logLines, logPath) {
    const lfs = require("uxp").storage.localFileSystem;
    const types = require("uxp").storage.types;
    const fileEntry = await lfs.createEntryWithUrl(fileUrl(logPath), { type: types.file, overwrite: true });
    await fileEntry.write(logLines.join("\n") + "\n");
}

module.exports = { checkAudiFont, renderAll, writeLog, debugModuleShape };
