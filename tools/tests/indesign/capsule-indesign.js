// InDesign check of Capsule subject placement on DISPOSABLE, SYNTHETIC files.
// Needs a running InDesign; never opens client files, never calls the backend.
//   node tools/tests/indesign/capsule-indesign.js
// 1. writes synthetic car photos (PNG) + the confirmed Capsule JSON into
//    tools/test-output/capsule-id/ (recreated each run)
// 2. in InDesign (UXP script): builds a synthetic Template Set (4 layouts:
//    1200x1200, 800x600, 1080x1920, 1000x700 with a bleeding image frame),
//    imports the Capsule data with capsule.js, runs the plugin's own
//    generateIndds (subjectSource "capsule"), reads every placed graphic back,
//    compares it with placement.js and with the editor's Preview, applies a
//    layout-only edit and regenerates, and exports preview JPGs
// 3. checks the result here and prints PASS / FAIL
// Only documents inside the test folder are ever closed.
const fs = require("fs");
const path = require("path");
const zlib = require("zlib");
const { execFileSync } = require("child_process");
const REPO = path.resolve(__dirname, "../../..");
const ROOT = REPO + "/tools/test-output/capsule-id";
let fails = 0;
const ok = (c, m) => { console.log((c ? "PASS " : "FAIL ") + m); if (!c) fails++; };

// ---------- synthetic photos ----------
function crc32(buf) {
    let c, crc = 0xffffffff;
    for (let n = 0; n < buf.length; n++) {
        c = (crc ^ buf[n]) & 0xff;
        for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
        crc = (crc >>> 8) ^ c;
    }
    return (crc ^ 0xffffffff) >>> 0;
}
function chunk(type, data) {
    const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
    const td = Buffer.concat([Buffer.from(type), data]);
    const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(td));
    return Buffer.concat([len, td, crc]);
}
// A light studio background with a dark "car" filling `box` (shares).
function carPng(w, h, box) {
    const raw = Buffer.alloc((w * 3 + 1) * h);
    const x0 = box.x * w, y0 = box.y * h, x1 = (box.x + box.width) * w, y1 = (box.y + box.height) * h;
    for (let y = 0; y < h; y++) {
        const row = y * (w * 3 + 1);
        raw[row] = 0;
        for (let x = 0; x < w; x++) {
            let r = 225 - (y / h) * 40, g = r, b = r + 10;
            const inBox = x >= x0 && x < x1 && y >= y0 && y < y1;
            if (inBox) {
                const ty = (y - y0) / (y1 - y0), tx = (x - x0) / (x1 - x0);
                const body = ty > 0.35 && ty < 0.85, roof = ty <= 0.35 && tx > 0.25 && tx < 0.75;
                const wheel = ty >= 0.7 && (Math.hypot(tx - 0.22, (ty - 0.85) * 2) < 0.12 || Math.hypot(tx - 0.78, (ty - 0.85) * 2) < 0.12);
                if (wheel) { r = g = b = 20; } else if (body || roof) { r = 150; g = 20; b = 30; }
            }
            raw[row + 1 + x * 3] = r; raw[row + 2 + x * 3] = g; raw[row + 3 + x * 3] = b;
        }
    }
    const ihdr = Buffer.alloc(13);
    ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(h, 4); ihdr[8] = 8; ihdr[9] = 2;
    return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk("IHDR", ihdr), chunk("IDAT", zlib.deflateSync(raw)), chunk("IEND", Buffer.alloc(0))]);
}

