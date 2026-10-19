#!/usr/bin/env node
// first-real-test.js — the FIRST real Firefly Generative Expand test, for ONE
// eligible extension plan, against the DEPLOYED App Builder actions.
//
// It uses the plugin's own Image Extension code (plugin/js/imageextension.js
// + placement.js) for planning and for the Firefly round trip, so it tests
// the same path the InDesign plugin uses — with only the plugin key from
// plugin/backend.config.json. It never sees the Adobe Client Secret or an
// access token (those stay inside the actions).
//
// Reports: presigned upload hostname, whether x-ms-blob-type is required,
// IMS/Firefly success, upload id, the exact expand-async request, job status,
// working / requested / returned dimensions, whether the original region
// changed in scale or position, the generated image, and plan reuse.
// Writes everything to tools/test-output/ (gitignored).
//
// The actions live in the App Builder project territory-app (Stage). jimp is
// loaded from that project's node_modules (--territory-app <dir>, env
// TERRITORY_APP_DIR, default ~/territory-app) — no npm install in this repo.
//
// Usage (from the plugin repo root, after the Stage deploy):
//   node tools/first-real-test.js
//   node tools/first-real-test.js --source "<photo>" --frame 800x600
//   node tools/first-real-test.js --from-log "<output>/image_extension_log.json" --plan EXT_xxxxxxxx
//   node tools/first-real-test.js --job "urn:ff:jobs:…"   (resume: status/verify an EXISTING job,
//                                                          no new Firefly generation; use the same
//                                                          --source/--frame/--from-log as the original run)
// Options: --config <file> (default plugin/backend.config.json), --base-url <url>,
//          --yes (no confirmation prompt), --compare (also write a side-by-side diagnostic JPG)

"use strict";

const fs = require("fs");
const path = require("path");
const Module = require("module");
const readline = require("readline");

const ROOT = path.resolve(__dirname, "..");
const PLUGIN = path.join(ROOT, "plugin");
const OUT = path.join(__dirname, "test-output");
// Default photo: "sourceImage" from tools/tests/indesign/config.local.json
// (gitignored, your local fixture paths) — or pass --source.
const DEFAULT_SOURCE = (() => {
    try { return JSON.parse(fs.readFileSync(path.join(__dirname, "tests", "indesign", "config.local.json"), "utf8")).sourceImage || null; } catch (e) { return null; }
})();

// ---------- args ----------
const args = {};
for (let i = 2; i < process.argv.length; i++) {
    const a = process.argv[i];
    if (a === "--yes") args.yes = true;
    else if (a.startsWith("--")) args[a.slice(2)] = process.argv[++i];
}

// ---------- load the plugin modules in Node (uxp shim) ----------
const uxpShim = {
    storage: {
        formats: { binary: "binary", utf8: "utf8" },
        localFileSystem: {
            async getEntryWithUrl(url) {
                const p = decodeURI(String(url).replace(/^file:/, ""));
                return { async read(opts) { const b = fs.readFileSync(p); return opts && opts.format === "binary" ? b.buffer.slice(b.byteOffset, b.byteOffset + b.length) : b.toString("utf8"); } };
            },
            async getPluginFolder() {
                return { async getEntry(name) { const p = path.join(PLUGIN, name); return { async read() { return fs.readFileSync(p, "utf8"); } }; } };
            },
        },
    },
};
const origLoad = Module._load;
Module._load = function (request) { return request === "uxp" ? uxpShim : origLoad.apply(this, arguments); };
const ext = require(path.join(PLUGIN, "js", "imageextension.js"));
const placement = require(path.join(PLUGIN, "js", "placement.js"));

// ---------- network log (no secrets: query strings + plugin key redacted) ----------
const NET = [];
const realFetch = global.fetch;
global.fetch = async function (url, init) {
    const started = Date.now();
    const res = await realFetch(url, init);
    const u = new URL(url);
    NET.push({ method: (init && init.method) || "GET", host: u.host, path: u.pathname, status: res.status, ms: Date.now() - started });
    return res;
};

