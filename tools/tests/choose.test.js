// Offline regression test (Node, no InDesign). Run: node tools/tests/run.js
// Choose Subject: object detection through the backend, the stored choice,
// and the detector that prefers the choice over the automatic box.
const PLUGIN_JS = require("path").resolve(__dirname, "../../plugin/js");
const Module = require("module"); const o = Module._load;
const files = { "/photos/car.jpg": new Uint8Array([0xff, 0xd8, 1, 2, 3]), "/photos/mats.jpg": new Uint8Array([0xff, 0xd8, 9]) };
const written = {};
const uxp = { storage: {
    formats: { binary: "binary" }, types: { file: "file" },
    localFileSystem: {
        async getPluginFolder() { return { async getEntry() { return { async read() { return JSON.stringify({ baseUrl: "https://ns.adobeio-static.net/api/v1/web/territory-app", pluginKey: "k" }); } }; } }; },
        async getEntryWithUrl(url) {
            const p = url.replace(/^file:/, "");
            if (written[p] === undefined && files[p] === undefined) throw new Error("missing " + p);
            return { async read() { return written[p] !== undefined ? written[p] : files[p].buffer; },
                async getMetadata() { return { size: files[p] ? files[p].length : 1, dateModified: new Date(0) }; } };
        },
        async createEntryWithUrl(url) { const p = url.replace(/^file:/, ""); return { async write(d) { written[p] = d; } }; },
    } } };
Module._load = function (r) { return r === "uxp" ? uxp : o.apply(this, arguments); };
const calls = [];
let polls = 0;
const json = (body, status = 200) => ({ ok: status < 400, status, json: async () => body });
global.fetch = async (url, init = {}) => {
    calls.push({ url, body: init.body ? (typeof init.body === "string" ? JSON.parse(init.body) : "bytes") : null, headers: init.headers });
    const base = "https://ns.adobeio-static.net/api/v1/web/territory-app/";
    if (url === base + "subject-upload-url") return json({ uploadUrl: "https://files.example/put", storagePath: "subject/uploads/SUB_1.jpg", uploadHeaders: { "x-ms-blob-type": "BlockBlob" } });
    if (url === "https://files.example/put") return json({}, 201);
    if (url === base + "subject-objects") return json({ jobId: "job-1", statusUrl: null, workPath: "subject/objects/OBJ_1.jpg", sentSize: { width: 2048, height: 1365 } });
    if (url === base + "subject-objects-status") {
        polls++;
        if (polls < 2) return json({ status: "running" });
        return json({ status: "succeeded", objects: [
            { id: 1, label: "Car", score: 0.97, box: { x: 0.3, y: 0.35, width: 0.65, height: 0.5 } },
            { id: 2, label: "Person", score: 0.95, box: { x: 0.05, y: 0.2, width: 0.18, height: 0.7 } },
        ] });
    }
    if (url === base + "subject-mask") return json({ jobId: "urn:ff:jobs:x", statusUrl: "s" });
    if (url === base + "subject-status") return json({ status: "succeeded", subjectBox: { x: 0, y: 0, width: 1, height: 1 } });
    throw new Error("unexpected " + url);
};
const subject = require(PLUGIN_JS + "/subject.js");
subject.CONFIG.pollIntervalMs = 1;
const picker = require(PLUGIN_JS + "/subjectpicker.js");
let f = 0; const ok = (c, m) => { console.log((c ? "PASS " : "FAIL ") + m); if (!c) f++; };

