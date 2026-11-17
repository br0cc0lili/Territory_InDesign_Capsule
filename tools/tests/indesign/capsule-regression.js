// Regression check in InDesign: ORIGINAL plugin code (a git ref, default
// main) vs. this working tree, on DISPOSABLE SYNTHETIC files only.
//   node tools/tests/indesign/capsule-regression.js [git-ref]
// Both versions run their own generateIndds() on the same synthetic Template
// Set + photos with the same subject boxes (the backend detector is replaced
// by a stub returning fixed boxes; fetch is blocked — no network):
//   • Auto Placement (API source)          original ≡ new
//   • Custom Subject Frames (API source)   original ≡ new
//   • Capsule source (new) with the same boxes ≡ original Auto Placement
// Compared per page: placed graphic bounds, placement label, generation
// warnings, Image Extension analysis records; plus the preview export (JPG names).
// Needs a running InDesign; only documents inside its test folder are closed.
const fs = require("fs");
const path = require("path");
const zlib = require("zlib");
const { execFileSync } = require("child_process");
const REPO = path.resolve(__dirname, "../../..");
const REF = process.argv[2] || "main";
const ROOT = REPO + "/tools/test-output/capsule-regression";
let fails = 0;
const ok = (c, m) => { console.log((c ? "PASS " : "FAIL ") + m); if (!c) fails++; };

const src = fs.readFileSync(__dirname + "/capsule-indesign.js", "utf8");
const { carPng } = new Function("zlib", src.slice(src.indexOf("function crc32"), src.indexOf("// close test documents")) + "; return { carPng };")(zlib);
function runInDesign(scriptPath, resultPath, timeoutS) {
    try { fs.unlinkSync(resultPath); } catch (e) {}
    execFileSync("osascript", ["-e", `with timeout of ${timeoutS} seconds`, "-e",
        `tell application id "com.adobe.InDesign" to do script "app.doScript(File('${scriptPath}'), ScriptLanguage.UXPSCRIPT); 'ok'" language javascript`, "-e", "end timeout"], { stdio: "ignore" });
    for (let i = 0; i < timeoutS; i++) {
        if (fs.existsSync(resultPath)) return JSON.parse(fs.readFileSync(resultPath, "utf8"));
        execFileSync("sleep", ["1"]);
    }
    throw new Error("no result from InDesign: " + resultPath);
}
const CLOSE = `async function closeTestDocuments() {
    const { app, SaveOptions } = require("indesign");
    for (let i = app.documents.length - 1; i >= 0; i--) {
        const d = app.documents.item(i); let p = "";
        try { const f = await d.fullName; p = String(typeof f === "string" ? f : (f && (f.nativePath || f.fsName)) || "").replace(/^file:(\\/\\/)?/, ""); } catch (e) {}
        if (p && p.indexOf(${JSON.stringify(ROOT + "/")}) === 0) { try { d.close(SaveOptions.NO); } catch (e) {} }
    }
}`;
if (fs.existsSync(ROOT)) {
    fs.writeFileSync(ROOT + "/cleanup.idjs", `${CLOSE}\nconst uxp = require("uxp"); await closeTestDocuments();
const f = await uxp.storage.localFileSystem.createEntryWithUrl("file:${ROOT}/cleanup.json", { type: uxp.storage.types.file, overwrite: true }); await f.write("{}");`);
    runInDesign(ROOT + "/cleanup.idjs", ROOT + "/cleanup.json", 60);
}
fs.rmSync(ROOT, { recursive: true, force: true });
for (const d of ["orig", "tpl", "tplz", "cap-auto", "cap-frames"]) fs.mkdirSync(ROOT + "/" + d, { recursive: true });
// the original plugin code, exactly as committed at REF
execFileSync("sh", ["-c", `git -C "${REPO}" archive "${REF}" plugin | tar -x -C "${ROOT}/orig"`]);
const refSha = execFileSync("git", ["-C", REPO, "rev-parse", REF]).toString().trim();
const PHOTOS = {
    A6: { file: ROOT + "/photos/A6/car_01.png", w: 1920, h: 1280, box: { x: 0.067434, y: 0.299543, width: 0.932566, height: 0.700457 } },
    Q5: { file: ROOT + "/photos/Q5/car_02.png", w: 1080, h: 1350, box: { x: 0.3, y: 0.55, width: 0.4, height: 0.2 } },
    A3: { file: ROOT + "/photos/A3/car_03.png", w: 3000, h: 2000, box: { x: 0.25, y: 0.4, width: 0.45, height: 0.3 } },
    W1: { file: ROOT + "/photos/W1/car_04.png", w: 1600, h: 1200, box: { x: 0, y: 0, width: 1, height: 1 } }, // whole-photo box
};
for (const p of Object.values(PHOTOS)) { fs.mkdirSync(path.dirname(p.file), { recursive: true }); fs.writeFileSync(p.file, carPng(p.w, p.h, p.box.width === 1 ? { x: 0.2, y: 0.3, width: 0.5, height: 0.4 } : p.box)); }

