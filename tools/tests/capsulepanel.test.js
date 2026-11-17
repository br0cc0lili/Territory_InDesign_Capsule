// Offline regression test (Node, no InDesign). Run: node tools/tests/run.js
// The REAL panel script (plugin/js/index.js) on a fake DOM / fake UXP file
// system / stubbed render.js: Capsule import, coverage, Missing Detection
// Data, the source switch, Apply → Regenerate with its warnings.
// Synthetic files only (tools/test-output/capsule-panel, recreated each run).
const path = require("path");
const fs = require("fs");
const vm = require("vm");
const Module = require("module");
const REPO = path.resolve(__dirname, "../..");
const PLUGIN = REPO + "/plugin";
const ROOT = REPO + "/tools/test-output/capsule-panel";
let f = 0;
const ok = (c, m) => { console.log((c ? "PASS " : "FAIL ") + m); if (!c) f++; };

// ---------- synthetic files ----------
fs.rmSync(ROOT, { recursive: true, force: true });
for (const d of ["out/InDesign/Service", "photos/A6", "photos/Q5", "photos/A3", "downloads", "tpl"]) fs.mkdirSync(ROOT + "/" + d, { recursive: true });
const jpeg = (w, h) => Buffer.from([0xff, 0xd8, 0xff, 0xc0, 0, 17, 8, h >> 8, h & 255, w >> 8, w & 255, 3, 1, 0x22, 0, 2, 0x11, 1, 3, 0x11, 1, 0xff, 0xd9]);
const png = (w, h) => { const b = Buffer.alloc(33); Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(b, 0); b.writeUInt32BE(13, 8); b.write("IHDR", 12); b.writeUInt32BE(w, 16); b.writeUInt32BE(h, 20); return b; };
const P1 = ROOT + "/photos/A6/car_01.jpg", P2 = ROOT + "/photos/Q5/car_02.png", P3 = ROOT + "/photos/A3/hero.jpg";
fs.writeFileSync(P1, jpeg(6000, 4000));
fs.writeFileSync(P2, png(1920, 1280));
fs.writeFileSync(P3, jpeg(1080, 1350));
const TPL = ROOT + "/tpl/SERVICE_Template_DataMerge.indd";
fs.writeFileSync(TPL, "template");
const CAPSULE = { focalPoint: { x: 0.533717114, y: 0.649771365, normalized: true }, boundingBox: { x: 0.067434214, y: 0.2995427, width: 0.9325658, height: 0.70045733, normalized: true } };
fs.writeFileSync(ROOT + "/downloads/car_01.json", JSON.stringify(CAPSULE));
fs.writeFileSync(ROOT + "/downloads/unrelated.json", JSON.stringify(CAPSULE));
fs.writeFileSync(ROOT + "/downloads/capsule_export_7.json", JSON.stringify(CAPSULE));
fs.writeFileSync(ROOT + "/downloads/broken.json", "{ \"focalPoint\": ");
const OUT = ROOT + "/out";
const inddOf = (headline) => `${OUT}/InDesign/Service/${headline}.indd`;
fs.writeFileSync(inddOf("A6 Avant"), "indd"); // A6 was generated before

// ---------- fake UXP ----------
const picks = [];
const entry = (p) => {
    if (!fs.existsSync(p)) throw new Error("no such file " + p);
    const st = fs.statSync(p);
    return { name: path.basename(p), nativePath: p, isFolder: st.isDirectory(),
        async read(o) { const b = fs.readFileSync(p); return o && o.format === "binary" ? b.buffer.slice(b.byteOffset, b.byteOffset + b.length) : b.toString("utf8"); },
        async getMetadata() { const s = fs.statSync(p); return { size: s.size, dateModified: s.mtime }; } };
};
const uxp = {
    storage: {
        formats: { binary: "binary", utf8: "utf8" }, types: { file: "file", folder: "folder" },
        localFileSystem: {
            async getEntryWithUrl(url) { return entry(String(url).replace(/^file:/, "")); },
            async createEntryWithUrl(url) { const p = String(url).replace(/^file:/, ""); return { async write(t) { fs.writeFileSync(p, t); } }; },
            async getFileForOpening(o) { const next = picks.shift(); return next ? (o && o.allowMultiple ? next.map(entry) : entry(next[0])) : null; },
            async getFolder() { return null; },
        },
    },
    entrypoints: { setup() {} },
    shell: { async openPath() { return ""; } },
};
const o = Module._load;
Module._load = function (r) { if (r === "uxp") return uxp; if (r === "indesign") return { app: {} }; return o.apply(this, arguments); };
const realRender = require(PLUGIN + "/js/render.js");
const capsule = require(PLUGIN + "/js/capsule.js");

