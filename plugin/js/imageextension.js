// imageextension.js — IMAGE EXTENSION stage (InDesign side).
//
// BOUNDARY
//   PLACEMENT (placement.js, later the bounding-box system) owns subject
//   positioning, scaling, movement and anchor decisions.
//   IMAGE EXTENSION (this file) owns, starting from the FINAL placed graphic
//   state: coverage analysis, underfill detection, source-pixel conversion,
//   extension planning, Firefly, caching/versioning, the `extendImage` layer
//   and post-extension validation.
//   This file never calls placement code and knows nothing about anchors or
//   fit modes. The caller passes one neutral flag — allowExtension — plus an
//   opaque `placement` description used only in logs.
//
// Pipeline per page (separate functions):
//   analyzeImageCoverage()            entry point: final frame + graphic state
//   captureGeometrySnapshot()         frame/graphic bounds + scale, kept for Phase 4 relink
//   calculateRequiredExpansion()      Phase 1: frame vs placed-graphic bounds, per side
//   convertExpansionToSourcePixels()  Phase 2: layout units -> source pixels
//   createExtensionPlan()             exact plan for THIS geometry + stable key / id
//   checkAutoExtensionEligibility()   50% limit, output resolution, format
//   findMatchingExtensionPlan()       reuse ONLY an identical plan
//   requestFireflyExpansion() / pollFireflyJob()   Phase 3 (via the App Builder backend)
//   obtainExtension()                 Phase 3: FULL expanded image, versioned asset store + cache
//   applyExtensionToPage()            Phase 4: extension-only frames on the `extendImage` layer
//   checkExtendedCoverage()           Phase 4: coverage = original Image + extendImage
//
// The ORIGINAL image is never relinked, moved, scaled or cropped by this
// file: Firefly's full expanded image is shown only through clipping frames
// on a separate `extendImage` layer, directly above the Image layer, and only
// over the strips the original leaves uncovered.
//
// Only the <<MainImage>> frame and its placed graphic are measured — shadow,
// text, footer and other layers are never looked at; nothing is exported or
// pixel-analysed.
//
// Geometry: InDesign geometricBounds are [top, left, bottom, right] in the
// document's ruler units — render.js switches product documents to points
// (usePoints), and 1 pt is 1 px in the final 72 dpi JPGs.

/* global require */

// ---------- configuration (all Image Extension settings in one place) ----------
const CONFIG = {
    // Gaps up to this many points per side (= px in the 72 dpi JPGs) are
    // rounding noise and never trigger an extension.
    coverageTolerancePt: 2,
    // Automatic-extension limit: if Firefly would have to generate more than
    // this share of the original source on EITHER axis, the plan is not sent
    // to Firefly — Needs Review ("Required extension exceeds automatic
    // generation limit").
    maxExtensionRatio: 0.5,
    // Firefly Generative Expand output limit, per side (px).
    fireflyMaxSide: 2688,
    // Resolution the extended image needs in the final JPGs: px per layout
    // point (final export is 72 dpi = 1 px per pt).
    outputPxPerPt: 1,
    // Formats Firefly Expand accepts as a source.
    fireflyFormats: ["jpeg", "png", "webp"],
    // InDesign's pixel-size estimate vs the file header: allowed difference.
    sizeMismatchTolerance: 0.03,
    // Plan reuse: plans match only if every side is identical (0 px). A small
    // value would let a plan reuse one that is at most this many px LARGER on
    // each side — never smaller. Kept at 0: always the minimum for the layout.
    planMatchTolerancePx: 0,
    // Phase 3 — Firefly via the App Builder backend (territory-app). Connection
    // settings live in plugin/backend.config.json (gitignored; see
    // backend.config.example.json). Without that file Firefly is skipped.
    firefly: {
        pollIntervalMs: 3000,     // status poll interval
        timeoutMs: 180000,        // give up on a job after this long
        maxAttempts: 1,           // automatic attempts per plan — then Needs Review
        maxConcurrentJobs: 3,     // plans generated in parallel per product
        // Test limiter: at most this many NEW Firefly generations per
        // Extend / Re-extend click (one generation per eligible page;
        // null = no limit — every eligible page is generated). Overridden by
        // "maxPlansPerRun" in plugin/backend.config.json — 1 while the Phase 4
        // UI is being verified, then null.
        maxPlansPerRun: null,
        // Test limiter: only generate this one plan id (e.g. "EXT_f7533899");
        // every other plan is skipped. Overridden by "onlyPlanId" in
        // plugin/backend.config.json. null = no restriction.
        onlyPlanId: null,
    },
    // How a product's extension is generated (Extend / Re-extend click):
    //   "consistent"  — DEFAULT. One MASTER Firefly generation per product
    //                   batch; every eligible page clips its strip from that
    //                   same result (consistent content across layouts). Split
    //                   into several masters only when one is impossible
    //                   (different sources, combined extension over the
    //                   limit, output resolution too low for a page).
    //   "independent" — one Firefly generation per page (API testing).
    // Overridden by "batchMode" in plugin/backend.config.json.
    batchMode: "consistent",
    // Phase 4 — how a generated extension is shown in the INDD.
    extension: {
        layerName: "extendImage",                 // created/reused directly above the Image layer
        itemName: (side) => `<<ImageExtension_${side}>>`,
        labelKey: "posterBatch.imageExtension",   // insertLabel key that marks OUR items
        // Extension frames reach this far into the neighbouring area (original
        // image / other extension frame) so no anti-aliased hairline of the
        // page background shows at a fractional seam in the JPG export. The
        // overlapping pixels are Firefly's copy of the original, which the
        // backend leaves geometrically unchanged. 0 = exact abutting seams.
        seamOverlapPt: 1,
        // Output size vs the requested Firefly canvas: allowed aspect
        // difference for a uniform rescale (otherwise not aligned → Review).
        aspectTolerance: 0.005,
        // The original moved by more than this since the extension was
        // applied → the extension no longer lines up → Review.
        alignTolerancePt: 0.5,
        // <output root>/generated_assets/image_extensions/<planId>/
        assetFolder: ["generated_assets", "image_extensions"],
    },
};

// Kept for existing callers.
const COVERAGE_TOLERANCE_PT = CONFIG.coverageTolerancePt;
const FIREFLY_MAX_SIDE = CONFIG.fireflyMaxSide;

// ---------- small helpers ----------

function itemAt(collection, i) {
    return typeof collection.item === "function" ? collection.item(i) : collection[i];
}

// [top, left, bottom, right] -> { top, left, bottom, right, width, height }
function toBox(b) {
    const [top, left, bottom, right] = [0, 1, 2, 3].map((i) => Number(b[i]));
    return { top, left, bottom, right, width: right - left, height: bottom - top };
}

function round2(n) {
    return Math.round(n * 100) / 100;
}

function sides(fn) {
    return { top: fn("top"), right: fn("right"), bottom: fn("bottom"), left: fn("left") };
}

// ---------- Phase 1: find the graphic, detect underfill ----------

// The single placed graphic inside the Image frame.
// Returns { graphic } or { error } (no graphic / more than one — ambiguous).
function getPlacedGraphic(frame) {
    let graphics;
    try { graphics = frame.allGraphics; } catch (e) { return { error: "could not read the frame's graphics (" + e + ")" }; }
    const n = graphics ? graphics.length : 0;
    if (n === 0) return { error: "Image frame contains no placed graphic" };
    if (n > 1) return { error: `Image frame contains ${n} graphics — ambiguous, not extended automatically` };
    return { graphic: itemAt(graphics, 0) };
}

// Rotation / shear / flip make geometricBounds an axis-aligned bounding box
// rather than the real edges, so the coverage check isn't reliable.
// Returns "" or a reason.
function transformProblem(frame, graphic) {
    const angle = (item, prop) => {
        try { return Number(item[prop]) || 0; } catch (e) { return 0; }
    };
    for (const [name, item] of [["frame", frame], ["image", graphic]]) {
        if (Math.abs(angle(item, "absoluteRotationAngle")) > 0.01) return `${name} is rotated`;
        if (Math.abs(angle(item, "absoluteShearAngle")) > 0.01) return `${name} is skewed`;
    }
    try {
        const flip = String(graphic.absoluteFlip || "");
        if (flip && !/none/i.test(flip)) return "image is flipped";
    } catch (e) {}
    return "";
}

// PURE. How much of the frame the graphic leaves uncovered, per side, in
// layout units. Each side is checked independently (the image may be offset).
//   frameBounds / graphicBounds: [top, left, bottom, right]
// Returns { needsExtension, missing: {top,right,bottom,left}, missingRaw }.
// Gaps up to `tolerance` count as covered (missing 0).
function detectImageUnderfill(frameBounds, graphicBounds, tolerance) {
    const tol = tolerance === undefined ? CONFIG.coverageTolerancePt : tolerance;
    const f = toBox(frameBounds);
    const g = toBox(graphicBounds);
    const missingRaw = {
        top: Math.max(0, g.top - f.top),
        right: Math.max(0, f.right - g.right),
        bottom: Math.max(0, f.bottom - g.bottom),
        left: Math.max(0, g.left - f.left),
    };
    const missing = sides((s) => (missingRaw[s] > tol ? round2(missingRaw[s]) : 0));
    const needsExtension = Object.values(missing).some((v) => v > 0);
    // A graphic that doesn't even overlap the frame can't be extended sensibly.
    const overlaps = g.right > f.left && g.left < f.right && g.bottom > f.top && g.top < f.bottom;
    return { needsExtension, missing, missingRaw: sides((s) => round2(missingRaw[s])), overlaps };
}