(async () => {
    // pure helpers
    const objs = [{ id: 1, box: { x: 0.3, y: 0.35, width: 0.65, height: 0.5 } }, { id: 2, box: { x: 0.05, y: 0.2, width: 0.18, height: 0.7 } }];
    ok(JSON.stringify(subject.unionBox(objs, [1, 2])) === JSON.stringify({ x: 0.05, y: 0.2, width: 0.9, height: 0.7 }), "union of two objects");
    ok(JSON.stringify(subject.unionBox(objs, [2])) === JSON.stringify(objs[1].box) && subject.unionBox(objs, []) === null && subject.unionBox(objs, [9]) === null, "one object / none");
    ok(subject.isWholePhotoBox({ x: 0, y: 0, width: 1, height: 1 }) && subject.isWholePhotoBox({ x: 0.01, y: 0.02, width: 0.97, height: 0.96 }) && !subject.isWholePhotoBox({ x: 0, y: 0, width: 1, height: 0.6 }), "whole-photo box");
    ok(picker.toBase64(new Uint8Array([77, 97, 110])) === "TWFu" && picker.toBase64(new Uint8Array([77, 97])) === "TWE=" && picker.toBase64(new Uint8Array([77])) === "TQ==", "base64");
    const big = new Uint8Array(100000).map((_, i) => i % 256);
    ok(picker.toBase64(big) === Buffer.from(big).toString("base64"), "base64 of a large buffer");
    ok(JSON.stringify(picker.previewSize({ width: 2160, height: 1440 })) === JSON.stringify({ width: 480, height: 320 }) &&
        picker.previewSize({ width: 1000, height: 2000 }).height === 320, "preview size keeps the aspect");
    ok(JSON.stringify(picker.boxToPixels({ x: 0.5, y: 0.25, width: 0.25, height: 0.5 }, { width: 400, height: 200 })) === JSON.stringify({ left: 200, top: 50, width: 100, height: 100 }), "box to preview pixels");

    // detection through the backend
    const cfg = (await subject.loadSubjectConfig()).config;
    const found = await subject.detectSubjectObjects("/photos/car.jpg", cfg);
    ok(found.objects.length === 2 && found.objects[0].label === "Car", "objects detected through subject-objects / subject-objects-status");
    const statusCall = calls.find((c) => c.url.endsWith("subject-objects-status"));
    ok(statusCall.body.workPath === "subject/objects/OBJ_1.jpg" && statusCall.body.sentSize.width === 2048, "status call echoes workPath + sentSize");
    ok(calls.filter((c) => c.url.includes("territory-app")).every((c) => c.headers["x-plugin-key"] === "k"), "every backend call carries the plugin key");
    let err = "";
    try { await subject.detectSubjectObjects("/photos/x.tif", cfg); } catch (e) { err = e.message; }
    ok(/JPG or PNG/.test(err), "tif refused clearly");

    // choices store
    const store = await subject.loadSubjectChoices("/out/");
    ok(store.path === "/out/subject_choices.json" && Object.keys(store.items).length === 0, "empty store when the file doesn't exist");
    const key = await subject.photoKey("/photos/car.jpg");
    store.items[key] = { imagePath: "/photos/car.jpg", objects: found.objects, selected: [2] };
    await subject.saveSubjectChoices(store);
    const again = await subject.loadSubjectChoices("/out");
    ok(again.items[key] && again.items[key].selected[0] === 2, "choice saved and read back");
    ok(subject.chosenSubject(again.items[key]).labels[0] === "Person" && subject.chosenSubject({ objects: found.objects, selected: null }) === null, "chosenSubject");

    // detector: chosen photo skips remove-background; other photo uses it and is flagged whole-photo
    const before = calls.length;
    const det = subject.createSubjectDetector(cfg, "", again);
    ok(det.hasChoices && det.enabled, "detector knows there are choices");
    const a = await det.detect("/photos/car.jpg");
    ok(a.source === "chosen" && a.labels[0] === "Person" && a.box.x === 0.05 && !a.wholePhoto && calls.length === before, "chosen subject used, no backend call");
    const b = await det.detect("/photos/mats.jpg");
    ok(b.source === "photoshop-mask" && b.wholePhoto === true, "automatic box covering the whole photo is flagged");
    // backend off, choice still works
    const offline = subject.createSubjectDetector(null, "backend not configured", again);
    ok(!offline.enabled && offline.hasChoices && (await offline.detect("/photos/car.jpg")).source === "chosen", "a stored choice works even without the backend");
    ok((await offline.detect("/photos/mats.jpg")).reason === "backend not configured", "no choice + no backend → reason");
    console.log(f ? f + " FAILED" : "all passed");
})().catch((e) => { console.log("FAIL crashed: " + e.stack); process.exit(1); });
