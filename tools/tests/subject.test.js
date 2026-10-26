// Offline regression test (Node, no InDesign). Run: node tools/tests/run.js
// Subject bounding box → placement.js (planImagePlacement): only the original
// image's position changes; never cropped; no box = exactly as before.
const PLUGIN_JS = require("path").resolve(__dirname, "../../plugin/js");
const pl = require(PLUGIN_JS + "/placement.js");
// These cases check the subject SHIFT at the contain-fit size, so the
// subject zoom (minFill) is off here — the zoom is tested in fill.test.js.
pl.PLACEMENT_CONFIG.subject.minFill = 0;
let f = 0; const ok = (c, m) => { console.log((c ? "PASS " : "FAIL ") + m); if (!c) f++; };
const top = { id: "t", placementMode: "extend", anchor: { vertical: "top", horizontal: "center" } };
const frame = [0, 0, 1200, 1200];
const src = { width: 2965, height: 2160 };              // landscape → vertical gap in a square frame
const plain = pl.planImagePlacement({ frameBounds: frame, sourceSize: src, policy: top });
const none = pl.planImagePlacement({ frameBounds: frame, sourceSize: src, policy: top, subjectBounds: null });
ok(JSON.stringify(plain.graphicBounds) === JSON.stringify(none.graphicBounds) && !none.subjectShift, "no subject box → identical to the previous placement");
const g0 = plain.graphicBounds, h = g0[2] - g0[0];
// subject in the lower part of the photo: centre at y = 0.7 → image moves UP… but it is top-anchored at 0 already → clamp keeps it inside
const low = pl.planImagePlacement({ frameBounds: frame, sourceSize: src, policy: top, subjectBounds: { x: 0.3, y: 0.5, width: 0.4, height: 0.4 } });
ok(low.graphicBounds[0] >= 0 && low.graphicBounds[2] <= 1200 + 1e-9, "image stays inside the frame (never cropped)");
const cy = low.graphicBounds[0] + (0.5 + 0.2) * h;
ok(Math.abs(cy - 600) < 1e-6 || low.graphicBounds[0] === 0 || Math.abs(low.graphicBounds[2] - 1200) < 1e-6, `subject centre moved to the frame centre (or clamped): y ${cy.toFixed(1)}`);
// subject near the top: centre y = 0.25 → image moves DOWN to centre it
const hi = pl.planImagePlacement({ frameBounds: frame, sourceSize: src, policy: top, subjectBounds: { x: 0.3, y: 0.1, width: 0.4, height: 0.3 } });
const cyHi = hi.graphicBounds[0] + (0.1 + 0.15) * h;
ok(hi.subjectShift.dy > 0 && Math.abs(cyHi - 600) < 1e-6 || Math.abs(hi.graphicBounds[2] - 1200) < 1e-6, `subject near the top → image shifted down (dy ${hi.subjectShift.dy}), clamped to the frame`);
ok(Math.abs((hi.graphicBounds[3] - hi.graphicBounds[1]) - (g0[3] - g0[1])) < 1e-9 && Math.abs((hi.graphicBounds[2] - hi.graphicBounds[0]) - h) < 1e-9, "scale unchanged (contain-fit)");
ok(hi.subjectShift.dx === 0, "no shift on the axis without a gap (full width)");
// horizontal gap (portrait photo in a landscape frame): subject on the right → shift left
const port = pl.planImagePlacement({ frameBounds: [0, 0, 600, 800], sourceSize: { width: 2000, height: 3000 }, policy: top, subjectBounds: { x: 0.6, y: 0.2, width: 0.3, height: 0.5 } });
ok(port.subjectShift.dx < 0 && port.graphicBounds[1] >= 0 && port.graphicBounds[3] <= 800 + 1e-9, `horizontal gap: subject on the right → image shifted left (dx ${port.subjectShift.dx}), inside the frame`);
// a box spanning the whole photo (no position information) → no shift
const full = pl.planImagePlacement({ frameBounds: frame, sourceSize: src, policy: top, subjectBounds: { x: 0, y: 0, width: 1, height: 1 } });
ok(JSON.stringify(full.graphicBounds) === JSON.stringify(g0) && full.subjectShift.dy === 0, "whole-photo box (HU-Service case) → placement unchanged");
// free band: headline text over the lower part of the frame → subject centred ABOVE it
const headlineLow = [[800, 60, 1100, 1140]];
const fb = pl.planImagePlacement({ frameBounds: frame, sourceSize: src, policy: top, subjectBounds: { x: 0.05, y: 0.06, width: 0.91, height: 0.9 }, avoidBounds: headlineLow });
const hFb = fb.graphicBounds[2] - fb.graphicBounds[0];
const cyFb = fb.graphicBounds[0] + (0.06 + 0.45) * hFb;
ok(JSON.stringify(fb.subjectShift.freeBand.y) === "[0,800]" && (Math.abs(cyFb - 400) < 1e-6 || fb.graphicBounds[0] === 0), `headline at 800–1100 → free band 0–800, subject centre ${cyFb.toFixed(1)} (≈400 or clamped at the top)`);
ok(fb.graphicBounds[0] >= 0 && fb.graphicBounds[2] <= 1200 + 1e-9, "free-band placement keeps the original inside the frame");
// headline at the top → free band below it → subject centred lower
const fbTop = pl.planImagePlacement({ frameBounds: frame, sourceSize: src, policy: top, subjectBounds: { x: 0.3, y: 0.3, width: 0.4, height: 0.4 }, avoidBounds: [[60, 60, 360, 1140]] });
const cyTop = fbTop.graphicBounds[0] + 0.5 * (fbTop.graphicBounds[2] - fbTop.graphicBounds[0]);
ok(JSON.stringify(fbTop.subjectShift.freeBand.y) === "[360,1200]" && (Math.abs(cyTop - 780) < 1e-6 || Math.abs(fbTop.graphicBounds[2] - 1200) < 1e-6), `headline at the top → free band 360–1200, subject centre ${cyTop.toFixed(1)} (≈780 or clamped)`);
// text frame outside the image frame → ignored; text covering almost everything → frame centre
const outside = pl.planImagePlacement({ frameBounds: frame, sourceSize: src, policy: top, subjectBounds: { x: 0.3, y: 0.1, width: 0.4, height: 0.3 }, avoidBounds: [[1300, 0, 1400, 100]] });
ok(JSON.stringify(outside.graphicBounds) === JSON.stringify(hi.graphicBounds), "text frame outside the image frame → same as no text");
const covered = pl.planImagePlacement({ frameBounds: frame, sourceSize: src, policy: top, subjectBounds: { x: 0.3, y: 0.1, width: 0.4, height: 0.3 }, avoidBounds: [[100, 0, 1150, 1200]] });
ok(JSON.stringify(covered.subjectShift.freeBand.y) === "[0,1200]", "text covering nearly the whole frame → no usable band → frame centre");
ok(JSON.stringify(pl.largestFreeInterval(0, 100, [[20, 30], [60, 70]], 0)) === "[30,60]", "largestFreeInterval picks the biggest gap");
// fill layouts unaffected; invalid boxes ignored
const fill = pl.planImagePlacement({ frameBounds: frame, sourceSize: src, policy: { id: "f", placementMode: "fill" }, subjectBounds: { x: 0.1, y: 0.1, width: 0.2, height: 0.2 } });
ok(fill.graphicBounds === null, "fill layouts: no change (placeImageFill / content-aware fit)");
ok(pl.validSubjectBox({ x: 0.9, y: 0, width: 0.5, height: 0.5 }) === null && pl.validSubjectBox({ x: NaN, y: 0, width: 1, height: 1 }) === null, "invalid boxes are ignored");
console.log(f ? f + " FAILED" : "all passed");
