// workflowdetect.js — "Detect with Adobe Workflow" (Capsule mode, step 3).
//
// Runs the published Adobe Workflow (Detect Focal Point) on the photos the
// plugin already knows, through the team backend (territory-app):
//   subject-upload-url     → PUT each photo to App Builder Files (same as Backend API mode)
//   capsule-detect         → ONE workflow batch, one run per photo → { jobId }
//   capsule-detect-status  → polled until done → per photo { ok, boundingBox, focalPoint } | { ok: false, error }
// The backend holds the Adobe credential, creates the signed read URLs and
// deletes the uploads; the plugin never sees either. Results are matched by
// position (the backend matches Adobe's asset_index), never by file name.
//
// Nothing here writes Capsule data: index.js stores the results through
// capsule.js (importText = the same validation as an imported JSON file).

/* global require, fetch */

const WORKFLOW_DETECT = {
    pollIntervalMs: 3000,
    timeoutMs: 15 * 60 * 1000,     // the backend cancels a batch after 30 min; the panel stops waiting before
    maxStatusErrors: 5,            // consecutive failed status calls before giving up
    maxPhotos: 100,                // = backend MAX_PHOTOS
    contentTypes: { jpg: "image/jpeg", jpeg: "image/jpeg", png: "image/png" },
};

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const extOf = (p) => String(p).split(".").pop().toLowerCase();

// Real connections: the backend actions (x-plugin-key) and the UXP file system.
//   cfg: { baseUrl, pluginKey } from backend.config.json (subject.js loadSubjectConfig)
//   fetchFn: fetch; storage: require("uxp").storage
function createDeps(cfg, fetchFn, storage) {
    const f = fetchFn || fetch;
    return {
        async post(action, body) {
            const res = await f(`${cfg.baseUrl}/${action}`, {
                method: "POST",
                headers: { "Content-Type": "application/json", "x-plugin-key": cfg.pluginKey },
                body: JSON.stringify(body),
            });
            let json = null;
            try { json = await res.json(); } catch (e) {}
            if (!res.ok) {
                const err = new Error((json && json.error) || `HTTP ${res.status}`);
                err.status = res.status;
                throw err;
            }
            return json;
        },
        async put(url, headers, bytes) {
            const res = await f(url, { method: "PUT", headers, body: bytes });
            return res.ok ? null : `upload failed (HTTP ${res.status})`;
        },
        async readBytes(path) {
            const st = storage || require("uxp").storage;
            const entry = await st.localFileSystem.getEntryWithUrl("file:" + path);
            return entry.read({ format: st.formats.binary });
        },
    };
}

// Detects the given photos (unique paths). Never throws for one photo's
// problem; returns one entry per path in the same order:
//   { imagePath, ok: true, detection: { focalPoint, boundingBox }, uncertaintyScore?, fingerprint }
//   { imagePath, ok: false, error }
// plus { jobId, batchId, error? } for the whole run.
//   deps: { post, put, readBytes, fingerprint(path), onProgress?, sleep?, now?, options? }
async function detectPhotos(paths, deps) {
    const opts = Object.assign({}, WORKFLOW_DETECT, deps.options || {});
    const wait = deps.sleep || sleep;
    const now = deps.now || (() => Date.now());
    const progress = deps.onProgress || (() => {});
    const out = paths.map((imagePath) => ({ imagePath, ok: false, error: "not detected" }));
    const fail = (i, error) => { out[i] = { imagePath: paths[i], ok: false, error }; };
    if (paths.length > opts.maxPhotos) {
        paths.forEach((p, i) => fail(i, `at most ${opts.maxPhotos} photos per detection`));
        return { results: out, error: `at most ${opts.maxPhotos} photos per detection` };
    }

    // 1. upload (the photo's fingerprint is taken first: a change during the run is caught later)
    const uploaded = []; // { i, storagePath, fingerprint }
    for (let i = 0; i < paths.length; i++) {
        progress({ phase: "upload", done: i, total: paths.length });
        const contentType = opts.contentTypes[extOf(paths[i])];
        if (!contentType) { fail(i, "only JPG and PNG photos can be detected"); continue; }
        try {
            const fingerprint = await deps.fingerprint(paths[i]);
            if (!fingerprint) { fail(i, "the photo can't be read"); continue; }
            const bytes = await deps.readBytes(paths[i]);
            const target = await deps.post("subject-upload-url", { contentType });
            const putError = await deps.put(target.uploadUrl, target.uploadHeaders, bytes);
            if (putError) { fail(i, putError); continue; }
            uploaded.push({ i, storagePath: target.storagePath, fingerprint });
        } catch (e) {
            fail(i, "upload failed: " + String((e && e.message) || e));
        }
    }
    progress({ phase: "upload", done: paths.length, total: paths.length });
    if (!uploaded.length) return { results: out, error: "no photo could be uploaded" };

    // 2. one batch
    let job;
    try {
        job = await deps.post("capsule-detect", { storagePaths: uploaded.map((u) => u.storagePath) });
    } catch (e) {
        const msg = "Adobe Workflow could not be started: " + String((e && e.message) || e);
        for (const u of uploaded) fail(u.i, msg);
        return { results: out, error: msg };
    }

    // 3. poll
    const started = now();
    let errors = 0;
    let st = null;
    for (;;) {
        try {
            st = await deps.post("capsule-detect-status", { jobId: job.jobId });
            errors = 0;
        } catch (e) {
            errors++;
            if (errors >= opts.maxStatusErrors) {
                const msg = "Adobe Workflow status unavailable: " + String((e && e.message) || e);
                for (const u of uploaded) fail(u.i, msg);
                return { jobId: job.jobId, batchId: job.batchId, results: out, error: msg };
            }
        }
        if (st && st.state === "done") break;
        progress({ phase: "detect", total: uploaded.length, status: st && st.status, progress: (st && st.progress) || null });
        if (now() - started > opts.timeoutMs) {
            const msg = "Adobe Workflow took too long — try again later";
            for (const u of uploaded) fail(u.i, msg);
            return { jobId: job.jobId, batchId: job.batchId, results: out, error: msg };
        }
        await wait(opts.pollIntervalMs);
    }

    // 4. results by position (backend index = position in storagePaths)
    const byIndex = new Map();
    for (const r of Array.isArray(st.results) ? st.results : []) if (r && Number.isInteger(r.index)) byIndex.set(r.index, r);
    uploaded.forEach((u, k) => {
        const r = byIndex.get(k);
        if (!r) { fail(u.i, "no result returned for this photo"); return; }
        if (!r.ok) { fail(u.i, String(r.error || "not detected")); return; }
        out[u.i] = Object.assign({ imagePath: paths[u.i], ok: true, fingerprint: u.fingerprint,
            detection: { focalPoint: r.focalPoint, boundingBox: r.boundingBox } },
            typeof r.uncertaintyScore === "number" ? { uncertaintyScore: r.uncertaintyScore } : {});
    });
    return { jobId: job.jobId, batchId: job.batchId, status: st.status, results: out };
}

// "Adobe Workflow · 2026-11-18 14:02" (local time) — shown as the data's source.
function workflowLabel(date) {
    const d = date || new Date();
    const p = (n) => String(n).padStart(2, "0");
    return `Adobe Workflow · ${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
}

// Same photo file as when it was uploaded?
function sameFingerprint(a, b) {
    return !!a && !!b && a.size === b.size && String(a.modified) === String(b.modified);
}

module.exports = { WORKFLOW_DETECT, createDeps, detectPhotos, workflowLabel, sameFingerprint };
