// Fix z-order in Poster_Master.indd: background rect (if any, unnamed) at back,
// image frame in the middle, Headline text frame always frontmost.
app.scriptPreferences.userInteractionLevel = UserInteractionLevels.neverInteract;

var masterFile = File("/Users/wpp88766/code/Bertelsmann_ID_Plugin/02_System/templates/Poster_Master.indd");
var doc = app.open(masterFile, false);

var logFile = File("/Users/wpp88766/code/Bertelsmann_ID_Plugin/02_System/templates/zorder_fix_log.txt");
logFile.encoding = "UTF-8";
logFile.open("w");

for (var p = 0; p < doc.pages.length; p++) {
    var page = doc.pages[p];
    var items = page.allPageItems;
    logFile.writeln("Page " + (p+1) + " label='" + page.label + "' item count=" + items.length);
    for (var i = 0; i < items.length; i++) {
        var it = items[i];
        var nm = ""; try { nm = it.name; } catch(e) {}
        logFile.writeln("  before: idx=" + i + " type=" + it.constructor.name + " name='" + nm + "'");
    }

    var headlineFrame = null;
    var mainImageFrame = null;
    var unnamedRects = [];

    for (var i = 0; i < items.length; i++) {
        var it = items[i];
        var nm = ""; try { nm = it.name; } catch(e) {}
        if (it.constructor.name === "TextFrame" && nm === "<<Headline>>") {
            headlineFrame = it;
        } else if (nm === "<<MainImage>>") {
            mainImageFrame = it;
        } else {
            unnamedRects.push(it);
        }
    }

    // Send unnamed background rectangles fully to back first
    for (var u = 0; u < unnamedRects.length; u++) {
        unnamedRects[u].sendToBack();
    }
    // Main image frame (if present) above the background, still below text
    if (mainImageFrame) {
        mainImageFrame.bringToFront();
    }
    // Headline always frontmost
    if (headlineFrame) {
        headlineFrame.bringToFront();
    }

    var itemsAfter = page.allPageItems;
    for (var i = 0; i < itemsAfter.length; i++) {
        var it = itemsAfter[i];
        var nm = ""; try { nm = it.name; } catch(e) {}
        logFile.writeln("  after: idx=" + i + " type=" + it.constructor.name + " name='" + nm + "'");
    }
}

doc.save();
doc.close(SaveOptions.no);
logFile.close();
"DONE";
