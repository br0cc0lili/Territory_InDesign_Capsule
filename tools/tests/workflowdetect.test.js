// Offline regression test (Node, no network). Run: node tools/tests/run.js
// plugin/js/workflowdetect.js — "Detect with Adobe Workflow": upload, one
// batch, polling, results by position, failures. Fake backend, synthetic data.
const path = require("path");
const REPO = path.resolve(__dirname, "../..");
const wd = require(REPO + "/plugin/js/workflowdetect.js");
let f = 0;
const ok = (c, m) => { console.log((c ? "PASS " : "FAIL ") + m); if (!c) f++; };
const J = JSON.stringify;

const DET = (x) => ({ focalPoint: { x: x + 0.2, y: 0.6, normalized: true }, boundingBox: { x, y: 0.4, width: 0.5, height: 0.45, normalized: true } });

// A fake backend. results(storagePaths) → the backend's results list.
function fakeBackend(opts) {
    const o = Object.assign({ runningPolls: 1, results: null, startError: null, statusErrors: 0, putFail: [] }, opts);
    const calls = { upload: 0, put: [], detect: [], status: 0 };
    let n = 0, polls = 0, statusErrors = o.statusErrors;
    const deps = {
        async post(action, body) {
            if (action === "subject-upload-url") {
                calls.upload++; n++;
                return { uploadUrl: `https://files.example/put/${n}?sig=SECRET`, storagePath: `subject/uploads/SUB_${String(n).padStart(12, "0")}-1795000000000.png`, uploadHeaders: { "x-ms-blob-type": "BlockBlob", "Content-Type": body.contentType } };
            }
            if (action === "capsule-detect") {
                if (o.startError) { const e = new Error(o.startError); e.status = 409; throw e; }
                calls.detect.push(body.storagePaths);
                return { jobId: "CDJ_00000000000000aa", batchId: "batch-test-0001", count: body.storagePaths.length, status: "pending" };
            }
            if (action === "capsule-detect-status") {
                calls.status++;
                if (statusErrors > 0) { statusErrors--; throw new Error("Workflow status unavailable — try again"); }
                polls++;
                if (polls <= o.runningPolls) return { state: "running", status: "running", progress: { total: 3, completed: polls - 1, failed: 0 } };
                const paths = calls.detect[calls.detect.length - 1];
                return { state: "done", status: "completed", results: o.results ? o.results(paths) : paths.map((p, i) => ({ index: i, ok: true, ...DET(0.1 * (i + 1)), source: "detect-focal-point" })) };
            }
            throw new Error("unexpected action " + action);
        },
        async put(url, headers, bytes) { calls.put.push({ url, headers, size: bytes.length }); return o.putFail.indexOf(calls.put.length) !== -1 ? "upload failed (HTTP 403)" : null; },
        async readBytes(p) { return Buffer.from("bytes of " + p); },
        async fingerprint(p) { return /unreadable/.test(p) ? null : { size: p.length, modified: 1000 }; },
        sleep: async () => {},
        options: { pollIntervalMs: 0 },
    };
    return { deps, calls };
}

