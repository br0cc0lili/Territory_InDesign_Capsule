// Offline regression test (Node, no InDesign). Run: node tools/tests/run.js
// render.js Capsule helpers: Preview Placement = the placement render.js
// really makes (placeProductImage on a simulated frame), the Missing
// Detection Data warning, and the status record.
const PLUGIN_JS = require("path").resolve(__dirname, "../../plugin/js");
const Module = require("module");
const FitOptions = { PROPORTIONALLY: "prop", CONTENT_AWARE_FIT: "caf", FILL_PROPORTIONALLY: "fill", CENTER_CONTENT: "center" };
const o = Module._load;
Module._load = function (r) {
    if (r === "uxp") return { storage: {} };
    if (r === "indesign") return { app: {}, FitOptions };
    return o.apply(this, arguments);
};
const fs = require("fs");
// placeProductImage is internal: compile render.js with it exported for the test.
const m = new Module(PLUGIN_JS + "/render.js");
m.filename = PLUGIN_JS + "/render.js";
m.paths = Module._nodeModulePaths(PLUGIN_JS);
m._compile(fs.readFileSync(PLUGIN_JS + "/render.js", "utf8") + "\nmodule.exports.__t={placeProductImage};", PLUGIN_JS + "/render.js");
const render = m.exports;
const cap = require(PLUGIN_JS + "/capsule.js");
let f = 0;
const ok = (c, msg) => { console.log((c ? "PASS " : "FAIL ") + msg); if (!c) f++; };
const J = JSON.stringify;
const near = (a, b) => !!a && !!b && a.length === b.length && a.every((v, i) => Math.abs(v - b[i]) < 1e-6);

// A simulated <<MainImage>> frame: place() puts the photo at 100% size
// (pixels × 72 / ppi), fit(PROPORTIONALLY) fits it, fit(CONTENT_AWARE_FIT) is
// InDesign's own crop — the plan is then applied to the graphic.
function mockFrame(bounds, px, ppi) {
    const frame = {
        geometricBounds: bounds.slice(),
        allGraphics: { length: 0, item: () => null },
        place() {
            const g = { geometricBounds: [bounds[0], bounds[1], bounds[0] + (px.height * 72) / ppi, bounds[1] + (px.width * 72) / ppi], actualPpi: [ppi, ppi], effectivePpi: [ppi, ppi] };
            frame.graphic = g;
            frame.allGraphics = { length: 1, item: () => g };
        },
        fit(opt) {
            const g = frame.graphic, [t, l, b, r] = bounds;
            const W = g.geometricBounds[3] - g.geometricBounds[1], H = g.geometricBounds[2] - g.geometricBounds[0];
            if (opt === FitOptions.PROPORTIONALLY) { const s = Math.min((r - l) / W, (b - t) / H); g.geometricBounds = [t, l, t + H * s, l + W * s]; }
            if (opt === FitOptions.CONTENT_AWARE_FIT) { g.contentAware = true; }
        },
    };
    return frame;
}

const EXAMPLE = cap.parseCapsuleJson(J({ focalPoint: { x: 0.533717114, y: 0.649771365, normalized: true },
    boundingBox: { x: 0.067434214, y: 0.2995427, width: 0.9325658, height: 0.70045733, normalized: true } })).detection;
const SMALL = { boundingBox: { x: 0.35, y: 0.45, width: 0.3, height: 0.25 }, focalPoint: { x: 0.5, y: 0.55 } };
const FP = { size: 1, modified: 1 };
const subjectOf = (det) => cap.subjectFromEntry(cap.importDetection({ items: {} }, "/p.jpg", det, { fingerprint: FP }).entry, FP);