// The required expansion in layout units, from the FINAL placement only
// (frame + placed graphic bounds) — independent of how the graphic got there.
function calculateRequiredExpansion(frameBounds, graphicBounds) {
    return detectImageUnderfill(frameBounds, graphicBounds, CONFIG.coverageTolerancePt);
}

// ---------- Phase 2: source pixels ----------

// Pixel size from the image file header (JPEG SOFn / PNG IHDR / WebP).
// Returns { width, height, format } or null if unreadable / unsupported.
function parseImageHeader(bytes) {
    const b = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
    const u16be = (i) => (b[i] << 8) | b[i + 1];
    const u32be = (i) => ((b[i] << 24) >>> 0) + (b[i + 1] << 16) + (b[i + 2] << 8) + b[i + 3];
    // PNG
    if (b.length > 24 && b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47) {
        return { width: u32be(16), height: u32be(20), format: "png" };
    }
    // JPEG: walk the markers to the first SOFn
    if (b.length > 4 && b[0] === 0xff && b[1] === 0xd8) {
        let i = 2;
        while (i + 9 < b.length) {
            if (b[i] !== 0xff) { i++; continue; }
            const marker = b[i + 1];
            if (marker === 0xd8 || marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) { i += 2; continue; }
            const len = u16be(i + 2);
            const isSOF = marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc;
            if (isSOF) return { width: u16be(i + 7), height: u16be(i + 5), format: "jpeg" };
            if (len < 2) break;
            i += 2 + len;
        }
        return null;
    }
    // WebP (RIFF....WEBP)
    if (b.length > 30 && b[0] === 0x52 && b[1] === 0x49 && b[8] === 0x57 && b[9] === 0x45) {
        const chunk = String.fromCharCode(b[12], b[13], b[14], b[15]);
        if (chunk === "VP8X") return { width: 1 + (b[24] | (b[25] << 8) | (b[26] << 16)), height: 1 + (b[27] | (b[28] << 8) | (b[29] << 16)), format: "webp" };
        if (chunk === "VP8 ") return { width: (b[26] | (b[27] << 8)) & 0x3fff, height: (b[28] | (b[29] << 8)) & 0x3fff, format: "webp" };
        if (chunk === "VP8L") {
            const bits = b[21] | (b[22] << 8) | (b[23] << 16) | (b[24] << 24);
            return { width: (bits & 0x3fff) + 1, height: ((bits >> 14) & 0x3fff) + 1, format: "webp" };
        }
    }
    return null;
}

// Reads the source file's header (first 256 KB is plenty for JPEG/PNG/WebP).
async function readImagePixelSize(path) {
    const storage = require("uxp").storage;
    const entry = await storage.localFileSystem.getEntryWithUrl("file:" + path);
    const data = await entry.read({ format: storage.formats.binary });
    const bytes = new Uint8Array(data);
    return parseImageHeader(bytes.length > 262144 ? bytes.subarray(0, 262144) : bytes);
}

// InDesign's own estimate of the source pixel size: layout size × effective
// ppi (pixels per inch at the current scale) ÷ 72 pt per inch.
function pixelSizeFromInDesign(graphic, graphicBounds) {
    try {
        const ppi = graphic.effectivePpi;
        const g = toBox(graphicBounds);
        const px = Number(ppi[0]);
        const py = Number(ppi[1]);
        if (!(px > 0 && py > 0)) return null;
        return { width: Math.round((g.width / 72) * px), height: Math.round((g.height / 72) * py) };
    } catch (e) {
        return null;
    }
}

// PURE. Converts the missing layout area into source-image pixels.
//   missing: {top,right,bottom,left} in layout units
//   graphicBounds: the placed graphic's bounds (full image, incl. cropped parts)
//   sourceWidth/Height: the original image's pixel size
// Per axis: source px per layout unit = source px / graphic size. Each side is
// rounded UP so the extension is never short of the frame.
function convertExpansionToSourcePixels(missing, graphicBounds, sourceWidth, sourceHeight) {
    const g = toBox(graphicBounds);
    const ratioX = sourceWidth / g.width;
    const ratioY = sourceHeight / g.height;
    const expansionPixels = {
        top: Math.ceil(missing.top * ratioY),
        right: Math.ceil(missing.right * ratioX),
        bottom: Math.ceil(missing.bottom * ratioY),
        left: Math.ceil(missing.left * ratioX),
    };
    return {
        sourceWidth, sourceHeight,
        ratio: { x: round2(ratioX), y: round2(ratioY) },
        missingLayout: missing,
        expansionPixels,
        targetWidth: sourceWidth + expansionPixels.left + expansionPixels.right,
        targetHeight: sourceHeight + expansionPixels.top + expansionPixels.bottom,
    };
}

// ---------- extension plans ----------

// FNV-1a 32-bit — a small deterministic hash for plan ids.
function fnv1a(str) {
    let h = 0x811c9dc5;
    for (let i = 0; i < str.length; i++) {
        h ^= str.charCodeAt(i);
        h = Math.imul(h, 0x01000193) >>> 0;
    }
    return ("00000000" + h.toString(16)).slice(-8);
}

// PURE. Firefly working resolution for a plan: never above the source
// (scale <= 1), only as far down as Firefly's per-side limit requires. ONE
// factor for source, expansion/inset and canvas, so the geometry is the same
// plan at a lower resolution. Also checks the extended image still gives the
// final output CONFIG.outputPxPerPt px per point.
//   canvasLayout: { width, height } the extended canvas covers, in layout units
// PURE. The Firefly working geometry for a source + extension (source px):
// ONE scale factor for source, extension/inset and canvas, rounded only at
// the end — source down, insets up (so the generated area always covers the
// gap). That rounding can add up to 1 px per extended side pair (e.g.
// floor(2569.4) + ceil(59.25) + ceil(59.25) = 2689), so the factor is
// reduced slightly until the rounded canvas fits fireflyMaxSide.
// Returns { scale, exactScale, downscaled, source, size, inset, originalTarget }.
function fitWorkingGeometry(sourceWidth, sourceHeight, expansionPixels) {
    const max = CONFIG.fireflyMaxSide;
    const targetWidth = sourceWidth + expansionPixels.left + expansionPixels.right;
    const targetHeight = sourceHeight + expansionPixels.top + expansionPixels.bottom;
    let scale = Math.min(1, max / targetWidth, max / targetHeight);
    let source, inset, size;
    for (let i = 0; i < 20; i++) {
        source = { width: Math.floor(sourceWidth * scale), height: Math.floor(sourceHeight * scale) };
        inset = sides((side) => Math.ceil(expansionPixels[side] * scale - 1e-9));
        size = { width: source.width + inset.left + inset.right, height: source.height + inset.top + inset.bottom };
        if (size.width <= max && size.height <= max) break;
        // over by rounding only: shrink the factor by the overshoot (+ a hair)
        scale = scale * Math.min(max / size.width, max / size.height) - 1e-7;
    }
    return {
        scale: Math.round(scale * 1e6) / 1e6,
        exactScale: scale,
        downscaled: scale < 1,
        source, size, inset,
        originalTarget: { width: targetWidth, height: targetHeight },
    };
}

function computeWorkingResolution(sourceWidth, sourceHeight, expansionPixels, canvasLayout) {
    const w = fitWorkingGeometry(sourceWidth, sourceHeight, expansionPixels);
    const pxPerPt = Math.min(w.size.width / canvasLayout.width, w.size.height / canvasLayout.height);
    return {
        scale: w.scale,
        downscaled: w.downscaled,
        source: w.source, size: w.size, inset: w.inset,
        originalTarget: w.originalTarget,          // full source-resolution canvas
        pxPerPt: round2(pxPerPt),
        requiredPxPerPt: CONFIG.outputPxPerPt,
        resolutionOk: pxPerPt >= CONFIG.outputPxPerPt,
    };
}

// PURE. The exact extension plan for one page: what Firefly would have to
// generate, nothing more. Its identity is the generation request itself —
// source image + size, the required expansion on each side, and the working
// request (size + inset) — all derived from the FINAL geometry. No placement
// concepts (anchor, fit mode) are part of it: two pages with the same source
// and the same required expansion need the very same generated asset, however
// placement got there. Different requirements never share a plan.
//   input: { sourcePath, sourceWidth, sourceHeight, format,
//            missingLayout, graphicBounds, expansionPixels }
function createExtensionPlan(input) {
    const g = toBox(input.graphicBounds);
    const m = input.missingLayout;
    const canvasLayout = { width: g.width + m.left + m.right, height: g.height + m.top + m.bottom };
    const e = input.expansionPixels;
    const working = computeWorkingResolution(input.sourceWidth, input.sourceHeight, e, canvasLayout);
    const ratio = {
        x: round2((e.left + e.right) / input.sourceWidth),
        y: round2((e.top + e.bottom) / input.sourceHeight),
    };
    ratio.max = Math.max(ratio.x, ratio.y);
    const key = JSON.stringify([
        String(input.sourcePath).toLowerCase(), input.sourceWidth, input.sourceHeight,
        e.top, e.right, e.bottom, e.left,
        working.size.width, working.size.height,
        working.inset.top, working.inset.right, working.inset.bottom, working.inset.left,
    ]);
    return {
        id: "EXT_" + fnv1a(key),
        key,
        source: { path: input.sourcePath, width: input.sourceWidth, height: input.sourceHeight, format: input.format },
        expansionPixels: e,
        target: { width: input.sourceWidth + e.left + e.right, height: input.sourceHeight + e.top + e.bottom },
        ratio,
        working,
    };
}

