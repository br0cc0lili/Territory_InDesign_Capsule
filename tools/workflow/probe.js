// probe.js — minimal integration test of the published Capsule subject-detection
// workflow through the Workflow API, with ONE synthetic image.
//
//   node tools/workflow/probe.js                       dry run: no network; builds the image and the request
//   node tools/workflow/probe.js --live --auth stage   LIVE (only with approval): Stage OAuth S2S credential
//                                                      + the deployed Stage actions for the image URL
//
// Options:  --workflow <id>  --node <node_id>  --storage-type <external|…> (default: what workflow-image-url returns)
//           --image-url <presigned GET url>        (skip App Builder Files)
//           --stage-dir <path to territory-app>    (default ~/territory-app; its .env is read in-process, never printed or changed)
//
// Steps (live):
//   1. IMS token: client_credentials with the Stage credential (client secret stays in this process)
//   2. synthetic PNG → subject-upload-url (deployed, unchanged) → PUT → workflow-image-url → presigned READ url (15 min)
//      (App Builder Files only works from inside Runtime, hence the deployed actions)
//   3. POST /batch/execute (one run) → batchId
//   4. GET /batch/{id}/status until completed / failed / cancelled (max 15 min)
//   5. GET /batch/{id}/executions → find focalPoint + boundingBox (inline, or an allowed JSON link)
//   6. validate with plugin/js/capsule.js parseCapsuleJson; compare with the synthetic car
//   7. delete the uploaded image (workflow-image-url op "delete")
// Every response is saved, redacted (no tokens, no presigned query strings), to
// tools/test-output/workflow-probe/<time>/. Nothing in the plugin or the Stage backend changes.

const fs = require("fs");
const os = require("os");
const path = require("path");
const api = require("./workflowapi.js");
const { SYNTHETIC, syntheticPng, iou } = require("./synthetic.js");
const capsule = require("../../plugin/js/capsule.js");

const DEFAULTS = {
    workflowId: "2d69b6ea-70a5-4119-b930-3d5e15ceff4e",   // published Capsule workflow (from the Publish dialog cURL)
    nodeId: "node-1794841303181-lnger91fw",               // its image input node
    storageType: "",                                       // "" = use what workflow-image-url returns ("external": presigned URL, per the input-files node docs)
    stageDir: path.join(os.homedir(), "territory-app"),
    pollMs: 5000,
    maxWaitMs: 15 * 60 * 1000,
};

function args(argv) {
    const o = { live: false };
    for (let i = 0; i < argv.length; i++) {
        const a = argv[i];
        if (a === "--live") o.live = true;
        else if (a.startsWith("--")) o[a.slice(2).replace(/-([a-z])/g, (m, c) => c.toUpperCase())] = argv[++i];
    }
    return o;
}

