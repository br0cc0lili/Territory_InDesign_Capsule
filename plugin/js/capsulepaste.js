// capsulepaste.js — the "Paste Capsule JSON" window (Capsule mode).
//
// The Capsule workflow shows the detection in its Preview node with a Copy
// button. This window takes that text: it is pasted (⌘V, or Paste from
// Clipboard; a valid Capsule JSON already on the clipboard is filled in when
// the window opens), checked with the same validation as an imported file,
// and drawn on the photo it is meant for — so the designer sees that box and
// photo belong together before anything is saved.
//
// Pasted text carries no file name, so the photo is never guessed from it:
// the designer picks the photo (or the window is opened from one product's
// ⋯ menu and shows only that photo).
//
// showCapsulePaste(options) resolves with { imagePath, text } or null.
// Nothing is saved here — index.js imports the text (capsule.js importText).

/* global require, document, navigator */

const PASTE = {
    windowWidth: 460,
    maxWidth: 420,
    maxHeight: 240,
};

function r3(v) {
    return Math.round(v * 1000) / 1000;
}

// The pasted text → { ok, detection, line, notes }.
//   parse: capsule.js parseCapsuleJson; clean: capsule.js cleanPastedText
function pasteState(text, parse, clean) {
    const s = clean ? clean(text) : String(text || "").trim();
    if (!s) return { ok: false, empty: true, detection: null, line: "Paste the JSON copied from the Capsule workflow.", notes: [] };
    const r = parse(s);
    if (!r.ok) return { ok: false, detection: null, line: "✗ Not a valid Capsule JSON:", notes: r.errors.slice() };
    const b = r.detection.boundingBox, f = r.detection.focalPoint;
    return {
        ok: true,
        detection: r.detection,
        line: `✓ Valid — box x ${r3(b.x)} y ${r3(b.y)} · ${r3(b.width)} × ${r3(b.height)} · focal point ${r3(f.x)}, ${r3(f.y)}`,
        notes: r.warnings.slice(),
    };
}

// Which photo the window starts on: the requested one, else the first photo
// without Capsule data, else the first.
function startPhoto(photos, selected) {
    if (!photos.length) return "";
    if (selected && photos.some((p) => p.imagePath === selected)) return selected;
    const missing = photos.find((p) => p.status === "missing" || p.status === "stale");
    return (missing || photos[0]).imagePath;
}

// Photo pixel size → preview size inside PASTE.maxWidth × maxHeight.
function thumbSize(px) {
    const w = px && px.width > 0 ? px.width : 4, h = px && px.height > 0 ? px.height : 3;
    const s = Math.min(PASTE.maxWidth / w, PASTE.maxHeight / h);
    return { width: Math.max(1, Math.round(w * s)), height: Math.max(1, Math.round(h * s)) };
}

