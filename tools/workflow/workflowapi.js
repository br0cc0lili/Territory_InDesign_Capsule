// workflowapi.js — Firefly Creative Production Workflow API ("Workflow Builder
// API") helpers for running the published Capsule subject-detection workflow.
// Pure functions: no network, no credentials. Used by probe.js (live test,
// run only with approval) and meant to move into the Stage backend action.
//
// API (developer.adobe.com/firefly-services/docs/workflow-builder-api, spec 1.0):
//   POST {host}/batch/execute            { workflow: { workflowId, inputs: [[{ node_id, content: [{ presignedUrl, storageType }] }], …] } }
//                                        → 202 { batchId, status, assets, links }
//   GET  {host}/batch/{batchId}/status   → { status: pending|running|completed|failed|cancelled, assets, … }
//   GET  {host}/batch/{batchId}/executions?limit&offset
//                                        → { executions: [{ assetIndex, status, outputs: [object], error }], pagination }
//   Headers on every call: Authorization: Bearer, x-api-key, x-gw-ims-org-id, x-gw-ims-user-id (+ api-version: 1.0)
//
// One run per photo (outer inputs list), so assetIndex i ↔ imageUrls[i].
// The shape of a run's `outputs` is NOT specified (array of objects), so the
// detection is searched for: an object with focalPoint + boundingBox, inline
// or as a JSON string, or a link to a JSON file on an allowed host.

const WORKFLOW_API = {
    host: "https://run-workflow.adobe.io",
    apiVersion: "1.0",
    // Hosts a result link may point to before it is fetched (no credentials are
    // ever sent to it): Adobe and the storage providers the API supports.
    resultHosts: [/\.adobe\.io$/, /\.adobe\.com$/, /\.blob\.core\.windows\.net$/, /\.amazonaws\.com$/, /^storage\.googleapis\.com$/, /\.dropboxusercontent\.com$/, /\.azureedge\.net$/],
    terminal: ["completed", "failed", "cancelled"],
};

function buildBatchRequest(opts) {
    const urls = opts.imageUrls || [];
    if (!opts.workflowId || !opts.nodeId || !urls.length) throw new Error("workflowId, nodeId and at least one image URL are required");
    return {
        workflow: {
            workflowId: String(opts.workflowId),
            inputs: urls.map((u) => [{ node_id: String(opts.nodeId), content: [{ presignedUrl: String(u), storageType: opts.storageType || "Azure" }] }]),
        },
    };
}

function apiHeaders(auth) {
    for (const k of ["token", "apiKey", "orgId", "userId"]) if (!auth || !auth[k]) throw new Error(`missing ${k}`);
    return {
        "Content-Type": "application/json",
        Accept: "application/json",
        Authorization: "Bearer " + auth.token,
        "x-api-key": auth.apiKey,
        "x-gw-ims-org-id": auth.orgId,
        "x-gw-ims-user-id": auth.userId,
        "api-version": WORKFLOW_API.apiVersion,
    };
}

// Non-secret claims of an IMS access token (payload only, never verified or logged whole).
function tokenClaims(token) {
    try {
        const p = String(token).split(".")[1];
        const c = JSON.parse(Buffer.from(p.replace(/-/g, "+").replace(/_/g, "/"), "base64").toString("utf8"));
        const created = Number(c.created_at);
        return { type: c.type, clientId: c.client_id, userId: c.user_id, scopes: String(c.scope || "").split(",").filter(Boolean),
            expiresAt: created && c.expires_in ? new Date(created + Number(c.expires_in)).toISOString() : null };
    } catch (e) { return null; }
}

function isTerminal(status) {
    return WORKFLOW_API.terminal.indexOf(String(status || "").toLowerCase()) !== -1;
}

function allowedResultUrl(u) {
    try {
        const url = new URL(String(u));
        return url.protocol === "https:" && WORKFLOW_API.resultHosts.some((re) => re.test(url.hostname));
    } catch (e) { return false; }
}

// "https://x.blob.core.windows.net/path/file.json?sig=…" → "https://x.blob.core.windows.net/path/file.json?…"
function redactUrl(u) {
    const s = String(u);
    const i = s.indexOf("?");
    return i === -1 ? s : s.slice(0, i) + "?…";
}

