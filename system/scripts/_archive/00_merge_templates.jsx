// Merge the 4 separate template .indd files into one Poster_Master.indd with 4 labeled pages.
// Run once. Source templates are left untouched.

app.scriptPreferences.userInteractionLevel = UserInteractionLevels.neverInteract;

var srcFolder = Folder("/Users/wpp88766/code/Bertelsmann_ID_Plugin/testingfile");
var outFolder = Folder("/Users/wpp88766/code/Bertelsmann_ID_Plugin/02_System/templates");
var logFile = File(outFolder.fsName + "/merge_log.txt");
logFile.encoding = "UTF-8";
logFile.open("w");

var sources = [
    { file: "case2-template-1-1top-Service 1.indd",   label: "top_service",     w: 1200, h: 1200 },
    { file: "case2-template-1-1top-denis 1.indd",     label: "top_denis",       w: 1200, h: 1200 },
    { file: "case2-template-1-1bottom-denis 1.indd",  label: "bottom_denis",    w: 1200, h: 1200 },
    { file: "case2-template-9-16top-denis 1.indd",    label: "9x16_top_service",w: 1080, h: 1920 }
];

// Create target document with 4 pages, single-page spreads (facing pages off)
var target = app.documents.add();
target.documentPreferences.facingPages = false;
target.documentPreferences.pageWidth = sources[0].w;
target.documentPreferences.pageHeight = sources[0].h;

while (target.pages.length < sources.length) {
    target.pages.add();
}

for (var i = 0; i < sources.length; i++) {
    var cfg = sources[i];
    var targetPage = target.pages[i];

    // Resize this specific page (mixed page sizes in one doc)
    targetPage.resize(
        CoordinateSpaces.INNER_COORDINATES,
        AnchorPoint.TOP_LEFT_ANCHOR,
        ResizeMethods.REPLACING_CURRENT_DIMENSIONS_WITH,
        [cfg.w, cfg.h]
    );
    targetPage.label = cfg.label;

    var srcFile = File(srcFolder.fsName + "/" + cfg.file);
    if (!srcFile.exists) {
        logFile.writeln("MISSING SOURCE: " + cfg.file);
        continue;
    }
    var srcDoc = app.open(srcFile, false);
    var srcPage = srcDoc.pages[0];
    var items = srcPage.allPageItems;

    logFile.writeln("Copying " + items.length + " items from " + cfg.file + " -> page label '" + cfg.label + "'");

    for (var j = 0; j < items.length; j++) {
        try {
            items[j].duplicate(targetPage);
        } catch (e) {
            logFile.writeln("  ERROR duplicating item " + j + ": " + e);
        }
    }
    srcDoc.close(SaveOptions.no);
}

// Save target
var masterFile = File(outFolder.fsName + "/Poster_Master.indd");
target.save(masterFile);
target.close(SaveOptions.no);

logFile.writeln("DONE. Saved to " + masterFile.fsName);
logFile.close();
"DONE";
