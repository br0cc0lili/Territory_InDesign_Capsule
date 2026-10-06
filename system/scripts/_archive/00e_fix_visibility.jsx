app.scriptPreferences.userInteractionLevel = UserInteractionLevels.neverInteract;
var masterFile = File("/Users/wpp88766/code/Bertelsmann_ID_Plugin/02_System/templates/Poster_Master.indd");
var doc = app.open(masterFile, false);

for (var p = 0; p < doc.pages.length; p++) {
    var items = doc.pages[p].allPageItems;
    for (var i = 0; i < items.length; i++) {
        items[i].visible = true;
    }
}

doc.save();
doc.close(SaveOptions.no);
"DONE";
