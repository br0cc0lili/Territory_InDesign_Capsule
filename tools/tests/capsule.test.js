// Offline regression test (Node, no InDesign). Run: node tools/tests/run.js
// Capsule JSON → the SAME subject result the backend API produces → the
// UNCHANGED placement.js. Parsing / validation, the adapter, persistence of
// imported vs. edited values, bulk matching, the detector (never the network).
const PLUGIN_JS = require("path").resolve(__dirname, "../../plugin/js");
const Module = require("module");
const o = Module._load;
Module._load = function (r) { return r === "uxp" ? { storage: {} } : o.apply(this, arguments); };
const cap = require(PLUGIN_JS + "/capsule.js");
const pl = require(PLUGIN_JS + "/placement.js");
const subj = require(PLUGIN_JS + "/subject.js");
let f = 0;
const ok = (c, m) => { console.log((c ? "PASS " : "FAIL ") + m); if (!c) f++; };
const J = JSON.stringify;

// ---------- the confirmed Capsule output ----------
const EXAMPLE = `{
  "focalPoint": { "x": 0.533717114, "y": 0.649771365, "normalized": true },
  "boundingBox": { "x": 0.067434214, "y": 0.2995427, "width": 0.9325658, "height": 0.70045733, "normalized": true }
}`;
const p = cap.parseCapsuleJson(EXAMPLE);
ok(p.ok, "confirmed Capsule JSON is valid");
ok(Math.abs(p.detection.boundingBox.x - 0.067434) < 1e-6 && Math.abs(p.detection.boundingBox.y - 0.299543) < 1e-6, "box x / y kept (left / top edge)");
ok(Math.abs(p.detection.boundingBox.x + p.detection.boundingBox.width - 1) < 1e-4 && Math.abs(p.detection.boundingBox.y + p.detection.boundingBox.height - 1) < 1e-4,
    "box reaches the right and bottom photo edge (x+w, y+h ≈ 1)");
