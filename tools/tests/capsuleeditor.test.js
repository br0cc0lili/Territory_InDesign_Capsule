// Offline regression test (Node, no InDesign). Run: node tools/tests/run.js
// capsuleeditor.js pure helpers: preview ↔ photo coordinates, drag / resize,
// typed values, preview diagrams.
const PLUGIN_JS = require("path").resolve(__dirname, "../../plugin/js");
const ed = require(PLUGIN_JS + "/capsuleeditor.js");
let f = 0;
const ok = (c, m) => { console.log((c ? "PASS " : "FAIL ") + m); if (!c) f++; };
const J = JSON.stringify;
const close = (a, b, eps) => Math.abs(a - b) <= (eps || 1e-4);

// preview size keeps the photo's aspect, for any resolution
for (const [w, h] of [[1920, 1280], [6000, 4000], [1080, 1920], [4000, 4000], [800, 200]]) {
    const s = ed.fitSize({ width: w, height: h });
    ok(s.width <= ed.EDITOR.maxWidth && s.height <= ed.EDITOR.maxHeight && Math.abs(s.width / s.height - w / h) < 0.02 &&
        (s.width === ed.EDITOR.maxWidth || s.height === ed.EDITOR.maxHeight), `${w}×${h} → preview ${s.width}×${s.height} (aspect kept, fits)`);
}
const size = ed.fitSize({ width: 6000, height: 4000 }); // 495×330
const capsuleBox = { x: 0.067434, y: 0.299543, width: 0.932566, height: 0.700457 };
// round trip box → preview pixels → box
const back = ed.previewToBox(ed.boxToPreview(capsuleBox, size), size);
ok(["x", "y", "width", "height"].every((k) => close(back[k], capsuleBox[k])), "box → preview → box round trip (Capsule example): " + J(back));
// a pixel in the preview is the same share of the original photo at any resolution
const at = ed.previewToPoint({ left: size.width * 0.25, top: size.height * 0.75 }, size);
ok(close(at.x, 0.25) && close(at.y, 0.75), "preview point (¼, ¾) → photo share (0.25, 0.75), i.e. pixel (1500, 3000) of 6000×4000");
const fp = ed.pointToPreview({ x: 0.533717, y: 0.649771 }, size);
ok(close(fp.left / size.width, 0.533717) && close(fp.top / size.height, 0.649771), "focal point → preview pixels at the same share");

// hit testing
const box = { x: 0.2, y: 0.3, width: 0.5, height: 0.4 };
const focal = { x: 0.45, y: 0.5 };
const b = ed.boxToPreview(box, size);
ok(ed.hitTest(ed.pointToPreview(focal, size), box, focal, size) === "focal", "press on the focal marker → focal");
ok(ed.hitTest({ left: b.left + 1, top: b.top + 1 }, box, focal, size) === "nw", "press on the top-left corner → resize nw");
ok(ed.hitTest({ left: b.left + b.width - 2, top: b.top + b.height + 2 }, box, focal, size) === "se", "press on the bottom-right corner → resize se");
ok(ed.hitTest({ left: b.left + b.width * 0.2, top: b.top + b.height * 0.8 }, box, focal, size) === "move", "press inside the box → move");
ok(ed.hitTest({ left: 2, top: 2 }, box, focal, size) === null, "press outside → nothing");

// dragging
const mv = ed.dragBox(box, "move", 0.1, -0.05);
ok(J(mv) === J({ x: 0.3, y: 0.25, width: 0.5, height: 0.4 }), "move keeps the size");
const mvEdge = ed.dragBox(box, "move", 0.9, 0.9);
ok(close(mvEdge.x + mvEdge.width, 1) && close(mvEdge.y + mvEdge.height, 1) && mvEdge.width === 0.5, "move stops at the photo edge (box can touch it, never leave it)");
const se = ed.dragBox(box, "se", 0.1, 0.1);
ok(J(se) === J({ x: 0.2, y: 0.3, width: 0.6, height: 0.5 }), "resize se: the top-left corner stays");
const nw = ed.dragBox(box, "nw", -0.5, -0.5);
ok(nw.x === 0 && nw.y === 0 && close(nw.x + nw.width, 0.7) && close(nw.y + nw.height, 0.7), "resize nw beyond the photo → clamped at 0, opposite corner stays");
const tiny = ed.dragBox(box, "ne", -0.9, 0.9);
ok(tiny.width >= ed.EDITOR.minShare - 1e-9 && tiny.height >= ed.EDITOR.minShare - 1e-9 && close(tiny.x, 0.2), "resize past the opposite corner → minimum size, no flip");
const edge = ed.dragBox(box, "se", 1, 1);
ok(close(edge.x + edge.width, 1) && close(edge.y + edge.height, 1), "resize to the photo edge → a box touching the edge (cropped subject) is possible");
ok(J(ed.dragPoint(focal, 0.9, -0.9)) === J({ x: 1, y: 0 }), "focal point drag clamped to the photo");