// close test documents left open by an earlier run BEFORE deleting their files
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
const CLOSE_TEST_DOCS = `
async function closeTestDocuments() {
    const { app, SaveOptions } = require("indesign");
    for (let i = app.documents.length - 1; i >= 0; i--) {
        const d = app.documents.item(i);
        let p = "";
        try { const f = await d.fullName; p = String(typeof f === "string" ? f : (f && (f.nativePath || f.fsName)) || "").replace(/^file:(\\/\\/)?/, ""); } catch (e) {}
        if (p && p.indexOf(${JSON.stringify(ROOT + "/")}) === 0) { try { d.close(SaveOptions.NO); } catch (e) {} }
    }
}`;
if (fs.existsSync(ROOT)) {
    const pre = ROOT + "/cleanup.idjs";
    fs.writeFileSync(pre, `${CLOSE_TEST_DOCS}
const uxp = require("uxp");
await closeTestDocuments();
const f = await uxp.storage.localFileSystem.createEntryWithUrl("file:${ROOT}/cleanup.json", { type: uxp.storage.types.file, overwrite: true });
await f.write("{}");`);
    runInDesign(pre, ROOT + "/cleanup.json", 60);
}
fs.rmSync(ROOT, { recursive: true, force: true });
for (const d of ["photos/A6", "photos/Q5", "photos/A3", "downloads", "tpl", "out"]) fs.mkdirSync(ROOT + "/" + d, { recursive: true });
const CAPSULE_BOX = { x: 0.067434214, y: 0.2995427, width: 0.9325658, height: 0.70045733 }; // the confirmed Capsule output (touches right + bottom)
const PHOTOS = {
    A6: { file: ROOT + "/photos/A6/car_01.png", w: 1920, h: 1280, box: CAPSULE_BOX, focal: { x: 0.533717114, y: 0.649771365 }, json: true },
    A3: { file: ROOT + "/photos/A3/car_03.png", w: 3000, h: 2000, box: { x: 0.25, y: 0.4, width: 0.45, height: 0.3 }, focal: { x: 0.47, y: 0.55 }, json: true },
    Q5: { file: ROOT + "/photos/Q5/car_02.png", w: 1080, h: 1350, box: { x: 0.3, y: 0.55, width: 0.4, height: 0.2 }, focal: { x: 0.5, y: 0.65 }, json: false },
};
for (const [k, p] of Object.entries(PHOTOS)) {
    fs.writeFileSync(p.file, carPng(p.w, p.h, p.box));
    if (p.json) fs.writeFileSync(`${ROOT}/downloads/${path.basename(p.file, ".png")}.json`, JSON.stringify({
        focalPoint: Object.assign({}, p.focal, { normalized: true }), boundingBox: Object.assign({}, p.box, { normalized: true }) }, null, 2));
}

