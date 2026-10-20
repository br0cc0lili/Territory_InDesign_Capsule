// subject.js — SUBJECT DETECTION (bounding box) for the PLACEMENT stage.
//
// Finds the main subject of a product photo via the territory-app App
// Builder actions (Photoshop API remove-background, mode "mask"):
//   subject-upload-url → PUT the photo to App Builder Files (presigned)
//   subject-mask       → backend shrinks it, submits the mask job
//   subject-status     → polled until done; returns subjectBox
//                        { x, y, width, height } as shares (0..1) of the photo
// The box only feeds placement.js (where the ORIGINAL image goes). Image
// Extension never sees it — it works from the final placed geometry.
//
// Never blocks Generate: any problem (backend not configured, unsupported
// file type, network, timeout, empty mask) returns { box: null, reason } and
// placement falls back to its normal behaviour. One detection per photo per
// run (cached), shared by every page and template of the product.

/* global require, fetch */

const CONFIG = {
    pollIntervalMs: 2000,
    timeoutMs: 90000,
    contentTypes: { jpg: "image/jpeg", jpeg: "image/jpeg", png: "image/png" },
};

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// POSTs JSON to one territory-app action (same gate as Image Extension).
async function post(cfg, action, body) {
    const res = await fetch(`${cfg.baseUrl}/${action}`, {
        method: "POST",
        headers: { "Content-Type": "application/json", "x-plugin-key": cfg.pluginKey },
        body: JSON.stringify(body),
    });
    let json = null;
    try { json = await res.json(); } catch (e) {}
    if (!res.ok) throw new Error(`${action}: ${(json && json.error) || "HTTP " + res.status}`);
    return json;
}

// The subject box of one photo, or { box: null, reason }.
//   cfg: { baseUrl, pluginKey } (plugin/backend.config.json)
async function detectSubjectBox(imagePath, cfg) {
    const started = Date.now();
    const ext = String(imagePath).split(".").pop().toLowerCase();
    const contentType = CONFIG.contentTypes[ext];
    if (!contentType) return { box: null, reason: `unsupported image type .${ext} for subject detection` };
    const target = await post(cfg, "subject-upload-url", { contentType });
    const storage = require("uxp").storage;
    const entry = await storage.localFileSystem.getEntryWithUrl("file:" + imagePath);
    const bytes = await entry.read({ format: storage.formats.binary });
    const put = await fetch(target.uploadUrl, { method: "PUT", headers: target.uploadHeaders, body: bytes });
    if (!put.ok) throw new Error(`photo upload failed (HTTP ${put.status})`);
    const job = await post(cfg, "subject-mask", { storagePath: target.storagePath, contentType });
    for (;;) {
        const st = await post(cfg, "subject-status", { jobId: job.jobId, statusUrl: job.statusUrl });
        if (st.status === "succeeded") {
            if (!st.subjectBox) return { box: null, reason: st.boxError || "no subject box returned", jobId: job.jobId };
            const b = st.subjectBox;
            return { box: { x: b.x, y: b.y, width: b.width, height: b.height }, coverage: b.coverage,
                source: "photoshop-mask", jobId: job.jobId, seconds: Math.round((Date.now() - started) / 1000) };
        }
        if (st.status === "failed" || st.status === "canceled" || st.status === "cancelled") {
            return { box: null, reason: `mask job ${st.status}: ${st.error || "no details"}`, jobId: job.jobId };
        }
        if (Date.now() - started > CONFIG.timeoutMs) return { box: null, reason: "subject detection timed out", jobId: job.jobId };
        await sleep(CONFIG.pollIntervalMs);
    }
}

// Connection from plugin/backend.config.json (the same file Image Extension
// uses): { config: { baseUrl, pluginKey } | null, reason }. Off when the file
// is missing / disabled, or "subjectDetection": false.
async function loadSubjectConfig() {
    try {
        const folder = await require("uxp").storage.localFileSystem.getPluginFolder();
        const cfg = JSON.parse(await (await folder.getEntry("backend.config.json")).read());
        if (!cfg || cfg.enabled === false) return { config: null, reason: "backend disabled in backend.config.json" };
        if (cfg.subjectDetection === false) return { config: null, reason: "subject detection disabled in backend.config.json" };
        if (!/^https:\/\//.test(String(cfg.baseUrl || "")) || !cfg.pluginKey) return { config: null, reason: "backend.config.json needs an https baseUrl and a pluginKey" };
        return { config: { baseUrl: String(cfg.baseUrl).replace(/\/+$/, ""), pluginKey: String(cfg.pluginKey) }, reason: "" };
    } catch (e) {
        return { config: null, reason: "backend not configured (plugin/backend.config.json missing)" };
    }
}

// A detector for one run: caches per photo, never throws.
//   cfg: backend config or null (→ every call returns { box: null, reason })
function createSubjectDetector(cfg, reasonIfOff) {
    const cache = new Map();
    return {
        enabled: !!cfg,
        detect(imagePath) {
            if (!cfg) return Promise.resolve({ box: null, reason: reasonIfOff || "subject detection off" });
            const key = String(imagePath).toLowerCase();
            if (!cache.has(key)) {
                cache.set(key, detectSubjectBox(imagePath, cfg).catch((e) => ({ box: null, reason: String((e && e.message) || e) })));
            }
            return cache.get(key);
        },
    };
}

module.exports = { CONFIG, loadSubjectConfig, detectSubjectBox, createSubjectDetector };
