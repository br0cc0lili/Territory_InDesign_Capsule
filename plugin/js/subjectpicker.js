// subjectpicker.js — the "Choose Subject" window.
//
// Shows the product photo with every object the backend found (mask-objects)
// as a numbered, coloured box, plus a tick list. The designer ticks one or
// more objects; the box around all ticked objects is what goes into the red
// subject frame (dashed white outline in the preview). No InDesign DOM here —
// only the panel's own HTML.
//
// showSubjectPicker(options) resolves with
//   { action: "save" | "save_regenerate" | "auto" | "redetect", selected: [ids] }
// or null (Cancel / Esc).

/* global require, document */

const PICKER = {
    maxWidth: 480,       // preview size in the window (px)
    maxHeight: 320,
    windowWidth: 540,
    maxPreviewBytes: 15 * 1024 * 1024,
    colours: ["#ff4d4d", "#4da3ff", "#ffd24d", "#5ad16b", "#c77dff", "#ff9a3c", "#3cd6d6", "#ff6fb5"],
};

// ---------- pure helpers (tested offline) ----------

const B64 = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";

// Uint8Array / ArrayBuffer → base64 (UXP has no reliable btoa for binary).
function toBase64(data) {
    const b = data instanceof Uint8Array ? data : new Uint8Array(data);
    const parts = [];
    let chunk = "";
    for (let i = 0; i < b.length; i += 3) {
        const n = (b[i] << 16) | ((i + 1 < b.length ? b[i + 1] : 0) << 8) | (i + 2 < b.length ? b[i + 2] : 0);
        chunk += B64[(n >> 18) & 63] + B64[(n >> 12) & 63] +
            (i + 1 < b.length ? B64[(n >> 6) & 63] : "=") + (i + 2 < b.length ? B64[n & 63] : "=");
        if (chunk.length >= 32768) { parts.push(chunk); chunk = ""; }
    }
    parts.push(chunk);
    return parts.join("");
}

// Preview size that fits maxWidth x maxHeight with the photo's aspect.
function previewSize(pixelSize, maxWidth, maxHeight) {
    const w = pixelSize && pixelSize.width > 0 ? pixelSize.width : 4;
    const h = pixelSize && pixelSize.height > 0 ? pixelSize.height : 3;
    const scale = Math.min((maxWidth || PICKER.maxWidth) / w, (maxHeight || PICKER.maxHeight) / h);
    return { width: Math.round(w * scale), height: Math.round(h * scale) };
}

// A share box → { left, top, width, height } in preview pixels.
function boxToPixels(box, size) {
    return {
        left: Math.round(box.x * size.width), top: Math.round(box.y * size.height),
        width: Math.max(2, Math.round(box.width * size.width)), height: Math.max(2, Math.round(box.height * size.height)),
    };
}

function objectLabel(o) {
    return `${o.id} · ${o.label || "Object"}${o.score != null ? ` (${Math.round(o.score * 100)}%)` : ""}`;
}

// ---------- window ----------

function el(tag, cls, text) {
    const n = document.createElement(tag);
    if (cls) n.className = cls;
    if (text != null) n.textContent = text;
    return n;
}

async function photoDataUrl(imagePath) {
    const storage = require("uxp").storage;
    const entry = await storage.localFileSystem.getEntryWithUrl("file:" + imagePath);
    const bytes = new Uint8Array(await entry.read({ format: storage.formats.binary }));
    let size = null;
    try {
        let ext = null;
        for (const p of ["./imageextension.js", "./js/imageextension.js"]) {
            try { ext = require(p); if (ext && ext.parseImageHeader) break; } catch (e) {}
        }
        if (ext && ext.parseImageHeader) size = ext.parseImageHeader(bytes.length > 262144 ? bytes.subarray(0, 262144) : bytes);
    } catch (e) {}
    // A very large file would make a huge data: URL — show the boxes only.
    if (bytes.length > PICKER.maxPreviewBytes) return { url: "", size, reason: "photo too large to preview — the boxes are to scale" };
    const type = /\.png$/i.test(imagePath) ? "image/png" : "image/jpeg";
    return { url: `data:${type};base64,${toBase64(bytes)}`, size };
}

