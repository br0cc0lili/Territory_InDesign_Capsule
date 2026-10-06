// Batch poster generator.
// Reads 02_System/data/manifest.csv, renders 4 poster variants per matched row
// from 02_System/templates/Poster_Master.indd, exports JPGs into
// 02_System/output/<headline>/, and logs to 02_System/logs/generation_log.csv.
//
// The master template file is only ever duplicated in memory, never saved over.

app.scriptPreferences.userInteractionLevel = UserInteractionLevels.neverInteract;

var ROOT = "/Users/wpp88766/code/Bertelsmann_ID_Plugin";
var MASTER_PATH = ROOT + "/02_System/templates/Poster_Master.indd";
var MANIFEST_PATH = ROOT + "/02_System/data/manifest.csv";
var OUTPUT_ROOT = ROOT + "/02_System/output";
var LOG_PATH = ROOT + "/02_System/logs/generation_log.csv";

var PLACEHOLDER_HEADLINE = "<<DANIS + SERVICE HEADLINE>>";
var PLACEHOLDER_DANIS = "<<DANIS SUBLINE>>";
var PLACEHOLDER_SERVICE = "<<SERVICE SUBLINE>>";

// Page label -> output config
var PAGE_CONFIG = {
    "top_service":       { textPos: "texttop",    subType: "service", w: 1200, h: 1200 },
    "top_denis":         { textPos: "texttop",    subType: "denis",   w: 1200, h: 1200 },
    "bottom_denis":      { textPos: "textbottom", subType: "denis",   w: 1200, h: 1200 },
    "9x16_top_service":  { textPos: "texttop",    subType: "service", w: 1080, h: 1920 }
};

// ---------- helpers ----------

function readTextFile(path) {
    var f = File(path);
    f.encoding = "UTF-8";
    f.open("r");
    var content = f.read();
    f.close();
    return content;
}

function parseCSV(text) {
    // Minimal RFC4180-ish CSV parser: handles quoted fields with embedded commas/newlines.
    var rows = [];
    var row = [];
    var field = "";
    var inQuotes = false;
    var i = 0;
    var len = text.length;
    // normalize line endings
    text = text.replace(/\r\n/g, "\n").replace(/\r/g, "\n");
    len = text.length;
    while (i < len) {
        var c = text.charAt(i);
        if (inQuotes) {
            if (c === '"') {
                if (text.charAt(i + 1) === '"') {
                    field += '"';
                    i += 2;
                    continue;
                } else {
                    inQuotes = false;
                    i++;
                    continue;
                }
            } else {
                field += c;
                i++;
                continue;
            }
        } else {
            if (c === '"') {
                inQuotes = true;
                i++;
                continue;
            } else if (c === ',') {
                row.push(field);
                field = "";
                i++;
                continue;
            } else if (c === '\n') {
                row.push(field);
                rows.push(row);
                row = [];
                field = "";
                i++;
                continue;
            } else {
                field += c;
                i++;
                continue;
            }
        }
    }
    // last field/row
    if (field.length > 0 || row.length > 0) {
        row.push(field);
        rows.push(row);
    }
    return rows;
}

function csvRowsToObjects(rows) {
    var headers = rows[0];
    var objects = [];
    for (var r = 1; r < rows.length; r++) {
        if (rows[r].length === 1 && rows[r][0] === "") continue; // skip blank trailing row
        var obj = {};
        for (var c = 0; c < headers.length; c++) {
            obj[headers[c]] = rows[r][c] !== undefined ? rows[r][c] : "";
        }
        objects.push(obj);
    }
    return objects;
}