// PURE. May Firefly extend this plan automatically?
// Returns { eligible, reasons: [], overridable }.
//   overridable: not eligible ONLY because of the soft limits (extension
//   over maxExtensionRatio, or output resolution below outputPxPerPt) — the
//   designer may still start it by hand (Extend Image, after a warning).
//   Unsupported file type / Firefly canvas size are hard limits.
function checkAutoExtensionEligibility(plan) {
    const reasons = [];
    let hard = false;
    if (CONFIG.fireflyFormats.indexOf(plan.source.format) === -1) {
        reasons.push(`unsupported image type for Firefly: ${plan.source.format}`);
        hard = true;
    }
    if (plan.ratio.max > CONFIG.maxExtensionRatio) {
        reasons.push(`Required extension exceeds automatic generation limit ` +
            `(${Math.round(plan.ratio.max * 100)}% > ${Math.round(CONFIG.maxExtensionRatio * 100)}%)`);
    }
    if (plan.working.size.width > CONFIG.fireflyMaxSide || plan.working.size.height > CONFIG.fireflyMaxSide) {
        reasons.push(`Firefly canvas ${plan.working.size.width}×${plan.working.size.height} exceeds ${CONFIG.fireflyMaxSide} px`);
        hard = true;
    }
    if (!plan.working.resolutionOk) {
        reasons.push(`Firefly's ${CONFIG.fireflyMaxSide} px limit can't give the output enough resolution ` +
            `(${plan.working.pxPerPt} px/pt < ${CONFIG.outputPxPerPt})`);
    }
    return { eligible: reasons.length === 0, reasons, overridable: reasons.length > 0 && !hard };
}

// A run's plan registry: Map key -> { plan, eligible, uses: [{product, layout, page}] }.
function createPlanRegistry() {
    return new Map();
}

// Deterministic lookup of a reusable plan. Exact key match by default; with
// CONFIG.planMatchTolerancePx > 0, an existing plan for the same source and
// working scale may be reused if it is at most that many px LARGER on each
// side (never smaller — the page must stay covered).
function findMatchingExtensionPlan(registry, plan) {
    if (registry.has(plan.key)) return registry.get(plan.key);
    const tol = CONFIG.planMatchTolerancePx;
    if (!(tol > 0)) return null;
    for (const entry of registry.values()) {
        const p = entry.plan;
        if (p.source.path.toLowerCase() !== plan.source.path.toLowerCase()) continue;
        if (p.working.scale !== plan.working.scale) continue;
        const fits = ["top", "right", "bottom", "left"].every((k) => {
            const d = p.expansionPixels[k] - plan.expansionPixels[k];
            return d >= 0 && d <= tol;
        });
        if (fits) return entry;
    }
    return null;
}

// Registers a plan use. Returns { plan, reuse: "new" | "matching" } — the
// plan to use (the existing one when matched).
function registerExtensionPlan(registry, plan, eligibility, use) {
    const match = findMatchingExtensionPlan(registry, plan);
    if (match) {
        match.uses.push(use);
        return { plan: match.plan, reuse: "matching" };
    }
    registry.set(plan.key, { plan, eligible: eligibility.eligible, reasons: eligibility.reasons, uses: [use] });
    return { plan, reuse: "new" };
}

// ---------- geometry snapshot (for Phase 4 relink) ----------

// The FINAL placed state of one page's image, captured before anything is
// generated: frame + graphic bounds, scale, effective ppi and the source-pixel
// to layout mapping. Phase 4 relinks the extended asset from this snapshot so
// the original content lands exactly where placement put it — the subject
// never moves. Pure data (JSON-safe).
function captureGeometrySnapshot(frame, graphic, sourceWidth, sourceHeight) {
    const num = (v) => { const n = Number(v); return isFinite(n) ? n : null; };
    const read = (fn) => { try { return fn(); } catch (e) { return null; } };
    const frameBounds = Array.from(frame.geometricBounds, Number);
    const graphicBounds = Array.from(graphic.geometricBounds, Number);
    const g = toBox(graphicBounds);
    return {
        frameBounds,
        graphicBounds,
        horizontalScale: read(() => num(graphic.horizontalScale)),
        verticalScale: read(() => num(graphic.verticalScale)),
        effectivePpi: read(() => Array.from(graphic.effectivePpi, Number)),
        sourceWidth: sourceWidth || null,
        sourceHeight: sourceHeight || null,
        // layout units per source pixel — the relink keeps this unchanged
        layoutPerSourcePx: sourceWidth && sourceHeight
            ? { x: g.width / sourceWidth, y: g.height / sourceHeight } : null,
        capturedAt: new Date().toISOString(),
    };
}

// ---------- one page: final placed state → coverage → plan ----------

// Statuses (image part of a page / product):
//   "not_required"       — the image covers the frame
//   "extension_required" — underfilled; an eligible extension plan exists
//   "needs_review"       — can't or mustn't extend automatically (ambiguous
//                          layout, missing link, unknown size, unsupported
//                          type, over the auto-extension limit, fill-mode
//                          layout that doesn't cover, …)
//   "failed"             — the check itself failed
//
// Starts from the FINAL placed state of `frame` — whatever placement did.
// ctx: { product, indd, page, layout,
//        allowExtension: boolean — may this page be extended automatically?
//                        (the placement stage's decision; false = e.g. a
//                        fill-mode layout),
//        placement: opaque object from the placement stage, logged as-is }
// registry: createPlanRegistry() shared by the whole run.
// Returns a plain JSON-safe record.
async function analyzeImageCoverage(frame, ctx, registry) {
    const rec = Object.assign({}, ctx, {
        allowExtension: ctx.allowExtension !== false,
        placement: ctx.placement || null,
        frame: "", originalAsset: "", frameBounds: null, graphicBounds: null, snapshot: null,
        needsExtension: false, missing: null, status: "not_required", problems: [],
        plan: null, planReuse: "", eligible: false,
    });
    const review = (why) => { rec.problems.push(why); rec.status = "needs_review"; return rec; };
    try {
        if (!frame) return review("no Image frame found");
        try { rec.frame = String(frame.name || ""); } catch (e) {}

        const found = getPlacedGraphic(frame);
        if (found.error) return review(found.error);
        const graphic = found.graphic;

        try {
            const link = graphic.itemLink;
            rec.originalAsset = String(link.filePath || link.name || "");
            const st = String(link.status || "");
            if (/missing/i.test(st)) return review("linked image is missing: " + rec.originalAsset);
        } catch (e) {
            return review("placed graphic has no link (embedded or pasted) — not extended automatically");
        }

        rec.frameBounds = Array.from(frame.geometricBounds, Number).map(round2);
        rec.graphicBounds = Array.from(graphic.geometricBounds, Number).map(round2);

        const transform = transformProblem(frame, graphic);
        if (transform) return review(transform + " — coverage can't be measured reliably");

        // Phase 1 — from the final placement only
        const d = calculateRequiredExpansion(rec.frameBounds, rec.graphicBounds);
        rec.needsExtension = d.needsExtension;
        rec.missing = d.missing;
        if (!d.overlaps) return review("image doesn't overlap its frame at all");
        if (!d.needsExtension) return rec; // covers the frame (cropping is fine)
        if (!rec.allowExtension) {
            return review("automatic extension isn't allowed for this layout, but the image doesn't cover its frame");
        }

        // Phase 2 — source pixels
        const header = await readImagePixelSize(rec.originalAsset).catch(() => null);
        const fromInDesign = pixelSizeFromInDesign(graphic, rec.graphicBounds);
        rec.sourceFromFile = header;
        rec.sourceFromInDesign = fromInDesign;
        if (!header) return review("original image size unavailable (unreadable or unsupported file)");
        if (fromInDesign) {
            const off = Math.max(
                Math.abs(fromInDesign.width - header.width) / header.width,
                Math.abs(fromInDesign.height - header.height) / header.height);
            if (off > CONFIG.sizeMismatchTolerance) {
                return review(`InDesign's size estimate (${fromInDesign.width}×${fromInDesign.height}) doesn't match ` +
                    `the file (${header.width}×${header.height})`);
            }
        }
        const px = convertExpansionToSourcePixels(d.missing, rec.graphicBounds, header.width, header.height);
        Object.assign(rec, px);
        // Final placed state, kept for the Phase 4 relink.
        rec.snapshot = captureGeometrySnapshot(frame, graphic, header.width, header.height);

        // Extension plan → eligibility → reuse
        const plan = createExtensionPlan({
            sourcePath: rec.originalAsset, sourceWidth: header.width, sourceHeight: header.height,
            format: header.format,
            missingLayout: d.missing, graphicBounds: rec.graphicBounds, expansionPixels: px.expansionPixels,
        });
        const eligibility = checkAutoExtensionEligibility(plan);
        const reg = registry ? registerExtensionPlan(registry, plan, eligibility,
            { product: rec.product, layout: rec.layout, page: rec.page }) : { plan, reuse: "new" };
        rec.plan = {
            id: reg.plan.id, key: reg.plan.key, ratio: reg.plan.ratio, working: reg.plan.working, target: reg.plan.target,
        };
        rec.planReuse = reg.reuse;
        rec.eligible = eligibility.eligible;
        if (!eligibility.eligible) {
            for (const r of eligibility.reasons) rec.problems.push(r);
            rec.status = "needs_review";
            // Over a soft limit only: Extend Image can still be started by hand.
            rec.overridable = !!eligibility.overridable;
            return rec;
        }
        rec.status = "extension_required";
        return rec;
    } catch (e) {
        rec.status = "failed";
        rec.problems.push(String((e && e.message) || e));
        return rec;
    }
}