//   options: { title, imagePath, objects: [{ id, label, score, box }],
//              selected: [ids] | null, chosenBefore: bool, unionBox(objects, ids) }
async function showSubjectPicker(options) {
    const objects = options.objects || [];
    const selected = new Set((options.selected || []).filter((id) => objects.some((o) => o.id === id)));
    let photo = { url: "", size: null };
    try { photo = await photoDataUrl(options.imagePath); } catch (e) {}
    const size = previewSize(photo.size);

    const dlg = el("dialog", "picker-dialog");
    const form = el("form", "picker-body");
    form.setAttribute("method", "dialog");
    dlg.appendChild(form);
    form.appendChild(el("div", "picker-hint", objects.length
        ? "Tick the object(s) that must sit inside the red subject frame. With several ticked, the box around all of them is used (dashed outline)."
        : "No separate objects were found in this photo — the automatic subject is used."));
    // No objects: show what the API answered (shape only), so it can be fixed.
    if (!objects.length && options.debug) {
        const details = el("div", "picker-debug", "API response: " + options.debug);
        form.appendChild(details);
    }

    const stage = el("div", "picker-stage");
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
        if (photo.reason) stage.appendChild(el("div", "picker-noimage", photo.reason));
    }
    // The outline around everything ticked sits UNDER the object boxes, so
    // the boxes stay clickable (to untick) while it is shown.
    const unionNode = el("div", "picker-union");
    stage.appendChild(unionNode);
    // Biggest first, so smaller boxes sit on top and stay clickable.
    const boxNodes = new Map();
    const checkNodes = new Map();
    for (const o of objects) {
        const px = boxToPixels(o.box, size);
        const colour = PICKER.colours[(o.id - 1) % PICKER.colours.length];
        const node = el("div", "picker-box");
        Object.assign(node.style, { left: px.left + "px", top: px.top + "px", width: px.width + "px", height: px.height + "px", borderColor: colour });
        const tag = el("div", "picker-tag", String(o.id));
        tag.style.backgroundColor = colour;
        node.appendChild(tag);
        node.addEventListener("click", () => toggle(o.id));
        stage.appendChild(node);
        boxNodes.set(o.id, node);
    }
    form.appendChild(stage);

    const list = el("div", "picker-list");
    for (const o of objects) {
        const row = el("div", "picker-row");
        const check = document.createElement("input");
        check.setAttribute("type", "checkbox");
        check.className = "picker-check";
        check.addEventListener("change", () => setChecked(o.id, !!check.checked));
        const swatch = el("span", "picker-swatch");
        swatch.style.backgroundColor = PICKER.colours[(o.id - 1) % PICKER.colours.length];
        const label = el("span", "picker-label", objectLabel(o));
        label.addEventListener("click", () => toggle(o.id));
        row.appendChild(check);
        row.appendChild(swatch);
        row.appendChild(label);
        list.appendChild(row);
        checkNodes.set(o.id, check);
    }
    form.appendChild(list);
    const summary = el("div", "picker-summary");
    form.appendChild(summary);

    const buttons = el("div", "picker-buttons");
    form.appendChild(buttons);
    const addButton = (label, value, cls) => {
        const b = el("button", cls || "", label);
        b.setAttribute("type", "button");
        b.addEventListener("click", () => finish(value));
        buttons.appendChild(b);
        return b;
    };
    const btnSave = addButton("Use Selected", "save");
    const btnSaveRegen = addButton("Use Selected & Regenerate .indd", "save_regenerate");
    if (options.chosenBefore) addButton("Back to Automatic", "auto");
    addButton("Detect Objects Again", "redetect");
    addButton("Cancel", null);

    function refresh() {
        for (const o of objects) {
            const on = selected.has(o.id);
            const node = boxNodes.get(o.id);
            if (node) node.className = "picker-box" + (on ? " picker-box-on" : "");
            const check = checkNodes.get(o.id);
            if (check && !!check.checked !== on) check.checked = on;
        }
        const ids = Array.from(selected);
        const u = ids.length && options.unionBox ? options.unionBox(objects, ids) : null;
        if (u) {
            const px = boxToPixels(u, size);
            Object.assign(unionNode.style, { display: "block", left: px.left + "px", top: px.top + "px", width: px.width + "px", height: px.height + "px" });
        } else {
            unionNode.style.display = "none";
        }
        const names = objects.filter((o) => selected.has(o.id)).map((o) => o.label || "Object");
        summary.textContent = names.length ? `Selected ${names.length}: ${names.join(" + ")}` : "Nothing selected";
        btnSave.disabled = !names.length;
        btnSaveRegen.disabled = !names.length;
    }
    function setChecked(id, on) { if (on) selected.add(id); else selected.delete(id); refresh(); }
    function toggle(id) { setChecked(id, !selected.has(id)); }

    const listRows = Math.min(objects.length, 8);
    const height = Math.min(780, 150 + size.height + listRows * 26 + (objects.length > 8 ? 20 : 0) + 120);
    dlg.style.width = PICKER.windowWidth + "px";
    dlg.style.height = height + "px";
    document.body.appendChild(dlg);
    refresh();

    let result = null;
    let settled = false;
    let resolvePicker = null;
    const closed = new Promise((resolve) => { resolvePicker = resolve; });
    function done() {
        if (settled) return;
        settled = true;
        // UXP won't open another modal while this one is still closing.
        setTimeout(() => { try { dlg.remove(); } catch (e) {} resolvePicker(result); }, 100);
    }
    function finish(value) {
        result = value ? { action: value, selected: Array.from(selected).sort((a, b) => a - b) } : null;
        try { dlg.close(value || "cancel"); } catch (e) { done(); }
    }
    dlg.addEventListener("close", done, { once: true });
    try {
        if (typeof dlg.uxpShowModal === "function") {
            dlg.uxpShowModal({ title: options.title || "Choose Subject", resize: "both", size: { width: PICKER.windowWidth, height } }).then(done, done);
        } else {
            dlg.showModal();
        }
    } catch (e) {
        done();
    }
    return closed;
}

module.exports = { PICKER, toBase64, previewSize, boxToPixels, objectLabel, showSubjectPicker, photoDataUrl };
