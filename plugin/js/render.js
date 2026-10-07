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

// Page label -> output config.
//
// Two source INDD files are expected:
//   Service_Template.indd -> 7 labelled pages
//   Denis_Template.indd   -> 3 labelled pages
//
// All normal layouts keep headline + subline in the same <<Headline>> frame.
// The Denis split layout uses two frames: <<Headline>> and <<Subline>>.
//
// `position` is the last part of the output file name (up / bottom / footer).
// The two Service 1200x1200 top variants get up-a / up-b so they never
// overwrite each other.
const PAGE_CONFIG = {
    "service_1200x1200_top_a": { textPos: "texttop",    position: "up-a",   subType: "service", textLayout: "stacked", w: 1200, h: 1200 },
    "service_1200x1200_top_b": { textPos: "texttop",    position: "up-b",   subType: "service", textLayout: "stacked", w: 1200, h: 1200 },
    "service_1080x1920_top":   { textPos: "texttop",    position: "up",     subType: "service", textLayout: "stacked", w: 1080, h: 1920 },
    "service_1080x1920_bottom":{ textPos: "textbottom", position: "bottom", subType: "service", textLayout: "stacked", w: 1080, h: 1920 },
    "service_800x600_top":     { textPos: "texttop",    position: "up",     subType: "service", textLayout: "stacked", w: 800,  h: 600  },
    "service_800x600_bottom":  { textPos: "textbottom", position: "bottom", subType: "service", textLayout: "stacked", w: 800,  h: 600  },
    "service_250x250_top":     { textPos: "texttop",    position: "up",     subType: "service", textLayout: "stacked", w: 250,  h: 250  },

    "denis_1200x1200_top":     { textPos: "texttop",    position: "up",     subType: "denis",   textLayout: "stacked", w: 1200, h: 1200 },
    "denis_1200x1200_bottom":  { textPos: "textbottom", position: "bottom", subType: "denis",   textLayout: "stacked", w: 1200, h: 1200 },
    "denis_1200x1200_split":   { textPos: "split",      position: "footer", subType: "denis",   textLayout: "split",   w: 1200, h: 1200 },
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

function findSublineFrame(page) {
    return findItemByName(page.allPageItems, "<<Subline>>");
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

function setSplitText(headlineFrame, sublineFrame, headline, subline) {
    headlineFrame.contents = headline;
    sublineFrame.contents = subline;
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

// ---------- main render loop ----------

// manifestRows: array from matcher.js's buildManifest() (only "matched" rows are rendered)
// templatePaths: one path or an array of .indd template paths. The new workflow
//                passes Service_Template.indd + Denis_Template.indd directly.
// outputRootPath: absolute path to the chosen output folder
// onProgress: optional callback(current, total, message) for UI progress updates
// Returns: { successCount, errorCount, logLines: string[], failures: [{headline, label, message}] }
async function renderAll(manifestRows, templatePaths, outputRootPath, onProgress) {
    const { app, SaveOptions } = indesign();
    const logLines = ["timestamp,headline,page_label,output_file,status,message"];
    const failures = [];

    const paths = Array.isArray(templatePaths) ? templatePaths : [templatePaths];
    const cleanPaths = paths.filter(Boolean);
    if (cleanPaths.length === 0) {
        throw new Error("No InDesign template file was provided.");
    }
    for (const path of cleanPaths) {
        if (!(await pathExists(path))) {
            throw new Error("Template not found: " + path);
        }
    }

    await ensureFolder(outputRootPath);

    const matchedRows = manifestRows.filter((r) => r.status === "matched");
    const totalOps = matchedRows.length * Object.keys(PAGE_CONFIG).length;
    let done = 0;
    let successCount = 0;
    let errorCount = 0;

    // Open each selected template only once. Pages can come from either the
    // Service or Denis INDD; page labels are the stable IDs used below.
    const docs = [];
    try {
        const pageByLabel = {};
        const duplicateLabels = [];

        for (const path of cleanPaths) {
            const doc = app.open(path, false);
            docs.push(doc);

            for (let p = 0; p < doc.pages.length; p++) {
                const pg = doc.pages.item(p);
                const label = String(pg.label || "");
                if (!label) continue;
                if (pageByLabel[label]) duplicateLabels.push(label);
                pageByLabel[label] = { page: pg, doc };
            }
        }

        if (duplicateLabels.length) {
            throw new Error("Duplicate page label(s) across template files: " + [...new Set(duplicateLabels)].join(", "));
        }

        const missingLabels = Object.keys(PAGE_CONFIG).filter((label) => !pageByLabel[label]);
        if (missingLabels.length) {
            throw new Error(
                "Template page label(s) missing: " + missingLabels.join(", ") +
                ". Check Service_Template.indd / Denis_Template.indd page labels."
            );
        }

        for (const rec of matchedRows) {
            const headline = rec.headline;
            const sanitized = sanitizeHeadline(headline);
            const imagePath = rec.imagePath;

            let outDir;
            try {
                outDir = await ensureFolder(outputRootPath + "/" + sanitized);
            } catch (e) {
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
                    const target = pageByLabel[label];
                    const targetPage = target.page;
                    const targetDoc = target.doc;

                    const allItems = targetPage.allPageItems;
                    for (let ai = 0; ai < allItems.length; ai++) {
                        itemAt(allItems, ai).visible = true;
                    }

                    const headlineFrame = findHeadlineFrame(targetPage);
                    if (!headlineFrame) {
                        throw new Error("<<Headline>> frame not found on page " + label);
                    }

                    if (cfg.textLayout === "split") {
                        const sublineFrame = findSublineFrame(targetPage);
                        if (!sublineFrame) {
                            throw new Error("<<Subline>> frame not found on split page " + label);
                        }
                        setSplitText(headlineFrame, sublineFrame, headline, subline);
                    } else {
                        setHeadlineText(headlineFrame, headline, subline);
                    }

                    const imageFrame = findImageFrame(targetPage);
                    if (!imageFrame) throw new Error("<<MainImage>> frame not found on page " + label);
                    const fitNote = placeImageFill(imageFrame, imagePath);

                    exportPageAsJPEG(targetDoc, targetPage, outPath);

                    logLines.push([new Date().toISOString(), headline, label, outPath, "success", fitNote].join(","));
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
        for (let i = docs.length - 1; i >= 0; i--) {
            try { docs[i].close(SaveOptions.no); } catch (closeErr) {}
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
