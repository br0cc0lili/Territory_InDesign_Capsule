// Offline regression test (Node, no InDesign). Run: node tools/tests/run.js
// Red subject frame: recognition (subjectzone.js) and placement inside it
// (placement.js planZonePlacement).
const PLUGIN_JS = require("path").resolve(__dirname, "../../plugin/js");
const Module = require("module"); const o = Module._load;
Module._load = function (r) { return r === "indesign" ? { ColorSpace: { RGB: "RGB_ENUM", CMYK: "CMYK_ENUM", LAB: "LAB_ENUM" } } : o.apply(this, arguments); };
const z = require(PLUGIN_JS + "/subjectzone.js");
const pl = require(PLUGIN_JS + "/placement.js");
let f = 0; const ok = (c, m) => { console.log((c ? "PASS " : "FAIL ") + m); if (!c) f++; };
const near = (a, b, t) => Math.abs(a - b) <= (t || 0.01);

// ---- names / layers / colours ----
for (const n of ["subject", "Subject Zone", "<<SubjectZone>>", "subject-frame", "SUBJECT_BOX", "bounding box", "BBox", "<<subject>>"]) ok(z.isZoneName(n), `zone name "${n}"`);
for (const n of ["<<MainImage>>", "subjects", "my subject frame", "Image", ""]) ok(!z.isZoneName(n), `not a zone name "${n}"`);
ok(z.isZoneLayerName("subject") && z.isZoneLayerName("Bounding Box") && !z.isZoneLayerName("Image") && !z.isZoneLayerName("shadow"), "zone layer names");
ok(z.isRedColor({ space: "RGB", values: [255, 0, 0] }) && z.isRedColor({ space: "RGB", values: [218, 37, 29] }), "RGB red");
ok(!z.isRedColor({ space: "RGB", values: [255, 140, 0] }) && !z.isRedColor({ space: "RGB", values: [255, 0, 255] }) && !z.isRedColor({ space: "RGB", values: [120, 20, 20] }), "orange / magenta / dark brown are not red");
ok(z.isRedColor({ space: "CMYK", values: [0, 100, 100, 0] }) && !z.isRedColor({ space: "CMYK", values: [0, 0, 0, 100] }), "CMYK red, not black");
ok(z.isRedColor({ space: "LAB", values: [54, 80, 67] }), "LAB red");
ok(!z.isRedColor({ name: "None" }) && z.isRedColor({ name: "Audi Red" }), "swatch names");

