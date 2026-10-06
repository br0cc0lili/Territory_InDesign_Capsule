// render.js — UXP port of 02_System/scripts/02_generate_posters.jsx
//
// Same PAGE_CONFIG, same placeholder names, same defensive visibility pass,
// same setHeadlineText/placeImageFill/JPEG export settings and naming
// convention as the proven CLI render script — just driven from the panel's
// in-memory manifest rows (from matcher.js) instead of manifest.csv, and
// using require("indesign") instead of ExtendScript globals.
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
// The master template file is never saved over: each product opens its own
// copy, which is saved-as into that product's output folder and then closed.

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

// Page label -> output config (identical to 02_generate_posters.jsx)
const PAGE_CONFIG = {
    "top_service":      { textPos: "texttop",    subType: "service", w: 1200, h: 1200 },
    "top_denis":        { textPos: "texttop",    subType: "denis",   w: 1200, h: 1200 },
    "bottom_denis":     { textPos: "textbottom", subType: "denis",   w: 1200, h: 1200 },
    "9x16_top_service": { textPos: "texttop",    subType: "service", w: 1080, h: 1920 },
};

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

function findImageFrame(page) {
    const items = page.allPageItems;
    const named = findItemByName(items, "<<MainImage>>");
    if (named) return named;
    for (let i = 0; i < items.length; i++) {
        const it = itemAt(items, i);
        if (it.constructor.name === "TextFrame") continue;
        return it;
    }
    return null;
}

function findHeadlineFrame(page) {
    return findItemByName(page.allPageItems, "<<Headline>>");
}

function setHeadlineText(frame, headline, subline) {
    itemAt(frame.paragraphs, 0).contents = headline;
    if (frame.paragraphs.length > 1) {
        itemAt(frame.paragraphs, 1).contents = subline;
    } else {
        const ips = frame.insertionPoints;
        itemAt(ips, ips.length - 1).contents = "\r" + subline;
    }
}

function placeImageFill(frame, imagePath) {
    frame.place(imagePath);
    frame.fit(indesign().FitOptions.FILL_PROPORTIONALLY);
    frame.fit(indesign().FitOptions.CENTER_CONTENT);
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

// Opens a fresh, independent working copy of the master template. Prefers
// OpenOptions.OPEN_COPY (an untitled doc with no link back to the master
// file, so even an accidental doc.save() can't touch it); falls back to a
// normal open if that enum isn't exposed in this InDesign version — the
// workflow below only ever save-as's to a new path, so the master is still
// never written either way.
async function openMasterCopy(masterPath) {
    const { app, OpenOptions } = indesign();
    const openCopy = OpenOptions && OpenOptions.OPEN_COPY;
    let lastErr = null;
    // One retry: the very first open after a close is the one most likely to
    // hit a half-torn-down previous document.
    for (let attempt = 0; attempt < 2; attempt++) {
        try {
            return openCopy ? app.open(masterPath, false, openCopy) : app.open(masterPath, false);
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

// manifestRows: array from matcher.js's buildManifest() (only "matched" rows are rendered)
// masterPath: absolute path to Poster_Master.indd
// outputRootPath: absolute path to the chosen output folder
// onProgress: optional callback(current, total, message) for UI progress updates
// Returns: { successCount, errorCount, logLines: string[], failures: [{headline, label, message}] }
//
// Each product gets its own document: a fresh copy of the master is opened,
// populated, exported to JPG (one per PAGE_CONFIG label), saved as an
// editable <product>.indd into that product's output folder, then closed
// before the next product starts. The master template itself is never saved.
async function renderAll(manifestRows, masterPath, outputRootPath, onProgress) {
    const logLines = ["timestamp,headline,page_label,output_file,status,message"];
    const failures = [];
    if (!(await pathExists(masterPath))) {
        throw new Error("Master template not found: " + masterPath);
    }

    await ensureFolder(outputRootPath);

    const labels = Object.keys(PAGE_CONFIG);
    const matchedRows = manifestRows.filter((r) => r.status === "matched");
    // One op per JPG plus one for the product's INDD save.
    const totalOps = matchedRows.length * (labels.length + 1);
    let done = 0;
    let successCount = 0;
    let errorCount = 0;

    const logSuccess = (headline, label, outPath) => {
        logLines.push([new Date().toISOString(), headline, label, outPath, "success", ""].join(","));
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
    // Marks every remaining op for a product (all JPG labels + the INDD) as failed.
    const skipProduct = (headline, e) => {
        for (const label of labels) {
            logError(headline, label, "", e);
            tick(`${headline} — ${label} (skipped)`);
        }
        logError(headline, "indd", "", e);
        tick(`${headline} — indd (skipped)`);
    };

    for (const rec of matchedRows) {
        const headline = rec.headline;
        const sanitized = sanitizeHeadline(headline);
        const imagePath = rec.imagePath;

        let outDir;
        try {
            outDir = await ensureFolder(outputRootPath + "/" + sanitized);
        } catch (e) {
            // Can't create this product's output folder — skip it rather
            // than aborting the rest of the batch.
            skipProduct(headline, e);
            continue;
        }

        const inddPath = outDir.nativePath + "/" + sanitized + ".indd";
        if (samePath(inddPath, masterPath)) {
            skipProduct(headline, new Error("Refusing to overwrite master template: " + inddPath));
            continue;
        }

        let doc = null;
        try {
            try {
                doc = await openMasterCopy(masterPath);
            } catch (e) {
                skipProduct(headline, new Error("Could not open master template: " + e));
                continue;
            }

            // Page references are per-document, so resolve them fresh for
            // every product's copy.
            const pageByLabel = {};
            for (let p = 0; p < doc.pages.length; p++) {
                const pg = doc.pages.item(p);
                pageByLabel[pg.label] = pg;
            }

            for (const label of labels) {
                const cfg = PAGE_CONFIG[label];
                const subline = cfg.subType === "denis" ? rec.danis_subline : rec.service_subline;
                const outFileName = `${sanitized}_${cfg.textPos}_${cfg.subType}_${cfg.w}x${cfg.h}.jpg`;
                const outPath = outDir.nativePath + "/" + outFileName;

                try {
                    const targetPage = pageByLabel[label];
                    if (!targetPage) throw new Error("Page label not found: " + label);

                    const allItems = targetPage.allPageItems;
                    for (let ai = 0; ai < allItems.length; ai++) { itemAt(allItems, ai).visible = true; }

                    const headlineFrame = findHeadlineFrame(targetPage);
                    if (!headlineFrame) throw new Error("Headline frame not found on page " + label);
                    setHeadlineText(headlineFrame, headline, subline);

                    const imageFrame = findImageFrame(targetPage);
                    if (!imageFrame) throw new Error("Image frame not found on page " + label);
                    placeImageFill(imageFrame, imagePath);

                    exportPageAsJPEG(doc, targetPage, outPath);
                    logSuccess(headline, label, outPath);
                } catch (e) {
                    logError(headline, label, outPath, e);
                }
                tick(`${headline} — ${label}`);
            }

            // Save-as to the product folder: writes a new file and leaves the
            // master template untouched.
            try {
                doc.save(inddPath);
                logSuccess(headline, "indd", inddPath);
            } catch (e) {
                logError(headline, "indd", inddPath, e);
            }
            tick(`${headline} — indd`);
        } finally {
            closeWithoutSaving(doc);
            await settle(250);
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

module.exports = { checkAudiFont, renderAll, writeLog, PAGE_CONFIG, debugModuleShape };
