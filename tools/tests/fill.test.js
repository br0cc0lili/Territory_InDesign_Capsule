// Offline regression test (Node, no InDesign). Run: node tools/tests/run.js
// Auto Placement subject size:
//   - a subject spanning less than 75% of the free band (frame minus text)
//     is enlarged to ~78% of it, centred, clear of the text;
//   - it must also span at least 70% of the WHOLE frame — if the text
//     leaves too little room, it is enlarged to ~75% of the frame and may
//     overlap the text area (as little as possible), never past 80%;
//   - big subjects and whole-photo boxes are left as they were;
//   - the text area is the lines' bounds, not the whole text frame.
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
const frameFill = (r) => Math.max((r[3] - r[1]) / 1200, (r[2] - r[0]) / 1200);
const plan = (b, avoid) => pl.planImagePlacement({ frameBounds: frame, sourceSize: src, policy: top, subjectBounds: b, avoidBounds: avoid });

// 1. wide small subject, headline on top (free band 360–1200): 78% of the band, no overlap needed
const small = { x: 0.33, y: 0.4, width: 0.35, height: 0.35 };
const head = [[60, 60, 360, 1140]];
const p1 = plan(small, head);
const r1 = subjRect(p1, small);
const fill1 = Math.max((r1[3] - r1[1]) / 1200, (r1[2] - r1[0]) / 840);
ok(p1.subjectShift.zoom > 1 && near(fill1, 0.78, 0.01), `small subject enlarged to ~78% of the free band (zoom x${p1.subjectShift.zoom}, fill ${fill1.toFixed(2)})`);
ok(frameFill(r1) >= 0.70 - 0.005 && frameFill(r1) <= 0.80 + 0.005, `... which is ${Math.round(frameFill(r1) * 100)}% of the whole frame (70–80%)`);
ok(r1[0] >= 360 - 0.5 && r1[2] <= 1200 + 0.5 && !p1.subjectShift.overText, "enlarged subject stays below the headline (no overlap)");
ok(near((r1[1] + r1[3]) / 2, 600, 1) && near((r1[0] + r1[2]) / 2, 780, 1), "subject centred in the free band");
ok(p1.graphicBounds[1] <= 0.01 && p1.graphicBounds[3] >= 1199.99, "photo covers the frame width");

// 2. tall subject, big headline frame (top half): band too small → 75% of the frame, overlaps the text
const tall = { x: 0.4, y: 0.2, width: 0.2, height: 0.6 };
const bigHead = [[0, 0, 600, 1200]];
const p2 = plan(tall, bigHead);
const r2 = subjRect(p2, tall);
ok(near(frameFill(r2), 0.75, 0.01), `big text frame: subject still fills ~75% of the frame (${Math.round(frameFill(r2) * 100)}%, zoom x${p2.subjectShift.zoom})`);
ok(p2.subjectShift.overText === true, "... by overlapping the text area (reported)");
ok(r2[0] >= 36 - 0.5 && r2[2] <= 1164 + 0.5 && r2[1] >= 0 && r2[3] <= 1200, "subject stays inside the frame (3% margin), never cropped");
ok(near(r2[2], 1164, 1), "overlap kept as small as possible: subject pushed to the far edge from the text");
ok(p2.graphicBounds[1] <= 0.01 && p2.graphicBounds[3] >= 1199.99 && p2.graphicBounds[0] <= 0.01 && p2.graphicBounds[2] >= 1199.99, "photo covers the frame");

// 3. same photo, text measured by its lines (smaller area): no overlap any more
const lines = [{ top: 40, left: 100, bottom: 110, right: 1000 }, { top: 120, left: 100, bottom: 190, right: 760 }];
const trimmed = pl.textBoundsFromLines(lines, bigHead[0]);
ok(trimmed && near(trimmed[0], 19, 0.5) && near(trimmed[2], 211, 0.5) && near(trimmed[1], 79, 0.5) && near(trimmed[3], 1021, 0.5),
    `text area = lines + padding: ${trimmed && trimmed.map((v) => Math.round(v)).join(",")} (frame 0,0,600,1200)`);
const p3 = plan(tall, [trimmed]);
const r3 = subjRect(p3, tall);
ok(near(frameFill(r3), 0.75, 0.01) && r3[0] >= 211 - 0.5 && !p3.subjectShift.overText,
    `trimmed text area: subject fills ${Math.round(frameFill(r3) * 100)}% of the frame without touching the text`);
ok(pl.textBoundsFromLines([], bigHead[0]) === null, "no lines → no text area");
ok(pl.textBoundsFromLines([{ top: 700, left: 0, bottom: 760, right: 50 }], bigHead[0]) === null, "lines outside the frame (rotated / vertical text) → unusable");

// 4. no text: ~78% of the frame
const p4 = plan(small, []);
ok(near(frameFill(subjRect(p4, small)), 0.78, 0.01), "no text over the photo: subject spans ~78% of the frame");

// 5. big subject already ≥ 75% → unchanged; never enlarged past 80%
const big = { x: 0.05, y: 0.1, width: 0.9, height: 0.8 };
const p5 = plan(big, []);
ok(p5.subjectShift.zoom === 1 && near(p5.graphicBounds[3] - p5.graphicBounds[1], 1200, 0.01), "subject already big enough → contain-fit size kept");
const mid = { x: 0.2, y: 0.2, width: 0.6, height: 0.6 }; // 60% of the frame width at contain-fit, band tiny
const p5b = plan(mid, [[0, 0, 900, 1200]]);
ok(frameFill(subjRect(p5b, mid)) <= 0.80 + 0.005, `never past 80% of the frame (${Math.round(frameFill(subjRect(p5b, mid)) * 100)}%)`);

// 6. whole-photo box → no zoom
ok(plan({ x: 0, y: 0, width: 1, height: 1 }, head).subjectShift.zoom === 1, "whole-photo box (busy photo) → not enlarged");

// 7. tiny subject → capped at maxZoom
const tiny = { x: 0.49, y: 0.49, width: 0.02, height: 0.02 };
ok(near(plan(tiny, []).subjectShift.zoom, pl.PLACEMENT_CONFIG.subject.maxZoom, 0.01), `tiny subject: zoom capped at x${pl.PLACEMENT_CONFIG.subject.maxZoom}`);

// 8. fill layouts unaffected
const fill = pl.planImagePlacement({ frameBounds: frame, sourceSize: src, policy: { id: "f", placementMode: "fill" }, subjectBounds: small });
ok(fill.graphicBounds === null, "fill layouts: unchanged (content-aware fit)");

// 9. whole-frame rule off → subject stays clear of the text (v1.2.4 behaviour)
pl.PLACEMENT_CONFIG.subject.minFrameFill = 0;
const p9 = plan(tall, bigHead);
const r9 = subjRect(p9, tall);
ok(!p9.subjectShift.overText && r9[0] >= 600 - 0.5, "minFrameFill 0 → no overlap, subject inside the free band");

// 10. all zoom off → old behaviour
pl.PLACEMENT_CONFIG.subject.minFill = 0;
const off = plan(small, head);
ok(off.subjectShift.zoom === 1 && near(off.graphicBounds[3] - off.graphicBounds[1], 1200, 0.01), "minFill 0 + minFrameFill 0 → zoom off, contain-fit as before");
pl.PLACEMENT_CONFIG.subject.minFill = 0.75;
pl.PLACEMENT_CONFIG.subject.minFrameFill = 0.70;
console.log(f ? f + " FAILED" : "all passed");
