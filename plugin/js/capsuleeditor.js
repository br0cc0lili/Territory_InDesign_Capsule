// capsuleeditor.js — the "Edit Subject Placement" window (Capsule mode).
//
// Shows the ORIGINAL product photo with
//   • the imported Capsule bounding box (dashed) and focal point (hollow)
//   • the box / focal point being edited (solid box with corner handles,
//     filled marker) — drag to move, drag a corner to resize, drag the marker
//   • exact values as numbers (0..1 shares of the photo), as a fallback to dragging
// and, on Preview Placement, one small diagram per layout made by the
// EXISTING placement (render.js previewPlacementForPage → placement.js):
// page, image frame, text areas, red subject frame, the placed photo and the
// subject. Nothing here changes an InDesign document — the panel saves the
// edit and regenerates (index.js).
//
// showCapsuleEditor(options) resolves with
//   { action: "apply_layout" | "apply_all", layoutId, values: { boundingBox, focalPoint } }
// or null (Cancel / Esc).
//
// Coordinates: the photo is shown scaled to fit maxWidth × maxHeight with its
// aspect kept; shares (0..1) map to preview pixels by × preview size — the
// same top-left convention as Capsule and the subject box.

/* global require, document, window */

const EDITOR = {
    maxWidth: 500,
    maxHeight: 330,
    windowWidth: 560,
    handlePx: 7,        // corner handle half-size for hit-testing
    focalPx: 7,         // focal marker radius for hit-testing
    minShare: 0.01,     // smallest box side (share of the photo)
    diagram: 150,       // preview diagram box (px)
};

// ---------- pure helpers (tested offline) ----------

const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));
const r6 = (v) => Math.round(v * 1e6) / 1e6; // the import's precision (capsule.js)

// Preview size that fits maxWidth × maxHeight with the photo's aspect.
function fitSize(pixelSize, maxWidth, maxHeight) {
    const w = pixelSize && pixelSize.width > 0 ? pixelSize.width : 4;
    const h = pixelSize && pixelSize.height > 0 ? pixelSize.height : 3;
    const s = Math.min((maxWidth || EDITOR.maxWidth) / w, (maxHeight || EDITOR.maxHeight) / h);
    return { width: Math.round(w * s), height: Math.round(h * s) };
}

// share box → preview pixels { left, top, width, height } (unrounded)
function boxToPreview(box, size) {
    return { left: box.x * size.width, top: box.y * size.height, width: box.width * size.width, height: box.height * size.height };
}

// preview pixels → share box (clamped to the photo)
function previewToBox(rect, size) {
    const x = clamp(rect.left / size.width, 0, 1), y = clamp(rect.top / size.height, 0, 1);
    return { x: r6(x), y: r6(y), width: r6(clamp(rect.width / size.width, 0, 1 - x)), height: r6(clamp(rect.height / size.height, 0, 1 - y)) };
}

function pointToPreview(p, size) { return { left: p.x * size.width, top: p.y * size.height }; }
function previewToPoint(px, size) { return { x: r6(clamp(px.left / size.width, 0, 1)), y: r6(clamp(px.top / size.height, 0, 1)) }; }

// What a press at preview point pt grabs: "focal" | "nw" | "ne" | "sw" | "se" | "move" | null.
function hitTest(pt, box, focal, size) {
    if (focal) {
        const f = pointToPreview(focal, size);
        if (Math.hypot(pt.left - f.left, pt.top - f.top) <= EDITOR.focalPx + 2) return "focal";
    }
    if (!box) return null;
    const b = boxToPreview(box, size), h = EDITOR.handlePx;
    const corners = { nw: [b.left, b.top], ne: [b.left + b.width, b.top], sw: [b.left, b.top + b.height], se: [b.left + b.width, b.top + b.height] };
    for (const [k, [x, y]] of Object.entries(corners)) if (Math.abs(pt.left - x) <= h && Math.abs(pt.top - y) <= h) return k;
    if (pt.left >= b.left && pt.left <= b.left + b.width && pt.top >= b.top && pt.top <= b.top + b.height) return "move";
    return null;
}