// UXP: navigator.clipboard.readText() (needs "clipboard": "read" in the
// manifest) resolves with a string, or with { "text/plain": string }.
async function readClipboardText() {
    if (typeof navigator === "undefined" || !navigator.clipboard) throw new Error("the clipboard is not available here");
    const c = navigator.clipboard;
    const v = typeof c.readText === "function" ? await c.readText()
        : typeof c.getContent === "function" ? await c.getContent() : null;
    if (typeof v === "string") return v;
    if (v && typeof v === "object") return String(v["text/plain"] || v.text || "");
    return "";
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

async function defaultPhotoUrl(imagePath) {
    let picker = null;
    for (const p of ["./subjectpicker.js", "./js/subjectpicker.js"]) {
        try { picker = require(p); if (picker && picker.photoDataUrl) break; } catch (e) {}
    }
    if (!picker || !picker.photoDataUrl) return { url: "", reason: "photo preview unavailable" };
    return picker.photoDataUrl(imagePath);
}

//   options: {
//     photos:   [{ imagePath, label, status, pixelSize }]   status: capsule.js entryStatus
//     selected: imagePath to start on
//     locked:   true → only options.selected (opened from a product's ⋯ menu)
//     parse, clean:   capsule.js parseCapsuleJson / cleanPastedText
//     readClipboard:  async () → text (default: UXP navigator.clipboard)
//     photoUrl:       async (imagePath) → { url, size } (default: subjectpicker.js)
//     autoPaste:      false → don't look at the clipboard on open
//   }
async function showCapsulePaste(options) {
    const photos = (options.locked ? options.photos.filter((p) => p.imagePath === options.selected) : options.photos).slice();
    const readClipboard = options.readClipboard || readClipboardText;
    const loadPhoto = options.photoUrl || defaultPhotoUrl;
    let imagePath = startPhoto(photos, options.selected);
    let state = pasteState("", options.parse, options.clean);

    const dlg = el("dialog", "picker-dialog capsule-dialog");
    const form = el("form", "picker-body");
    form.setAttribute("method", "dialog");
    dlg.appendChild(form);
    form.appendChild(el("div", "picker-hint", "In the Capsule workflow, click Copy on the Preview node, then paste here. Check that the green box sits on the product in this photo."));

    // the photo this JSON belongs to
    const photoRow = el("div", "capsule-layout-row");
    photoRow.appendChild(el("span", "capsule-field-label", "Photo: "));
    let photoSelect = null;
    if (photos.length > 1) {
        photoSelect = document.createElement("select");
        photoSelect.className = "capsule-select paste-photo-select";
        for (const p of photos) {
            const opt = document.createElement("option");
            opt.setAttribute("value", p.imagePath);
            opt.textContent = p.label;
            if (p.imagePath === imagePath) opt.setAttribute("selected", "selected");
            photoSelect.appendChild(opt);
        }
        try { photoSelect.value = imagePath; } catch (e) {}
        photoRow.appendChild(photoSelect);
    } else {
        photoRow.appendChild(el("span", "paste-photo-name", photos.length ? photos[0].label : "no matched photo"));
    }
    form.appendChild(photoRow);
    const photoNote = el("div", "capsule-legend");
    form.appendChild(photoNote);

    const stage = el("div", "picker-stage paste-stage");
    form.appendChild(stage);

    // the text
    const pasteRow = el("div", "paste-row");
    const btnClip = el("button", "btn-small", "Paste from Clipboard");
    btnClip.setAttribute("type", "button");
    const btnClear = el("button", "btn-small btn-quiet", "Clear");
    btnClear.setAttribute("type", "button");
    pasteRow.appendChild(btnClip);
    pasteRow.appendChild(btnClear);
    form.appendChild(pasteRow);
    const textBox = document.createElement("textarea");
    textBox.className = "paste-text";
    textBox.setAttribute("rows", "5");
    textBox.setAttribute("placeholder", '{"focalPoint": {"x": …, "y": …, "normalized": true}, "boundingBox": {"x": …, "y": …, "width": …, "height": …, "normalized": true}}');
    form.appendChild(textBox);
    const status = el("div", "paste-status");
    form.appendChild(status);
    const notes = el("div", "capsule-legend");
    form.appendChild(notes);

    const buttons = el("div", "picker-buttons");
    form.appendChild(buttons);
    const btnImport = el("button", "btn-primary", "Import for This Photo");
    btnImport.setAttribute("type", "button");
    const btnCancel = el("button", "", "Cancel");
    btnCancel.setAttribute("type", "button");
    buttons.appendChild(btnImport);
    buttons.appendChild(btnCancel);

    let size = { width: PASTE.maxWidth, height: PASTE.maxHeight };
    let loadToken = 0;
    async function showPhoto() {
        const token = ++loadToken;
        const p = photos.find((x) => x.imagePath === imagePath) || {};
        photoNote.textContent = p.status === "auto" || p.status === "manual"
            ? "This photo already has Capsule data — importing replaces it (you are asked first)."
            : p.status === "stale" ? "This photo changed after its Capsule data was imported." : "";
        size = thumbSize(p.pixelSize);
        stage.innerHTML = "";
        stage.style.width = size.width + "px";
        stage.style.height = size.height + "px";
        stage.appendChild(el("div", "picker-noimage", "Loading photo…"));
        drawBox();
        let photo = { url: "" };
        try { photo = await loadPhoto(imagePath); } catch (e) {}
        if (token !== loadToken) return; // another photo was chosen meanwhile
        if (!p.pixelSize && photo.size) {
            size = thumbSize(photo.size);
            stage.style.width = size.width + "px";
            stage.style.height = size.height + "px";
        }
        stage.innerHTML = "";
        if (photo.url) {
            const img = el("img", "picker-photo");
            img.style.width = size.width + "px";
            img.style.height = size.height + "px";
            img.setAttribute("src", photo.url);
            img.addEventListener("error", () => { img.style.display = "none"; stage.classList.add("picker-stage-empty"); });
            stage.appendChild(img);
            stage.classList.remove("picker-stage-empty");
        } else {
            stage.classList.add("picker-stage-empty");
            stage.appendChild(el("div", "picker-noimage", photo.reason || "no photo preview — the box is to scale"));
        }
        drawBox();
    }

    let boxNode = null, focalNode = null;
    function drawBox() {
        if (boxNode) { try { boxNode.remove(); } catch (e) {} boxNode = null; }
        if (focalNode) { try { focalNode.remove(); } catch (e) {} focalNode = null; }
        if (!state.ok) return;
        const b = state.detection.boundingBox, f = state.detection.focalPoint;
        boxNode = el("div", "capsule-edit-box paste-box");
        px(boxNode, { left: b.x * size.width, top: b.y * size.height, width: b.width * size.width, height: b.height * size.height });
        focalNode = el("div", "capsule-edit-focal");
        px(focalNode, { left: f.x * size.width - 6, top: f.y * size.height - 6 });
        stage.appendChild(boxNode);
        stage.appendChild(focalNode);
    }

    function update() {
        state = pasteState(textBox.value, options.parse, options.clean);
        status.textContent = state.line;
        status.className = "paste-status" + (state.ok ? " paste-ok" : state.empty ? "" : " paste-bad");
        notes.textContent = state.notes.map((n) => (state.ok ? "Note — " : "• ") + n).join("\n");
        btnImport.disabled = !state.ok || !imagePath;
        drawBox();
    }

    async function fromClipboard(silent) {
        let text = "";
        try { text = await readClipboard(); } catch (e) {
            if (!silent) { status.textContent = "Couldn't read the clipboard (" + String((e && e.message) || e) + ") — click in the box below and press ⌘V."; status.className = "paste-status paste-bad"; }
            return;
        }
        // On open, only take the clipboard when it holds a Capsule JSON.
        if (silent && !pasteState(text, options.parse, options.clean).ok) return;
        if (!silent && !String(text || "").trim()) { status.textContent = "The clipboard is empty — copy the JSON in the Capsule workflow first."; status.className = "paste-status paste-bad"; return; }
        textBox.value = text;
        update();
    }

    textBox.addEventListener("input", update);
    textBox.addEventListener("change", update);
    btnClip.addEventListener("click", () => fromClipboard(false));
    btnClear.addEventListener("click", () => { textBox.value = ""; update(); });
    if (photoSelect) photoSelect.addEventListener("change", () => {
        try { imagePath = String(photoSelect.value || imagePath); } catch (e) {}
        update();
        showPhoto();
    });

    const height = Math.min(780, 330 + PASTE.maxHeight + 60);
    dlg.style.width = PASTE.windowWidth + "px";
    dlg.style.height = height + "px";
    document.body.appendChild(dlg);
    update();
    showPhoto();
    if (options.autoPaste !== false) fromClipboard(true);

    let result = null;
    let settled = false;
    let resolveWindow = null;
    const closed = new Promise((resolve) => { resolveWindow = resolve; });
    function done() {
        if (settled) return;
        settled = true;
        setTimeout(() => { try { dlg.remove(); } catch (e) {} resolveWindow(result); }, 100);
    }
    function finish(ok) {
        if (ok) {
            update();
            if (!state.ok || !imagePath) return;
            result = { imagePath, text: options.clean ? options.clean(textBox.value) : String(textBox.value).trim() };
        }
        try { dlg.close(ok ? "import" : "cancel"); } catch (e) { done(); }
    }
    btnImport.addEventListener("click", () => finish(true));
    btnCancel.addEventListener("click", () => finish(false));
    dlg.addEventListener("close", done, { once: true });
    try {
        if (typeof dlg.uxpShowModal === "function") {
            dlg.uxpShowModal({ title: "Paste Capsule JSON", resize: "both", size: { width: PASTE.windowWidth, height } }).then(done, done);
        } else {
            dlg.showModal();
        }
    } catch (e) {
        done();
    }
    return closed;
}

module.exports = { PASTE, pasteState, startPhoto, thumbSize, readClipboardText, showCapsulePaste };