ok(p.detection.focalPoint.x === 0.533717 && p.detection.focalPoint.y === 0.649771, "focal point kept (6 decimals)");
ok(p.warnings.some((w) => /touches the photo's right \/ bottom edge/.test(w)), "edge-touching box → 'may be cut off' note: " + p.warnings[0]);
const e = cap.edgesTouched(p.detection.boundingBox);
ok(!e.left && !e.top && e.right && e.bottom, "edges touched: right + bottom only");

// ---------- invalid input ----------
const bad = (text, re, name) => {
    const r = cap.parseCapsuleJson(text);
    ok(!r.ok && r.errors.some((x) => re.test(x)), `${name} → rejected (${r.errors ? r.errors.join(" | ") : "accepted!"})`);
};
const box = (b) => J({ focalPoint: { x: 0.5, y: 0.5, normalized: true }, boundingBox: Object.assign({ x: 0.1, y: 0.1, width: 0.5, height: 0.5, normalized: true }, b) });
bad("{ focalPoint: 1 }", /not valid JSON/, "malformed JSON");
bad("", /not valid JSON/, "empty file");
bad("[1,2]", /must be an object/, "JSON array");
bad("null", /must be an object/, "JSON null");
bad(J({ focalPoint: { x: 0.5, y: 0.5, normalized: true } }), /boundingBox is missing/, "missing boundingBox");
bad(J({ boundingBox: { x: 0.1, y: 0.1, width: 0.5, height: 0.5, normalized: true } }), /focalPoint is missing/, "missing focalPoint");
bad(box({ normalized: false }), /normalized must be true/, "boundingBox.normalized false");
bad(J({ focalPoint: { x: 0.5, y: 0.5 }, boundingBox: { x: 0.1, y: 0.1, width: 0.5, height: 0.5, normalized: true } }), /focalPoint.normalized must be true/, "focalPoint without normalized");
bad(box({ x: "0.1" }), /boundingBox.x must be a number/, "string coordinate");
bad(box({ y: null }), /boundingBox.y must be a number/, "null coordinate");
bad(box({ x: -0.2 }), /boundingBox.x = -0.2 is outside 0..1/, "negative x");
bad(box({ width: 1.5 }), /boundingBox.width = 1.5 is outside 0..1/, "width > 1");
bad(box({ x: 0.6, width: 0.6 }), /x \+ width = 1.2 is greater than 1/, "x + width > 1");
bad(box({ y: 0.7, height: 0.5 }), /y \+ height = 1.2 is greater than 1/, "y + height > 1");
bad(box({ width: 0 }), /width must be greater than 0/, "zero width");
bad(J({ focalPoint: { x: 1.2, y: 0.5, normalized: true }, boundingBox: { x: 0.1, y: 0.1, width: 0.5, height: 0.5, normalized: true } }), /focalPoint.x = 1.2/, "focal point outside 0..1");
bad(box({ x: 400, y: 300, width: 800, height: 600, normalized: false }), /normalized must be true/, "pixel coordinates");
// tolerated rounding slack
const slack = cap.parseCapsuleJson(box({ x: 0.5, width: 0.50004 }));
ok(slack.ok && slack.detection.boundingBox.x + slack.detection.boundingBox.width <= 1, "x + width = 1.00004 (rounding) → accepted, clamped to 1");
ok(cap.parseCapsuleJson("﻿" + EXAMPLE).ok, "UTF-8 BOM accepted");
const outside = cap.parseCapsuleJson(J({ focalPoint: { x: 0.05, y: 0.05, normalized: true }, boundingBox: { x: 0.3, y: 0.3, width: 0.4, height: 0.4, normalized: true } }));
ok(outside.ok && outside.warnings.some((w) => /focal point lies outside/.test(w)), "focal point outside the box → accepted with a note");
const whole = cap.parseCapsuleJson(box({ x: 0, y: 0, width: 1, height: 1 }));
ok(whole.ok && whole.warnings.some((w) => /whole photo/.test(w)), "whole-photo box → accepted with the whole-photo note");

// ---------- store: imported vs edited, re-import, reset ----------
const PHOTO = "/photos/A6 Avant/car_01.jpg";
const FP = { size: 12345, modified: 1700000000000 };
const store = { path: "/out/capsule_subjects.json", items: {} };
const imp = cap.importDetection(store, PHOTO, p.detection, { sourceFile: "car_01.json", fingerprint: FP, now: "2026-11-16T10:00:00Z" });
ok(!imp.replaced && !imp.hadEdits && cap.entryStatus(store.items[cap.storeKey(PHOTO)], FP) === "auto", "first import → status auto");
const r0 = cap.subjectFromEntry(store.items[cap.storeKey(PHOTO)], FP);
ok(J(r0.box) === J(p.detection.boundingBox) && r0.source === "capsule" && r0.wholePhoto === false, "adapter: box = Capsule boundingBox, source capsule, not whole photo");
ok(J(r0.focalPoint) === J(p.detection.focalPoint) && r0.capsule.status === "auto" && r0.capsule.focalSource === "auto", "adapter keeps the focal point as metadata");
// edit for every layout
const edited = { boundingBox: { x: 0.1, y: 0.32, width: 0.85, height: 0.66 }, focalPoint: { x: 0.5, y: 0.6 } };
cap.saveEdit(store, PHOTO, edited, "", "2026-11-16T11:00:00Z");
const ent = store.items[cap.storeKey(PHOTO)];
ok(J(ent.auto.boundingBox) === J(p.detection.boundingBox), "edit never overwrites the imported box");
const r1 = cap.subjectFromEntry(ent, FP);
ok(J(r1.box) === J(edited.boundingBox) && r1.source === "capsule-manual" && r1.capsule.status === "manual", "edited box used (source capsule-manual)");
ok(J(r1.focalPoint) === J(edited.focalPoint) && r1.capsule.focalSource === "manual", "edited focal point stored separately");
// focal-only edit: box stays the imported one
cap.saveEdit(store, PHOTO, { boundingBox: p.detection.boundingBox, focalPoint: { x: 0.4, y: 0.5 } }, "");
const r2 = cap.subjectFromEntry(ent, FP);
ok(J(r2.box) === J(p.detection.boundingBox) && r2.capsule.boxSource === "auto" && r2.capsule.focalSource === "manual" && r2.source === "capsule",
    "focal-point-only edit → box stays imported (placement identical to auto)");
// values equal to the imported ones → no edit stored
cap.saveEdit(store, PHOTO, { boundingBox: p.detection.boundingBox, focalPoint: p.detection.focalPoint }, "");
ok(ent.manual === null && cap.entryStatus(ent, FP) === "auto", "saving the imported values = no edit (auto)");
// per-layout edit
const L1 = { subType: "service", size: "1200x1200", position: "up" };
const L2 = { subType: "service", size: "1080x1920", position: "up" };
ok(cap.layoutId(L1) === "service/1200x1200/up", "layout id");
cap.saveEdit(store, PHOTO, { boundingBox: { x: 0.2, y: 0.4, width: 0.6, height: 0.5 }, focalPoint: p.detection.focalPoint }, cap.layoutId(L1));
const r3 = cap.subjectFromEntry(ent, FP);
ok(J(r3.box) === J(p.detection.boundingBox), "per-layout edit: shared result keeps the imported box");
ok(J(r3.forLayout(L1).box) === J({ x: 0.2, y: 0.4, width: 0.6, height: 0.5 }) && r3.forLayout(L1).capsule.boxSource === "layout", "forLayout(edited layout) → that layout's box");
ok(r3.forLayout(L2) === r3 && r3.forLayout(null) === r3, "forLayout(other layout) → the shared result, unchanged");
ok(cap.entryStatus(ent, FP) === "manual", "a layout edit counts as adjusted");
// image-level edit replaces layout edits
cap.saveEdit(store, PHOTO, edited, "");
ok(Object.keys(ent.layouts).length === 0 && J(cap.subjectFromEntry(ent, FP).forLayout(L1).box) === J(edited.boundingBox), "edit for all layouts replaces layout-specific edits");
// reset
cap.resetToAuto(store, PHOTO);
ok(cap.entryStatus(ent, FP) === "auto" && J(cap.subjectFromEntry(ent, FP).box) === J(p.detection.boundingBox), "Reset to Auto → imported values again");
// re-import with / without keeping edits
cap.saveEdit(store, PHOTO, edited, "");
const newer = cap.parseCapsuleJson(box({ x: 0.15, y: 0.2, width: 0.7, height: 0.6 }));
const re1 = cap.importDetection(store, PHOTO, newer.detection, { sourceFile: "car_01_v2.json", fingerprint: FP }, true);
ok(re1.replaced && re1.hadEdits && J(re1.entry.auto.boundingBox) === J(newer.detection.boundingBox) && J(re1.entry.manual.boundingBox) === J(edited.boundingBox),
    "re-import (keep edits) → new imported values, edits kept");
const re2 = cap.importDetection(store, PHOTO, newer.detection, { sourceFile: "car_01_v2.json", fingerprint: FP }, false);
ok(re2.replaced && re2.hadEdits && re2.entry.manual === null && cap.entryStatus(re2.entry, FP) === "auto", "re-import (drop edits) → imported values only");
// changed photo → stale until re-import or confirmed
const FP2 = { size: 99999, modified: 1800000000000 };
ok(cap.entryStatus(store.items[cap.storeKey(PHOTO)], FP2) === "stale", "photo file changed → stale");
const rs = cap.subjectFromEntry(store.items[cap.storeKey(PHOTO)], FP2);
ok(rs.box === null && rs.capsule.status === "stale" && /earlier version/.test(rs.reason), "stale data is NOT applied (box null)");
cap.acceptChangedPhoto(store, PHOTO, FP2);
ok(cap.entryStatus(store.items[cap.storeKey(PHOTO)], FP2) === "auto", "keep data for the changed photo → applied again");
ok(cap.subjectFromEntry(null, null).box === null && cap.subjectFromEntry(null, null).capsule.status === "missing", "no data → missing");
ok(/Missing Detection Data/.test(cap.subjectFromEntry(null, null).reason), "missing reason says 'Missing Detection Data'");
let threw = false;
try { cap.saveEdit(store, PHOTO, { boundingBox: { x: 0.9, y: 0, width: 0.5, height: 0.5 } }, ""); } catch (x) { threw = /greater than 1/.test(x.message); }
ok(threw, "an invalid edited box is refused");
ok(cap.saveEdit(store, "/photos/other.jpg", edited, "") === null, "no edit without imported data");

// ---------- bulk import: file-name matching only ----------
const photos = ["/p/A6/car_01.jpg", "/p/Q5/car_02.JPG", "/p/A3/hero.png", "/p/A4/hero.png"];
const m = cap.matchJsonFilesToPhotos(["/dl/car_01.json", "/dl/CAR_02.capsule.json", "/dl/hero.json", "/dl/unrelated.json", "/dl/x/car_01_capsule.json"], photos);
ok(m.unmatched.length === 1 && m.unmatched[0] === "/dl/unrelated.json", "no photo of that name → unmatched (never applied)");
ok(m.ambiguous.length === 1 && m.ambiguous[0].photos.length === 2, "two photos named hero → ambiguous (never applied)");
ok(m.duplicates.length === 1 && m.duplicates[0].jsons.length === 2 && m.matched.length === 1 && m.matched[0].photo === "/p/Q5/car_02.JPG",
    "two JSONs for car_01 → duplicate (never applied); CAR_02.capsule.json → car_02.JPG");
const cov = cap.coverage(store, [PHOTO, PHOTO, "/p/none.jpg"], new Map([[cap.storeKey(PHOTO), FP2]]));
ok(J(cov) === J({ total: 2, auto: 1, manual: 0, missing: 1, stale: 0 }), "coverage counts each photo once: " + J(cov));

// ---------- detector: same interface as subject.js, never the network ----------
(async () => {
    global.fetch = () => { throw new Error("network used"); };
    const det = cap.createCapsuleDetector(store, async () => FP2);
    const apiDet = subj.createSubjectDetector(null, "off", null);
    ok(J(Object.keys(det).filter((k) => k !== "source").sort()) === J(Object.keys(apiDet).sort()), "detector interface = createSubjectDetector's (enabled, hasChoices, detect)");
    const a = await det.detect(PHOTO.toUpperCase());
    ok(a.box && a.source === "capsule", "detect(): path case-insensitive, imported box");
    ok(det.detect(PHOTO) === det.detect(PHOTO), "one result per photo per run (cached)");
    const none = await det.detect("/p/none.jpg");
    ok(none.box === null && none.capsule.status === "missing", "photo without data → box null, status missing — no API call");
    const failing = cap.createCapsuleDetector(store, async () => { throw new Error("disk"); });
    const fr = await failing.detect(PHOTO);
    ok(fr.box === null && /could not be read/.test(fr.reason), "a read problem never throws → missing");

    // ---------- the EXISTING placement with a Capsule box = with the same API box ----------
    const api = { box: Object.assign({}, a.box), source: "photoshop-mask", wholePhoto: subj.isWholePhotoBox(a.box) };
    ok(a.wholePhoto === api.wholePhoto, "whole-photo flag computed like subject.js");
    const extend = { id: "t", placementMode: "extend", anchor: { vertical: "top", horizontal: "center" } };
    const fill = { id: "f", placementMode: "fill" };
    const frames = { square: [0, 0, 1200, 1200], landscape: [0, 0, 600, 800], portrait: [0, 0, 1920, 1080], small: [0, 0, 250, 250] };
    const sources = { "1080x720": { width: 1080, height: 720 }, "6000x4000": { width: 6000, height: 4000 }, "2160x3840": { width: 2160, height: 3840 } };
    const text = [[860, 40, 1150, 1160]];
    let same = 0, n = 0;
    for (const [fn, fb] of Object.entries(frames)) for (const [sn, src] of Object.entries(sources)) for (const avoid of [null, text]) {
        const pa = pl.planImagePlacement({ frameBounds: fb, sourceSize: src, policy: extend, subjectBounds: a.box, avoidBounds: avoid });
        const pb = pl.planImagePlacement({ frameBounds: fb, sourceSize: src, policy: extend, subjectBounds: api.box, avoidBounds: avoid });
        n++; if (J(pa) === J(pb)) same++;
        if (fn === "square" && sn === "1080x720" && avoid) {
            ok(pa.subjectShift && pa.subjectShift.frameFill >= 0.7, `existing occupancy rules apply to the Capsule box (frame fill ${pa.subjectShift.frameFill}, zoom ${pa.subjectShift.zoom})`);
        }
    }
    ok(same === n, `planImagePlacement: Capsule box ≡ API box in ${same}/${n} cases (square / landscape / portrait / 250px × 3 resolutions × with/without text)`);
    const fa = pl.planImagePlacement({ frameBounds: frames.portrait, sourceSize: sources["1080x720"], policy: fill, subjectBounds: a.box });
    ok(fa.mode === "fill" && fa.graphicBounds === null, "Fill layouts: unchanged (Content-Aware Fit decides, as in the original)");
    let zs = 0, zn = 0;
    for (const [, fb] of Object.entries(frames)) for (const policy of [extend, fill]) for (const maxScale of [0, 1.2, 5]) {
        const zone = [fb[0] + 0.1 * (fb[2] - fb[0]), fb[1] + 0.1 * (fb[3] - fb[1]), fb[0] + 0.7 * (fb[2] - fb[0]), fb[1] + 0.9 * (fb[3] - fb[1])];
        const za = pl.planZonePlacement({ frameBounds: fb, zoneBounds: zone, sourceSize: sources["6000x4000"], subjectBounds: a.box, policy, maxScale });
        const zb = pl.planZonePlacement({ frameBounds: fb, zoneBounds: zone, sourceSize: sources["6000x4000"], subjectBounds: api.box, policy, maxScale });
        zn++; if (J(za) === J(zb) && za) zs++;
    }
    ok(zs === zn, `planZonePlacement (red subject frames): Capsule box ≡ API box in ${zs}/${zn} cases`);
    // the same normalized box from photos of different resolution: same placement (only the aspect matters)
    const lo = pl.planImagePlacement({ frameBounds: frames.square, sourceSize: { width: 1080, height: 720 }, policy: extend, subjectBounds: a.box, avoidBounds: text });
    const hi = pl.planImagePlacement({ frameBounds: frames.square, sourceSize: { width: 6000, height: 4000 }, policy: extend, subjectBounds: a.box, avoidBounds: text });
    ok(J(lo.graphicBounds) === J(hi.graphicBounds), "1080 px and 6000 px photo (same aspect) → same placement");
    // whole-photo Capsule box → the existing whole-photo behaviour (no shift)
    const wb = cap.subjectFromEntry(cap.importDetection({ items: {} }, "/w.jpg", whole.detection, { fingerprint: FP }).entry, FP);
    const plain = pl.planImagePlacement({ frameBounds: frames.square, sourceSize: sources["1080x720"], policy: extend });
    const wp = pl.planImagePlacement({ frameBounds: frames.square, sourceSize: sources["1080x720"], policy: extend, subjectBounds: wb.box });
    ok(wb.wholePhoto && J(wp.graphicBounds) === J(plain.graphicBounds), "whole-photo Capsule box → placement exactly as without a box (existing rule)");
    // render.js populateDocument's rule for the red frame: usable = chosen or not whole photo
    const usable = (s) => s && s.box && (s.source === "chosen" || !s.wholePhoto) ? s.box : null;
    ok(usable(a) && !usable(wb) && !usable(none), "red-frame rule unchanged: Capsule box usable, whole-photo / missing not");

    // ---------- EXIF orientation ----------
    const exif = (le, v) => {
        const tiff = le ? [0x49, 0x49, 0x2a, 0x00, 8, 0, 0, 0, 1, 0, 0x12, 0x01, 3, 0, 1, 0, 0, 0, v, 0, 0, 0, 0, 0, 0, 0]
            : [0x4d, 0x4d, 0x00, 0x2a, 0, 0, 0, 8, 0, 1, 0x01, 0x12, 0, 3, 0, 0, 0, 1, 0, v, 0, 0, 0, 0, 0, 0];
        const body = [0x45, 0x78, 0x69, 0x66, 0, 0].concat(tiff);
        return new Uint8Array([0xff, 0xd8, 0xff, 0xe1, (body.length + 2) >> 8, (body.length + 2) & 255].concat(body, [0xff, 0xda, 0, 2]));
    };
    ok(cap.jpegExifOrientation(exif(true, 6)) === 6 && cap.jpegExifOrientation(exif(false, 8)) === 8, "EXIF orientation read (little / big endian)");
    ok(cap.jpegExifOrientation(new Uint8Array([0xff, 0xd8, 0xff, 0xda, 0, 2])) === 1 && cap.jpegExifOrientation(new Uint8Array([0x89, 0x50, 0x4e, 0x47])) === 1, "no Exif / PNG → 1");
    ok(/rotated by 90/.test(cap.orientationWarning(6)) && cap.orientationWarning(1) === "", "rotated photo → import warning");

    console.log(f ? `${f} FAILED` : "all passed");
    process.exit(f ? 1 : 0);
})();
