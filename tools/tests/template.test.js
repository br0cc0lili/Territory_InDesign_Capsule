// Offline regression test (Node, no InDesign). Run: node tools/tests/run.js
// Custom Subject Frames: the open template is found whatever shape
// doc.fullName has, and "Save Frame Changes" saves only that document.
const PLUGIN_JS = require("path").resolve(__dirname, "../../plugin/js");
const Module = require("module"); const o = Module._load;
const docs = [];
const app = { documents: { get length() { return docs.length; }, item: (i) => docs[i] } };
Module._load = function (r) {
    if (r === "indesign") return { app };
    if (r === "uxp") return { storage: { localFileSystem: {} } };
    return o.apply(this, arguments);
};
const render = require(PLUGIN_JS + "/render.js");
let f = 0; const ok = (c, m) => { console.log((c ? "PASS " : "FAIL ") + m); if (!c) f++; };
const mk = (name, fullName, modified) => ({ name, fullName, modified, saves: 0, save() { this.saves++; this.modified = false; } });
const TPL = "/Users/me/Documents/Client Files/DANIS_Template_DataMerge.indd";
(async () => {
    docs.push(mk("Other.indd", "/Users/me/Other.indd", true));
    docs.push(mk("DANIS_Template_DataMerge.indd", "file:///Users/me/Documents/Client%20Files/DANIS_Template_DataMerge.indd", true));
    ok(JSON.stringify(render.templateState(TPL)) === JSON.stringify({ open: true, modified: true }), "file: URL with %20 → template found, unsaved");
    const r = await render.saveTemplate(TPL);
    ok(r.saved && docs[1].saves === 1 && docs[0].saves === 0, "Save Frame Changes saves the template only");
    ok(render.templateState(TPL).modified === false, "after saving: no unsaved changes");
    docs[1].fullName = { nativePath: "~/Documents/Client Files/DANIS_Template_DataMerge.indd" };
    docs[1].modified = true;
    ok(render.templateState(TPL).open, "~/ path object → template found");
    docs[1].fullName = { toString() { return "weird"; } };
    ok(render.templateState(TPL).open, "unreadable path → matched by its file name");
    docs.push(mk("DANIS_Template_DataMerge.indd", "/elsewhere/DANIS_Template_DataMerge.indd", false));
    ok(!render.templateState(TPL).open, "two open documents with that name and no path match → not guessed");
    docs.length = 0;
    const none = await render.saveTemplate(TPL);
    ok(!none.open && !none.saved, "template not open → nothing saved");
    console.log(f ? f + " FAILED" : "all passed");
})().catch((e) => { console.log("FAIL crashed: " + e.stack); process.exit(1); });
