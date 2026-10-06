app.scriptPreferences.userInteractionLevel = UserInteractionLevels.neverInteract;
var masterFile = File("/Users/wpp88766/code/Bertelsmann_ID_Plugin/02_System/templates/Poster_Master.indd");
var out = File("/Users/wpp88766/code/Bertelsmann_ID_Plugin/02_System/templates/debug_page1.txt");
out.encoding = "UTF-8";
out.open("w");

var doc = app.open(masterFile, false);
var page = null;
for (var p = 0; p < doc.pages.length; p++) {
    if (doc.pages[p].label === "top_service") { page = doc.pages[p]; break; }
}
var items = page.allPageItems;
for (var i = 0; i < items.length; i++) {
    var it = items[i];
    var nm = ""; try { nm = it.name; } catch(e){}
    out.writeln("idx=" + i + " type=" + it.constructor.name + " name='" + nm + "'");
    out.writeln("  visible=" + it.visible);
    out.writeln("  layer=" + it.itemLayer.name);
    try { out.writeln("  fillColor=" + it.fillColor.name); } catch(e) { out.writeln("  fillColor=ERR " + e); }
    try { out.writeln("  opacity=" + it.transparencySettings.blendingSettings.opacity); } catch(e) {}
    try { out.writeln("  strokeColor=" + it.strokeColor.name); } catch(e) {}
    try { out.writeln("  images.length=" + it.images.length); } catch(e) {}
    try { out.writeln("  geometricBounds=" + it.geometricBounds.join(",")); } catch(e) {}
}

// Now place the image like the generator does and re-check
var imgPath = "/Users/wpp88766/code/Bertelsmann_ID_Plugin/01_Assets/Pictures/11_8Y4071151_Grundträger/Q5_as_2025_8358/Q5_as_2025_8358 (web_1080p).jpeg";
var mainImageFrame = null;
for (var i = 0; i < items.length; i++) {
    var nm = ""; try { nm = items[i].name; } catch(e){}
    if (nm === "<<MainImage>>") mainImageFrame = items[i];
}
out.writeln("--- placing image into MainImage ---");
mainImageFrame.place(File(imgPath));
mainImageFrame.fit(FitOptions.FILL_PROPORTIONALLY);
mainImageFrame.fit(FitOptions.CENTER_CONTENT);
out.writeln("images.length after place=" + mainImageFrame.images.length);

// re-dump order/visibility after placing
var items2 = page.allPageItems;
for (var i = 0; i < items2.length; i++) {
    var it = items2[i];
    var nm = ""; try { nm = it.name; } catch(e){}
    out.writeln("post-place idx=" + i + " type=" + it.constructor.name + " name='" + nm + "' visible=" + it.visible);
}

// export as-is to compare
var expFile = File("/Users/wpp88766/code/Bertelsmann_ID_Plugin/02_System/templates/debug_page1_export.jpg");
app.jpegExportPreferences.exportResolution = 72;
app.jpegExportPreferences.jpegQuality = JPEGOptionsQuality.MAXIMUM;
app.jpegExportPreferences.jpegColorSpace = JpegColorSpaceEnum.RGB;
app.jpegExportPreferences.jpegExportRange = ExportRangeOrAllPages.EXPORT_RANGE;
app.jpegExportPreferences.pageString = String(page.documentOffset + 1);
doc.exportFile(ExportFormat.JPG, expFile, false);

doc.close(SaveOptions.no);
out.close();
"DONE";