// ---------- stubbed render.js (no InDesign) ----------
const calls = { generate: [], closed: [], opened: [], backups: [] };
const unsavedPath = { value: "" }; // a product INDD "open with unsaved changes" in the fake InDesign
const ROWS = [
    { headline: "A6 Avant", imagePath: P1, status: "matched" },
    { headline: "Q5", imagePath: P2, status: "matched" },
    { headline: "A3", imagePath: P3, status: "matched" },
    { headline: "No photo", imagePath: "", status: "no_match", notes: "no folder" },
];
const GEOMETRY = { source: "product", pages: [
    { layout: { subType: "service", size: "1200x1200", position: "up", key: "service_up" }, layoutId: "service/1200x1200/up", page: 1, frameBounds: [0, 0, 1200, 1200], pageBounds: [0, 0, 1200, 1200], avoid: [[900, 60, 1140, 1140]], zone: null },
    { layout: { subType: "service", size: "1080x1920", position: "up", key: "service_up" }, layoutId: "service/1080x1920/up", page: 2, frameBounds: [0, 0, 1920, 1080], pageBounds: [0, 0, 1920, 1080], avoid: [], zone: null },
] };
const render = {
    checkAudiFont: () => ({ ok: true }),
    inddPathFor: (rec) => ({ inddPath: inddOf(rec.headline), subType: "service" }),
    pathExists: async (p) => fs.existsSync(p),
    async generateIndds(rows, tpls, out, onProgress, options) {
        calls.generate.push({ rows: rows.map((r) => r.headline), options });
        for (const r of rows) fs.writeFileSync(inddOf(r.headline), "indd");
        return { generated: rows.map((r) => ({ rec: r, subType: "service", inddPath: inddOf(r.headline), warnings: [], image: { status: "extension_available" },
            subject: { detected: true, mode: "auto", capsule: { status: "auto", boxSource: "auto", focalSource: "auto", edges: [], layoutEdits: [] } } })),
            failed: [], logLines: [], failures: [], imageChecks: [], templates: [] };
    },
    writeLog: async () => {},
    isInddOpen: (p) => p === inddOf("A6 Avant") || p === unsavedPath.value,
    inddOpenState: (p) => ({ open: p === inddOf("A6 Avant") || p === unsavedPath.value, modified: p === unsavedPath.value }),
    closeIndd: async (p) => { if (p === unsavedPath.value) throw new Error("unsaved"); calls.closed.push(p); },
    backupIndds: async (paths) => { calls.backups.push(paths.slice()); return { folder: OUT + "/InDesign/_backup/x", copied: paths.filter((x) => fs.existsSync(x)) }; },
    openIndd: async (p) => { calls.opened.push(p); return "x"; },
    activeDocumentPath: () => "",
    typeOfTemplate: () => "service", typeFolder: () => "Service", templateState: () => ({ open: false, modified: false }),
    outputFolderFor: () => OUT, detectTemplateLayouts: async () => ({ problems: [], detected: "" }),
    readPlacementGeometry: async (indd, tpl) => { calls.geometry = { indd, tpl }; return GEOMETRY; },
    previewPlacementForPage: realRender.previewPlacementForPage,
};