// Deep copy with presigned query strings and bearer tokens removed, for logs.
function redact(value) {
    if (typeof value === "string") {
        if (/^https?:\/\//.test(value)) return redactUrl(value);
        if (/^Bearer\s/i.test(value) || /^eyJ[\w-]+\.[\w-]+\.[\w-]+$/.test(value)) return "<redacted>";
        return value;
    }
    if (Array.isArray(value)) return value.map(redact);
    if (value && typeof value === "object") {
        const out = {};
        for (const [k, v] of Object.entries(value)) out[k] = /authorization|token|secret|signature|sig$/i.test(k) ? "<redacted>" : redact(v);
        return out;
    }
    return value;
}

function looksLikeDetection(o) {
    return !!o && typeof o === "object" && !Array.isArray(o) && o.focalPoint && typeof o.focalPoint === "object" && o.boundingBox && typeof o.boundingBox === "object";
}

// Searches one execution's outputs for the Detect Focal Point result.
// → { kind: "inline", detection, path } | { kind: "url", url, path } | { kind: "none" }
// (inline wins; a JSON-file link is returned for the caller to fetch if allowed)
function findDetection(outputs) {
    const links = [];
    let hit = null;
    const visit = (v, path, depth) => {
        if (hit || depth > 8 || v == null) return;
        if (typeof v === "string") {
            const s = v.trim();
            if ((s.startsWith("{") || s.startsWith("[")) && s.indexOf("focalPoint") !== -1) {
                // JSON text (e.g. the Execute Script text output): search inside it,
                // also when it is a list ("one entry per input image")
                let j; try { j = JSON.parse(s); } catch (e) { j = undefined; }
                if (j !== undefined) { visit(j, path + "<json>", depth + 1); return; }
            }
            if (/^https:\/\//.test(s)) links.push({ url: s, path });
            return;
        }
        if (Array.isArray(v)) { v.forEach((x, i) => visit(x, `${path}[${i}]`, depth + 1)); return; }
        if (typeof v === "object") {
            if (looksLikeDetection(v)) { hit = { kind: "inline", detection: v, path }; return; }
            for (const [k, x] of Object.entries(v)) visit(x, path ? `${path}.${k}` : k, depth + 1);
        }
    };
    visit(outputs, "outputs", 0);
    if (hit) return hit;
    const json = links.find((l) => /\.json(\?|$)/i.test(l.url) || /json/i.test(l.path));
    const any = json || links.find((l) => !/\.(png|jpe?g|webp|tiff?|gif|psd)(\?|$)/i.test(l.url));
    return any ? { kind: "url", url: any.url, path: any.path } : { kind: "none" };
}

// The outputs' structure without values (keys, types, link hosts) — what the
// probe reports so the real shape can be documented.
function describeShape(v, depth) {
    const d = depth || 0;
    if (d > 6) return "…";
    if (v == null) return String(v);
    if (Array.isArray(v)) return v.length ? [describeShape(v[0], d + 1)].concat(v.length > 1 ? [`…${v.length} items`] : []) : [];
    if (typeof v === "object") { const o = {}; for (const [k, x] of Object.entries(v)) o[k] = describeShape(x, d + 1); return o; }
    if (typeof v === "string") return /^https?:\/\//.test(v) ? `url(${(() => { try { return new URL(v).hostname; } catch (e) { return "?"; } })()})` : `string(${v.length})`;
    return typeof v;
}

// executions response → per image: { index, status, kind, detection?, url?, error? }
function collectResults(executionsResponse, count) {
    const byIndex = new Map();
    for (const ex of (executionsResponse && executionsResponse.executions) || []) {
        const idx = Number(ex.assetIndex != null ? ex.assetIndex : ex.inputAsset && ex.inputAsset.index);
        byIndex.set(idx, ex);
    }
    const out = [];
    for (let i = 0; i < count; i++) {
        const ex = byIndex.get(i);
        if (!ex) { out.push({ index: i, status: "missing", kind: "none", error: "no execution for this image" }); continue; }
        if (ex.status !== "success") { out.push({ index: i, status: ex.status, kind: "none", error: ex.error || `execution ${ex.status}` }); continue; }
        out.push(Object.assign({ index: i, status: ex.status }, findDetection(ex.outputs)));
    }
    return out;
}

module.exports = { WORKFLOW_API, buildBatchRequest, apiHeaders, tokenClaims, isTerminal, allowedResultUrl, redactUrl, redact, findDetection, describeShape, collectResults };