// ---------- the InDesign part ----------
const script = `${CLOSE_TEST_DOCS}
const uxp = require("uxp");
const id = require("indesign");
const { app } = id;
const render = require("../../../plugin/js/render.js");
const capsule = require("../../../plugin/js/capsule.js");
const placement = require("../../../plugin/js/placement.js");
const ROOT = ${JSON.stringify(ROOT)};
const PHOTOS = ${JSON.stringify(PHOTOS)};
const out = { steps: [] };
const step = (s) => out.steps.push(s);
async function writeOut() {
    const f = await uxp.storage.localFileSystem.createEntryWithUrl("file:" + ROOT + "/result.json", { type: uxp.storage.types.file, overwrite: true });
    await f.write(JSON.stringify(out, null, 1));
}
const items = (c) => { const a = []; for (let i = 0; i < (c ? c.length : 0); i++) a.push(typeof c.item === "function" ? c.item(i) : c[i]); return a; };
const r2 = (b) => Array.from(b, (v) => Math.round(Number(v) * 100) / 100);
const uil = app.scriptPreferences.userInteractionLevel;
try {
    app.scriptPreferences.userInteractionLevel = id.UserInteractionLevels.NEVER_INTERACT;
    await closeTestDocuments();
    out.docsBefore = app.documents.length;
    // --- synthetic Template Set: 4 layouts on 4 pages of different sizes
    const TPL = ROOT + "/tpl/SERVICE_Synthetic_DataMerge.indd";
    const LAYOUTS = [
        { w: 1200, h: 1200, frame: [0, 0, 1200, 1200], text: [900, 60, 1140, 1140] },
        { w: 800, h: 600, frame: [0, 0, 600, 800], text: [40, 40, 140, 760] },
        { w: 1080, h: 1920, frame: [0, 0, 1920, 1080], text: [1500, 60, 1800, 1020] },
        { w: 1000, h: 700, frame: [-9, -9, 709, 1009], text: [520, 50, 680, 950] },
    ];
    const doc = app.documents.add(false);
    doc.documentPreferences.facingPages = false;
    doc.viewPreferences.horizontalMeasurementUnits = id.MeasurementUnits.POINTS;
    doc.viewPreferences.verticalMeasurementUnits = id.MeasurementUnits.POINTS;
    doc.viewPreferences.rulerOrigin = id.RulerOrigin.PAGE_ORIGIN;
    doc.documentPreferences.pageWidth = 1200;
    doc.documentPreferences.pageHeight = 1200;
    while (doc.pages.length < LAYOUTS.length) doc.pages.add();
    const imageLayer = doc.layers.add({ name: "Image" });
    const textLayer = doc.layers.add({ name: "Text" });
    for (let i = 0; i < LAYOUTS.length; i++) {
        const L = LAYOUTS[i];
        const page = doc.pages.item(i);
        if (i > 0) page.resize(id.CoordinateSpaces.INNER_COORDINATES, id.AnchorPoint.TOP_LEFT_ANCHOR, id.ResizeMethods.REPLACING_CURRENT_DIMENSIONS_WITH, [L.w, L.h]);
        const fr = page.rectangles.add({ geometricBounds: L.frame, itemLayer: imageLayer, name: "<<MainImage>>" });
        const tf = page.textFrames.add({ geometricBounds: L.text, itemLayer: textLayer, name: "<<Headline>>" });
        tf.contents = "Synthetic headline";
        try { tf.parentStory.pointSize = 48; } catch (e) {}
    }
    out.pageSizes = items(doc.pages).map((p) => r2(p.bounds));
    doc.save(await uxp.storage.localFileSystem.createEntryWithUrl("file:" + TPL, { overwrite: true }));
    doc.close(id.SaveOptions.NO);
    step("template");
    // --- Capsule data: car_01 + car_03 imported, car_02 missing
    const store = await capsule.loadCapsuleStore(ROOT + "/out");
    for (const k of ["A6", "A3"]) {
        const r = await capsule.importFile(store, PHOTOS[k].file, ROOT + "/downloads/" + PHOTOS[k].file.split("/").pop().replace(".png", ".json"), true);
        out["import_" + k] = { ok: r.ok, warnings: r.warnings, errors: r.errors || [] };
    }
    await capsule.saveCapsuleStore(store);
    step("import");
    const rows = Object.keys(PHOTOS).map((k) => ({ headline: k + " Synthetic", imagePath: PHOTOS[k].file, status: "matched", year: "2026", service_subline: "", danis_subline: "" }));
    // --- Generate (the plugin's own pipeline), Capsule source, Auto Placement
    const gen = await render.generateIndds(rows, [TPL], ROOT + "/out", null, { placementMode: "auto", subjectSource: "capsule" });
    out.generate = { generated: gen.generated.map((g) => ({ headline: g.rec.headline, inddPath: g.inddPath, warnings: g.warnings, subject: g.subject })),
        failed: gen.failed.map((x) => ({ headline: x.rec.headline, error: x.error })), log: gen.logLines.filter((l) => /subject/.test(l)).slice(0, 40) };
    step("generate");
    // --- read every placed graphic back; compare with placement.js + Preview
    async function readProduct(g, k) {
        const P = PHOTOS[k];
        const d = app.open(g.inddPath, false);
        const pages = [];
        try {
            d.viewPreferences.horizontalMeasurementUnits = id.MeasurementUnits.POINTS;
            d.viewPreferences.verticalMeasurementUnits = id.MeasurementUnits.POINTS;
            for (const page of items(d.pages)) {
                const frame = items(page.allPageItems).find((it) => String(it.name) === "<<MainImage>>");
                const gr = frame && frame.allGraphics.length ? items(frame.allGraphics)[0] : null;
                let label = null; try { label = JSON.parse(frame.extractLabel("posterBatch.placement")); } catch (e) {}
                let link = ""; try { link = String(gr.itemLink.filePath); } catch (e) {}
                pages.push({ pageBounds: r2(page.bounds), frame: r2(frame.geometricBounds), graphic: gr ? r2(gr.geometricBounds) : null, link, label,
                    ppi: gr ? Array.from(gr.actualPpi || [], Number) : null });
            }
        } finally { d.close(id.SaveOptions.NO); }
        return pages;
    }
    out.products = {};
    for (const g of gen.generated) {
        const k = g.rec.headline.split(" ")[0];
        const P = PHOTOS[k];
        const pages = await readProduct(g, k);
        const store2 = await capsule.loadCapsuleStore(ROOT + "/out");
        const subject = capsule.subjectFromEntry(store2.items[capsule.storeKey(P.file)], await capsule.photoFingerprint(P.file));
        const geo = await render.readPlacementGeometry(g.inddPath, TPL);
        const previews = geo.pages.map((pg) => render.previewPlacementForPage(pg, subject, { width: P.w, height: P.h }, false));
        out.products[k] = { pages, previews: previews.map((p) => ({ kind: p.kind, layout: p.layout.size + " " + p.layout.position, graphic: p.graphicBounds ? r2(p.graphicBounds) : null,
            subjectRect: p.subjectRect ? r2(p.subjectRect) : null, stats: p.stats, warnings: p.warnings, notes: p.notes })), geometrySource: geo.source,
            layoutIds: geo.pages.map((pg) => pg.layoutId) };
    }
    out.docsAfterRead = app.documents.length;
    step("read");
    // --- layout-only edit for A6 on the first layout, regenerate A6
    const store3 = await capsule.loadCapsuleStore(ROOT + "/out");
    const lid = out.products.A6.layoutIds[0];
    capsule.saveEdit(store3, PHOTOS.A6.file, { boundingBox: { x: 0.3, y: 0.45, width: 0.4, height: 0.3 }, focalPoint: PHOTOS.A6.focal }, lid);
    await capsule.saveCapsuleStore(store3);
    const gen2 = await render.generateIndds([rows[0]], [TPL], ROOT + "/out", null, { placementMode: "auto", subjectSource: "capsule" });
    out.regenerate = { generated: gen2.generated.length, failed: gen2.failed.map((x) => x.error), warnings: gen2.generated[0] && gen2.generated[0].warnings,
        log: gen2.logLines.filter((l) => /layout only|layout edits/.test(l)) };
    out.productsAfterEdit = { A6: await readProduct(gen2.generated[0], "A6") };
    out.editedLayout = lid;
    step("edit");
    // --- export compatibility: Preview JPGs + Commit check from the generated INDDs
    const exp = await render.exportFromIndds(gen.generated.map((g) => ({ rec: g.rec, subType: g.subType, inddPath: g.inddPath })), ROOT + "/out", null, { preview: true });
    out.export = exp.items.map((o) => ({ inddPath: o.inddPath, error: o.error || "", warnings: o.warnings, folder: o.folder || "", files: o.files || null }));
    step("export");
    out.docsAtEnd = app.documents.length;
} catch (e) {
    out.error = String(e && e.stack || e);
} finally {
    app.scriptPreferences.userInteractionLevel = uil;
}
await writeOut();
`;
fs.mkdirSync(ROOT, { recursive: true });
fs.writeFileSync(ROOT + "/run.idjs", script);
console.log("running in InDesign … (synthetic files in tools/test-output/capsule-id)");
const R = runInDesign(ROOT + "/run.idjs", ROOT + "/result.json", 900);
fs.writeFileSync(ROOT + "/result.pretty.json", JSON.stringify(R, null, 2));
if (R.error) { console.log("FAIL InDesign script error after steps [" + R.steps.join(", ") + "]: " + R.error); process.exit(1); }