// KEY=value lines; values may be JSON (arrays). Kept in memory only.
function readEnvFile(file) {
    const env = {};
    for (const line of fs.readFileSync(file, "utf8").split(/\r?\n/)) {
        const m = /^([A-Za-z0-9_\-]+)=(.*)$/.exec(line);
        if (!m) continue;
        let v = m[2].trim().replace(/^['"]|['"]$/g, "");
        if (/^\[.*\]$/.test(v)) { try { v = JSON.parse(v); } catch (e) {} }
        env[m[1]] = v;
    }
    return env;
}

const first = (v) => (Array.isArray(v) ? v[0] : v);

async function stageToken(env) {
    const clientId = first(env.IMS_OAUTH_S2S_CLIENT_ID), secret = first(env.IMS_OAUTH_S2S_CLIENT_SECRET), orgId = first(env.IMS_OAUTH_S2S_ORG_ID);
    const scopes = Array.isArray(env.IMS_OAUTH_S2S_SCOPES) ? env.IMS_OAUTH_S2S_SCOPES.join(",") : String(env.IMS_OAUTH_S2S_SCOPES || "");
    if (!clientId || !secret || !orgId) throw new Error("the Stage .env has no IMS_OAUTH_S2S_CLIENT_ID / _CLIENT_SECRET / _ORG_ID");
    const body = new URLSearchParams({ grant_type: "client_credentials", client_id: clientId, client_secret: secret, scope: scopes });
    const res = await fetch("https://ims-na1.adobelogin.com/ims/token/v3", { method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" }, body });
    const j = await res.json().catch(() => ({}));
    if (!res.ok || !j.access_token) throw new Error(`IMS token request failed: HTTP ${res.status} ${j.error || ""} ${j.error_description || ""}`.trim());
    const claims = api.tokenClaims(j.access_token) || {};
    const techId = first(env["AIO_ims_contexts_Credential__in__Territory__Automation__-__Stage_technical__account__id"]);
    return { token: j.access_token, apiKey: clientId, orgId, userId: claims.userId || techId, claims };
}

// The deployed Stage web actions (same base URL form as the plugin's backend.config.json).
function stageActions(env) {
    const ns = first(env.AIO_runtime_namespace), key = first(env.PLUGIN_SHARED_KEY);
    if (!ns || !key) throw new Error("the Stage .env has no AIO_runtime_namespace / PLUGIN_SHARED_KEY");
    const base = `https://${ns}.adobeio-static.net/api/v1/web/territory-app`;
    return async (action, body) => {
        const res = await fetch(`${base}/${action}`, { method: "POST", headers: { "Content-Type": "application/json", "x-plugin-key": key }, body: JSON.stringify(body) });
        const j = await res.json().catch(() => ({}));
        if (!res.ok) throw new Error(`${action}: HTTP ${res.status} ${j.error || ""}`.trim());
        return j;
    };
}

// Checks a signed read URL without printing it: SAS permissions, expiry,
// resource type and path; that it reads the upload; and that the same
// signature does NOT open another file in or outside the upload folder.
async function sasChecks(readUrl, storagePath, bytes) {
    const u = new URL(readUrl);
    const q = u.searchParams;
    const checks = [];
    const add = (name, ok, detail) => checks.push({ name, ok: !!ok, detail });
    const seconds = Math.round((Date.parse(q.get("se") || "") - Date.now()) / 1000);
    add("permissions (sp)", q.get("sp") === "r", `sp=${q.get("sp")}`);
    add("expiry (se)", seconds > 0 && seconds <= 15 * 60 + 60, `expires in ${seconds} s`);
    add("resource (sr)", q.get("sr") === "b", `sr=${q.get("sr")} (b = this blob only)`);
    add("path", decodeURIComponent(u.pathname).endsWith("/" + storagePath), `…/${storagePath}`);
    let r = await fetch(u.toString());
    const got = r.ok ? (await r.arrayBuffer()).byteLength : 0;
    add("reads the upload", r.status === 200 && got === bytes, `GET HTTP ${r.status}, ${got} bytes`);
    const other = new URL(u.toString());
    other.pathname = u.pathname.replace(/SUB_[0-9a-f]{12}-\d{13}/, "SUB_000000000000-" + Date.now());
    r = await fetch(other.toString());
    add("other file in subject/uploads/", r.status === 403, `GET HTTP ${r.status}`);
    const outside = new URL(u.toString());
    outside.pathname = u.pathname.replace(/subject\/uploads\/.*$/, "image-extension/uploads/EXT_00000000.png");
    r = await fetch(outside.toString());
    add("file outside the upload folder", r.status === 403, `GET HTTP ${r.status}`);
    const write = await fetch(u.toString(), { method: "PUT", headers: { "x-ms-blob-type": "BlockBlob" }, body: Buffer.from("x") });
    add("write with the read URL", write.status === 403, `PUT HTTP ${write.status}`);
    return { ok: checks.every((c) => c.ok), checks };
}

async function main() {
    const o = args(process.argv.slice(2));
    const cfg = {
        workflowId: o.workflow || DEFAULTS.workflowId, nodeId: o.node || DEFAULTS.nodeId,
        storageType: o.storageType || DEFAULTS.storageType, stageDir: o.stageDir || DEFAULTS.stageDir,
    };
    const stamp = new Date().toISOString().replace(/[:.]/g, "-");
    const outDir = path.resolve(__dirname, "../test-output/workflow-probe", stamp);
    fs.mkdirSync(outDir, { recursive: true });
    const save = (name, data) => fs.writeFileSync(path.join(outDir, name), JSON.stringify(api.redact(data), null, 2));
    const log = (...a) => console.log(...a);

    const png = syntheticPng();
    fs.writeFileSync(path.join(outDir, "synthetic.png"), png);
    log(`synthetic image: ${SYNTHETIC.width}×${SYNTHETIC.height} PNG, ${png.length} bytes → ${path.join(outDir, "synthetic.png")}`);
    log(`workflow ${cfg.workflowId} · input node ${cfg.nodeId} · storageType ${cfg.storageType || "(from workflow-image-url)"}`);

    if (!o.live) {
        const req = api.buildBatchRequest({ workflowId: cfg.workflowId, nodeId: cfg.nodeId, imageUrls: ["https://<stage-files>.blob.core.windows.net/<path>?<sas>"], storageType: cfg.storageType || "external" });
        save("request.dry-run.json", req);
        log("DRY RUN — no network. Request body:\n" + JSON.stringify(req, null, 2));
        log("Headers: Authorization (Bearer), x-api-key, x-gw-ims-org-id, x-gw-ims-user-id, api-version: 1.0");
        log("Run with --live --auth stage only after approval.");
        return 0;
    }
    if (o.auth !== "stage") { log("Refusing: --live needs --auth stage (the Stage OAuth S2S credential)."); return 2; }

    const env = readEnvFile(path.join(cfg.stageDir, ".env"));
    const auth = await stageToken(env);
    log(`IMS token: ${auth.claims.type || "?"} for client ${auth.claims.clientId ? "…" + String(auth.claims.clientId).slice(-4) : "?"}, scopes ${(auth.claims.scopes || []).join(",")}, expires ${auth.claims.expiresAt || "?"}`);
    const headers = api.apiHeaders(auth);

    const call = o.imageUrl ? null : stageActions(env);
    let storagePath = "", imageUrl = o.imageUrl || "", storageType = cfg.storageType;
    try {
        if (!imageUrl) {
            const up = await call("subject-upload-url", { contentType: "image/png" });
            storagePath = up.storagePath;
            const put = await fetch(up.uploadUrl, { method: "PUT", headers: up.uploadHeaders, body: png });
            log(`upload via subject-upload-url: ${storagePath} → PUT HTTP ${put.status}`);
            if (!put.ok) throw new Error(`upload PUT failed: HTTP ${put.status}`);
            const rd = await call("workflow-image-url", { storagePath });
            imageUrl = rd.readUrl;
            storageType = storageType || rd.storageType;
            log(`read URL via workflow-image-url: ${api.redactUrl(imageUrl)} (${rd.expiresInSeconds} s, storageType ${rd.storageType}, ${rd.contentLength} bytes)`);
            fs.writeFileSync(path.join(outDir, "0-image-url.json"), JSON.stringify(api.redact(rd), null, 2));
        }
        if (call && storagePath) {
            // Security gate before any execution: read-only, ~15 min, this one blob only.
            const sas = await sasChecks(imageUrl, storagePath, png.length);
            fs.writeFileSync(path.join(outDir, "0b-sas-checks.json"), JSON.stringify(sas, null, 2));
            for (const c of sas.checks) log(`  ${c.ok ? "✓" : "✗"} ${c.name}: ${c.detail}`);
            if (!sas.ok) { log("✗ read URL security checks failed — stopping before any workflow execution"); return 1; }
        }
        const body = api.buildBatchRequest({ workflowId: cfg.workflowId, nodeId: cfg.nodeId, imageUrls: [imageUrl], storageType: storageType || "external" });
        save("1-request.json", body);
        let res = await fetch(`${api.WORKFLOW_API.host}/batch/execute`, { method: "POST", headers, body: JSON.stringify(body) });
        let j = await res.json().catch(() => ({}));
        save("2-execute-response.json", { httpStatus: res.status, body: j });
        log(`POST /batch/execute → HTTP ${res.status}${j.batchId ? " batch " + j.batchId : ""}`);
        if (res.status !== 202 || !j.batchId) { log("✗ execute failed: " + JSON.stringify(api.redact(j))); return 1; }

        const batchId = j.batchId;
        const t0 = Date.now();
        let status = null;
        while (Date.now() - t0 < DEFAULTS.maxWaitMs) {
            await new Promise((r) => setTimeout(r, DEFAULTS.pollMs));
            res = await fetch(`${api.WORKFLOW_API.host}/batch/${encodeURIComponent(batchId)}/status`, { headers });
            status = await res.json().catch(() => ({}));
            log(`  status ${Math.round((Date.now() - t0) / 1000)}s: HTTP ${res.status} ${status.status || ""} ${JSON.stringify(status.assets || {})}`);
            if (res.status !== 200 || api.isTerminal(status.status)) break;
        }
        save("3-status.json", status);
        res = await fetch(`${api.WORKFLOW_API.host}/batch/${encodeURIComponent(batchId)}/executions?limit=10`, { headers });
        const ex = await res.json().catch(() => ({}));
        save("4-executions.json", ex);
        const first0 = (ex.executions || [])[0];
        save("5-outputs-shape.json", first0 ? api.describeShape(first0.outputs) : null);
        log(`GET /executions → HTTP ${res.status}; outputs shape: ${JSON.stringify(first0 ? api.describeShape(first0.outputs) : null)}`);

        let r = api.collectResults(ex, 1)[0];
        if (r.kind === "url") {
            if (!api.allowedResultUrl(r.url)) { log(`✗ result link on a host that is not allowed: ${api.redactUrl(r.url)}`); return 1; }
            const fr = await fetch(r.url); // no credentials sent
            const text = await fr.text();
            fs.writeFileSync(path.join(outDir, "6-result-file.json"), text);
            let parsed = null; try { parsed = JSON.parse(text); } catch (e) {}
            const found = api.findDetection(parsed);
            r = Object.assign({}, r, found.kind === "inline" ? { kind: "inline", detection: found.detection, via: api.redactUrl(r.url) } : { kind: "none", error: "linked file has no focalPoint/boundingBox" });
        }
        if (r.kind !== "inline") { log(`✗ no Detect Focal Point result found (${r.status}: ${r.error || r.kind})`); return 1; }

        const v = capsule.parseCapsuleJson(JSON.stringify(r.detection));
        save("7-validation.json", { found: r, capsule: v });
        if (!v.ok) { log("✗ capsule.js rejected the result:\n• " + v.errors.join("\n• ")); return 1; }
        const score = iou(v.detection.boundingBox, SYNTHETIC.truth);
        log(`✓ capsule.js accepted it: box ${JSON.stringify(v.detection.boundingBox)} focal ${JSON.stringify(v.detection.focalPoint)}`);
        for (const w of v.warnings) log("  note: " + w);
        log(`  overlap with the synthetic car (IoU): ${score.toFixed(2)}`);
        return 0;
    } finally {
        if (call && storagePath) {
            try { const d = await call("workflow-image-url", { storagePath, op: "delete" }); log(`probe image ${d.deleted ? "deleted" : "already gone"}: ${storagePath}`); }
            catch (e) { log(`could not delete the probe image ${storagePath}: ${e.message}`); }
        }
        log("saved (redacted): " + outDir);
    }
}

main().then((code) => process.exit(code || 0), (e) => { console.log("✗ " + String((e && e.message) || e)); process.exit(1); });