function log(title, value) {
    console.log(`\n▸ ${title}`);
    if (value !== undefined) console.log(typeof value === "string" ? "  " + value : JSON.stringify(value, null, 2).replace(/^/gm, "  "));
}

async function confirm(q) {
    if (args.yes) return true;
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    const answer = await new Promise((r) => rl.question(q + " [y/N] ", r));
    rl.close();
    return /^y(es)?$/i.test(answer.trim());
}

// ---------- 1. the ONE plan ----------
async function buildPlan() {
    if (args["from-log"]) {
        const records = JSON.parse(fs.readFileSync(args["from-log"], "utf8"));
        const r = records.find((x) => x.plan && x.plan.id === args.plan && x.status === "extension_required");
        if (!r) throw new Error(`no eligible record for plan ${args.plan} in ${args["from-log"]}`);
        const header = ext.parseImageHeader(fs.readFileSync(r.originalAsset));
        const plan = ext.createExtensionPlan({
            sourcePath: r.originalAsset, sourceWidth: r.sourceWidth, sourceHeight: r.sourceHeight, format: header.format,
            missingLayout: r.missing, graphicBounds: r.graphicBounds, expansionPixels: r.expansionPixels,
        });
        return { plan, origin: `real InDesign geometry from ${path.basename(args["from-log"])} (${r.product}, ${r.layout})`, record: r };
    }
    const source = args.source || DEFAULT_SOURCE;
    if (!source) throw new Error("no source photo — pass --source <photo> or set sourceImage in tools/tests/indesign/config.local.json");
    const [fw, fh] = String(args.frame || "800x600").split("x").map(Number);
    const header = ext.parseImageHeader(fs.readFileSync(source));
    if (!header) throw new Error("can't read image size: " + source);
    const frameBounds = [0, 0, fh, fw];
    const policy = { id: "first-real-test", placementMode: "extend", anchor: { vertical: "top", horizontal: "center" } };
    const placed = placement.planImagePlacement({ frameBounds, sourceSize: { width: header.width, height: header.height }, policy });
    const d = ext.calculateRequiredExpansion(frameBounds, placed.graphicBounds);
    const px = ext.convertExpansionToSourcePixels(d.missing, placed.graphicBounds, header.width, header.height);
    const plan = ext.createExtensionPlan({
        sourcePath: source, sourceWidth: header.width, sourceHeight: header.height, format: header.format,
        missingLayout: d.missing, graphicBounds: placed.graphicBounds, expansionPixels: px.expansionPixels,
    });
    return { plan, origin: `computed: ${path.basename(source)} placed (extend, top) in a ${fw}x${fh} frame` };
}


// jimp from the territory-app project (where the actions use it).
function loadJimp() {
    const dir = args["territory-app"] || process.env.TERRITORY_APP_DIR || path.join(require("os").homedir(), "territory-app");
    try { return require(require.resolve("jimp", { paths: [dir] })); } catch (e) {}
    throw new Error(`jimp not found — run npm install in ${dir} or pass --territory-app <dir>`);
}

// ---------- image helpers (jimp, as in the actions) ----------
function gray(img, x, y) {
    const i = (img.bitmap.width * y + x) << 2, d = img.bitmap.data;
    return 0.299 * d[i] + 0.587 * d[i + 1] + 0.114 * d[i + 2];
}

// Mean absolute grey difference between `ref` (w x h) and `img` sampled at
// offset (ox, oy) with scale s around the region's top-left. Sampled grid.
function regionMAE(ref, img, ox, oy, s, step) {
    let sum = 0, n = 0;
    for (let y = 0; y < ref.bitmap.height; y += step) {
        for (let x = 0; x < ref.bitmap.width; x += step) {
            const X = Math.round(ox + x * s), Y = Math.round(oy + y * s);
            if (X < 0 || Y < 0 || X >= img.bitmap.width || Y >= img.bitmap.height) continue;
            sum += Math.abs(gray(ref, x, y) - gray(img, X, Y)); n++;
        }
    }
    return n ? sum / n : Infinity;
}