// ---- DOM recognition with mock page items ----
const coll = (arr) => ({ get length() { return arr.length; }, item: (i) => arr[i] });
function item(type, props) {
    const it = Object.assign({ geometricBounds: [0, 0, 10, 10], strokeWeight: 0, allGraphics: coll([]), removed: false,
        remove() { this.removed = true; } }, props);
    it.constructor = { name: type };
    return it;
}
const imageLayer = { name: "Image" }, subjectLayer = { name: "subject" }, textLayer = { name: "text" };
const red = { space: "RGB_ENUM", colorValue: [230, 20, 20], name: "" };
const photoFrame = item("Rectangle", { name: "<<MainImage>>", itemLayer: imageLayer, geometricBounds: [0, 0, 1200, 1200], allGraphics: coll([{}]) });
const redOnImage = item("Rectangle", { name: "", itemLayer: imageLayer, geometricBounds: [400, 100, 1100, 1100], strokeWeight: 6, strokeColor: red });
const redWithPhoto = item("Rectangle", { name: "", itemLayer: imageLayer, strokeWeight: 6, strokeColor: red, allGraphics: coll([{}]) });
const blueOnImage = item("Rectangle", { name: "", itemLayer: imageLayer, strokeWeight: 6, strokeColor: { space: "RGB_ENUM", colorValue: [0, 0, 255] } });
const onSubjectLayer = item("Oval", { name: "", itemLayer: subjectLayer, geometricBounds: [300, 300, 900, 900] });
const named = item("Rectangle", { name: "<<SubjectZone>>", itemLayer: textLayer, geometricBounds: [100, 100, 500, 500] });
const textOnSubjectLayer = item("TextFrame", { name: "", itemLayer: subjectLayer });
const tintRed = item("Rectangle", { name: "", itemLayer: imageLayer, strokeWeight: 2, strokeColor: { baseColor: red, tintValue: 80 } });
ok(z.zoneReason(redOnImage) === "red frame", "red empty frame on the Image layer → zone");
ok(z.zoneReason(photoFrame) === "" && z.zoneReason(redWithPhoto) === "" && z.zoneReason(blueOnImage) === "", "photo frame / red frame with a photo / blue frame → not a zone");
ok(z.zoneReason(onSubjectLayer) === "layer" && z.zoneReason(named) === "name", "any item on layer \"subject\" / named <<SubjectZone>>");
ok(z.zoneReason(textOnSubjectLayer) === "", "text frames are never zones");
ok(z.zoneReason(tintRed) === "red frame", "a tint of red counts");
// a page whose ONLY Image-layer frame is red-stroked keeps it as its photo frame
const onlyRed = item("Rectangle", { id: 50, name: "", itemLayer: imageLayer, strokeWeight: 4, strokeColor: red });
onlyRed.parentPage = { allPageItems: coll([onlyRed]) };
ok(z.zoneReason(onlyRed) === "", "the only (red-stroked, empty) frame on the Image layer stays the photo frame");
const redNext = item("Rectangle", { id: 51, name: "", itemLayer: imageLayer, strokeWeight: 4, strokeColor: red });
const plainFrame = item("Rectangle", { id: 52, name: "", itemLayer: imageLayer });
redNext.parentPage = { allPageItems: coll([plainFrame, redNext]) };
ok(z.zoneReason(redNext) === "red frame", "red frame next to the photo frame → zone");
// a group on the subject layer counts once (its children are part of it)
const grp = item("Group", { id: 60, name: "", itemLayer: subjectLayer, geometricBounds: [10, 10, 50, 50] });
const child = item("Rectangle", { id: 61, name: "", itemLayer: subjectLayer, parent: grp });
const placedImg = item("Image", { id: 62, name: "", itemLayer: subjectLayer });
ok(z.findSubjectZones({ allPageItems: coll([grp, child, placedImg]) }).length === 1, "group counted once; placed images never count");
const page = { allPageItems: coll([photoFrame, redOnImage, named]), masterPageItems: coll([onSubjectLayer]) };
const zones = z.findSubjectZones(page);
ok(zones.length === 3 && zones.filter((x) => x.onParent).length === 1, "own + parent-page zones found");
const pick = z.zoneForPage(page);
ok(pick && pick.count === 3 && JSON.stringify(pick.bounds) === "[400,100,1100,1100]", "largest zone is used");
// removal: own items removed, parent item overridden first
let overridden = 0;
onSubjectLayer.override = () => { overridden++; return item("Oval", { name: "copy" }); };
const layers = [{ name: "subject", visible: true, printable: true }, { name: "Image", visible: true, printable: true }];
const doc = { pages: coll([page]), layers: coll(layers) };
const r = z.removeSubjectZones(doc);
ok(r.removed === 3 && redOnImage.removed && named.removed && overridden === 1 && !photoFrame.removed, "zones removed from the product INDD, photo frame kept");
ok(layers[0].visible === false && layers[0].printable === false && layers[1].visible === true, "zone layer hidden + non-printing, Image layer untouched");

