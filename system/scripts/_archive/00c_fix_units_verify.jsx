app.scriptPreferences.userInteractionLevel = UserInteractionLevels.neverInteract;
var f = File("/Users/wpp88766/code/Bertelsmann_ID_Plugin/02_System/templates/Poster_Master.indd");
var out = File("/Users/wpp88766/code/Bertelsmann_ID_Plugin/02_System/templates/verify_output2.txt");
out.encoding = "UTF-8";
out.open("w");
var doc = app.open(f, false);
doc.viewPreferences.horizontalMeasurementUnits = MeasurementUnits.POINTS;
doc.viewPreferences.verticalMeasurementUnits = MeasurementUnits.POINTS;

out.writeln("Pages: " + doc.pages.length);
for (var p = 0; p < doc.pages.length; p++) {
    var page = doc.pages[p];
    out.writeln("--- Page " + (p+1) + " label='" + page.label + "' bounds=" + page.bounds.join(","));
}
doc.save();
doc.close(SaveOptions.no);
out.close();
"DONE";