const script = `${CLOSE}
const uxp = require("uxp"); const id = require("indesign"); const { app } = id;
const ROOT = ${JSON.stringify(ROOT)}; const PHOTOS = ${JSON.stringify(PHOTOS)};
const out = { steps: [] };
const items = (c) => { const a = []; for (let i = 0; i < (c ? c.length : 0); i++) a.push(typeof c.item === "function" ? c.item(i) : c[i]); return a; };
const r2 = (b) => Array.from(b, (v) => Math.round(Number(v) * 100) / 100);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const realFetch = globalThis.fetch; const fetchCalls = [];
globalThis.fetch = async (u) => { fetchCalls.push(String(u)); throw new Error("network blocked by test"); };
const uil = app.scriptPreferences.userInteractionLevel;
try {
    app.scriptPreferences.userInteractionLevel = id.UserInteractionLevels.NEVER_INTERACT;
    await closeTestDocuments();
    out.docsBefore = app.documents.length;
    // synthetic Template Sets: plain (Auto Placement) + with red subject frames on 2 layouts
    const LAYOUTS = [
        { w: 1200, h: 1200, frame: [0, 0, 1200, 1200], text: [900, 60, 1140, 1140], zone: [150, 200, 800, 1000] },
        { w: 800, h: 600, frame: [0, 0, 600, 800], text: [40, 40, 140, 760], zone: null },
        { w: 1080, h: 1920, frame: [0, 0, 1920, 1080], text: [1500, 60, 1800, 1020], zone: [300, 100, 1300, 980] },
        { w: 1000, h: 700, frame: [-9, -9, 709, 1009], text: [520, 50, 680, 950], zone: null },
    ];
    async function makeTemplate(file, withZones) {
        const doc = app.documents.add(false);
        doc.documentPreferences.facingPages = false;
        doc.viewPreferences.horizontalMeasurementUnits = id.MeasurementUnits.POINTS; doc.viewPreferences.verticalMeasurementUnits = id.MeasurementUnits.POINTS;
        doc.viewPreferences.rulerOrigin = id.RulerOrigin.PAGE_ORIGIN;
        doc.documentPreferences.pageWidth = 1200; doc.documentPreferences.pageHeight = 1200;
        while (doc.pages.length < LAYOUTS.length) doc.pages.add();
        const imageLayer = doc.layers.add({ name: "Image" }); const textLayer = doc.layers.add({ name: "Text" });
        const zoneLayer = withZones ? doc.layers.add({ name: "subject" }) : null;
        for (let i = 0; i < LAYOUTS.length; i++) {
            const L = LAYOUTS[i]; const page = doc.pages.item(i);
            if (i > 0) page.resize(id.CoordinateSpaces.INNER_COORDINATES, id.AnchorPoint.TOP_LEFT_ANCHOR, id.ResizeMethods.REPLACING_CURRENT_DIMENSIONS_WITH, [L.w, L.h]);
            page.rectangles.add({ geometricBounds: L.frame, itemLayer: imageLayer, name: "<<MainImage>>" });
            const tf = page.textFrames.add({ geometricBounds: L.text, itemLayer: textLayer, name: "<<Headline>>" });
            tf.contents = "Synthetic headline"; try { tf.parentStory.pointSize = 48; } catch (e) {}
            if (withZones && L.zone) page.rectangles.add({ geometricBounds: L.zone, itemLayer: zoneLayer, name: "<<SubjectZone>>" });
        }
        doc.save(await uxp.storage.localFileSystem.createEntryWithUrl("file:" + file, { overwrite: true }));
        doc.close(id.SaveOptions.NO); await sleep(300);
    }
    const TPL = ROOT + "/tpl/SERVICE_Synthetic_DataMerge.indd", TPLZ = ROOT + "/tplz/SERVICE_Zones_DataMerge.indd";
    await makeTemplate(TPL, false); await makeTemplate(TPLZ, true);
    out.steps.push("templates");
    const rows = Object.keys(PHOTOS).map((k) => ({ headline: k + " Synthetic", imagePath: PHOTOS[k].file, status: "matched", year: "2026", service_subline: "", danis_subline: "" }));
    const boxFor = (p) => { const k = Object.keys(PHOTOS).find((x) => PHOTOS[x].file.toLowerCase() === String(p).toLowerCase()); return PHOTOS[k].box; };
    // the backend detector replaced by fixed boxes — identical for both versions
    function stubSubject(subjectMod) {
        subjectMod.loadSubjectConfig = async () => ({ config: { baseUrl: "https://stub.invalid", pluginKey: "stub" }, reason: "" });
        subjectMod.createSubjectDetector = () => ({ enabled: true, hasChoices: false,
            detect: async (p) => { const b = Object.assign({}, boxFor(p)); return { box: b, source: "photoshop-mask", wholePhoto: subjectMod.isWholePhotoBox(b) }; } });
    }
    async function readAll(folder) {
        const res = {};
        const f = await uxp.storage.localFileSystem.getEntryWithUrl("file:" + folder + "/InDesign/Service");
        for (const e of await f.getEntries()) {
            if (!/\\.indd$/.test(e.name)) continue;
            const d = app.open(e.nativePath, false);
            try {
                d.viewPreferences.horizontalMeasurementUnits = id.MeasurementUnits.POINTS; d.viewPreferences.verticalMeasurementUnits = id.MeasurementUnits.POINTS;
                res[e.name] = items(d.pages).map((p) => { const fr = items(p.allPageItems).find((it) => String(it.name) === "<<MainImage>>"); const g = fr && fr.allGraphics.length ? items(fr.allGraphics)[0] : null;
                    let label = null; try { label = JSON.parse(fr.extractLabel("posterBatch.placement")); } catch (x) {}
                    const zones = items(p.allPageItems).filter((it) => /SubjectZone/.test(String(it.name))).length;
                    return { size: Math.round(p.bounds[3] - p.bounds[1]) + "x" + Math.round(p.bounds[2] - p.bounds[0]), graphic: g ? r2(g.geometricBounds) : null, label, zonesLeft: zones }; });
            } finally { d.close(id.SaveOptions.NO); await sleep(300); }
        }
        return res;
    }
    const clean = (records) => JSON.stringify(records).split(ROOT).join("<ROOT>").replace(/\\/(orig|new|cap)-(auto|frames)\\//g, "/<OUT>/").replace(/"(at|time|timestamp|createdAt|capturedAt)":"[^"]*"/g, "");
    async function run(label, modDir, templatePath, opts) {
        const render = require(modDir + "/render.js");
        const subjectMod = require(modDir + "/subject.js");
        stubSubject(subjectMod);
        const outDir = ROOT + "/" + label;
        const gen = await render.generateIndds(rows, [templatePath], outDir, null, opts);
        await sleep(500);
        const exp = await render.exportFromIndds(gen.generated.map((g) => ({ rec: g.rec, subType: g.subType, inddPath: g.inddPath })), outDir, null, { preview: true });
        await sleep(500);
        return { generated: gen.generated.map((g) => ({ name: g.inddPath.split("/").pop(), warnings: g.warnings })), failed: gen.failed.map((f) => f.error),
            imageChecks: clean(gen.imageChecks), export: exp.items.map((o) => ({ name: o.inddPath.split("/").pop(), error: o.error, warnings: o.warnings })),
            pages: await readAll(outDir) };
    }
    const ORIG = "./orig/plugin/js", NEW = "../../../plugin/js";
    out.origAuto = await run("orig-auto", ORIG, TPL, { placementMode: "auto" }); out.steps.push("orig-auto");
    out.newAuto = await run("new-auto", NEW, TPL, { placementMode: "auto" }); out.steps.push("new-auto");
    out.origFrames = await run("orig-frames", ORIG, TPLZ, { placementMode: "frames" }); out.steps.push("orig-frames");
    out.newFrames = await run("new-frames", NEW, TPLZ, { placementMode: "frames" }); out.steps.push("new-frames");
    // Capsule source (new code): the same boxes imported as Capsule JSON
    const cap = require(NEW + "/capsule.js");
    for (const label of ["cap-auto", "cap-frames"]) {
        const store = await cap.loadCapsuleStore(ROOT + "/" + label);
        for (const k of Object.keys(PHOTOS)) cap.importDetection(store, PHOTOS[k].file, { boundingBox: PHOTOS[k].box, focalPoint: { x: 0.5, y: 0.5 } }, { fingerprint: await cap.photoFingerprint(PHOTOS[k].file) });
        await cap.saveCapsuleStore(store);
    }
    out.capAuto = await run("cap-auto", NEW, TPL, { placementMode: "auto", subjectSource: "capsule" }); out.steps.push("cap-auto");
    out.capFrames = await run("cap-frames", NEW, TPLZ, { placementMode: "frames", subjectSource: "capsule" }); out.steps.push("cap-frames");
    out.fetchCalls = fetchCalls;
    out.docsAfter = app.documents.length;
} catch (e) { out.error = String(e && e.stack || e); }
finally { app.scriptPreferences.userInteractionLevel = uil; globalThis.fetch = realFetch; }
const f = await uxp.storage.localFileSystem.createEntryWithUrl("file:" + ROOT + "/result.json", { type: uxp.storage.types.file, overwrite: true });
await f.write(JSON.stringify(out));
`;
fs.writeFileSync(ROOT + "/run.idjs", script);
console.log(`running in InDesign … original = ${REF} (${refSha.slice(0, 7)}), new = working tree`);
const R = runInDesign(ROOT + "/run.idjs", ROOT + "/result.json", 1500);
fs.writeFileSync(ROOT + "/result.pretty.json", JSON.stringify(R, null, 1));
if (R.error) { console.log("FAIL InDesign script error after [" + R.steps.join(", ") + "]: " + R.error); process.exit(1); }

