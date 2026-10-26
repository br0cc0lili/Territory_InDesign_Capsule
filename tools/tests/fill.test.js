// Offline regression test (Node, no InDesign). Run: node tools/tests/run.js
// Auto Placement subject size: a subject spanning less than 75% of the free
// band (frame minus text) is enlarged to ~78%, centred in the band, clear of
// the text; big subjects and whole-photo boxes are left as they were.
const PLUGIN_JS = require("path").resolve(__dirname, "../../plugin/js");
const pl = require(PLUGIN_JS + "/placement.js");
let f = 0; const ok = (c, m) => { console.log((c ? "PASS " : "FAIL ") + m); if (!c) f++; };
const near = (a, b, t) => Math.abs(a - b) <= (t || 0.5);
const top = { id: "t", placementMode: "extend", anchor: { vertical: "top", horizontal: "center" } };
const frame = [0, 0, 1200, 1200];
const src = { width: 1920, height: 1080 };
const subjRect = (p, b) => {
    const [t, l, bt, r] = p.graphicBounds; const W = r - l, H = bt - t;
    return [t + b.y * H, l + b.x * W, t + (b.y + b.height) * H, l + (b.x + b.width) * W];
};
// small subject, headline on top (free band 360–1200)
const small = { x: 0.33, y: 0.4, width: 0.35, height: 0.35 }; // 35% of the frame width at contain-fit
const head = [[60, 60, 360, 1140]];
const p1 = pl.planImagePlacement({ frameBounds: frame, sourceSize: src, policy: top, subjectBounds: small, avoidBounds: head });
const r1 = subjRect(p1, small);
const fill1 = Math.max((r1[3] - r1[1]) / 1200, (r1[2] - r1[0]) / 840);
ok(p1.subjectShift.zoom > 1 && near(fill1, 0.78, 0.01), `small subject enlarged to ~78% of the free band (zoom x${p1.subjectShift.zoom}, fill ${fill1.toFixed(2)})`);
ok(r1[0] >= 360 - 0.5 && r1[2] <= 1200 + 0.5, "enlarged subject stays below the headline (inside the free band)");
ok(near((r1[1] + r1[3]) / 2, 600, 1) && near((r1[0] + r1[2]) / 2, 780, 1), "subject centred in the free band");
ok(p1.graphicBounds[1] <= 0.01 && p1.graphicBounds[3] >= 1199.99, "photo covers the frame width");
// no text: subject fills ~78% of the frame
const p2 = pl.planImagePlacement({ frameBounds: frame, sourceSize: src, policy: top, subjectBounds: small, avoidBounds: [] });
const r2 = subjRect(p2, small);
ok(near(Math.max((r2[3] - r2[1]) / 1200, (r2[2] - r2[0]) / 1200), 0.78, 0.01), "no text over the photo: subject spans ~78% of the frame");
// big subject already ≥ 75% → unchanged (no zoom, as before)
const big = { x: 0.05, y: 0.1, width: 0.9, height: 0.8 };
const p3 = pl.planImagePlacement({ frameBounds: frame, sourceSize: src, policy: top, subjectBounds: big, avoidBounds: [] });
ok(p3.subjectShift.zoom === 1 && near(p3.graphicBounds[3] - p3.graphicBounds[1], 1200, 0.01), "subject already big enough → contain-fit size kept");
// whole-photo box → no zoom
const whole = pl.planImagePlacement({ frameBounds: frame, sourceSize: src, policy: top, subjectBounds: { x: 0, y: 0, width: 1, height: 1 }, avoidBounds: head });
ok(whole.subjectShift.zoom === 1, "whole-photo box (busy photo) → not enlarged");
// tiny subject → capped at maxZoom
const tiny = { x: 0.49, y: 0.49, width: 0.02, height: 0.02 };
const p4 = pl.planImagePlacement({ frameBounds: frame, sourceSize: src, policy: top, subjectBounds: tiny, avoidBounds: [] });
ok(near(p4.subjectShift.zoom, pl.PLACEMENT_CONFIG.subject.maxZoom, 0.01), `tiny subject: zoom capped at x${pl.PLACEMENT_CONFIG.subject.maxZoom}`);
// fill layouts unaffected
const fill = pl.planImagePlacement({ frameBounds: frame, sourceSize: src, policy: { id: "f", placementMode: "fill" }, subjectBounds: small });
ok(fill.graphicBounds === null, "fill layouts: unchanged (content-aware fit)");
// zoom off → old behaviour
pl.PLACEMENT_CONFIG.subject.minFill = 0;
const off = pl.planImagePlacement({ frameBounds: frame, sourceSize: src, policy: top, subjectBounds: small, avoidBounds: head });
ok(off.subjectShift.zoom === 1 && near(off.graphicBounds[3] - off.graphicBounds[1], 1200, 0.01), "minFill 0 → zoom off, contain-fit as before");
console.log(f ? f + " FAILED" : "all passed");
