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
// The master template file is only ever duplicated in memory, never saved over.

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
// `position` is the last part of the output file name (up / bottom / footer).
const PAGE_CONFIG = {
    "top_service":      { textPos: "texttop",    position: "up",     subType: "service", w: 1200, h: 1200 },
    "top_denis":        { textPos: "texttop",    position: "up",     subType: "denis",   w: 1200, h: 1200 },
    "bottom_denis":     { textPos: "textbottom", position: "bottom", subType: "denis",   w: 1200, h: 1200 },
    "9x16_top_service": { textPos: "texttop",    position: "up",     subType: "service", w: 1080, h: 1920 },
};

// File name prefix per subline type.
const PROJECT_PREFIX = {
    denis: "DANIS_Herbst",
    service: "Service_Herbst",
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

// Headline as used inside output file names: spaces removed (so "_" stays a
// clean field separator), trailing footnote digits dropped
// ("Ski- und Snowboardhalter1" -> "Ski-undSnowboardhalter").
function fileNameHeadline(headline) {
    let s = headline.replace(/\d+$/, "").replace(/\s+/g, "");
    s = s.replace(/[\/\\:\*\?"<>\|_]/g, "");
    return s;
}

// <DANIS_Herbst|Service_Herbst>_<year>_<headline>_<WxH>_<up|bottom|footer>.jpg
function buildOutputFileName(rec, cfg) {
    return [
        PROJECT_PREFIX[cfg.subType],
        rec.year,
        fileNameHeadline(rec.headline),
        `${cfg.w}x${cfg.h}`,
        cfg.position,
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

// ---------- main render loop ----------

// manifestRows: array from matcher.js's buildManifest() (only "matched" rows are rendered)
// masterPath: absolute path to Poster_Master.indd
// outputRootPath: absolute path to the chosen output folder
// onProgress: optional callback(current, total, message) for UI progress updates
// Returns: { successCount, errorCount, logLines: string[], failures: [{headline, label, message}] }
async function renderAll(manifestRows, masterPath, outputRootPath, onProgress) {
    const { app, SaveOptions } = indesign();
    const logLines = ["timestamp,headline,page_label,output_file,status,message"];
    const failures = [];
    if (!(await pathExists(masterPath))) {
        throw new Error("Master template not found: " + masterPath);
    }

    await ensureFolder(outputRootPath);

    const matchedRows = manifestRows.filter((r) => r.status === "matched");
    const totalOps = matchedRows.length * Object.keys(PAGE_CONFIG).length;
    let done = 0;
    let successCount = 0;
    let errorCount = 0;

    // Opening/closing the master file once per page-config (44 times for 11
    // products) caused intermittent "Object is invalid" errors — InDesign
    // doesn't always finish tearing down the previous document before the
    // next open() call lands, so roughly every other cycle got a stale
    // reference. Opening it ONCE for the whole batch and reusing the same
    // page objects (each label's page just gets its text/image overwritten
    // fresh per product, which is safe since we never save) removes the
    // open/close race entirely and is much faster besides.
    let doc = null;
    try {
        doc = app.open(masterPath, false);

        const pageByLabel = {};
        for (let p = 0; p < doc.pages.length; p++) {
            const pg = doc.pages.item(p);
            pageByLabel[pg.label] = pg;
        }

        for (const rec of matchedRows) {
            const headline = rec.headline;
            const sanitized = sanitizeHeadline(headline);
            const imagePath = rec.imagePath;

            let outDir;
            try {
                outDir = await ensureFolder(outputRootPath + "/" + sanitized);
            } catch (e) {
                // Can't create this product's output folder — skip all its
                // page configs rather than aborting the rest of the batch.
                for (const label in PAGE_CONFIG) {
                    if (!PAGE_CONFIG.hasOwnProperty(label)) continue;
                    logLines.push([new Date().toISOString(), headline, label, "", "error", String(e).replace(/,/g, ";")].join(","));
                    errorCount++;
                    failures.push({ headline, label, message: String(e) });
                    done++;
                    if (onProgress) onProgress(done, totalOps, `${headline} — ${label} (skipped)`);
                }
                continue;
            }

            for (const label in PAGE_CONFIG) {
                if (!PAGE_CONFIG.hasOwnProperty(label)) continue;
                const cfg = PAGE_CONFIG[label];
                const subline = cfg.subType === "denis" ? rec.danis_subline : rec.service_subline;
                const outFileName = buildOutputFileName(rec, cfg);
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

                    logLines.push([new Date().toISOString(), headline, label, outPath, "success", ""].join(","));
                    successCount++;
                } catch (e) {
                    logLines.push([new Date().toISOString(), headline, label, outPath, "error", String(e).replace(/,/g, ";")].join(","));
                    errorCount++;
                    failures.push({ headline, label, message: String(e) });
                }

                done++;
                if (onProgress) onProgress(done, totalOps, `${headline} — ${label}`);
            }
        }
    } finally {
        try {
            if (doc) doc.close(SaveOptions.no);
        } catch (closeErr) {}
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