// ---------- fake DOM ----------
const nodes = {};
function node(id) {
    const n = { id, textContent: "", value: "", disabled: false, style: {}, children: [], listeners: {}, _cls: new Set(),
        classList: { add: (c) => n._cls.add(c), remove: (c) => n._cls.delete(c), contains: (c) => n._cls.has(c) },
        set className(v) { n._cls = new Set(String(v).split(/\s+/).filter(Boolean)); }, get className() { return [...n._cls].join(" "); },
        set innerHTML(v) { n.children = []; }, get innerHTML() { return ""; },
        appendChild(c) { n.children.push(c); return c; }, addEventListener(t, fn) { (n.listeners[t] = n.listeners[t] || []).push(fn); },
        fire(t) { return Promise.all((n.listeners[t] || []).map((fn) => fn({}))); },
        setAttribute() {}, removeAttribute() {}, querySelector: () => node("q"), remove() {} };
    return n;
}
const document = { getElementById: (id) => (nodes[id] = nodes[id] || node(id)), createElement: (t) => node(t), body: node("body") };
const storage = {};
const localStorage = { getItem: (k) => (k in storage ? storage[k] : null), setItem: (k, v) => { storage[k] = String(v); }, removeItem: (k) => { delete storage[k]; } };
storage["posterBatch.excelPath"] = JSON.stringify(ROOT + "/tpl/x.xlsx");
fs.writeFileSync(ROOT + "/tpl/x.xlsx", "x");
storage["posterBatch.photosPath"] = JSON.stringify(ROOT + "/photos");
storage["posterBatch.outputPath"] = JSON.stringify(OUT);
storage["posterBatch.templatePaths"] = JSON.stringify([TPL]);

// dialogs: answered from a queue of { pick: /label/ } (null = Cancel)
const dialogs = [];
const answers = [];
const editorAnswers = [];
const pasteAnswers = [];
const sandboxRequire = (r) => {
    if (r === "uxp") return uxp;
    if (r === "indesign") return { app: {} };
    if (r === "./js/render.js") return render;
    if (r === "./js/matcher.js") return { buildManifest: async () => ROWS.map((x) => Object.assign({}, x)) };
    if (r === "./js/capsule.js") return capsule;
    if (r === "./js/capsulepaste.js") return { showCapsulePaste: async (opts) => { const a = pasteAnswers.shift(); return typeof a === "function" ? a(opts) : a; } };
    if (r === "./js/capsuleeditor.js") return { showCapsuleEditor: async (opts) => { const a = editorAnswers.shift(); return typeof a === "function" ? a(opts) : a; } };
    return {};
};
const sandbox = {
    require: sandboxRequire, document, localStorage, location: { reload() {} }, console,
    setTimeout, clearTimeout, setInterval: () => 0, Promise, Date, JSON, Math, Array, Object, Map, Set, String, Number, Error, RegExp, isNaN, Uint8Array,
    __dialog: async (title, message, buttons, options) => {
        dialogs.push({ title, message, buttons: (buttons || []).filter((b) => b.label).map((b) => b.label), entries: buttons });
        const a = answers.shift();
        const btn = a && a.pick ? (buttons || []).find((b) => b.label && a.pick.test(b.label)) : null;
        if (a && a.pick && !btn) throw new Error(`dialog "${title}": no button ${a.pick} in ${(buttons || []).map((b) => b.label).join(" | ")}`);
        const value = btn ? btn.value : null;
        return options && (options.withText || options.input) ? { value, text: "" } : value;
    },
};
vm.createContext(sandbox);
let src = fs.readFileSync(PLUGIN + "/js/index.js", "utf8");
src = src.replace("function showDialog(title, message, buttons, options) {", "function showDialog(title, message, buttons, options) { if (globalThis.__dialog) return globalThis.__dialog(title, message, buttons, options);");
src += "\n;globalThis.__panel = { init, subjectSource, setSubjectSource, refreshCapsuleSummary, confirmCapsuleCoverage, importCapsuleFiles, importCapsuleForRow, pasteCapsuleJson, editSubjectRow, regenerateRow, productActions, subjectLine, warningSummary, getStatus, setStatus, capsulePendingLine, rows: () => manifestRows };";
vm.runInContext(src, sandbox, { filename: "index.js" });
const P = sandbox.__panel;
const text = (id) => nodes[id] ? nodes[id].textContent : "";
const storeFile = OUT + "/capsule_subjects.json";
const readStore = () => JSON.parse(fs.readFileSync(storeFile, "utf8"));
const rowOf = (h) => P.rows().find((r) => r.headline === h);