// ---------- checks ----------
const near = (a, b, eps) => !!a && !!b && a.length === b.length && a.every((v, i) => Math.abs(v - b[i]) <= (eps || 0.05));
ok(R.import_A6.ok && R.import_A3.ok, "Capsule JSON imported for car_01 / car_03 inside InDesign (capsule.js + UXP file access)");
ok(R.import_A6.warnings.some((w) => /right \/ bottom edge/.test(w)), "confirmed Capsule box flagged as touching the right / bottom edge (cropped car)");
ok(R.generate.failed.length === 0 && R.generate.generated.length === 3, `Generate (subjectSource capsule): ${R.generate.generated.length} INDDs, ${R.generate.failed.length} failed` +
    (R.generate.failed.length ? " — " + JSON.stringify(R.generate.failed) : ""));
const g = (k) => R.generate.generated.find((x) => x.headline.startsWith(k));
ok(g("A6").subject.capsule.status === "auto" && g("A6").subject.detected, "A6: Capsule box used (status auto)");
ok(g("Q5").subject.capsule.status === "missing" && !g("Q5").subject.detected && g("Q5").warnings.some((w) => /Missing Detection Data/.test(w)),
    "Q5 (no JSON): default placement + Review warning 'Missing Detection Data' — no API call");
ok(!g("A6").warnings.some((w) => /Missing Detection Data/.test(w)) && !g("A3").warnings.some((w) => /Missing Detection Data/.test(w)), "products with Capsule data: no Missing Detection Data warning");
ok(R.generate.log.some((l) => /backend API not used/.test(l)), "log: 'Capsule JSON — backend API not used'");
for (const k of ["A6", "A3", "Q5"]) {
    const pr = R.products[k];
    ok(pr.pages.length === 4 && pr.pages.every((p) => p.graphic && p.link.indexOf(PHOTOS[k].file.split("/").pop()) !== -1), `${k}: the ORIGINAL photo is placed on all 4 layouts`);
    let same = 0, n = 0;
    const miss = [];
    pr.pages.forEach((p, i) => {
        const pv = pr.previews[i];
        if (pv.kind === "fill") { n++; if (p.label && p.label.mode === "fill") same++; else miss.push(`page ${i + 1}: preview fill, label ${JSON.stringify(p.label)}`); return; }
        n++;
        if (near(pv.graphic, p.graphic, 0.06)) same++; else miss.push(`page ${i + 1} ${pv.layout}: preview ${JSON.stringify(pv.graphic)} vs InDesign ${JSON.stringify(p.graphic)}`);
    });
    ok(same === n, `${k}: Preview Placement = the placement InDesign applied on ${same}/${n} layouts` + (miss.length ? "\n   " + miss.join("\n   ") : ""));
}
const a6 = R.products.A6;
const sq = a6.previews[0];
ok(sq.kind === "extend" && sq.stats && sq.stats.frameFill >= 0.7, `A6 1200x1200: existing Auto Placement — subject fills ${Math.round(sq.stats.frameFill * 100)}% of the frame (zoom ×${sq.stats.zoom})`);
const a3 = R.products.A3.previews[0];
ok(a3.kind === "extend" && a3.stats.frameFill >= 0.7 && a3.stats.frameFill <= 0.8 + 1e-6 && a3.stats.zoom > 1, `A3 small car → enlarged by the existing 75–80% rule: ${Math.round(a3.stats.frameFill * 100)}% (×${a3.stats.zoom})`);
ok(a3.subjectRect[2] <= 900 + 0.5 || a3.notes.some((x) => /overlaps the text/.test(x)), "A3: subject above the headline area (or the existing overlap rule says so)");
ok(R.products.A6.pages[2].label.mode === "fill", "1080x1920: Fill layout keeps Content-Aware Fit (original behaviour)");
ok(R.products.A6.pages[3].label.policy === "fallback/geometry" && near(R.products.A6.pages[3].frame, [-9, -9, 709, 1009]), "1000x700 with a bleeding frame: generic geometry policy, frame ≠ page");
ok(R.docsAfterRead === R.docsBefore, `Preview geometry read from copies — no documents left open (${R.docsBefore} → ${R.docsAfterRead})`);
// layout-only edit
const before = R.products.A6.pages, after = R.productsAfterEdit.A6;
ok(R.regenerate.generated === 1 && R.regenerate.failed.length === 0, "layout edit → Regenerate A6");
ok(!near(before[0].graphic, after[0].graphic, 0.5), `edited layout (${R.editedLayout}) placed differently: ${JSON.stringify(before[0].graphic)} → ${JSON.stringify(after[0].graphic)}`);
ok([1, 2, 3].every((i) => (before[i].graphic === null && after[i].graphic === null) || near(before[i].graphic, after[i].graphic, 0.01)), "other layouts: placement unchanged");
ok(R.regenerate.log.length > 0, "log notes the layout-only edit");
// export
ok(R.export.length === 3 && R.export.every((e) => !e.error), "Preview export from the generated INDDs: " + R.export.map((e) => e.error || "ok").join(", "));
const jpgs = [];
(function walk(d) { for (const f of fs.readdirSync(d)) { const p = d + "/" + f; if (fs.statSync(p).isDirectory()) walk(p); else if (/\.jpe?g$/i.test(f)) jpgs.push(p); } })(ROOT + "/out");
ok(jpgs.length >= 12, `preview JPGs written: ${jpgs.length} (3 products × 4 layouts)`);
ok(R.docsAtEnd === R.docsBefore, `no test documents left open (${R.docsAtEnd})`);
console.log(fails ? `${fails} FAILED` : "all passed");
process.exit(fails ? 1 : 0);