const LAYOUTS = [
    { name: "square 1200 (known, extend)", layout: { subType: "service", size: "1200x1200", position: "up" }, frame: [0, 0, 1200, 1200], page: [0, 0, 1200, 1200], avoid: [[900, 60, 1140, 1140]] },
    { name: "landscape 800x600 (known, extend)", layout: { subType: "service", size: "800x600", position: "bottom" }, frame: [0, 0, 600, 800], page: [0, 0, 600, 800], avoid: [[40, 40, 140, 760]] },
    { name: "portrait 1080x1920 (known, fill)", layout: { subType: "service", size: "1080x1920", position: "up" }, frame: [0, 0, 1920, 1080], page: [0, 0, 1920, 1080], avoid: [[1500, 60, 1800, 1020]] },
    { name: "unknown 1000x700 (geometry fallback)", layout: { subType: "service", size: "1000x700", position: "up" }, frame: [-9, -9, 709, 1009], page: [0, 0, 700, 1000], avoid: [[500, 50, 680, 950]] },
    { name: "small 250x250 thumbnail", layout: { subType: "service", size: "250x250", position: "thumbnail" }, frame: [0, 0, 250, 250], page: [0, 0, 250, 250], avoid: [] },
];
const PHOTOS = [{ px: { width: 1920, height: 1280 }, ppi: 72 }, { px: { width: 6000, height: 4000 }, ppi: 300 }, { px: { width: 1080, height: 1350 }, ppi: 72 }];

for (const [dname, det] of [["Capsule example (edge-touching)", EXAMPLE], ["small subject", SMALL]]) {
    const subject = subjectOf(det);
    let same = 0, n = 0;
    const misses = [];
    for (const L of LAYOUTS) for (const ph of PHOTOS) for (const framesMode of [false, true]) {
        const zone = framesMode ? { bounds: [L.frame[0] + 0.15 * (L.frame[2] - L.frame[0]), L.frame[1] + 0.1 * (L.frame[3] - L.frame[1]), L.frame[0] + 0.7 * (L.frame[2] - L.frame[0]), L.frame[1] + 0.9 * (L.frame[3] - L.frame[1])] } : null;
        const page = { layout: L.layout, frameBounds: L.frame, pageBounds: L.page, avoid: L.avoid, zone };
        const pv = render.previewPlacementForPage(page, subject, ph.px, framesMode);
        // what render.js really does (populateDocument → placeProductImage)
        const usable = subject.box && (subject.source === "chosen" || !subject.wholePhoto) ? subject.box : null;
        const frame = mockFrame(L.frame, ph.px, ph.ppi);
        const placed = render.__t.placeProductImage(frame, "/p.jpg", L.layout, usable || subject.box, L.avoid, zone && usable ? zone.bounds : null);
        n++;
        const real = placed.mode === "fill" && !placed.zone ? null : frame.graphic.geometricBounds;
        const match = pv.kind === "fill" ? (real === null && frame.graphic.contentAware === true) : near(pv.graphicBounds, real);
        if (match && (pv.kind === "zone") === !!placed.zone) same++; else misses.push(`${L.name} ${ph.px.width}px frames=${framesMode}: preview ${pv.kind} ${J(pv.graphicBounds)} vs ${placed.mode} ${J(real)}`);
    }
    ok(same === n, `${dname}: Preview Placement ≡ placeProductImage in ${same}/${n} cases (5 layouts × 3 photos × auto / red frames)` + (misses.length ? "\n   " + misses.join("\n   ") : ""));
}