(async () => {
    await P.init();
    ok(P.subjectSource() === "capsule", "default subject detection in this plugin: Capsule JSON");
    ok(!nodes["capsule-actions"].classList.contains("hidden") && nodes["src-capsule"].classList.contains("source-selected"), "step 3 shows the Capsule controls");
    // Import before Match: the import matches first, then pairs the files
    picks.push([ROOT + "/downloads/unrelated.json"]);
    answers.push(null);
    await P.importCapsuleFiles();
    ok(P.rows().length === 4 && dialogs[dialogs.length - 1].title === "Import Capsule JSON" && /unrelated\.json — no matched photo/.test(dialogs[dialogs.length - 1].message),
        "Import before Match → products matched automatically, then the files are paired");
    await nodes["btn-match"].fire("click");
    ok(/Capsule data: 0 of 3 photos · ⚠ 3 Missing Detection Data/.test(text("capsule-summary")), "after Match: " + text("capsule-summary"));

    // bulk import: name matching only; unrelated / broken never applied
    picks.push([ROOT + "/downloads/car_01.json", ROOT + "/downloads/unrelated.json", ROOT + "/downloads/capsule_export_7.json"]);
    answers.push({ pick: /^Import 1 File/ });
    await P.importCapsuleFiles();
    const d1 = dialogs[dialogs.length - 1];
    ok(/car_01\.json → A6\/car_01\.jpg/.test(d1.message) && /unrelated\.json — no matched photo/.test(d1.message) && /capsule_export_7\.json — no matched photo/.test(d1.message),
        "bulk import lists the match and what is NOT imported");
    const s1 = readStore();
    ok(Object.keys(s1.items).length === 1 && s1.items[P1.toLowerCase()].auto.sourceFile === "car_01.json", "only car_01 stored (capsule_subjects.json in the output folder)");
    ok(s1.items[P1.toLowerCase()].pixelSize.width === 6000 && s1.items[P1.toLowerCase()].manual === null, "pixel size recorded, no edit");
    ok(/Capsule data: 1 of 3 photos · ⚠ 2 Missing Detection Data/.test(text("capsule-summary")), "summary after import: " + text("capsule-summary"));
    ok(/✓ Imported 1 Capsule JSON file/.test(text("capsule-message")), "import message: " + text("capsule-message").split("\n")[0]);

    // per product: a differently named JSON needs explicit confirmation
    picks.push([ROOT + "/downloads/capsule_export_7.json"]);
    answers.push(null); // Cancel at "Use this JSON for this photo?"
    await P.importCapsuleForRow(rowOf("Q5"));
    ok(dialogs[dialogs.length - 1].title === "Use this JSON for this photo?" && !readStore().items[P2.toLowerCase()], "per product: other file name → confirmation; Cancel → nothing stored");
    picks.push([ROOT + "/downloads/capsule_export_7.json"]);
    answers.push({ pick: /Use for This Photo/ });
    await P.importCapsuleForRow(rowOf("Q5"));
    ok(!!readStore().items[P2.toLowerCase()], "per product: confirmed → stored for Q5's photo");
    // broken JSON → rejected with the reason, store unchanged
    const before = fs.readFileSync(storeFile, "utf8");
    picks.push([ROOT + "/downloads/broken.json"]);
    answers.push({ pick: /Use for This Photo/ });
    await P.importCapsuleForRow(rowOf("A3"));
    ok(/was not imported:\n• not valid JSON/.test(text("gen-message")) && fs.readFileSync(storeFile, "utf8") === before, "malformed JSON → rejected with the reason, nothing stored");

    // Generate All in Capsule mode: A3 has no data → explicit choice
    answers.push(null); // Cancel at Missing Detection Data
    await nodes["btn-generate"].fire("click");
    const md = dialogs[dialogs.length - 1];
    ok(md.title === "Missing Detection Data" && /A3 — A3\/hero\.jpg/.test(md.message) && !/A6 Avant —/.test(md.message), "Generate All: lists only the product without Capsule data");
    ok(md.buttons.join("|") === "Paste Capsule JSON…|Import Capsule JSON Files…|Continue with Default Placement", "choices: paste, import, or continue with the default placement");
    ok(calls.generate.length === 0, "Cancel → nothing generated");
    answers.push({ pick: /Continue with Default Placement/ }, { pick: /Replace and Generate All/ });
    await nodes["btn-generate"].fire("click");
    ok(calls.generate.length === 1 && calls.generate[0].options.subjectSource === "capsule" && calls.generate[0].rows.length === 4, "continue → Generate with subjectSource capsule");
    ok(dialogs[dialogs.length - 1].title === "Generate All .indd", "the existing 'replace existing INDDs' warning still follows");

    // Backend API source: no Capsule check, the original options
    P.setSubjectSource("api");
    ok(nodes["capsule-actions"].classList.contains("hidden"), "Backend API → Capsule controls hidden");
    const nDialogs = dialogs.length;
    answers.push({ pick: /Replace and Generate All/ });
    await nodes["btn-generate"].fire("click");
    ok(dialogs.length === nDialogs + 1 && dialogs[dialogs.length - 1].title === "Generate All .indd" && calls.generate[1].options.subjectSource === "api",
        "API mode: no Missing Detection Data prompt, subjectSource api (original path)");
    P.setSubjectSource("capsule");

    // status lines
    const miss = { subject: { detected: false, reason: "Missing Detection Data — …", capsule: { status: "missing" } } };
    ok(P.subjectLine(miss)[1] === "Subject ⚠ Missing Detection Data — default placement" && P.subjectLine(miss)[0] === "detail-warning", "missing → 'Subject ⚠ Missing Detection Data'");
    const okLine = P.subjectLine({ subject: { detected: true, capsule: { status: "manual" } } });
    ok(okLine[1] === "Subject ✓ Auto-centred · Capsule (adjusted)", "adjusted → original line + '· Capsule (adjusted)'");
    ok(P.subjectLine({ subject: { detected: true } })[1] === "Subject ✓ Auto-centred", "API result → original line unchanged");
    const ws = P.warningSummary({ warnings: ["Missing Detection Data: no Capsule JSON imported for this photo — the original default placement was used"] });
    ok(ws.length === 1 && ws[0][1] === "⚠ Missing Detection Data · 1", "Review summary groups 'Missing Detection Data'");

    // ⋯ menu: Capsule group with live status
    answers.push(null);
    await P.productActions(rowOf("A3"));
    const menu = dialogs[dialogs.length - 1];
    ok(menu.buttons.indexOf("Paste Capsule JSON…") !== -1 && menu.buttons.indexOf("Import Capsule JSON File…") !== -1 && menu.buttons.indexOf("Edit Subject Placement…") === -1 &&
        menu.entries.some((e) => e.status && /Missing Detection Data/.test(e.status[0][1])), "⋯ (no data): status + Paste + Import, no Edit");
    answers.push(null);
    await P.productActions(rowOf("A6 Avant"));
    const menu2 = dialogs[dialogs.length - 1];
    ok(menu2.buttons.indexOf("Paste New Capsule JSON…") !== -1 && menu2.buttons.indexOf("Re-import Capsule JSON File…") !== -1 && menu2.buttons.indexOf("Edit Subject Placement…") !== -1,
        "⋯ (data): Paste New + Re-import + Edit Subject Placement");

    // Edit → Apply to all layouts → warnings → Save & Regenerate
    const A6 = inddOf("A6 Avant");
    P.setStatus(A6, { status: "ready", committedAt: "2026-11-16T10:00:00Z", exportedAt: "2026-11-16T11:00:00Z", warnings: [], image: { status: "extended", versions: [{ version: 1 }] } });
    let seen = null;
    const edited = { boundingBox: { x: 0.1, y: 0.32, width: 0.85, height: 0.66 }, focalPoint: { x: 0.5, y: 0.6 } };
    editorAnswers.push((opts) => { seen = opts; return { action: "apply_all", layoutId: "", values: edited }; });
    answers.push({ pick: /^Save & Regenerate$/ });
    const gBefore = calls.generate.length;
    await P.editSubjectRow(rowOf("A6 Avant"));
    ok(seen && seen.pixelSize.width === 6000 && seen.layouts.length === 2 && calls.geometry.indd === A6 && calls.geometry.tpl === TPL, "editor gets the photo size and the product's layouts (read from the INDD + template)");
    ok(Math.abs(seen.auto.boundingBox.x - 0.067434) < 1e-6 && seen.current.boundingBox.x === seen.auto.boundingBox.x, "editor starts from the imported Capsule values");
    const pv = seen.preview(edited);
    ok(pv.length === 2 && pv[0].kind === "extend" && pv[1].kind === "fill" && pv[0].layoutId === "service/1200x1200/up", "Preview runs the existing placement per layout (extend / fill)");
    const ap = dialogs[dialogs.length - 1];
    ok(ap.title === "Apply subject change?" && /Regenerating will replace the current INDD and may discard manual edits/.test(ap.message), "Apply: the existing Regenerate warning");
    ok(/Completed artwork: A6 Avant/.test(ap.message) && /JPGs already exported are not deleted/.test(ap.message), "Apply: Committed / Exported artwork flagged");
    ok(/Image Extension results exist for A6 Avant/.test(ap.message) && /extend again/.test(ap.message), "Apply: existing Image Extension results flagged");
    ok(/Open in InDesign \(no unsaved changes\): A6 Avant — closed first/.test(ap.message) && /Template Set is not changed/.test(ap.message), "Apply: open (saved) INDD + templates preserved stated");
    ok(/_backup/.test(ap.message) && calls.backups.length === 1 && calls.backups[0].join() === A6, "Apply: the INDD is backed up before it is replaced");
    ok(calls.generate.length === gBefore + 1 && calls.generate[gBefore].rows.join() === "A6 Avant" && calls.generate[gBefore].options.subjectSource === "capsule", "Save & Regenerate → only the products using this photo");
    ok(calls.closed.indexOf(A6) !== -1, "the open INDD was closed (without saving) before regenerating");
    const st = readStore().items[P1.toLowerCase()];
    ok(JSON.stringify(st.manual.boundingBox) === JSON.stringify(edited.boundingBox) && Math.abs(st.auto.boundingBox.x - 0.067434) < 1e-6, "edit stored separately from the imported box");
    const after = P.getStatus(A6);
    ok(after.status === "review" && after.warnings.some((w) => /before the subject change/.test(w)) && !after.committedAt, "regenerated product with old extension results → Review + 're-check extension' warning");

    // Apply to current layout → Save Only: stored, nothing regenerated
    editorAnswers.push(() => ({ action: "apply_layout", layoutId: "service/1080x1920/up", values: { boundingBox: { x: 0.2, y: 0.3, width: 0.5, height: 0.5 }, focalPoint: edited.focalPoint } }));
    answers.push({ pick: /^Save Only$/ });
    const g2 = calls.generate.length;
    await P.editSubjectRow(rowOf("A6 Avant"));
    const st2 = readStore().items[P1.toLowerCase()];
    ok(calls.generate.length === g2 && st2.layouts["service/1080x1920/up"] && JSON.stringify(st2.manual.boundingBox) === JSON.stringify(edited.boundingBox),
        "Apply to Current Layout + Save Only → layout edit stored, image-level edit kept, nothing regenerated");
    ok(/Subject ↻ Capsule data changed — Regenerate/.test((P.capsulePendingLine(rowOf("A6 Avant"), P.getStatus(A6)) || [])[1] || ""), "row shows 'Capsule data changed — Regenerate .indd to apply'");
    // Cancel in the confirmation → nothing saved
    editorAnswers.push(() => ({ action: "apply_all", layoutId: "", values: { boundingBox: { x: 0.3, y: 0.3, width: 0.3, height: 0.3 }, focalPoint: edited.focalPoint } }));
    answers.push(null);
    const raw = fs.readFileSync(storeFile, "utf8");
    await P.editSubjectRow(rowOf("A6 Avant"));
    ok(fs.readFileSync(storeFile, "utf8") === raw, "Cancel at Apply → store unchanged");
    // editor Cancel → nothing
    editorAnswers.push(null);
    const nd = dialogs.length;
    await P.editSubjectRow(rowOf("A6 Avant"));
    ok(dialogs.length === nd && fs.readFileSync(storeFile, "utf8") === raw, "editor Cancel → no dialog, nothing saved");

    // re-import over edits: keep / discard asked
    picks.push([ROOT + "/downloads/car_01.json"]);
    answers.push({ pick: /Discard My Adjustments/ });
    await P.importCapsuleForRow(rowOf("A6 Avant"));
    const ri = dialogs[dialogs.length - 1];
    const st3 = readStore().items[P1.toLowerCase()];
    ok(ri.title === "Replace Capsule data?" && /You adjusted/.test(ri.message) && st3.manual === null && Object.keys(st3.layouts).length === 0, "re-import over edits → asked; Discard → imported values only");

    // an INDD open WITH unsaved changes: Apply and ⋯ → Regenerate stop, nothing saved / closed / generated
    unsavedPath.value = A6;
    editorAnswers.push(() => ({ action: "apply_all", layoutId: "", values: { boundingBox: { x: 0.3, y: 0.3, width: 0.3, height: 0.3 }, focalPoint: edited.focalPoint } }));
    const raw2 = fs.readFileSync(storeFile, "utf8"), g4 = calls.generate.length, c4 = calls.closed.length, b4 = calls.backups.length;
    await P.editSubjectRow(rowOf("A6 Avant"));
    const us = dialogs[dialogs.length - 1];
    ok(us.title === "Unsaved changes" && /A6 Avant\.indd is open in InDesign with unsaved changes/.test(us.message) && us.buttons.length === 0,
        "Apply with unsaved changes in the open INDD → 'Unsaved changes' message only");
    ok(fs.readFileSync(storeFile, "utf8") === raw2 && calls.generate.length === g4 && calls.closed.length === c4 && calls.backups.length === b4,
        "… nothing saved, closed, backed up or regenerated");
    await P.regenerateRow(rowOf("A6 Avant"));
    ok(dialogs[dialogs.length - 1].title === "Unsaved changes" && calls.generate.length === g4 && calls.closed.length === c4, "⋯ → Regenerate .indd with unsaved changes → stops, nothing closed");
    unsavedPath.value = "";

    // changed photo → stale → Missing Detection Data again until confirmed
    fs.writeFileSync(P1, Buffer.concat([jpeg(6000, 4000), Buffer.from([0, 0, 0])]));
    answers.push(null);
    await P.confirmCapsuleCoverage([rowOf("A6 Avant")]);
    ok(/1 photo changed after the Capsule JSON was imported/.test(dialogs[dialogs.length - 1].message), "photo replaced on disk → flagged before Generate (stale)");

    // Regenerate .indd (⋯) in Capsule mode also checks coverage first
    answers.push(null);
    const g3 = calls.generate.length;
    await P.regenerateRow(rowOf("A3"));
    ok(dialogs[dialogs.length - 1].title === "Missing Detection Data" && calls.generate.length === g3, "⋯ → Regenerate .indd: Missing Detection Data prompt first; Cancel → nothing");
    ok(!fs.existsSync(ROOT + "/tpl/SERVICE_Template_DataMerge.indd.bak") && fs.readFileSync(TPL, "utf8") === "template", "Template Set file untouched");

    // Paste Capsule JSON (step 3): the designer picks the photo; nothing is guessed
    const COPIED = JSON.stringify(CAPSULE);
    const raw5 = fs.readFileSync(storeFile, "utf8");
    pasteAnswers.push(null); // Cancel in the paste window
    await nodes["btn-capsule-paste"].fire("click");
    ok(fs.readFileSync(storeFile, "utf8") === raw5, "Paste → Cancel: nothing stored");
    let pOpts = null;
    pasteAnswers.push((opts) => { pOpts = opts; return { imagePath: P3, text: "{ broken" }; });
    await P.pasteCapsuleJson(null);
    ok(pOpts && !pOpts.locked && pOpts.photos.length === 3 && pOpts.selected === "", "Paste (step 3): every matched photo offered, none forced");
    const a3 = pOpts.photos.find((x) => x.imagePath === P3);
    ok(a3 && a3.status === "missing" && /^A3 — A3\/hero\.jpg · no data$/.test(a3.label.replace(/\s+·\s+/, " · ")), "Paste: photo labelled with product + status: " + (a3 && a3.label));
    ok(/The pasted JSON was not imported:\n• not valid JSON/.test(text("capsule-message")) && fs.readFileSync(storeFile, "utf8") === raw5, "Paste of invalid text (should the window let it through) → rejected, nothing stored");
    pasteAnswers.push({ imagePath: P3, text: COPIED });
    await P.pasteCapsuleJson(null);
    const s5 = readStore().items[P3.toLowerCase()];
    ok(s5 && /^Pasted \d{4}-\d\d-\d\d \d\d:\d\d$/.test(s5.auto.sourceFile) && s5.pixelSize.width === 1080 && Math.abs(s5.auto.boundingBox.x - 0.067434) < 1e-6,
        "Paste for A3 → stored for A3's photo, source 'Pasted <date time>', pixel size read");
    ok(/✓ Capsule data pasted for A3\/hero\.jpg \(A3\) — ⋯ → Edit Subject Placement to check it, Regenerate \.indd to apply it\./.test(text("capsule-message")), "Paste message (A3 already generated): " + text("capsule-message").split("\n")[0]);
    ok(/⚠ 1 photo changed since import/.test(text("capsule-summary")) && !/Missing Detection Data/.test(text("capsule-summary")), "summary after paste: " + text("capsule-summary"));
    // ⋯ → Paste New Capsule JSON… on a photo with data: only that photo, replacement asked
    pOpts = null;
    pasteAnswers.push((opts) => { pOpts = opts; return { imagePath: P2, text: COPIED.replace("0.533717114", "0.5") }; });
    answers.push(null); // Cancel at "Replace Capsule data?"
    const raw6 = fs.readFileSync(storeFile, "utf8");
    await P.pasteCapsuleJson(rowOf("Q5"));
    ok(pOpts.locked && pOpts.selected === P2 && pOpts.photos.length === 1, "⋯ → Paste: only that product's photo");
    ok(dialogs[dialogs.length - 1].title === "Replace Capsule data?" && fs.readFileSync(storeFile, "utf8") === raw6, "⋯ → Paste over existing data → asked first; Cancel → unchanged");
    pasteAnswers.push({ imagePath: P2, text: COPIED.replace("0.533717114", "0.5") });
    answers.push({ pick: /^Replace$/ });
    await P.pasteCapsuleJson(rowOf("Q5"));
    ok(readStore().items[P2.toLowerCase()].auto.focalPoint.x === 0.5 && /✓ Capsule data pasted for Q5\/car_02\.png \(Q5\)/.test(text("gen-message")), "⋯ → Paste → Replace → stored, message in the product area");

    console.log(f ? `${f} FAILED` : "all passed");
    process.exit(f ? 1 : 0);
})().catch((e) => { console.log("FAIL harness error: " + (e && e.stack || e)); process.exit(1); });