// ---- placement inside the zone ----
const frame = [0, 0, 1200, 1200];
const zone = [450, 150, 1050, 1050];             // lower part (text on top)
const extend = { id: "e", placementMode: "extend", anchor: { vertical: "top", horizontal: "center" } };
const fill = { id: "f", placementMode: "fill" };
const src = { width: 1416, height: 1062 };
const box = { x: 0.2175, y: 0.418, width: 0.4435, height: 0.3249 }; // a car in the middle-low part
const p = pl.planZonePlacement({ frameBounds: frame, zoneBounds: zone, sourceSize: src, subjectBounds: box, policy: extend });
const [sy0, sx0, sy1, sx1] = p.subjectRect;
ok(sy0 >= 450 - 0.5 && sx0 >= 150 - 0.5 && sy1 <= 1050 + 0.5 && sx1 <= 1050 + 0.5, `subject inside the red frame (${p.subjectRect.join(",")})`);
ok(near((sx0 + sx1) / 2, 600, 1) && near((sy0 + sy1) / 2, 750, 1), "subject centred in the red frame");
ok(near(sx1 - sx0, 900 * 0.94, 1) || near(sy1 - sy0, 600 * 0.94, 1), "subject as large as fits (3% margin)");
ok(p.graphicBounds[0] <= 0.01 && p.graphicBounds[1] <= 0.01 && p.graphicBounds[2] >= 1199.99 && p.graphicBounds[3] >= 1199.99 && !p.gaps.x && !p.gaps.y, "photo covers the frame");
// whole-photo box in extend mode: photo shrinks into the zone → gap, extension may fill
const whole = pl.planZonePlacement({ frameBounds: frame, zoneBounds: zone, sourceSize: src, subjectBounds: { x: 0, y: 0, width: 1, height: 1 }, policy: extend });
ok(whole.gaps.y && whole.mode === "extend" && whole.notes.some((n) => /Image Extension/.test(n)), "small subject-fit photo leaves a gap in extend layouts (Image Extension)");
// fill layout: always covers, warns when the subject can't fit
const pf = pl.planZonePlacement({ frameBounds: [0, 0, 1920, 1080], zoneBounds: [1000, 100, 1500, 980], sourceSize: src, subjectBounds: { x: 0.1, y: 0.1, width: 0.8, height: 0.8 }, policy: fill });
ok(pf.mode === "fill" && pf.graphicBounds[0] <= 0.01 && pf.graphicBounds[1] <= 0.01 && pf.graphicBounds[2] >= 1919.99 && pf.graphicBounds[3] >= 1079.99, "fill layout: photo always covers the frame");
ok(pf.warnings.length > 0, "fill layout: warning when the subject is bigger than the red frame");
// chosen small object (e.g. the person on the left) moves into the zone
const person = pl.planZonePlacement({ frameBounds: frame, zoneBounds: zone, sourceSize: src, subjectBounds: { x: 0.05, y: 0.3, width: 0.15, height: 0.6 }, policy: extend });
ok(person.subjectRect[1] >= 150 - 0.5 && person.subjectRect[3] <= 1050 + 0.5 && person.subjectRect[0] >= 450 - 0.5 && person.subjectRect[2] <= 1050 + 0.5, "a chosen object at the photo's edge still ends up inside the red frame");
// resolution cap: a tiny chosen box can't blow the photo up 18x
const tiny = pl.planZonePlacement({ frameBounds: frame, zoneBounds: frame, sourceSize: { width: 3000, height: 2000 }, subjectBounds: { x: 0.5, y: 0.5, width: 0.05, height: 0.05 }, policy: extend, maxScale: 0.8 });
const containS = 1200 / 3000;
ok(near((tiny.graphicBounds[3] - tiny.graphicBounds[1]) / 3000, 0.8, 1e-6) && tiny.warnings.some((w) => /resolution/.test(w)), "enlargement capped at the photo's resolution, with a warning");
const lowRes = pl.planZonePlacement({ frameBounds: frame, zoneBounds: frame, sourceSize: { width: 3000, height: 2000 }, subjectBounds: { x: 0.5, y: 0.5, width: 0.05, height: 0.05 }, policy: extend, maxScale: 0.1 });
ok(near((lowRes.graphicBounds[3] - lowRes.graphicBounds[1]) / 3000, containS, 1e-6), "cap never goes below the normal contain-fit size");
// subject that just fits (inside the 3% margin but not the frame) → no false "bigger" warning
const fits = pl.planZonePlacement({ frameBounds: [0, 0, 1000, 1000], zoneBounds: [0, 0, 1000, 1000], sourceSize: { width: 1000, height: 1000 }, subjectBounds: { x: 0, y: 0.01, width: 1, height: 0.98 }, policy: fill });
ok(!fits.warnings.some((w) => /bigger/.test(w)), "no false 'bigger than the red frame' warning");
// zone partly outside the image frame → clipped; zone outside → null; bad box → null
const clipped = pl.planZonePlacement({ frameBounds: frame, zoneBounds: [1000, 100, 1500, 1100], sourceSize: src, subjectBounds: box, policy: extend });
ok(clipped.zoneRect[2] === 1200, "zone clipped to the image frame");
ok(pl.planZonePlacement({ frameBounds: frame, zoneBounds: [1300, 0, 1400, 100], sourceSize: src, subjectBounds: box, policy: extend }) === null, "zone outside the image frame → normal placement");
ok(pl.planZonePlacement({ frameBounds: frame, zoneBounds: zone, sourceSize: src, subjectBounds: { x: 0.9, y: 0, width: 0.5, height: 0.5 }, policy: extend }) === null, "invalid box → normal placement");
// ---- default subject frame (Custom Subject Frames) ----
const dz = pl.defaultSubjectZone([0, 0, 1200, 1200], [0, 0, 1200, 1200], [[60, 60, 360, 1140]]);
ok(dz[0] > 360 && dz[2] < 1200 && dz[1] > 0 && dz[3] < 1200, `default frame below the headline, inside the frame (${dz.join(",")})`);
ok(Math.abs(dz[0] - (360 + 840 * 0.05)) < 0.01 && Math.abs(dz[1] - 60) < 0.01, "5% margin inside the free band");
const dzBleed = pl.defaultSubjectZone([-10, -10, 1210, 1210], [0, 0, 1200, 1200], []);
ok(dzBleed[0] >= 0 && dzBleed[1] >= 0 && dzBleed[2] <= 1200 && dzBleed[3] <= 1200, "default frame clipped to the page (image frame with bleed)");
const dzLow = pl.defaultSubjectZone([0, 0, 1200, 1200], [0, 0, 1200, 1200], [[800, 60, 1100, 1140]]);
ok(dzLow[2] < 800 && dzLow[0] >= 0, "headline at the bottom → default frame above it");
// drawing a default frame: layer + colour + rectangle props
const made = [];
const zpage = { rectangles: { add: (p) => { const r = Object.assign({}, p); made.push(r); return r; } } };
const zlayers = [];
const zdoc = { layers: { get length() { return zlayers.length; }, item: (i) => zlayers[i], add: (p) => { const l = Object.assign({ locked: true, visible: false }, p); zlayers.push(l); return l; } },
    colors: { itemByName: () => ({ isValid: false }), add: (p) => Object.assign({ isValid: true }, p) }, swatches: { itemByName: () => ({ isValid: true, name: "None" }) } };
const zl = z.ensureZoneLayer(zdoc);
ok(zl.name === "subject" && zl.locked === false && zl.visible === true && z.ensureZoneLayer(zdoc) === zl, "subject layer created once, unlocked and visible");
const zc = z.zoneColour(zdoc);
const rect = z.addZoneFrame(zpage, [100, 100, 500, 500], zl, zc, { name: "None" });
ok(rect.name === "<<SubjectZone>>" && rect.itemLayer === zl && rect.nonprinting === true && rect.strokeColor === zc && z.isZoneName(rect.name), "default frame: named <<SubjectZone>>, on layer subject, non-printing, red stroke");
console.log(f ? f + " FAILED" : "all passed");