const J = JSON.stringify;
function compare(name, a, b, opts) {
    const o = opts || {};
    ok(a.failed.length === 0 && b.failed.length === 0 && a.generated.length === 4 && b.generated.length === 4, `${name}: 4 + 4 INDDs generated, none failed`);
    let same = 0, n = 0; const diffs = [];
    for (const file of Object.keys(a.pages)) a.pages[file].forEach((p, i) => {
        const q = (b.pages[file] || [])[i] || {};
        n++;
        const la = Object.assign({}, p.label), lb = Object.assign({}, q.label);
        const eq = J(p.graphic) === J(q.graphic) && J(la) === J(lb) && p.zonesLeft === q.zonesLeft;
        if (eq) same++; else diffs.push(`${file} ${p.size}: ${J(p.graphic)} ${J(la)} vs ${J(q.graphic)} ${J(lb)}`);
    });
    ok(same === n && n === 16, `${name}: ${same}/${n} pages identical (graphic bounds, placement label, red frames removed)` + (diffs.length ? "\n   " + diffs.join("\n   ") : ""));
    const wa = J(a.generated.map((g) => [g.name, g.warnings])), wb = J(b.generated.map((g) => [g.name, (g.warnings || []).filter((w) => !o.ignoreWarning || !o.ignoreWarning.test(w))]));
    ok(wa === wb, `${name}: generation warnings identical` + (wa === wb ? "" : `\n   ${wa}\n   ${wb}`));
    ok(a.imageChecks === b.imageChecks, `${name}: Image Extension analysis records identical`);
    ok(J(a.export) === J(b.export), `${name}: preview export identical (names, warnings, no errors)`);
}
compare("Auto Placement — original vs new (API source)", R.origAuto, R.newAuto);
compare("Custom Subject Frames — original vs new (API source)", R.origFrames, R.newFrames);
compare("Capsule source vs original Auto Placement (same boxes)", R.origAuto, R.capAuto);
compare("Capsule source vs original Custom Subject Frames (same boxes)", R.origFrames, R.capFrames);
ok(Object.values(R.origFrames.pages).some((pp) => pp.some((p) => p.label && p.label.zone)), "red-frame placement actually used in the frames run");
ok(R.fetchCalls.length === 0, `no network request in any run (${R.fetchCalls.length})`);
ok(R.docsAfter === R.docsBefore, `no test documents left open (${R.docsBefore} → ${R.docsAfter})`);
console.log(fails ? `${fails} FAILED` : "all passed");
process.exit(fails ? 1 : 0);