// preview details
const sq = { layout: LAYOUTS[0].layout, frameBounds: LAYOUTS[0].frame, pageBounds: LAYOUTS[0].page, avoid: LAYOUTS[0].avoid, zone: null };
const pv = render.previewPlacementForPage(sq, subjectOf(SMALL), { width: 1920, height: 1280 }, false);
ok(pv.kind === "extend" && pv.stats.frameFill >= 0.7 && pv.stats.frameFill <= 0.8 + 1e-9, `small subject in the square layout → enlarged by the existing rule (frame fill ${pv.stats.frameFill}, zoom ${pv.stats.zoom})`);
ok(pv.subjectRect && pv.subjectRect[2] <= LAYOUTS[0].avoid[0][0] + 1e-6, "subject kept above the text area (existing text avoidance)");
ok(pv.focal && pv.focal.x > pv.subjectRect[1] && pv.focal.x < pv.subjectRect[3], "focal point shown in page coordinates (display only)");
const fillPv = render.previewPlacementForPage({ layout: LAYOUTS[2].layout, frameBounds: LAYOUTS[2].frame, pageBounds: LAYOUTS[2].page, avoid: [], zone: null }, subjectOf(SMALL), { width: 1920, height: 1280 }, false);
ok(fillPv.kind === "fill" && fillPv.graphicBounds === null && /Content-Aware Fit/.test(fillPv.notes.join()), "Fill layout → 'Content-Aware Fit decides' (original behaviour), no invented crop");
const nobox = render.previewPlacementForPage(sq, cap.subjectFromEntry(null, null), { width: 1920, height: 1280 }, false);
const plainFrame = mockFrame(sq.frameBounds, { width: 1920, height: 1280 }, 72);
render.__t.placeProductImage(plainFrame, "/p.jpg", sq.layout, null, sq.avoid, null);
ok(nobox.warnings.some((w) => /no subject box/.test(w)) && near(nobox.graphicBounds, plainFrame.graphic.geometricBounds), "missing data → preview = the original default placement");
// a box edited for one layout only
const store = { items: {} };
cap.importDetection(store, "/p.jpg", SMALL, { fingerprint: FP });
cap.saveEdit(store, "/p.jpg", { boundingBox: { x: 0.05, y: 0.2, width: 0.5, height: 0.5 }, focalPoint: SMALL.focalPoint }, cap.layoutId(LAYOUTS[0].layout));
const edited = cap.subjectFromEntry(store.items["/p.jpg"], FP);
const pvEdit = render.previewPlacementForPage(sq, edited, { width: 1920, height: 1280 }, false);
const pvOther = render.previewPlacementForPage({ layout: LAYOUTS[1].layout, frameBounds: LAYOUTS[1].frame, pageBounds: LAYOUTS[1].page, avoid: LAYOUTS[1].avoid }, edited, { width: 1920, height: 1280 }, false);
const pvOtherAuto = render.previewPlacementForPage({ layout: LAYOUTS[1].layout, frameBounds: LAYOUTS[1].frame, pageBounds: LAYOUTS[1].page, avoid: LAYOUTS[1].avoid }, subjectOf(SMALL), { width: 1920, height: 1280 }, false);
ok(pvEdit.boxSource === "layout" && !near(pvEdit.graphicBounds, pv.graphicBounds), "layout edit → that layout's preview changes");
ok(near(pvOther.graphicBounds, pvOtherAuto.graphicBounds), "layout edit → other layouts unchanged");

// Missing Detection Data warning + status record
ok(render.capsuleMissingWarning(cap.subjectFromEntry(null, null)).startsWith("WARNING Missing Detection Data: no Capsule JSON imported"), "missing → Review warning");
const staleEntry = cap.importDetection({ items: {} }, "/p.jpg", SMALL, { fingerprint: FP }).entry;
ok(/photo changed/.test(render.capsuleMissingWarning(cap.subjectFromEntry(staleEntry, { size: 2, modified: 2 }))), "stale → Review warning");
ok(render.capsuleMissingWarning(subjectOf(SMALL)) === "", "Capsule data present → no warning");
ok(render.capsuleMissingWarning({ box: null, reason: "subject detection off" }) === "" && render.capsuleMissingWarning(null) === "", "API mode (no capsule info) → unchanged, no warning");
const rec = render.capsuleStatusRecord(subjectOf(EXAMPLE));
ok(rec.status === "auto" && J(rec.edges) === J(["right", "bottom"]) && rec.focalPoint && rec.boxSource === "auto", "status record: auto, edges right/bottom, focal point");
ok(render.capsuleStatusRecord({ box: { x: 0, y: 0, width: 1, height: 1 }, source: "photoshop-mask" }) === null, "API subject → no Capsule status");
ok(/^WARNING /.test(render.capsuleMissingWarning(cap.subjectFromEntry(null, null))), "warning starts with 'WARNING ' → counted by generateIndds as a Review warning");

console.log(f ? `${f} FAILED` : "all passed");
process.exit(f ? 1 : 0);