// ---------- Phase 3: Firefly Generative Expand via the App Builder backend ----------
//
// The plugin holds NO Adobe credentials (no Client Secret, no access token).
// It talks to three web actions (territory-app) through a plugin key, which is
// only a prototype request gate — client-side config, NOT a secret:
//   get-upload-url  -> presigned App Builder Files URL; the plugin PUTs the
//                      source there directly (no image bytes in a Runtime
//                      request — 1 MB limit)
//   expand-image    -> backend resizes to the plan's working size, uploads to
//                      Firefly, submits /v3/images/expand-async -> jobId
//   expand-status   -> polled until succeeded / failed / timeout
// One request per UNIQUE eligible plan (registry), one automatic attempt.
// Never throws into the batch: failures are recorded on the plan.

const CONTENT_TYPE = { jpeg: "image/jpeg", png: "image/png", webp: "image/webp" };

// plugin/backend.config.json: { "enabled": true, "baseUrl": "https://<ns>.adobeioruntime.net/api/v1/web/image-extension", "pluginKey": "…" }
// Returns the config, or null (with a reason) when Firefly can't be used.
async function loadBackendConfig() {
    try {
        const fs = require("uxp").storage.localFileSystem;
        const folder = await fs.getPluginFolder();
        const entry = await folder.getEntry("backend.config.json");
        const cfg = JSON.parse(await entry.read());
        if (!cfg || cfg.enabled === false) return { config: null, reason: "Firefly disabled in backend.config.json" };
        if (!/^https:\/\//.test(String(cfg.baseUrl || "")) || !cfg.pluginKey) {
            return { config: null, reason: "backend.config.json needs an https baseUrl and a pluginKey" };
        }
        const maxPlans = Number.isInteger(cfg.maxPlansPerRun) && cfg.maxPlansPerRun >= 0 ? cfg.maxPlansPerRun : CONFIG.firefly.maxPlansPerRun;
        const onlyPlanId = /^EXT_[0-9a-f]{8}$/.test(String(cfg.onlyPlanId || "")) ? cfg.onlyPlanId : CONFIG.firefly.onlyPlanId;
        const batchMode = cfg.batchMode === "independent" || cfg.batchMode === "consistent" ? cfg.batchMode : CONFIG.batchMode;
        return { config: { baseUrl: String(cfg.baseUrl).replace(/\/+$/, ""), pluginKey: String(cfg.pluginKey), maxPlansPerRun: maxPlans, onlyPlanId, batchMode }, reason: "" };
    } catch (e) {
        return { config: null, reason: "Firefly backend not configured (plugin/backend.config.json missing)" };
    }
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// POSTs JSON to a backend action. Throws with the backend's error message.
async function callBackend(cfg, action, body) {
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

// Uploads the plan's ORIGINAL source file to temporary storage (presigned
// URL). The source asset itself is only read, never modified.
// Returns { storagePath, contentType }.
async function uploadSourceForPlan(cfg, plan) {
    const contentType = CONTENT_TYPE[plan.source.format];
    if (!contentType) throw new Error(`unsupported source format ${plan.source.format}`);
    const target = await callBackend(cfg, "get-upload-url", { planId: plan.id, contentType });
    const storage = require("uxp").storage;
    const entry = await storage.localFileSystem.getEntryWithUrl("file:" + plan.source.path);
    const bytes = await entry.read({ format: storage.formats.binary });
    const res = await fetch(target.uploadUrl, {
        method: "PUT",
        headers: target.uploadHeaders || { "x-ms-blob-type": "BlockBlob", "Content-Type": contentType },
        body: bytes,
    });
    if (!res.ok) throw new Error(`source upload failed (HTTP ${res.status})`);
    return { storagePath: target.storagePath, contentType };
}

// Phase 3 request: upload + submit Generative Expand for one plan.
// Returns { jobId, statusUrl (logging only), uploadId, fireflyRequest, workingSource }.
//   prompt: optional designer text guiding the generated area ("" = none)
async function requestFireflyExpansion(cfg, plan, prompt) {
    const up = await uploadSourceForPlan(cfg, plan);
    const w = plan.working;
    const body = {
        planId: plan.id,
        storagePath: up.storagePath,
        contentType: up.contentType,
        working: { source: w.source, size: w.size, inset: w.inset },
    };
    if (prompt) body.prompt = String(prompt).slice(0, 1024);
    return callBackend(cfg, "expand-image", body);
}

// Polls a job until it finishes or CONFIG.firefly.timeoutMs passes.
// Returns { status: "succeeded", outputUrl, size } or throws.
async function pollFireflyJob(cfg, job, options) {
    const o = Object.assign({}, CONFIG.firefly, options || {});
    const started = Date.now();
    for (;;) {
        // jobId only — the backend builds the Firefly status URL itself.
        const st = await callBackend(cfg, "expand-status", { jobId: job.jobId });
        if (st.status === "succeeded") return st;
        if (st.status === "failed" || st.status === "canceled" || st.status === "cancelled") {
            throw new Error(`Firefly job ${st.status}: ${st.error || "no details"}`);
        }
        if (Date.now() - started > o.timeoutMs) throw new Error(`Firefly job timed out after ${Math.round(o.timeoutMs / 1000)} s`);
        await sleep(o.pollIntervalMs);
    }
}

// Generates ONE plan (registry entry), at most CONFIG.firefly.maxAttempts
// times, and stores the outcome on the entry:
//   entry.generation = { status: "succeeded"|"failed"|"skipped", jobId,
//                        outputUrl, size, error, attempts, startedAt, finishedAt }
// Concurrent callers for the same plan share one in-flight request.
function generateExtensionForPlan(cfg, entry) {
    if (entry.generationPromise) return entry.generationPromise;
    entry.generationPromise = (async () => {
        const gen = { status: "pending", jobId: null, outputUrl: null, size: null, error: "", attempts: 0,
            startedAt: new Date().toISOString(), finishedAt: null };
        entry.generation = gen;
        while (gen.attempts < CONFIG.firefly.maxAttempts) {
            gen.attempts++;
            try {
                gen.status = "extending";
                const job = await requestFireflyExpansion(cfg, entry.plan);
                gen.jobId = job.jobId;
                gen.statusUrl = job.statusUrl || null;         // Firefly's own URL — logging only
                gen.uploadId = job.uploadId || null;           // Firefly storage id
                gen.fireflyRequest = job.fireflyRequest || null; // exact expand-async body (no credentials)
                gen.workingSource = job.workingSource || null;
                const done = await pollFireflyJob(cfg, job);
                gen.status = "succeeded";
                gen.outputUrl = done.outputUrl;
                gen.size = done.size || null;
                gen.error = "";
                break;
            } catch (e) {
                gen.status = "failed";
                gen.error = String((e && e.message) || e);
            }
        }
        gen.finishedAt = new Date().toISOString();
        return gen;
    })();
    return entry.generationPromise;
}

// Runs Phase 3 for the eligible records of one product: each unique plan is
// generated once (shared across pages / products through the registry), up
// to CONFIG.firefly.maxConcurrentJobs at a time. Annotates every eligible
// record with rec.firefly = { status, jobId, outputUrl, error, planReuse }.
// backend: loadBackendConfig() result.
async function runFireflyForRecords(records, registry, backend) {
    const eligible = records.filter((r) => r.status === "extension_required" && r.plan);
    if (!eligible.length) return;
    if (!backend || !backend.config) {
        for (const r of eligible) r.firefly = { status: "skipped", error: (backend && backend.reason) || "Firefly backend not configured" };
        return;
    }
    const entries = [];
    for (const r of eligible) {
        const entry = registry.get(r.plan.key);
        if (entry && entries.indexOf(entry) === -1) entries.push(entry);
    }
    // Test limiter (maxPlansPerRun): plans beyond the limit are skipped, not
    // generated. Counted per run on the registry; reused plans don't count.
    const limit = backend.config.maxPlansPerRun;
    const queue = [];
    for (const entry of entries) {
        if (entry.generation || entry.generationPromise) { queue.push(entry); continue; }
        if (backend.config.onlyPlanId && entry.plan.id !== backend.config.onlyPlanId) {
            entry.generation = { status: "skipped", error: `test limit: onlyPlanId = ${backend.config.onlyPlanId}`, attempts: 0 };
            continue;
        }
        if (limit !== null && limit !== undefined && (registry.newGenerations || 0) >= limit) {
            entry.generation = { status: "skipped", error: `test limit: maxPlansPerRun = ${limit}`, attempts: 0 };
            continue;
        }
        registry.newGenerations = (registry.newGenerations || 0) + 1;
        queue.push(entry);
    }
    const workers = Array.from({ length: Math.min(CONFIG.firefly.maxConcurrentJobs, queue.length) }, async () => {
        while (queue.length) {
            const entry = queue.shift();
            if (!entry.generation || entry.generation.status !== "skipped") await generateExtensionForPlan(backend.config, entry);
        }
    });
    await Promise.all(workers);
    for (const r of eligible) {
        const g = (registry.get(r.plan.key) || {}).generation || { status: "failed", error: "plan missing from registry" };
        r.firefly = { status: g.status, jobId: g.jobId, statusUrl: g.statusUrl || null, uploadId: g.uploadId || null, outputUrl: g.outputUrl, size: g.size,
            error: g.error, attempts: g.attempts, fireflyRequest: g.fireflyRequest || null };
        if (g.status === "failed") {
            // One automatic attempt only — the page now needs a human.
            r.problems.push("Firefly extension failed: " + g.error);
            r.status = "needs_review";
        }
    }
}

// ---------- Phase 3: generated asset store (cache + versions) ----------
//
// Every successful Firefly generation is kept — the FULL expanded image as
// Firefly returned it (never cropped) plus its geometry metadata, under a
// human-readable name that follows the normal output naming (render.js
// buildOutputFileName / buildInddFileName — passed in as usedFor.baseName):
//   <output root>/generated_assets/image_extensions/
//     <prefix>_<year>_<product>_<WxH>_<variant>_extended/      one page / layout
//       …_extended_v001.jpg   …_extended_v001.json
//       …_extended_v002.jpg   …_extended_v002.json   ← Re-extend adds a version
//     <prefix>_<year>_<product>_extension_master/              shared by several pages
//       …_extension_master_v001.jpg   …_extension_master_v001.json
// The JPG and JSON of one generation share one basename. The METADATA is the
// authoritative record (planId, batch, pages, Firefly job, …) — lookups never
// depend on folder or file names. Legacy folders (<planId>/result_vNNN.jpg +
// metadata_vNNN.json) are still read; new generations are never written there.
// Old versions are never deleted or overwritten. This is a HISTORY (rollback,
// Use existing, debugging, comparing generations) — not an API-saving cache:
// Extend and Re-extend always make new Firefly generation(s); only an
// explicit "Use existing extension" reads a stored version.

function uxpStorage() {
    return require("uxp").storage;
}

async function entryOrNull(path) {
    try { return await uxpStorage().localFileSystem.getEntryWithUrl("file:" + path); } catch (e) { return null; }
}

// Creates every missing folder of `path` (absolute); returns the path.
async function ensureDir(path) {
    const st = uxpStorage();
    const parts = String(path).replace(/\/+$/, "").split("/");
    let cur = "";
    for (const part of parts) {
        if (!part) continue;
        cur += "/" + part;
        if (!(await entryOrNull(cur))) await st.localFileSystem.createEntryWithUrl("file:" + cur, { type: st.types.folder });
    }
    return cur;
}

async function writeFile(path, data, binary) {
    const st = uxpStorage();
    const entry = await st.localFileSystem.createEntryWithUrl("file:" + path, { type: st.types.file, overwrite: true });
    await entry.write(data, binary ? { format: st.formats.binary } : undefined);
    return path;
}

function extensionsRoot(outputRoot) {
    return [String(outputRoot).replace(/\/+$/, "")].concat(CONFIG.extension.assetFolder).join("/");
}

// The folder of one extension group: its readable base name (or, for legacy
// assets, the plan id).
function assetFolderFor(outputRoot, name) {
    return extensionsRoot(outputRoot) + "/" + name;
}

const pad3 = (n) => ("00" + n).slice(-3);

// Generation metadata files: "<base>_vNNN.json" (current) or
// "metadata_vNNN.json" (legacy <planId> folders).
const GENERATION_JSON = /(^metadata|_)v(\d{3})\.json$/;

// Every generation stored in ONE folder (metadata objects, oldest first).
async function readFolderGenerations(folder) {
    const out = [];
    if (!folder || !folder.isFolder) return out;
    for (const e of await folder.getEntries()) {
        if (!GENERATION_JSON.test(e.name)) continue;
        try {
            const meta = JSON.parse(await e.read());
            if (!meta || !meta.planId) continue;
            meta.metadataPath = folder.nativePath ? folder.nativePath + "/" + e.name : e.name;
            meta.assetExists = !!(await entryOrNull(meta.generatedAssetPath));
            out.push(meta);
        } catch (err) {}
    }
    return out.sort((a, b) => (a.generationVersion || 0) - (b.generationVersion || 0));
}

// All stored generations under an output root — readable AND legacy folders —
// read once and kept briefly (a Generate run asks for many plans). Writing a
// new generation drops the cache.
const INDEX_TTL_MS = 60000;
let generationIndex = null; // { root, at, list }
async function loadGenerationIndex(outputRoot, fresh) {
    const root = extensionsRoot(outputRoot);
    if (!fresh && generationIndex && generationIndex.root === root && Date.now() - generationIndex.at < INDEX_TTL_MS) {
        return generationIndex.list;
    }
    const list = [];
    const top = await entryOrNull(root);
    if (top && top.isFolder) {
        for (const f of await top.getEntries()) {
            if (f.isFolder) list.push(...(await readFolderGenerations(f)));
        }
    }
    generationIndex = { root, at: Date.now(), list };
    return list;
}

// Every stored generation of a plan (by metadata planId — any folder), oldest
// first by creation time.
async function listGenerations(outputRoot, planId, fresh) {
    const all = await loadGenerationIndex(outputRoot, fresh);
    return all.filter((g) => g.planId === planId)
        .sort((a, b) => String(a.createdAt || "").localeCompare(String(b.createdAt || "")));
}

// The newest valid generation of this exact plan whose file is still on
// disk, or null.
async function latestValidGeneration(outputRoot, planId) {
    const all = await listGenerations(outputRoot, planId);
    for (let i = all.length - 1; i >= 0; i--) if (all[i].valid && all[i].assetExists) return all[i];
    return null;
}

// PURE. Does the returned image map onto the requested Firefly canvas?
// Same size → scale 1; same aspect (uniform rescale) → that scale; else not
// alignable (never guessed).
function checkGeneratedSize(requested, returned) {
    if (!returned || !returned.width || !returned.height) return { ok: false, reason: "output size unknown" };
    if (returned.width === requested.width && returned.height === requested.height) return { ok: true, scale: 1 };
    const sx = returned.width / requested.width;
    const sy = returned.height / requested.height;
    if (Math.abs(sx - sy) / Math.max(sx, sy) <= CONFIG.extension.aspectTolerance) {
        return { ok: true, scale: Math.round(sx * 10000) / 10000, note: "uniformly rescaled by Firefly" };
    }
    return { ok: false, reason: `Firefly returned ${returned.width}×${returned.height}, requested ${requested.width}×${requested.height} — can't be aligned` };
}

// Downloads a Firefly output URL. Returns { bytes: ArrayBuffer, header }.
async function downloadGeneratedImage(url) {
    const res = await fetch(url);
    if (!res.ok) throw new Error(`download of the generated image failed (HTTP ${res.status})`);
    const bytes = await res.arrayBuffer();
    const header = parseImageHeader(new Uint8Array(bytes));
    if (!header) throw new Error("generated image is not a readable JPEG/PNG/WebP");
    return { bytes, header };
}

// Phase 3 for ONE plan: a new Firefly generation → FULL expanded image saved
// as the next version + metadata. Never crops; never touches InDesign.
//   plan: createExtensionPlan() result; snapshot: captureGeometrySnapshot()
// Returns the metadata (valid:false + reason if the output can't be aligned).
async function generateNewVersion(cfg, outputRoot, plan, snapshot, mode, usedFor, prompt) {
    const job = await requestFireflyExpansion(cfg, plan, prompt);
    const done = await pollFireflyJob(cfg, job);
    const dl = await downloadGeneratedImage(done.outputUrl);
    // Readable folder + basename (normal output naming, from render.js);
    // the plan id only if no name was given.
    const base = (usedFor && usedFor.baseName) || plan.id;
    const folder = await ensureDir(assetFolderFor(outputRoot, base));
    const ext = dl.header.format === "png" ? "png" : dl.header.format === "webp" ? "webp" : "jpg";
    // Next version of THIS folder; never overwrite an existing file.
    const inFolder = await readFolderGenerations(await entryOrNull(folder));
    let version = inFolder.reduce((m, g) => Math.max(m, g.generationVersion || 0), 0) + 1;
    while (await entryOrNull(`${folder}/${base}_v${pad3(version)}.${ext}`) || await entryOrNull(`${folder}/${base}_v${pad3(version)}.json`)) version++;
    const assetPath = `${folder}/${base}_v${pad3(version)}.${ext}`;
    await writeFile(assetPath, dl.bytes, true);
    const returned = { width: dl.header.width, height: dl.header.height };
    const sizeCheck = checkGeneratedSize(plan.working.size, returned);
    const meta = {
        planId: plan.id,
        sourceImagePath: plan.source.path,
        sourceSize: { width: plan.source.width, height: plan.source.height },
        workingSource: plan.working.source,             // what Firefly received (px)
        workingScale: plan.working.scale,
        target: plan.working.size,                      // Firefly canvas requested (px)
        originalWorkingTarget: plan.working.originalTarget || plan.target, // full source-resolution canvas
        fireflyWorkingTarget: plan.working.size,        // = target, after normalising to fireflyMaxSide
        fullResolutionTarget: plan.target,              // source + extension at source resolution
        returnedSize: returned,
        outputScale: sizeCheck.ok ? sizeCheck.scale : null,
        extension: plan.expansionPixels,                // per side, source px
        inset: plan.working.inset,                      // per side, working px (Firefly placement.inset)
        generatedAssetPath: assetPath,                  // the FULL expanded image
        fireflyJobId: job.jobId,
        fireflyStatusUrl: job.statusUrl || null,        // logging only
        fireflyRequest: job.fireflyRequest || null,
        generationVersion: version,
        generationMode: mode,
        kind: plan.kind || "page",                      // "master" = shared by a product batch
        memberPlans: plan.members || null,              // page plans a master covers
        usedFor: usedFor || null,                       // { product, layout|"batch", layouts?, baseName, … } that requested it
        readableName: base,                             // folder + file basename (without _vNNN)
        templateType: (usedFor && usedFor.templateType) || null,
        year: (usedFor && usedFor.year) || null,
        product: (usedFor && usedFor.product) || null,
        width: (usedFor && usedFor.width) || null,      // page size for a single-layout generation
        height: (usedFor && usedFor.height) || null,
        variant: (usedFor && usedFor.variant) || null,
        pages: (usedFor && usedFor.pages) || null,      // page / layout assignments
        shared: !!(usedFor && usedFor.pages && usedFor.pages.length > 1), // product-level master
        batchId: usedFor && usedFor.pages && usedFor.pages.length > 1 ? plan.id : null,
        prompt: prompt || "",                           // designer's optional prompt ("" = none)
        cacheHit: false,                                // a fresh generation
        valid: sizeCheck.ok,
        invalidReason: sizeCheck.ok ? "" : sizeCheck.reason,
        snapshot: snapshot || null,                     // placement state it was generated for
        createdAt: new Date().toISOString(),
    };
    await writeFile(`${folder}/${base}_v${pad3(version)}.json`, JSON.stringify(meta, null, 2));
    generationIndex = null; // a new generation exists
    return meta;
}

// The stored version "Use existing extension" applies: found by METADATA
// (planId — readable or legacy folder alike), preferring the newest valid
// version generated for the same readable name / product + layout,
// otherwise the newest valid version of the plan. null if there is none.
async function existingGenerationFor(outputRoot, planId, usedFor) {
    const all = (await listGenerations(outputRoot, planId, true)).filter((g) => g.valid && g.assetExists);
    const same = (g) => g.usedFor && usedFor && (
        (usedFor.baseName && g.readableName === usedFor.baseName) ||
        (g.usedFor.product === usedFor.product && g.usedFor.layout === usedFor.layout));
    for (let i = all.length - 1; i >= 0; i--) if (same(all[i])) return all[i];
    return all.length ? all[all.length - 1] : null;
}

// "Use existing" for ONE page when no version of its exact (master) plan is
// stored — e.g. the product is now grouped differently: any stored valid
// generation that can serve this page, judged from METADATA only:
//   same source image (path + pixel size), at least the page's required
//   extension on every side (source px), and enough output resolution for
//   this page at that generation's working scale.
// Such a generation aligns exactly (computeExtensionCanvasBounds maps it onto
// this page's own graphic). Prefers one generated for the same product +
// layout, then the newest. null if none.
async function applicableGenerationFor(outputRoot, pagePlan, graphicBounds, usedFor) {
    const g0 = toBox(graphicBounds);
    const src = pagePlan.source;
    const fits = (g) => {
        if (!g.valid || !g.assetExists || !g.extension || !g.workingSource) return false;
        if (String(g.sourceImagePath || "").toLowerCase() !== String(src.path).toLowerCase()) return false;
        if (!g.sourceSize || g.sourceSize.width !== src.width || g.sourceSize.height !== src.height) return false;
        if (!["top", "right", "bottom", "left"].every((k) => (g.extension[k] || 0) >= pagePlan.expansionPixels[k])) return false;
        return Math.min(g.workingSource.width / g0.width, g.workingSource.height / g0.height) >= CONFIG.outputPxPerPt;
    };
    const all = (await loadGenerationIndex(outputRoot, true)).filter(fits)
        .sort((a, b) => String(a.createdAt || "").localeCompare(String(b.createdAt || "")));
    const forPage = (g) => usedFor && (g.product || (g.usedFor && g.usedFor.product)) === usedFor.product &&
        ((g.pages || []).some((p) => p.layout === usedFor.layout) || (g.usedFor && g.usedFor.layout === usedFor.layout));
    for (let i = all.length - 1; i >= 0; i--) if (forPage(all[i])) return all[i];
    return all.length ? all[all.length - 1] : null;
}

// The generated extension for ONE page:
//   mode "extend"       — Extend image: a NEW Firefly generation
//   mode "regenerate"   — Re-extend image: a NEW Firefly generation
//   mode "use_existing" — Use existing extension: a stored version, no Firefly
// Every generation becomes the plan's next version; nothing is overwritten.
//   usedFor: { product, layout, page } — recorded in the metadata
//   options.prompt: optional text guiding Firefly (new generations only)
// Returns { meta, cacheHit } — or throws with a user-facing reason.
async function obtainExtension(cfg, outputRoot, plan, snapshot, mode, usedFor, options) {
    if (mode === "use_existing") {
        const existing = await existingGenerationFor(outputRoot, plan.id, usedFor);
        if (!existing) throw new Error(`no existing extension for plan ${plan.id}`);
        return { meta: existing, cacheHit: true };
    }
    if (!cfg) throw new Error("Firefly backend not configured (plugin/backend.config.json)");
    const meta = await generateNewVersion(cfg, outputRoot, plan, snapshot, mode, usedFor, options && options.prompt);
    if (!meta.valid) throw new Error(meta.invalidReason + ` (kept as v${pad3(meta.generationVersion)}, not applied)`);
    return { meta, cacheHit: false };
}

// ---------- consistent batch: one MASTER plan for many pages ----------

// PURE. One master extension plan covering several pages' plans of the SAME
// source: per side, the largest extension any page needs (source px). Each
// page then clips its own strip from the master result — its required area
// is always inside the master canvas. Resolution is checked per page at the
// master's working scale.
//   members: [{ plan, graphicBounds }] (page plans from analyzeImageCoverage)
// Returns the plan (same shape as createExtensionPlan + kind/members), with
// `eligibility` = checkAutoExtensionEligibility(master).
function createMasterExtensionPlan(members) {
    const src = members[0].plan.source;
    const e = sides((side) => Math.max.apply(null, members.map((m) => m.plan.expansionPixels[side])));
    const targetWidth = src.width + e.left + e.right;
    const targetHeight = src.height + e.top + e.bottom;
    // Same normalisation as a page plan: the whole master geometry scaled by
    // one factor so the Firefly canvas fits fireflyMaxSide.
    const fit = fitWorkingGeometry(src.width, src.height, e);
    const { source, inset, size } = fit;
    // Output px per layout pt on each member page at this working scale.
    const pxPerPt = Math.min.apply(null, members.map((m) => {
        const g = toBox(m.graphicBounds);
        return Math.min(source.width / g.width, source.height / g.height);
    }));
    const working = {
        scale: fit.scale, downscaled: fit.downscaled, source, size, inset, originalTarget: fit.originalTarget,
        pxPerPt: round2(pxPerPt), requiredPxPerPt: CONFIG.outputPxPerPt, resolutionOk: pxPerPt >= CONFIG.outputPxPerPt,
    };
    const ratio = { x: round2((e.left + e.right) / src.width), y: round2((e.top + e.bottom) / src.height) };
    ratio.max = Math.max(ratio.x, ratio.y);
    const key = JSON.stringify(["master", String(src.path).toLowerCase(), src.width, src.height,
        e.top, e.right, e.bottom, e.left, size.width, size.height, inset.top, inset.right, inset.bottom, inset.left]);
    const plan = {
        id: "EXT_" + fnv1a(key), key, kind: "master",
        source: src, expansionPixels: e, target: { width: targetWidth, height: targetHeight }, ratio, working,
        members: members.map((m) => m.plan.id),
    };
    plan.eligibility = checkAutoExtensionEligibility(plan);
    return plan;
}

// PURE. Groups a batch's eligible pages into as FEW master plans as possible
// (normally one). Pages are only separated when a shared master is
// genuinely impossible: a different source image, or adding the page would
// make the master ineligible (combined extension over the limit, or a
// page's output resolution too low at the master's working scale).
//   pages: [{ plan, graphicBounds, ref }] — ref is returned untouched
//   options.allowLarge: a manual Extend of over-limit pages — a master that
//   is only over the soft limits may still be shared
// Returns [{ master, pages }] (deterministic: input order).
function groupIntoMasterPlans(pages, options) {
    const allowLarge = !!(options && options.allowLarge);
    const groups = [];
    for (const p of pages) {
        let placed = false;
        for (const g of groups) {
            if (g.sourceKey !== String(p.plan.source.path).toLowerCase() + "|" + p.plan.source.width + "x" + p.plan.source.height) continue;
            const trial = createMasterExtensionPlan(g.pages.concat([p]));
            if (!trial.eligibility.eligible && !(allowLarge && trial.eligibility.overridable)) continue;
            g.pages.push(p);
            g.master = trial;
            placed = true;
            break;
        }
        if (!placed) {
            groups.push({
                sourceKey: String(p.plan.source.path).toLowerCase() + "|" + p.plan.source.width + "x" + p.plan.source.height,
                pages: [p], master: createMasterExtensionPlan([p]),
            });
        }
    }
    return groups.map((g) => ({ master: g.master, pages: g.pages }));
}

// ---------- Phase 4: the `extendImage` layer ----------
//
//   Text / Footer / other artwork
//   extendImage   ← generated extension strips only (this file)
//   Image         ← the original, exactly as placement left it
//   Shadow / Background
//
// Each strip is a plain rectangle (no stroke/fill) named
// <<ImageExtension_<side>>> that contains the SAME full expanded image,
// positioned so its original region lies exactly on the original graphic;
// the rectangle clips it to the uncovered strip. Our items carry an
// insertLabel(CONFIG.extension.labelKey) record; nothing else on the layer is
// ever touched.

// PURE. Where the full expanded image goes in layout units, so its original
// region coincides with the original graphic:
//   graphicBounds: the original graphic's bounds [t, l, b, r]
//   working: plan.working (source = the region Firefly kept, inset, size)
// One working px = graphic size / working source size (per axis — the
// backend resized the source to exactly working.source).
function computeExtensionCanvasBounds(graphicBounds, working) {
    const g = toBox(graphicBounds);
    const ux = g.width / working.source.width;
    const uy = g.height / working.source.height;
    const top = g.top - working.inset.top * uy;
    const left = g.left - working.inset.left * ux;
    return [top, left, top + working.size.height * uy, left + working.size.width * ux];
}

// PURE. The non-overlapping extension strips for one frame:
//   top / bottom — full frame width (they own the corners)
//   left / right — only between the top and bottom strips
// Each strip reaches `overlap` into its neighbours (seam safety, see CONFIG).
//   missing: per side (layout units; 0 = covered)
// Returns [{ side, bounds: [t, l, b, r] }].
function computeExtensionStrips(frameBounds, graphicBounds, missing, overlap) {
    const f = toBox(frameBounds);
    const g = toBox(graphicBounds);
    const o = overlap || 0;
    const strips = [];
    const midTop = missing.top > 0 ? g.top : f.top;
    const midBottom = missing.bottom > 0 ? g.bottom : f.bottom;
    if (missing.top > 0) strips.push({ side: "top", bounds: [f.top, f.left, Math.min(f.bottom, g.top + o), f.right] });
    if (missing.bottom > 0) strips.push({ side: "bottom", bounds: [Math.max(f.top, g.bottom - o), f.left, f.bottom, f.right] });
    const vTop = missing.top > 0 ? Math.max(f.top, midTop - o) : f.top;
    const vBottom = missing.bottom > 0 ? Math.min(f.bottom, midBottom + o) : f.bottom;
    if (missing.left > 0) strips.push({ side: "left", bounds: [vTop, f.left, vBottom, Math.min(f.right, g.left + o)] });
    if (missing.right > 0) strips.push({ side: "right", bounds: [vTop, Math.max(f.left, g.right - o), vBottom, f.right] });
    return strips;
}

function readLabel(item) {
    try {
        const raw = item.extractLabel(CONFIG.extension.labelKey);
        return raw ? JSON.parse(raw) : null;
    } catch (e) {
        return null;
    }
}

function isValidObject(o) {
    try { return !!o && o.isValid !== false; } catch (e) { return false; }
}

// The `extendImage` layer of a document, or null.
function findExtendLayer(doc) {
    try {
        const layer = doc.layers.itemByName(CONFIG.extension.layerName);
        return isValidObject(layer) && layer.name === CONFIG.extension.layerName ? layer : null;
    } catch (e) {
        return null;
    }
}

// Creates or reuses `extendImage` and puts it directly above `imageLayer`.
// Existing items on it are kept.
function ensureExtendLayer(doc, imageLayer, id) {
    let layer = findExtendLayer(doc);
    if (!layer) layer = doc.layers.add({ name: CONFIG.extension.layerName });
    try { layer.locked = false; } catch (e) {}
    try { if (imageLayer && imageLayer.name !== layer.name) layer.move(id.LocationOptions.BEFORE, imageLayer); } catch (e) {}
    return layer;
}

// Our extension items on a page — optionally only those of one Image frame.
function extensionItemsOnPage(page, frameId) {
    const out = [];
    let items;
    try { items = page.allPageItems; } catch (e) { return out; }
    const n = items ? items.length : 0;
    for (let i = 0; i < n; i++) {
        const it = itemAt(items, i);
        const label = readLabel(it);
        if (!label || label.feature !== "imageExtension") continue;
        if (frameId !== undefined && frameId !== null && label.frameId !== frameId) continue;
        out.push({ item: it, label });
    }
    return out;
}

function removeExtensionItems(page, frameId) {
    let removed = 0;
    for (const x of extensionItemsOnPage(page, frameId)) {
        try { x.item.remove(); removed++; } catch (e) {}
    }
    return removed;
}

// Phase 4 for ONE page: shows the generated extension of `record` (from
// analyzeImageCoverage, status extension_required) on `extendImage`.
// The original Image frame and graphic are only READ.
//   meta: obtainExtension().meta; id: require("indesign")
// Returns { sides, canvasBounds, version, planId }.
function applyExtensionToPage(doc, page, frame, record, meta, cacheHit, id) {
    const found = getPlacedGraphic(frame);
    if (found.error) throw new Error(found.error);
    const graphicBounds = Array.from(found.graphic.geometricBounds, Number);
    const frameBounds = Array.from(frame.geometricBounds, Number);
    // The plan was made for exactly this geometry — refuse if it moved since.
    const snap = record.snapshot;
    if (snap && snap.graphicBounds.some((v, i) => Math.abs(v - graphicBounds[i]) > CONFIG.extension.alignTolerancePt)) {
        throw new Error("the original image moved after the analysis — run Extend again");
    }
    const working = { source: meta.workingSource, size: meta.target, inset: meta.inset };
    const canvasBounds = computeExtensionCanvasBounds(graphicBounds, working);
    const strips = computeExtensionStrips(frameBounds, graphicBounds, record.missing, CONFIG.extension.seamOverlapPt);
    if (!strips.length) throw new Error("no uncovered strip to extend");

    let frameId = null;
    try { frameId = frame.id; } catch (e) {}
    const layer = ensureExtendLayer(doc, frame.itemLayer, id);
    try { layer.visible = true; } catch (e) {}
    removeExtensionItems(page, frameId); // only OUR items of this frame

    let none = null;
    try { none = doc.swatches.itemByName("None"); } catch (e) {}
    const sides = [];
    for (const s of strips) {
        const props = { geometricBounds: s.bounds, itemLayer: layer, name: CONFIG.extension.itemName(s.side), strokeWeight: 0 };
        if (none) { props.fillColor = none; props.strokeColor = none; }
        const rect = page.rectangles.add(props);
        rect.place(meta.generatedAssetPath);
        try { rect.frameFittingOptions.autoFit = false; } catch (e) {}
        const g = itemAt(rect.allGraphics, 0);
        g.geometricBounds = canvasBounds;
        rect.insertLabel(CONFIG.extension.labelKey, JSON.stringify({
            feature: "imageExtension", side: s.side, frameId,
            planId: meta.planId, version: meta.generationVersion, cacheHit: !!cacheHit,
            asset: meta.generatedAssetPath,
            originalGraphicBounds: graphicBounds, frameBounds, canvasBounds,
            appliedAt: new Date().toISOString(),
        }));
        sides.push(s.side);
    }
    return { sides, canvasBounds, version: meta.generationVersion, planId: meta.planId };
}

// Shows / hides the whole `extendImage` layer. Returns false if the document
// has no such layer.
function setExtendLayerVisible(doc, visible) {
    const layer = findExtendLayer(doc);
    if (!layer) return false;
    layer.visible = !!visible;
    return true;
}

// ---------- Phase 4: coverage = original Image + extendImage ----------

// PURE. a minus b → up to 4 boxes ({top,left,bottom,right}).
function subtractBox(a, b) {
    const t = Math.max(a.top, b.top), l = Math.max(a.left, b.left);
    const btm = Math.min(a.bottom, b.bottom), r = Math.min(a.right, b.right);
    if (t >= btm || l >= r) return [a];
    const out = [];
    if (a.top < t) out.push({ top: a.top, left: a.left, bottom: t, right: a.right });
    if (btm < a.bottom) out.push({ top: btm, left: a.left, bottom: a.bottom, right: a.right });
    if (a.left < l) out.push({ top: t, left: a.left, bottom: btm, right: l });
    if (r < a.right) out.push({ top: t, left: r, bottom: btm, right: a.right });
    return out;
}

// PURE. Parts of `frameBounds` not covered by any of `covers` (bounds
// arrays). Slivers up to `tolerance` thick are ignored (rounding noise).
function uncoveredBoxes(frameBounds, covers, tolerance) {
    const tol = tolerance === undefined ? CONFIG.coverageTolerancePt : tolerance;
    let left = [toBox(frameBounds)];
    for (const c of covers) {
        const cb = toBox(c);
        left = left.reduce((acc, box) => acc.concat(subtractBox(box, cb)), []);
    }
    return left.filter((b) => b.bottom - b.top > tol && b.right - b.left > tol)
        .map((b) => [b.top, b.left, b.bottom, b.right].map(round2));
}

function intersectBounds(a, b) {
    return [Math.max(a[0], b[0]), Math.max(a[1], b[1]), Math.min(a[2], b[2]), Math.min(a[3], b[3])];
}

// Post-extension validation of one Image frame. Coverage = what the original
// graphic covers + what visible extension frames show (each frame clips its
// graphic). Returns
//   { state, text, uncovered, extension: {planId, version, cacheHit, sides} | null }
//   state: "covered"           — the original alone covers the frame
//          "extended"          — original + extension cover it
//          "extension_hidden"  — covered only with the hidden extendImage layer
//          "misaligned"        — extension frames don't match the original any more
//          "underfilled"       — not covered (no / incomplete extension)
//          "unknown"           — can't be measured (no graphic, transformed…)
function checkExtendedCoverage(page, frame) {
    const out = { state: "unknown", text: "", uncovered: [], extension: null };
    const found = getPlacedGraphic(frame);
    if (found.error) { out.text = found.error; return out; }
    const t = transformProblem(frame, found.graphic);
    if (t) { out.text = t; return out; }
    const frameBounds = Array.from(frame.geometricBounds, Number);
    const graphicBounds = Array.from(found.graphic.geometricBounds, Number);
    const original = uncoveredBoxes(frameBounds, [graphicBounds]);
    if (!original.length) { out.state = "covered"; return out; }

    let frameId = null;
    try { frameId = frame.id; } catch (e) {}
    const ext = extensionItemsOnPage(page, frameId);
    if (!ext.length) {
        out.state = "underfilled"; out.uncovered = original;
        out.text = "image doesn't cover its frame";
        return out;
    }
    const l0 = ext[0].label;
    out.extension = { planId: l0.planId, version: l0.version, cacheHit: !!l0.cacheHit, sides: ext.map((x) => x.label.side) };
    const tol = CONFIG.extension.alignTolerancePt;
    for (const x of ext) {
        const moved = (x.label.originalGraphicBounds || []).some((v, i) => Math.abs(v - graphicBounds[i]) > tol);
        if (moved) { out.state = "misaligned"; out.text = "the original image moved after the extension was applied — re-extend"; return out; }
        try {
            const st = String(itemAt(x.item.allGraphics, 0).itemLink.status || "");
            if (/missing/i.test(st)) { out.state = "misaligned"; out.text = "generated extension file is missing: " + x.label.asset; return out; }
        } catch (e) {}
    }
    const covers = [graphicBounds];
    let hidden = false;
    for (const x of ext) {
        try {
            if (!x.item.itemLayer.visible || x.item.visible === false) hidden = true;
            const g = itemAt(x.item.allGraphics, 0);
            covers.push(intersectBounds(Array.from(x.item.geometricBounds, Number), Array.from(g.geometricBounds, Number)));
        } catch (e) {}
    }
    const rest = uncoveredBoxes(frameBounds, covers);
    if (rest.length) {
        out.state = "underfilled"; out.uncovered = rest;
        out.text = "image + extension don't cover the frame";
        return out;
    }
    out.state = hidden ? "extension_hidden" : "extended";
    return out;
}

// ---------- reports ----------

const SIDES = ["top", "right", "bottom", "left"];
const pct = (n) => Math.round(n * 100) + "%";

function sideList(m, unit) {
    const parts = SIDES.filter((k) => m && m[k] > 0).map((k) => `${k} +${m[k]}${unit}`);
    return parts.length ? parts.join(", ") : "none";
}

// The placement stage's description, printed as-is (this file doesn't
// interpret placement concepts).
function placementText(p) {
    if (!p) return "-";
    return Object.keys(p).map((k) => `${k} ${typeof p[k] === "object" ? JSON.stringify(p[k]) : p[k]}`).join(" · ");
}

// Multi-line block per page for image_extension_log.txt.
function formatCoverageReport(r) {
    const side = (m, unit) => SIDES.map((k) => `  ${k}: ${m ? m[k] : 0}${unit}`).join("\n");
    const lines = [
        `Product: ${r.product}`,
        `INDD: ${r.indd}`,
        `Layout: ${r.layout} (page ${r.page})`,
        `Placement (from the placement stage): ${placementText(r.placement)}`,
        `Automatic extension allowed: ${r.allowExtension ? "yes" : "no"}`,
        `Original source: ${r.originalAsset || "-"}`,
        `Source dimensions: ${r.sourceWidth && r.sourceHeight ? `${r.sourceWidth}x${r.sourceHeight}` : "-"}`,
        `Frame bounds: [${(r.frameBounds || []).join(", ")}]`,
        `Placed graphic bounds: [${(r.graphicBounds || []).join(", ")}]`,
        "Underfill:", side(r.missing, "pt"),
    ];
    if (r.expansionPixels && r.plan) {
        const p = r.plan;
        lines.push("Required source extension:", side(r.expansionPixels, "px"));
        lines.push(`Extension ratio: X ${pct(p.ratio.x)} · Y ${pct(p.ratio.y)} · maximum ${pct(p.ratio.max)}`);
        lines.push(`Auto-extension limit: ${pct(CONFIG.maxExtensionRatio)}`);
        lines.push(`Eligibility: ${r.eligible ? "yes" : "no"}`);
        lines.push(`Extension plan: ${p.id}`);
        lines.push(`Plan reuse: ${r.planReuse === "matching" ? "matching existing plan" : "new plan"}`);
        lines.push(`Firefly working source size: ${p.working.source.width}x${p.working.source.height}` +
            ` (scale ${p.working.scale}${p.working.downscaled ? `, downscaled for the ${CONFIG.fireflyMaxSide} px limit` : ", no downscale"})`);
        lines.push(`Firefly working target size: ${p.working.size.width}x${p.working.size.height}` +
            ` — ${p.working.pxPerPt} px/pt in the output (needs ${p.working.requiredPxPerPt})`);
        lines.push(`Firefly inset: top ${p.working.inset.top}, right ${p.working.inset.right}, bottom ${p.working.inset.bottom}, left ${p.working.inset.left}`);
        if (r.firefly) {
            lines.push(`Firefly: ${r.firefly.status}` + (r.firefly.jobId ? ` · job ${r.firefly.jobId}` : "") +
                (r.firefly.attempts ? ` · attempts ${r.firefly.attempts}` : "") + (r.firefly.error ? ` · ${r.firefly.error}` : ""));
            if (r.firefly.outputUrl) lines.push(`Generated asset (Firefly URL): ${r.firefly.outputUrl.split("?")[0]}`);
        }
        lines.push(`Existing extension on disk: ${r.cachedVersion ? "v" + pad3(r.cachedVersion) + " (Extend Image → Use existing)" : "none"}`);
    } else {
        lines.push(`Eligibility: no`);
    }
    lines.push(`Final status: ${r.status}${r.problems.length ? " — " + r.problems.join("; ") : ""}`);
    return lines.join("\n");
}

// One line for the panel / Review warnings.
function describeCoverage(r) {
    const gaps = (m) => SIDES.filter((k) => m[k] > 0).map((k) => `${k} ${m[k]} pt`).join(", ");
    if (r.status === "not_required") return "Image covers its frame";
    if (r.status === "extension_required") {
        const ff = r.cachedVersion ? ` — existing extension v${pad3(r.cachedVersion)} available` : "";
        return `Image doesn't cover its frame (${gaps(r.missing)}) — extension required (${sideList(r.expansionPixels, " px")}, plan ${r.plan.id})${ff}`;
    }
    return `Image needs review: ${r.problems.join("; ")}`;
}

// Per product: which plan each layout uses, the unique eligible plans and the
// potential Firefly calls (= unique eligible plans; reused plans count once).
// records: analyzeImageCoverage() results of a run.
function summarizeExtensionPlans(records) {
    const products = new Map();
    const allEligible = new Set();
    for (const r of records) {
        if (!products.has(r.product)) products.set(r.product, { product: r.product, layouts: [], plans: new Map() });
        const p = products.get(r.product);
        let use;
        if (r.status === "extension_required") use = r.plan.id;
        else if (!r.allowExtension && r.status === "not_required") use = "no automatic extension (covers frame) / no Firefly";
        else if (r.status === "not_required") use = "covers frame / no Firefly";
        else use = (r.plan ? r.plan.id + " — " : "") + "Needs Review: " + r.problems.join("; ");
        p.layouts.push({ layout: r.layout, page: r.page, use });
        if (r.status === "extension_required") {
            allEligible.add(r.plan.id);
            if (!p.plans.has(r.plan.id)) p.plans.set(r.plan.id, { id: r.plan.id, expansionPixels: r.expansionPixels, layouts: [] });
            p.plans.get(r.plan.id).layouts.push(r.layout);
        }
    }
    const list = [...products.values()].map((p) => ({
        product: p.product,
        layouts: p.layouts,
        plans: [...p.plans.values()],
        potentialFireflyCalls: p.plans.size,
    }));
    return { products: list, uniqueEligiblePlans: allEligible.size };
}

function formatPlanSummary(summary) {
    const out = [];
    for (const p of summary.products) {
        out.push(`Product: ${p.product}`, "Layouts:");
        for (const l of p.layouts) out.push(`  - ${l.layout} → ${l.use}`);
        out.push("Unique extension plans:");
        if (!p.plans.length) out.push("  (none)");
        for (const pl of p.plans) {
            out.push(`  ${pl.id}: ${sideList(pl.expansionPixels, "px")}`,
                `    used by ${pl.layouts.length} layout(s): ${pl.layouts.join(", ")}`);
        }
        out.push(`Potential Firefly calls: ${p.potentialFireflyCalls}`, "");
    }
    out.push(`TOTAL potential Firefly calls (unique eligible plans in this run): ${summary.uniqueEligiblePlans}`);
    return out.join("\n");
}

module.exports = {
    CONFIG, COVERAGE_TOLERANCE_PT, FIREFLY_MAX_SIDE,
    // detection + conversion
    getPlacedGraphic, transformProblem, detectImageUnderfill, calculateRequiredExpansion,
    parseImageHeader, readImagePixelSize, pixelSizeFromInDesign, convertExpansionToSourcePixels,
    // snapshot + plans
    captureGeometrySnapshot, fitWorkingGeometry, computeWorkingResolution, createExtensionPlan, checkAutoExtensionEligibility,
    createPlanRegistry, findMatchingExtensionPlan, registerExtensionPlan,
    // Phase 3 (Firefly via the backend)
    loadBackendConfig, callBackend, uploadSourceForPlan, requestFireflyExpansion, pollFireflyJob,
    generateExtensionForPlan, runFireflyForRecords,
    // Phase 3 asset store (full expanded images, versions, cache)
    assetFolderFor, extensionsRoot, loadGenerationIndex, readFolderGenerations, listGenerations, latestValidGeneration, checkGeneratedSize, downloadGeneratedImage,
    generateNewVersion, obtainExtension, existingGenerationFor, applicableGenerationFor,
    // consistent batch (one master generation per product)
    createMasterExtensionPlan, groupIntoMasterPlans,
    // Phase 4 (extendImage layer + combined coverage)
    computeExtensionCanvasBounds, computeExtensionStrips, findExtendLayer, ensureExtendLayer,
    extensionItemsOnPage, removeExtensionItems, applyExtensionToPage, setExtendLayerVisible,
    subtractBox, uncoveredBoxes, checkExtendedCoverage,
    // page analysis + reports
    analyzeImageCoverage, describeCoverage, formatCoverageReport, summarizeExtensionPlans, formatPlanSummary,
};