// typed values
ok(ed.parseShare("0.25") === 0.25 && ed.parseShare("0,5") === 0.5 && ed.parseShare(".1") === 0.1 && ed.parseShare("1") === 1, "typed numbers (also decimal comma)");
ok([ "1.2", "-0.1", "abc", "", "0.2px", "NaN"].every((t) => isNaN(ed.parseShare(t))), "invalid / out-of-range typed values rejected");
const good = ed.valuesFromFields({ x: "0.1", y: "0.2", width: "0.5", height: "0.6", fx: "0.4", fy: "0.5" });
ok(good.values && J(good.values.boundingBox) === J({ x: 0.1, y: 0.2, width: 0.5, height: 0.6 }) && J(good.values.focalPoint) === J({ x: 0.4, y: 0.5 }), "valid fields → values");
const over = ed.valuesFromFields({ x: "0.6", y: "0.2", width: "0.5", height: "0.6", fx: "0.4", fy: "0.5" });
ok(!over.values && over.errors.some((e) => /x \+ width/.test(e)), "x + width > 1 → refused");
const zero = ed.valuesFromFields({ x: "0.1", y: "0.2", width: "0", height: "0.6", fx: "0.4", fy: "0.5" });
ok(!zero.values && zero.errors.some((e) => /at least/.test(e)), "zero width → refused");

// preview diagrams
const T = ed.diagramTransform([0, 0, 600, 800], [[-9, -9, 609, 809]], 150);
ok(T.size.width <= 150 && T.size.height <= 150 && T.size.width === 150, "diagram fits 150px (bleed frame included)");
const pr = T.rect([0, 0, 600, 800]);
ok(close(pr.left, 9 * T.scale, 1e-6) && close(pr.width, 800 * T.scale, 1e-6), "page drawn inside the bleed view");
ok(ed.previewSummary({ layout: { size: "1200x1200", position: "up" }, kind: "extend", stats: { frameFill: 0.78, zoom: 1.6 } }) === "1200x1200 up · fills 78% of the frame · ×1.6", "summary: existing frame fill + zoom");
ok(/Content-Aware Fit/.test(ed.previewSummary({ layout: { size: "1080x1920", position: "up" }, kind: "fill", stats: {} })), "summary: Fill layout");

// imported values (6 decimals) shown in the fields and read back → unchanged (no false "adjusted")
const imp = { x: 0.067434, y: 0.299543, width: 0.932566, height: 0.700457 };
const rt = ed.valuesFromFields({ x: String(imp.x), y: String(imp.y), width: String(imp.width), height: String(imp.height), fx: "0.533717", fy: "0.649771" });
ok(J(rt.values.boundingBox) === J(imp), "imported values shown + read back unchanged (no false 'adjusted' edit)");