(async () => {
    // several photos, unsupported one in the middle: positions stay right
    let fb = fakeBackend({ results: (paths) => paths.map((p, i) => ({ index: i, ok: true, ...DET(0.1 * (i + 1)), uncertaintyScore: 0.1 })).reverse() });
    const progress = [];
    fb.deps.onProgress = (p) => progress.push(p.phase);
    let r = await wd.detectPhotos(["/p/a.jpg", "/p/b.tif", "/p/c.PNG", "/p/d.jpeg"], fb.deps);
    ok(fb.calls.upload === 3 && fb.calls.detect.length === 1 && fb.calls.detect[0].length === 3, "3 supported photos uploaded, ONE batch with 3 paths");
    ok(J(r.results.map((x) => [x.imagePath, x.ok, x.ok ? x.detection.boundingBox.x : x.error])) === J([["/p/a.jpg", true, 0.1], ["/p/b.tif", false, "only JPG and PNG photos can be detected"], ["/p/c.PNG", true, 0.2], ["/p/d.jpeg", true, 0.30000000000000004]]),
        "results matched by position (backend index), not by order of the list; unsupported type reported");
    ok(r.results[0].uncertaintyScore === 0.1 && r.results[0].fingerprint.size === 8 && r.jobId === "CDJ_00000000000000aa" && r.batchId === "batch-test-0001", "fingerprint taken before upload; job + batch ids returned");
    ok(fb.calls.put[0].headers["x-ms-blob-type"] === "BlockBlob" && fb.calls.put[0].size === "bytes of /p/a.jpg".length, "the photo's own bytes are PUT with the backend's upload headers");
    ok(progress.indexOf("upload") !== -1 && progress.indexOf("detect") !== -1, "progress reported for upload and detection");

    // partial failures from the workflow, missing result, upload failure
    fb = fakeBackend({ putFail: [2], results: () => [{ index: 0, ok: true, ...DET(0.1) }, { index: 1, ok: false, error: "workflow run failed: input asset not reachable (403)" }] });
    r = await wd.detectPhotos(["/p/a.jpg", "/p/b.jpg", "/p/c.jpg", "/p/d.jpg"], fb.deps);
    ok(J(r.results.map((x) => x.ok ? "ok" : x.error)) === J(["ok", "upload failed (HTTP 403)", "workflow run failed: input asset not reachable (403)", "no result returned for this photo"]),
        "upload failure, workflow run failure (e.g. expired link) and a missing result → per-photo errors");

    // invalid detections are passed on as returned — the panel validates with capsule.js
    fb = fakeBackend({ results: () => [{ index: 0, ok: true, focalPoint: { x: 2, y: 0, normalized: true }, boundingBox: { x: 0, y: 0, width: 1, height: 1, normalized: true } }] });
    r = await wd.detectPhotos(["/p/a.jpg"], fb.deps);
    ok(r.results[0].ok && r.results[0].detection.focalPoint.x === 2, "detection passed through unchanged (validated later by capsule.js)");

    // start failure, transient status errors, persistent status errors, timeout
    fb = fakeBackend({ startError: "upload already used by another detection" });
    r = await wd.detectPhotos(["/p/a.jpg", "/p/b.png"], fb.deps);
    ok(r.results.every((x) => /Adobe Workflow could not be started: upload already used/.test(x.error)) && fb.calls.status === 0, "capsule-detect refused → every photo failed with the reason, no polling");
    fb = fakeBackend({ statusErrors: 2 });
    r = await wd.detectPhotos(["/p/a.jpg"], fb.deps);
    ok(r.results[0].ok && fb.calls.status === 4, "two failed status calls → polled again, then done");
    fb = fakeBackend({ statusErrors: 99 });
    r = await wd.detectPhotos(["/p/a.jpg"], fb.deps);
    ok(/Adobe Workflow status unavailable/.test(r.results[0].error) && fb.calls.status === 5, "5 failed status calls in a row → stopped with an error");
    fb = fakeBackend({ runningPolls: 1e9 });
    let t = 0;
    fb.deps.now = () => (t += 60000);
    fb.deps.options = { pollIntervalMs: 0, timeoutMs: 5 * 60000 };
    r = await wd.detectPhotos(["/p/a.jpg"], fb.deps);
    ok(/took too long/.test(r.results[0].error), "still running after the time limit → error, the panel is freed");

    // nothing uploadable, too many photos, unreadable photo
    fb = fakeBackend({});
    r = await wd.detectPhotos(["/p/a.gif", "/p/unreadable.jpg"], fb.deps);
    ok(r.error === "no photo could be uploaded" && fb.calls.detect.length === 0 && r.results[1].error === "the photo can't be read", "no uploadable photo → no batch");
    r = await wd.detectPhotos(Array.from({ length: 101 }, (_, i) => `/p/${i}.jpg`), fb.deps);
    ok(/at most 100/.test(r.error) && fb.calls.upload === 0, "more than 100 photos refused before uploading");

    // createDeps: backend errors carry the message and status; no secrets in errors
    const fetchCalls = [];
    const deps = wd.createDeps({ baseUrl: "https://ns.adobeio-static.net/api/v1/web/territory-app", pluginKey: "KEY" },
        async (url, init) => { fetchCalls.push({ url, init }); return { ok: false, status: 409, json: async () => ({ error: "upload already used by another detection: SUB_x.png" }) }; }, {});
    let err = null;
    try { await deps.post("capsule-detect", { storagePaths: ["a"] }); } catch (e) { err = e; }
    ok(err && err.status === 409 && err.message === "upload already used by another detection: SUB_x.png" && fetchCalls[0].init.headers["x-plugin-key"] === "KEY" && fetchCalls[0].url.endsWith("/capsule-detect"), "createDeps: POST with x-plugin-key; backend error message + status");

    ok(/^Adobe Workflow · \d{4}-\d\d-\d\d \d\d:\d\d$/.test(wd.workflowLabel()), "source label 'Adobe Workflow · <date time>'");
    ok(wd.sameFingerprint({ size: 5, modified: 10 }, { size: 5, modified: "10" }) && !wd.sameFingerprint({ size: 5, modified: 10 }, { size: 6, modified: 10 }) && !wd.sameFingerprint(null, { size: 1 }), "photo change check (size + modified)");

    console.log(f ? `${f} FAILED` : "all passed");
    process.exit(f ? 1 : 0);
})().catch((e) => { console.log("FAIL harness error: " + (e && e.stack || e)); process.exit(1); });