function sanitizeHeadline(headline) {
    // spaces -> underscore, keep umlauts/hyphens, strip characters that are unsafe in filenames
    var s = headline.replace(/\s+/g, "_");
    s = s.replace(/[\/\\:\*\?"<>\|]/g, "");
    return s;
}

function ensureFolder(path) {
    var f = Folder(path);
    if (!f.exists) f.create();
    return f;
}

function findItemByName(items, name) {
    for (var i = 0; i < items.length; i++) {
        try {
            if (items[i].name === name) return items[i];
        } catch (e) {}
    }
    return null;
}

function findImageFrame(page) {
    var items = page.allPageItems;
    var named = findItemByName(items, "<<MainImage>>");
    if (named) return named;
    // fallback: the single full-bleed rectangle that is not the headline text frame
    for (var i = 0; i < items.length; i++) {
        var it = items[i];
        if (it.constructor.name === "TextFrame") continue;
        return it; // first non-text item
    }
    return null;
}

function findHeadlineFrame(page) {
    var items = page.allPageItems;
    return findItemByName(items, "<<Headline>>");
}

function setHeadlineText(frame, headline, subline) {
    // Preserve existing paragraph-level formatting by editing contents per paragraph.
    frame.paragraphs[0].contents = headline;
    if (frame.paragraphs.length > 1) {
        frame.paragraphs[1].contents = subline;
    } else {
        frame.insertionPoints[-1].contents = "\r" + subline;
    }
}

function placeImageFill(frame, imagePath) {
    var imgFile = File(imagePath);
    if (!imgFile.exists) {
        throw new Error("Image file not found: " + imagePath);
    }
    frame.place(imgFile);
    frame.fit(FitOptions.FILL_PROPORTIONALLY);
    frame.fit(FitOptions.CENTER_CONTENT);
}

function exportPageAsJPEG(doc, page, outputFile, pxWidth) {
    // Isolate export to just this page
    app.jpegExportPreferences.exportResolution = 72; // page units are already in px (points==px here)
    app.jpegExportPreferences.jpegQuality = JPEGOptionsQuality.MAXIMUM;
    app.jpegExportPreferences.jpegColorSpace = JpegColorSpaceEnum.RGB;
    app.jpegExportPreferences.jpegExportRange = ExportRangeOrAllPages.EXPORT_RANGE;
    app.jpegExportPreferences.pageString = String(page.documentOffset + 1);

    doc.exportFile(ExportFormat.JPG, outputFile, false);
}

// ---------- main ----------

function main() {
    var logLines = ["timestamp,headline,page_label,output_file,status,message"];
    var manifestText = readTextFile(MANIFEST_PATH);
    var rows = csvRowsToObjects(parseCSV(manifestText));

    var masterFile = File(MASTER_PATH);
    if (!masterFile.exists) {
        throw new Error("Master template not found: " + MASTER_PATH);
    }

    ensureFolder(OUTPUT_ROOT);
    ensureFolder(ROOT + "/02_System/logs");

    var successCount = 0;
    var errorCount = 0;

    for (var r = 0; r < rows.length; r++) {
        var rec = rows[r];
        if (rec.status !== "matched") continue;

        var headline = rec.headline;
        var sanitized = sanitizeHeadline(headline);
        var imagePath = ROOT + "/" + rec.image_path;
        var outDir = ensureFolder(OUTPUT_ROOT + "/" + sanitized);

        for (var label in PAGE_CONFIG) {
            if (!PAGE_CONFIG.hasOwnProperty(label)) continue;
            var cfg = PAGE_CONFIG[label];
            var subline = (cfg.subType === "denis") ? rec.danis_subline : rec.service_subline;
            var outFileName = sanitized + "_" + cfg.textPos + "_" + cfg.subType + "_" + cfg.w + "x" + cfg.h + ".jpg";
            var outFile = File(outDir.fsName + "/" + outFileName);

            var doc = null;
            try {
                doc = app.open(masterFile, false);

                // find the target page by label
                var targetPage = null;
                for (var p = 0; p < doc.pages.length; p++) {
                    if (doc.pages[p].label === label) { targetPage = doc.pages[p]; break; }
                }
                if (!targetPage) throw new Error("Page label not found: " + label);

                // Defensive: template items should always be visible; force it in case
                // a design-time hidden state slips through.
                var allItems = targetPage.allPageItems;
                for (var ai = 0; ai < allItems.length; ai++) { allItems[ai].visible = true; }

                var headlineFrame = findHeadlineFrame(targetPage);
                if (!headlineFrame) throw new Error("Headline frame not found on page " + label);
                setHeadlineText(headlineFrame, headline, subline);

                var imageFrame = findImageFrame(targetPage);
                if (!imageFrame) throw new Error("Image frame not found on page " + label);
                placeImageFill(imageFrame, imagePath);

                exportPageAsJPEG(doc, targetPage, outFile, cfg.w);

                logLines.push([new Date().toISOString ? new Date().toISOString() : String(new Date()), headline, label, outFile.fsName, "success", ""].join(","));
                successCount++;
            } catch (e) {
                logLines.push([String(new Date()), headline, label, outFile.fsName, "error", ("" + e).replace(/,/g, ";")].join(","));
                errorCount++;
            } finally {
                if (doc) {
                    doc.close(SaveOptions.no);
                }
            }
        }
    }

    var logFile = File(LOG_PATH);
    logFile.encoding = "UTF-8";
    logFile.open("w");
    logFile.write(logLines.join("\n") + "\n");
    logFile.close();

    return "DONE success=" + successCount + " errors=" + errorCount;
}

main();