// The box after dragging by (dx, dy) shares from the start box.
//   mode "move": keeps the size, stays inside the photo
//   mode "nw"/"ne"/"sw"/"se": that corner follows, the opposite one stays;
//   never smaller than minShare, never outside the photo
function dragBox(start, mode, dx, dy) {
    const m = EDITOR.minShare;
    if (mode === "move") {
        return { x: r6(clamp(start.x + dx, 0, 1 - start.width)), y: r6(clamp(start.y + dy, 0, 1 - start.height)), width: start.width, height: start.height };
    }
    let x0 = start.x, y0 = start.y, x1 = start.x + start.width, y1 = start.y + start.height;
    if (mode === "nw" || mode === "sw") x0 = clamp(x0 + dx, 0, x1 - m); else x1 = clamp(x1 + dx, x0 + m, 1);
    if (mode === "nw" || mode === "ne") y0 = clamp(y0 + dy, 0, y1 - m); else y1 = clamp(y1 + dy, y0 + m, 1);
    return { x: r6(x0), y: r6(y0), width: r6(x1 - x0), height: r6(y1 - y0) };
}

function dragPoint(start, dx, dy) {
    return { x: r6(clamp(start.x + dx, 0, 1)), y: r6(clamp(start.y + dy, 0, 1)) };
}

// A typed value: a number in 0..1, else NaN.
function parseShare(text) {
    const s = String(text == null ? "" : text).trim().replace(",", ".");
    if (!/^[+-]?(\d+\.?\d*|\.\d+)$/.test(s)) return NaN;
    const v = Number(s);
    return v >= 0 && v <= 1 ? v : NaN;
}

// The six fields → { values, errors }. The box must stay inside the photo.
function valuesFromFields(f) {
    const errors = [];
    const n = {};
    for (const k of ["x", "y", "width", "height", "fx", "fy"]) {
        n[k] = parseShare(f[k]);
        if (isNaN(n[k])) errors.push(`${k} must be a number from 0 to 1`);
    }
    if (!errors.length) {
        if (n.width < EDITOR.minShare || n.height < EDITOR.minShare) errors.push(`width and height must be at least ${EDITOR.minShare}`);
        if (n.x + n.width > 1.0001) errors.push("x + width must not exceed 1");
        if (n.y + n.height > 1.0001) errors.push("y + height must not exceed 1");
    }
    if (errors.length) return { values: null, errors };
    return { values: { boundingBox: { x: r6(n.x), y: r6(n.y), width: r6(Math.min(n.width, 1 - n.x)), height: r6(Math.min(n.height, 1 - n.y)) }, focalPoint: { x: r6(n.fx), y: r6(n.fy) } }, errors };
}

// Page geometry [top, left, bottom, right] → diagram pixels inside a box
// of maxPx: { scale, size: { width, height }, rect(bounds) → { left, top, width, height } }.
// The view spans the page plus anything sticking out of it (bleed frames).
function diagramTransform(pageBounds, extraBounds, maxPx) {
    const all = [pageBounds].concat((extraBounds || []).filter(Boolean));
    const t = Math.min(...all.map((b) => b[0])), l = Math.min(...all.map((b) => b[1]));
    const b = Math.max(...all.map((x) => x[2])), r = Math.max(...all.map((x) => x[3]));
    const scale = Math.min(maxPx / (r - l), maxPx / (b - t));
    return {
        scale,
        size: { width: Math.round((r - l) * scale), height: Math.round((b - t) * scale) },
        rect: (bb) => ({ left: (bb[1] - l) * scale, top: (bb[0] - t) * scale, width: (bb[3] - bb[1]) * scale, height: (bb[2] - bb[0]) * scale }),
    };
}

// One line for a preview diagram (existing placement numbers).
function previewSummary(pv) {
    const head = `${pv.layout.size} ${pv.layout.position}`;
    if (pv.kind === "fill") return `${head} · Fill (Content-Aware Fit)`;
    if (pv.kind === "zone") return `${head} · red frame · scale ×${pv.stats.scale}`;
    const s = pv.stats || {};
    return s.frameFill != null ? `${head} · fills ${Math.round(s.frameFill * 100)}% of the frame` + (s.zoom > 1 ? ` · ×${s.zoom}` : "") : `${head} · default placement`;
}

// ---------- window ----------

function el(tag, cls, text) {
    const n = document.createElement(tag);
    if (cls) n.className = cls;
    if (text != null) n.textContent = text;
    return n;
}

function px(node, r) {
    node.style.left = Math.round(r.left) + "px";
    node.style.top = Math.round(r.top) + "px";
    if (r.width != null) node.style.width = Math.max(1, Math.round(r.width)) + "px";
    if (r.height != null) node.style.height = Math.max(1, Math.round(r.height)) + "px";
}