function stats(img, x0, y0, x1, y1, step) {
    let s = 0, s2 = 0, n = 0;
    for (let y = y0; y < y1; y += step) for (let x = x0; x < x1; x += step) { const g = gray(img, x, y); s += g; s2 += g * g; n++; }
    const mean = n ? s / n : 0;
    return { mean: +mean.toFixed(1), std: +(n ? Math.sqrt(Math.max(0, s2 / n - mean * mean)) : 0).toFixed(1), samples: n };
}

// ---------- main ----------
const report = { startedAt: new Date().toISOString() };
const REPORT_PATH = path.join(OUT, "first-real-test-report.json");
function saveReport() {
    fs.mkdirSync(OUT, { recursive: true });
    report.network = NET;
    fs.writeFileSync(REPORT_PATH, JSON.stringify(report, null, 2));
}

(async () => {
    fs.mkdirSync(OUT, { recursive: true });

    // Config: plugin/backend.config.json (plugin key = prototype request gate, not a secret)
    const cfgFile = JSON.parse(fs.readFileSync(args.config || path.join(PLUGIN, "backend.config.json"), "utf8"));
    const cfg = { baseUrl: String(args["base-url"] || cfgFile.baseUrl).replace(/\/+$/, ""), pluginKey: cfgFile.pluginKey, maxPlansPerRun: 1 };
    log("Backend", cfg.baseUrl);

    // 1. Preflight (no Firefly request): the Stage workspace credential injected
    //    via include-ims-credentials must carry the Firefly scopes and get a token.
    const authCheck = await ext.callBackend(cfg, "firefly-auth-check", {});
    report.authCheck = authCheck;
    log("Firefly auth check", authCheck);
    if (authCheck.missingScopes && authCheck.missingScopes.length) throw new Error(`Stage credential lacks Firefly scopes: ${authCheck.missingScopes.join(", ")} — add Firefly Services to the Stage OAuth Server-to-Server credential`);
    if (!authCheck.tokenOk) throw new Error(`IMS token request failed: ${authCheck.tokenError || "unknown"}`);
    if (!authCheck.scopesListed) log("Note", "credential lists no scopes — the Firefly upload below is the real scope check");

    const { plan, origin } = await buildPlan();
    const elig = ext.checkAutoExtensionEligibility(plan);
    const e = plan.expansionPixels;
    log(`Plan ${plan.id} — ${origin}`, {
        source: plan.source, expansionPixels: e, target: plan.target, ratio: plan.ratio,
        working: plan.working, eligible: elig.eligible, reasons: elig.reasons,
    });
    if (!elig.eligible) throw new Error("plan is not eligible — pick another one");
    if (e.top || e.left || e.right || !e.bottom) throw new Error("first test must be a simple bottom-only extension");
    if (plan.ratio.max >= 0.5) throw new Error("first test must be comfortably below the 50% limit");
    Object.assign(report, { planId: plan.id, origin, plan: { source: plan.source, expansionPixels: e, target: plan.target, ratio: plan.ratio, working: plan.working } });

    let gen;
    if (args.job) {
        // RESUME: an existing job — no upload, no expand-image, no new generation.
        report.mode = "resume-existing-job";
        log("Resuming existing Firefly job (no new generation)", args.job);
        const t0 = Date.now();
        gen = { status: "pending", jobId: args.job, outputUrl: null, size: null, error: "" };
        try {
            const done = await ext.pollFireflyJob(cfg, { jobId: args.job });
            Object.assign(gen, { status: "succeeded", outputUrl: done.outputUrl, size: done.size || null });
        } catch (e) {
            Object.assign(gen, { status: "failed", error: String((e && e.message) || e) });
        }
        report.firefly = {
            status: gen.status, error: gen.error, jobId: gen.jobId, requestedSize: plan.working.size, returnedSize: gen.size,
            seconds: Math.round((Date.now() - t0) / 1000),
            expandImageCalls: NET.filter((n) => n.path.endsWith("/expand-image")).length,
            statusPolls: NET.filter((n) => n.path.endsWith("/expand-status")).length,
            outputUrl: gen.outputUrl ? gen.outputUrl.split("?")[0] : null,
        };
        log("Firefly (existing job)", report.firefly);
        saveReport();
        if (gen.status !== "succeeded") throw new Error("existing job did not succeed: " + gen.error);
    } else {
    if (!(await confirm(`This makes ONE real Firefly Generative Expand request for ${plan.id}. Continue?`))) process.exit(1);

    // 2. Presigned upload: real hostname, and is x-ms-blob-type required?
    const probe = await ext.callBackend(cfg, "get-upload-url", { planId: plan.id, contentType: "image/jpeg" });
    const host = new URL(probe.uploadUrl).host;
    const tiny = Buffer.from("first-real-test-probe");
    const noHeader = await realFetch(probe.uploadUrl, { method: "PUT", headers: { "Content-Type": "image/jpeg" }, body: tiny });
    let noHeaderError = "";
    if (!noHeader.ok) { try { noHeaderError = (await noHeader.text()).slice(0, 300); } catch (err) {} }
    report.upload = {
        presignedHost: host,
        putWithoutBlockBlobHeader: noHeader.status,
        blockBlobHeaderRequired: !noHeader.ok,
        withoutHeaderError: noHeaderError.replace(/sig=[^&"<]+/g, "sig=…"),
    };
    log("Presigned upload URL", report.upload);
    log("Manifest check", ["*.adobeioruntime.net", "*.blob.core.windows.net", "*.azureedge.net"].some((d) => host.endsWith(d.slice(1)))
        ? `host ${host} is covered by plugin/manifest.json`
        : `host ${host} is NOT in plugin/manifest.json network.domains — add "https://${host}" (or its parent wildcard)`);

    // 3. ONE real generation through the plugin's own code. Two pages share
    //    the plan (e.g. service_up + service_bottom) — must be ONE request.
    const registry = ext.createPlanRegistry();
    const use = (layout) => ({ product: "first-real-test", layout, page: 1 });
    const records = ["service_up 800x600", "service_bottom 800x600"].map((layout) => {
        const reg = ext.registerExtensionPlan(registry, plan, elig, use(layout));
        return { product: "first-real-test", layout, status: "extension_required", problems: [], plan: { id: reg.plan.id, key: reg.plan.key }, planReuse: reg.reuse };
    });
    const t0 = Date.now();
    await ext.runFireflyForRecords(records, registry, { config: cfg });
    gen = registry.get(plan.key).generation;
    const expandCalls = NET.filter((n) => n.path.endsWith("/expand-image")).length;
    report.firefly = {
        status: gen.status, error: gen.error || "", jobId: gen.jobId, uploadId: gen.uploadId,
        returnedStatusUrl: gen.statusUrl || null, returnedStatusUrlHost: gen.statusUrl ? new URL(gen.statusUrl).host : null,
        imsAuthentication: gen.uploadId ? "succeeded (Firefly accepted the backend's token)" : "not confirmed",
        exactExpandAsyncRequest: gen.fireflyRequest, workingSourceSentToFirefly: gen.workingSource,
        requestedSize: plan.working.size, returnedSize: gen.size, seconds: Math.round((Date.now() - t0) / 1000),
        statusPolls: NET.filter((n) => n.path.endsWith("/expand-status")).length,
        outputUrl: gen.outputUrl ? gen.outputUrl.split("?")[0] : null,
    };
    log("Firefly", report.firefly);
    saveReport(); // jobId on disk before anything else can fail
    if (gen.status !== "succeeded") throw new Error("Firefly generation did not succeed: " + gen.error);

    // 4. Reuse: a second request for the SAME plan must not regenerate.
    const again = { product: "first-real-test", layout: "danis_up 1200x1200", status: "extension_required", problems: [],
        plan: { id: plan.id, key: plan.key }, planReuse: ext.registerExtensionPlan(registry, plan, elig, use("again")).reuse };
    await ext.runFireflyForRecords([again], registry, { config: cfg });
    const expandCallsAfter = NET.filter((n) => n.path.endsWith("/expand-image")).length;
    report.reuse = {
        pagesSharingThePlanInTheFirstRequest: 2, expandImageCallsForThem: expandCalls,
        secondRequestSamePlan: again.planReuse, newExpandImageCalls: expandCallsAfter - expandCalls,
        reused: expandCallsAfter === expandCalls && again.firefly && again.firefly.jobId === gen.jobId,
        scope: "within one run (plan registry); persistent cross-run cache = Phase 4",
    };
    log("Reuse", report.reuse);
    }

    // 5. Download + verify geometry of the original region.
    const Jimp = loadJimp();
    const bytes = Buffer.from(await (await realFetch(gen.outputUrl)).arrayBuffer());
    const outExt = (bytes[0] === 0x89 ? "png" : "jpg");
    const outPath = path.join(OUT, `${plan.id}_extended.${outExt}`);
    fs.writeFileSync(outPath, bytes);
    const out = await Jimp.read(bytes);
    const src = (await Jimp.read(plan.source.path)).resize(plan.working.source.width, plan.working.source.height, Jimp.RESIZE_BICUBIC);
    const inset = plan.working.inset;
    const returned = { width: out.bitmap.width, height: out.bitmap.height };

    // Best match of the original inside the output: offsets ±6 px, scales ±2 %.
    let best = { mae: Infinity };
    for (const s of [0.98, 0.99, 1, 1.01, 1.02]) {
        for (let dy = -6; dy <= 6; dy++) for (let dx = -6; dx <= 6; dx++) {
            const mae = regionMAE(src, out, inset.left + dx, inset.top + dy, s, 8);
            if (mae < best.mae) best = { mae, dx, dy, scale: s };
        }
    }
    const atPlan = regionMAE(src, out, inset.left, inset.top, 1, 4);
    const seamY = inset.top + plan.working.source.height;
    const generated = stats(out, 0, seamY, out.bitmap.width, out.bitmap.height, 4);
    const aboveSeam = stats(out, 0, Math.max(0, seamY - 40), out.bitmap.width, seamY, 4);
    report.verification = {
        workingInput: plan.working.source, requested: plan.working.size, returned,
        returnedMatchesRequested: returned.width === plan.working.size.width && returned.height === plan.working.size.height,
        originalRegion: {
            maeAtPlannedPosition: +atPlan.toFixed(2),
            bestMatch: { dx: best.dx, dy: best.dy, scale: best.scale, mae: +best.mae.toFixed(2) },
            unchanged: best.dx === 0 && best.dy === 0 && best.scale === 1 && atPlan < 8,
        },
        generatedArea: { side: "bottom", rows: out.bitmap.height - seamY, stats: generated, notFlat: generated.std > 3, rowsAboveSeam: aboveSeam },
    };
    log("Verification", report.verification);

    // Optional diagnostic only (--compare): side-by-side working source |
    // output with a red seam line. Not part of the extension workflow — the
    // comparison there is the extendImage layer in InDesign.
    report.files = { extended: outPath };
    if (args.compare) {
        const W = src.bitmap.width + out.bitmap.width + 20, H = Math.max(src.bitmap.height, out.bitmap.height);
        const sheet = new Jimp(W, H, 0xffffffff);
        sheet.composite(src, 0, inset.top).composite(out, src.bitmap.width + 20, 0);
        for (let x = src.bitmap.width + 20; x < W; x++) for (let t = -1; t <= 1; t++) sheet.setPixelColor(0xff0000ff, x, seamY + t);
        const sheetPath = path.join(OUT, `${plan.id}_compare.jpg`);
        await sheet.resize(Math.round(W / 3), Jimp.AUTO).quality(85).writeAsync(sheetPath);
        report.files.compare = sheetPath;
    }
    saveReport();
    log("Files", report.files);
    console.log("\nDone — report: tools/test-output/first-real-test-report.json");
})().catch((e) => {
    console.error("\n✗ " + (e && e.message ? e.message : e));
    report.error = String((e && e.message) || e);
    try { saveReport(); console.error("Partial report: tools/test-output/first-real-test-report.json"); } catch (err) {}
    process.exit(1);
});
