app.scriptPreferences.userInteractionLevel = UserInteractionLevels.neverInteract;
var f = File("/Users/wpp88766/code/Bertelsmann_ID_Plugin/02_System/templates/Poster_Master.indd");
var out = File("/Users/wpp88766/code/Bertelsmann_ID_Plugin/02_System/templates/verify_output.txt");
out.encoding = "UTF-8";
out.open("w");
var doc = app.open(f, false);
out.writeln("Pages: " + doc.pages.length);
for (var p = 0; p < doc.pages.length; p++) {
    var page = doc.pages[p];
    out.writeln("--- Page " + (p+1) + " label='" + page.label + "' bounds=" + page.bounds.join(","));
    var items = page.allPageItems;
    for (var i = 0; i < items.length; i++) {
        var item = items[i];
        var typeName = item.constructor.name;
        var name = ""; try { name = item.name; } catch(e){}
        var bounds = ""; try { bounds = item.geometricBounds.join(","); } catch(e){}
        out.writeln("  " + typeName + " name='" + name + "' bounds=" + bounds);
        if (typeName === "TextFrame") {
            try { out.writeln("     contents: " + item.contents); } catch(e) {}
        }
    }
}
doc.close(SaveOptions.no);
out.close();
"DONE";