async function photoUrl(imagePath) {
    let picker = null;
    for (const p of ["./subjectpicker.js", "./js/subjectpicker.js"]) {
        try { picker = require(p); if (picker && picker.photoDataUrl) break; } catch (e) {}
    }
    if (!picker || !picker.photoDataUrl) return { url: "", reason: "photo preview unavailable" };
    return picker.photoDataUrl(imagePath);
}

//   options: {
//     title, imagePath, pixelSize,
//     auto:    { boundingBox, focalPoint }   imported Capsule values
//     current: { boundingBox, focalPoint }   values to start from (edits in force)
//     info:    [lines]                       file, status, notes
//     layouts: [{ layoutId, label }]         the product's layouts
//     currentLayoutId,
//     preview(values) → [previewPlacementForPage results, one per layout] (sync)
//     previewNote: "" (e.g. text areas from the template)
//   }
async function showCapsuleEditor(options) {
    const auto = options.auto;
    let box = Object.assign({}, (options.current || auto).boundingBox);
    let focal = Object.assign({}, (options.current || auto).focalPoint);
    let photo = { url: "" };
    try { photo = await photoUrl(options.imagePath); } catch (e) {}
    const size = fitSize(options.pixelSize || photo.size);

    const dlg = el("dialog", "picker-dialog capsule-dialog");
    const form = el("form", "picker-body");
    form.setAttribute("method", "dialog");
    dlg.appendChild(form);
    for (const line of options.info || []) form.appendChild(el("div", "picker-hint", line));

    // photo + overlays
    const stage = el("div", "picker-stage capsule-stage");
    stage.style.width = size.width + "px";
    stage.style.height = size.height + "px";
    if (photo.url) {
        const img = el("img", "picker-photo");
        img.style.width = size.width + "px";
        img.style.height = size.height + "px";
        img.setAttribute("src", photo.url);
        img.addEventListener("error", () => { img.style.display = "none"; stage.classList.add("picker-stage-empty"); });
        stage.appendChild(img);
    } else {
        stage.classList.add("picker-stage-empty");
        stage.appendChild(el("div", "picker-noimage", photo.reason || "no photo preview — the boxes are to scale"));
    }
    const autoBox = el("div", "capsule-auto-box");
    const autoFocal = el("div", "capsule-auto-focal");
    const editBox = el("div", "capsule-edit-box");
    const handles = {};
    for (const k of ["nw", "ne", "sw", "se"]) { handles[k] = el("div", "capsule-handle"); editBox.appendChild(handles[k]); }
    const editFocal = el("div", "capsule-edit-focal");
    for (const n of [autoBox, autoFocal, editBox, editFocal]) stage.appendChild(n);
    form.appendChild(stage);
    const legend = el("div", "capsule-legend", "Dashed: imported from Capsule · Solid: used for placement — drag the box, its corners or the focal point. The focal point is stored but does not move the placement.");
    form.appendChild(legend);

    // numbers
    const fieldsRow = el("div", "capsule-fields");
    const fields = {};
    let fieldsDirty = false; // typed but not yet confirmed (Enter / Tab)
    const fieldDefs = [["x", "Box x"], ["y", "Box y"], ["width", "Width"], ["height", "Height"], ["fx", "Focal x"], ["fy", "Focal y"]];
    for (const [k, label] of fieldDefs) {
        const wrap = el("label", "capsule-field");
        wrap.appendChild(el("span", "capsule-field-label", label));
        const input = document.createElement("input");
        input.setAttribute("type", "text");
        input.className = "capsule-input";
        input.addEventListener("input", () => { fieldsDirty = true; });
        input.addEventListener("change", fromFields);
        wrap.appendChild(input);
        fieldsRow.appendChild(wrap);
        fields[k] = input;
    }
    form.appendChild(fieldsRow);
    const fieldError = el("div", "capsule-error");
    form.appendChild(fieldError);
    const state = el("div", "picker-summary");
    form.appendChild(state);

    // layout picker (target of "Apply to Current Layout")
    const layoutRow = el("div", "capsule-layout-row");
    layoutRow.appendChild(el("span", "capsule-field-label", "Current layout: "));
    const layoutSelect = document.createElement("select");
    layoutSelect.className = "capsule-select";
    for (const l of options.layouts || []) {
        const opt = document.createElement("option");
        opt.setAttribute("value", l.layoutId);
        opt.textContent = l.label;
        if (l.layoutId === options.currentLayoutId) opt.setAttribute("selected", "selected");
        layoutSelect.appendChild(opt);
    }
    layoutRow.appendChild(layoutSelect);
    try { if (options.currentLayoutId) layoutSelect.value = options.currentLayoutId; } catch (e) {}
    form.appendChild(layoutRow);

    const previewBox = el("div", "capsule-previews");
    form.appendChild(previewBox);

    const buttons = el("div", "picker-buttons");
    form.appendChild(buttons);
    const addButton = (label, onClick, cls) => {
        const b = el("button", cls || "", label);
        b.setAttribute("type", "button");
        b.addEventListener("click", onClick);
        buttons.appendChild(b);
        return b;
    };
    addButton("Reset to Auto", () => { box = Object.assign({}, auto.boundingBox); focal = Object.assign({}, auto.focalPoint); refresh(true); if (previewShown) renderPreview(); });
    addButton("Preview Placement", () => renderPreview());
    const btnLayout = addButton("Apply to Current Layout", () => finish("apply_layout"));
    addButton("Apply to All Relevant Layouts", () => finish("apply_all"));
    addButton("Cancel", () => finish(null));
    if (!(options.layouts || []).length) btnLayout.disabled = true;

    function selectedLayoutId() {
        try { return String(layoutSelect.value || ""); } catch (e) { return ""; }
    }

    function refresh(updateFields) {
        px(autoBox, boxToPreview(auto.boundingBox, size));
        const af = pointToPreview(auto.focalPoint, size);
        px(autoFocal, { left: af.left - 5, top: af.top - 5 });
        const b = boxToPreview(box, size);
        px(editBox, b);
        const hs = EDITOR.handlePx - 2;
        px(handles.nw, { left: -hs, top: -hs }); px(handles.ne, { left: b.width - hs, top: -hs });
        px(handles.sw, { left: -hs, top: b.height - hs }); px(handles.se, { left: b.width - hs, top: b.height - hs });
        const f = pointToPreview(focal, size);
        px(editFocal, { left: f.left - 6, top: f.top - 6 });
        if (updateFields) {
            const v = { x: box.x, y: box.y, width: box.width, height: box.height, fx: focal.x, fy: focal.y };
            for (const k of Object.keys(fields)) fields[k].value = String(r6(v[k]));
            fieldError.textContent = "";
            fieldsDirty = false;
        }
        const sameBox = ["x", "y", "width", "height"].every((k) => Math.abs(box[k] - auto.boundingBox[k]) < 1e-6);
        const sameFocal = Math.abs(focal.x - auto.focalPoint.x) < 1e-6 && Math.abs(focal.y - auto.focalPoint.y) < 1e-6;
        state.textContent = `Box: ${sameBox ? "as imported" : "adjusted"} · Focal point: ${sameFocal ? "as imported" : "adjusted"}`;
    }

    function fromFields() {
        const raw = {};
        for (const k of Object.keys(fields)) raw[k] = fields[k].value;
        const r = valuesFromFields(raw);
        if (!r.values) { fieldError.textContent = "⚠ " + r.errors.join("; ") + " — not applied"; return; }
        box = r.values.boundingBox;
        focal = r.values.focalPoint;
        refresh(false);
        fieldError.textContent = "";
        fieldsDirty = false;
        if (previewShown) renderPreview();
    }

    // dragging (mouse events; pointer events where UXP has them)
    let drag = null;
    function local(ev) {
        const r = stage.getBoundingClientRect();
        return { left: ev.clientX - r.left, top: ev.clientY - r.top };
    }
    function onDown(ev) {
        const pt = local(ev);
        const mode = hitTest(pt, box, focal, size);
        if (!mode) return;
        drag = { mode, from: pt, box: Object.assign({}, box), focal: Object.assign({}, focal) };
        try { ev.preventDefault(); } catch (e) {}
    }
    function onMove(ev) {
        if (!drag) return;
        const pt = local(ev);
        const dx = (pt.left - drag.from.left) / size.width, dy = (pt.top - drag.from.top) / size.height;
        if (drag.mode === "focal") focal = dragPoint(drag.focal, dx, dy);
        else box = dragBox(drag.box, drag.mode, dx, dy);
        refresh(true);
    }
    function onUp() {
        if (!drag) return;
        drag = null;
        if (previewShown) renderPreview();
    }
    const usePointer = typeof window !== "undefined" && typeof window.PointerEvent === "function";
    stage.addEventListener(usePointer ? "pointerdown" : "mousedown", onDown);
    stage.addEventListener(usePointer ? "pointermove" : "mousemove", onMove);
    stage.addEventListener(usePointer ? "pointerup" : "mouseup", onUp);
    stage.addEventListener(usePointer ? "pointerleave" : "mouseleave", onUp);

    // Preview Placement: the existing placement, one diagram per layout
    let previewShown = false;
    function renderPreview() {
        previewShown = true;
        previewBox.innerHTML = "";
        let results = [];
        try { results = options.preview({ boundingBox: box, focalPoint: focal }) || []; } catch (e) {
            previewBox.appendChild(el("div", "capsule-error", "Preview failed: " + String((e && e.message) || e)));
            return;
        }
        if (options.previewNote) previewBox.appendChild(el("div", "picker-hint", options.previewNote));
        const current = selectedLayoutId();
        const grid = el("div", "capsule-grid");
        for (const pv of results) {
            const cell = el("div", "capsule-cell" + (pv.layoutId === current ? " capsule-cell-current" : ""));
            const T = diagramTransform(pv.pageBounds, [pv.frameBounds, pv.graphicBounds], EDITOR.diagram);
            const d = el("div", "capsule-diagram");
            d.style.width = T.size.width + "px";
            d.style.height = T.size.height + "px";
            const add = (cls, bounds) => { if (!bounds) return; const n = el("div", cls); px(n, T.rect(bounds)); d.appendChild(n); };
            add("dg-page", pv.pageBounds);
            add("dg-graphic", pv.graphicBounds);
            add("dg-frame", pv.frameBounds);
            for (const a of pv.avoid || []) add("dg-text", a);
            if (pv.zone) add("dg-zone", pv.zone.bounds);
            add("dg-subject", pv.subjectRect);
            if (pv.focal) { const n = el("div", "dg-focal"); const r = T.rect([pv.focal.y, pv.focal.x, pv.focal.y, pv.focal.x]); px(n, { left: r.left - 3, top: r.top - 3 }); d.appendChild(n); }
            cell.appendChild(d);
            cell.appendChild(el("div", "capsule-cell-title", previewSummary(pv)));
            for (const w of pv.warnings || []) cell.appendChild(el("div", "capsule-cell-warning", "⚠ " + w));
            for (const n of pv.notes || []) cell.appendChild(el("div", "capsule-cell-note", n));
            grid.appendChild(cell);
        }
        previewBox.appendChild(grid);
        previewBox.appendChild(el("div", "capsule-legend", "Blue: placed photo · green: subject box · grey: text area · red dashed: red subject frame · outline: image frame. Same calculation as Generate."));
    }
    layoutSelect.addEventListener("change", () => { if (previewShown) renderPreview(); });

    const height = Math.min(780, 260 + size.height + 120);
    dlg.style.width = EDITOR.windowWidth + "px";
    dlg.style.height = height + "px";
    document.body.appendChild(dlg);
    refresh(true);

    let result = null;
    let settled = false;
    let resolveEditor = null;
    const closed = new Promise((resolve) => { resolveEditor = resolve; });
    function done() {
        if (settled) return;
        settled = true;
        setTimeout(() => { try { dlg.remove(); } catch (e) {} resolveEditor(result); }, 100);
    }
    function finish(action) {
        if (action) {
            if (fieldsDirty) fromFields(); // a typed value not yet confirmed with Enter / Tab
            if (fieldError.textContent) return; // invalid numbers: stay open
            result = { action, layoutId: action === "apply_layout" ? selectedLayoutId() : "", values: { boundingBox: Object.assign({}, box), focalPoint: Object.assign({}, focal) } };
        } else {
            result = null;
        }
        try { dlg.close(action || "cancel"); } catch (e) { done(); }
    }
    dlg.addEventListener("close", done, { once: true });
    try {
        if (typeof dlg.uxpShowModal === "function") {
            dlg.uxpShowModal({ title: options.title || "Edit Subject Placement", resize: "both", size: { width: EDITOR.windowWidth, height } }).then(done, done);
        } else {
            dlg.showModal();
        }
    } catch (e) {
        done();
    }
    return closed;
}

module.exports = {
    EDITOR, fitSize, boxToPreview, previewToBox, pointToPreview, previewToPoint, hitTest, dragBox, dragPoint,
    parseShare, valuesFromFields, diagramTransform, previewSummary, showCapsuleEditor,
};
