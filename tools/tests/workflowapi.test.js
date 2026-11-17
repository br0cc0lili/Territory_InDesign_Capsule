// Offline regression test (Node, no network). Run: node tools/tests/run.js
// tools/workflow/workflowapi.js: the Workflow API request, result search in
// the (unspecified) execution outputs, redaction; and the synthetic image.
const path = require("path");
const zlib = require("zlib");
const REPO = path.resolve(__dirname, "../..");
const api = require(REPO + "/tools/workflow/workflowapi.js");
const { SYNTHETIC, syntheticPng, iou } = require(REPO + "/tools/workflow/synthetic.js");
const capsule = require(REPO + "/plugin/js/capsule.js");
let f = 0;
const ok = (c, m) => { console.log((c ? "PASS " : "FAIL ") + m); if (!c) f++; };
const J = JSON.stringify;

// request: one run per image, same node, spec field names
const req = api.buildBatchRequest({ workflowId: "wf", nodeId: "node-1", imageUrls: ["https://a.blob.core.windows.net/x.png?sig=1", "https://a.blob.core.windows.net/y.png?sig=2"] });
ok(J(req) === J({ workflow: { workflowId: "wf", inputs: [
    [{ node_id: "node-1", content: [{ presignedUrl: "https://a.blob.core.windows.net/x.png?sig=1", storageType: "Azure" }] }],
    [{ node_id: "node-1", content: [{ presignedUrl: "https://a.blob.core.windows.net/y.png?sig=2", storageType: "Azure" }] }]] } }),
    "batch request: one run per photo (assetIndex ↔ photo), presignedUrl + storageType");
let threw = false; try { api.buildBatchRequest({ workflowId: "wf", nodeId: "", imageUrls: ["u"] }); } catch (e) { threw = true; }
ok(threw, "request without node id refused");
const h = api.apiHeaders({ token: "T", apiKey: "K", orgId: "O@AdobeOrg", userId: "U" });
ok(h.Authorization === "Bearer T" && h["x-api-key"] === "K" && h["x-gw-ims-org-id"] === "O@AdobeOrg" && h["x-gw-ims-user-id"] === "U" && h["api-version"] === "1.0", "headers: the four required + api-version 1.0");
threw = false; try { api.apiHeaders({ token: "T", apiKey: "K", orgId: "O" }); } catch (e) { threw = true; }
ok(threw, "missing user id refused");

// token claims (payload only)
const fake = "eyJhbGciOiJub25lIn0." + Buffer.from(J({ type: "access_token", client_id: "c1", user_id: "tech@techacct.adobe.com", scope: "openid,ff_apis", created_at: "1000", expires_in: "86400000" })).toString("base64url") + ".sig";
const cl = api.tokenClaims(fake);
ok(cl.userId === "tech@techacct.adobe.com" && cl.scopes.join() === "openid,ff_apis" && cl.expiresAt === new Date(86401000).toISOString(), "token claims read without the signature");

// result search: inline object, JSON string, nested, link, none
const DET = { focalPoint: { x: 0.53, y: 0.65, normalized: true }, boundingBox: { x: 0.07, y: 0.3, width: 0.93, height: 0.7, normalized: true } };
ok(api.findDetection([{ name: "result", value: DET }]).kind === "inline", "outputs: inline object found");
const s = api.findDetection([{ type: "text", content: J(DET) }]);
ok(s.kind === "inline" && s.detection.boundingBox.width === 0.93 && s.path === "outputs[0].content", "outputs: JSON string found (path " + s.path + ")");
ok(api.findDetection({ a: { b: [{ c: { data: DET } }] } }).kind === "inline", "outputs: deeply nested object found");
const l = api.findDetection([{ name: "image", href: "https://x.blob.core.windows.net/o/img.png?sig" }, { name: "json", href: "https://x.blob.core.windows.net/o/focal.json?sig" }]);
ok(l.kind === "url" && /focal\.json/.test(l.url), "outputs: a JSON file link is chosen over an image link");
ok(api.findDetection([{ href: "https://x.blob.core.windows.net/o/img.png?sig" }]).kind === "none", "outputs: only an image → nothing found");
ok(api.findDetection([{ text: '{"focalPoint": broken' }]).kind === "none", "outputs: broken JSON string → nothing found");

// executions → per image, by assetIndex
const ex = { executions: [
    { assetIndex: 1, status: "failed", error: "unsupported image" },
    { assetIndex: 0, status: "success", outputs: [{ value: J(DET) }] }] };
const rs = api.collectResults(ex, 3);
ok(rs[0].kind === "inline" && rs[1].status === "failed" && rs[1].error === "unsupported image" && rs[2].status === "missing", "executions mapped back by assetIndex (success / failed / missing)");
const v = capsule.parseCapsuleJson(J(rs[0].detection));
ok(v.ok && v.detection.boundingBox.x === 0.07, "a found result validates with the existing capsule.js adapter");

// hosts and redaction
ok(api.allowedResultUrl("https://abc.blob.core.windows.net/x.json?sig") && api.allowedResultUrl("https://run-workflow.adobe.io/x") && !api.allowedResultUrl("http://abc.blob.core.windows.net/x") && !api.allowedResultUrl("https://evil.example.com/x.json"),
    "result links: https on Adobe / supported storage only");
const red = api.redact({ Authorization: "Bearer abc", url: "https://a.blob.core.windows.net/p.png?sv=1&sig=SECRET", nested: [{ token: "x", note: "eyJa.eyJb.c" }], ok: "plain" });
ok(J(red) === J({ Authorization: "<redacted>", url: "https://a.blob.core.windows.net/p.png?…", nested: [{ token: "<redacted>", note: "<redacted>" }], ok: "plain" }), "redaction: tokens and presigned query strings removed");
ok(J(api.describeShape([{ name: "r", href: "https://a.blob.core.windows.net/x?s", n: 2 }])) === J([{ name: "string(1)", href: "url(a.blob.core.windows.net)", n: "number" }]), "outputs shape described without values");
ok(api.isTerminal("COMPLETED") && api.isTerminal("failed") && !api.isTerminal("running"), "terminal batch states");

// synthetic image: a valid PNG of the documented size
const png = syntheticPng();
ok(png.slice(1, 4).toString() === "PNG" && png.readUInt32BE(16) === SYNTHETIC.width && png.readUInt32BE(20) === SYNTHETIC.height, "synthetic PNG 1200×800");
const raw = zlib.inflateSync(png.slice(41, 41 + png.readUInt32BE(33)));
const px = (x, y) => { const o = y * (SYNTHETIC.width * 3 + 1) + 1 + x * 3; return [raw[o], raw[o + 1], raw[o + 2]]; };
ok(J(px(600, 600)) === J([196, 30, 36]) && px(100, 100)[0] > 200, "synthetic PNG: red car body, light background");
ok(Math.abs(iou(SYNTHETIC.truth, SYNTHETIC.truth) - 1) < 1e-9 && iou(SYNTHETIC.truth, { x: 0, y: 0, width: 0.1, height: 0.1 }) === 0, "IoU helper");

console.log(f ? `${f} FAILED` : "all passed");
process.exit(f ? 1 : 0);