// ---------- the window itself, on a minimal fake DOM (UXP isn't available offline) ----------
function fakeDom() {
    const all = [];
    const mk = (tag) => {
        const n = { tagName: tag, children: [], style: {}, attrs: {}, listeners: {}, className: "", textContent: "", value: "", disabled: false,
            classList: { add(c) { n.className += " " + c; }, remove() {} },
            appendChild(c) { n.children.push(c); c.parent = n; if (c.tagName === "option" && (c.attrs.selected || n.value === "")) n.value = c.attrs.value; return c; },
            setAttribute(k, v) { n.attrs[k] = v; if (k === "selected") n.parent && (n.parent.value = n.attrs.value); },
            addEventListener(t, fn) { (n.listeners[t] = n.listeners[t] || []).push(fn); },
            fire(t, ev) { for (const fn of n.listeners[t] || []) fn(ev || {}); },
            getBoundingClientRect() { return { left: 100, top: 50 }; },
            remove() {}, set innerHTML(v) { n.children = []; }, get innerHTML() { return ""; },
            close() { n.fire("close"); }, showModal() {} };
        all.push(n);
        return n;
    };
    return { all, document: { createElement: mk, body: mk("body") } };
}
(async () => {
    const dom = fakeDom();
    global.document = dom.document;
    global.window = {};
    const timers = [];
    const realSetTimeout = setTimeout;
    const auto = { boundingBox: { x: 0.067434, y: 0.299543, width: 0.932566, height: 0.700457 }, focalPoint: { x: 0.533717, y: 0.649771 } };
    let previewCalls = 0, lastPreviewValues = null;
    const preview = (v) => { previewCalls++; lastPreviewValues = v; return [
        { layoutId: "service/1200x1200/up", layout: { size: "1200x1200", position: "up" }, kind: "extend", pageBounds: [0, 0, 1200, 1200], frameBounds: [0, 0, 1200, 1200],
            graphicBounds: [0, -100, 1100, 1400], subjectRect: [300, 0, 1100, 1300], focal: { x: 600, y: 700 }, avoid: [[900, 60, 1140, 1140]], zone: null, stats: { frameFill: 0.78, zoom: 1.2 }, warnings: [], notes: [] },
        { layoutId: "service/1080x1920/up", layout: { size: "1080x1920", position: "up" }, kind: "fill", pageBounds: [0, 0, 1920, 1080], frameBounds: [0, 0, 1920, 1080],
            graphicBounds: null, subjectRect: null, avoid: [], zone: null, stats: {}, warnings: [], notes: ["Fill layout"] }]; };
    const opts = { title: "t", imagePath: "/nope.jpg", pixelSize: { width: 6000, height: 4000 }, auto, current: auto, info: ["Imported car_01.json"],
        layouts: [{ layoutId: "service/1200x1200/up", label: "1200x1200 up" }, { layoutId: "service/1080x1920/up", label: "1080x1920 up" }],
        currentLayoutId: "service/1080x1920/up", preview };
    const find = (cls) => dom.all.find((n) => (" " + n.className + " ").indexOf(" " + cls + " ") !== -1);
    const button = (label) => dom.all.find((n) => n.tagName === "button" && n.textContent === label);
    const open = ed.showCapsuleEditor(opts);
    await new Promise((r) => realSetTimeout(r, 20));
    const stage = find("capsule-stage");
    ok(!!stage && stage.style.width === "495px" && stage.style.height === "330px", "window: photo stage 495×330 for a 6000×4000 photo");
    const fields = dom.all.filter((n) => n.className === "capsule-input");
    ok(fields.length === 6 && fields[0].value === "0.067434" && fields[4].value === "0.533717", "window: fields show the imported values");
    // drag the box 10% of the preview width to the left (press inside, move, release)
    const inside = { clientX: 100 + 495 * 0.5, clientY: 50 + 330 * 0.5 };
    stage.fire("mousedown", Object.assign({ preventDefault() {} }, inside));
    stage.fire("mousemove", { clientX: inside.clientX - 49.5, clientY: inside.clientY });
    stage.fire("mouseup", {});
    ok(fields[0].value === "0" && fields[2].value === "0.932566" && fields[1].value === "0.299543", "drag left past the edge → box x clamped to 0, size kept: x " + fields[0].value);
    // type a focal point
    fields[4].value = "0.4"; fields[4].fire("input"); fields[4].fire("change");
    button("Preview Placement").fire("click");
    ok(previewCalls === 1 && lastPreviewValues.focalPoint.x === 0.4 && lastPreviewValues.boundingBox.x === 0, "Preview Placement → preview(edited values)");
    ok(dom.all.filter((n) => /capsule-cell( |$)/.test(n.className.trim()) || n.className.indexOf("capsule-cell ") === 0).length >= 2, "one diagram per layout");
    ok(!!dom.all.find((n) => n.className.indexOf("capsule-cell-current") !== -1), "current layout highlighted");
    // invalid typed value blocks Apply
    fields[2].value = "1.5"; fields[2].fire("input");
    button("Apply to All Relevant Layouts").fire("click");
    ok(/not applied/.test(find("capsule-error").textContent), "invalid width → message, window stays open");
    fields[2].value = "0.8"; fields[2].fire("input");
    button("Reset to Auto").fire("click");
    ok(fields[0].value === "0.067434" && fields[4].value === "0.533717", "Reset to Auto → imported values again");
    fields[5].value = "0.6"; fields[5].fire("input"); // typed, not confirmed
    button("Apply to Current Layout").fire("click");
    const res = await open;
    ok(res && res.action === "apply_layout" && res.layoutId === "service/1080x1920/up" && res.values.focalPoint.y === 0.6 &&
        J(res.values.boundingBox) === J(auto.boundingBox), "Apply to Current Layout → { action, layoutId, values } with the unconfirmed typed value");
    // Cancel
    const dom2 = fakeDom(); global.document = dom2.document;
    const p2 = ed.showCapsuleEditor(opts);
    await new Promise((r) => realSetTimeout(r, 20));
    dom2.all.find((n) => n.tagName === "button" && n.textContent === "Cancel").fire("click");
    ok((await p2) === null, "Cancel → null (nothing saved)");
    console.log(f ? `${f} FAILED` : "all passed");
    process.exit(f ? 1 : 0);
})();
