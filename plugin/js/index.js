// index.js — panel UI wiring for the Poster Batch Generator plugin.
// Ties together matcher.js (fuzzy match), datamerge.js (prepare the client
// template) and render.js (generate the product INDDs, export JPGs from
// them), entirely in-panel.
//
// Workflow: 1 Inputs (Excel, photos, output folder) → 2 Template (Prepare)
// → 3 Match, Generate & Review: "Generate All .indd" builds one INDD per
// product (no JPGs); each product can be opened, previewed (low-res JPGs)
// and committed individually; Commit (one / "Commit All Ready .indd") saves
// + checks INDDs and marks them Committed without exporting → 4 "Export All
// Committed Images" exports the final JPGs of every Committed product.
// MASS GENERATION + INDIVIDUAL EXCEPTION HANDLING.

/* global require, document, localStorage, location */
const uxp = require("uxp");
const fs = uxp.storage.localFileSystem;

// Each local module is required defensively: if one throws (e.g. a typo, or
// an environment where require("indesign") turns out not to behave as
// expected), we still want every OTHER button in the panel to keep working
// instead of the whole script aborting silently before any listener attaches.
let matcher = null, render = null, datamerge = null, subjectMod = null, pickerMod = null;
const loadErrors = [];
// Note: index.js is loaded via a plain <script src="js/index.js"> tag in
// index.html, so require()'s relative resolution here is anchored at the
// plugin root ("./"), not at this file's own "js/" folder — hence "./js/…".
try { matcher = require("./js/matcher.js"); } catch (e) { loadErrors.push("matcher.js: " + e); }
try { render = require("./js/render.js"); } catch (e) { loadErrors.push("render.js: " + e); }
try { datamerge = require("./js/datamerge.js"); } catch (e) { loadErrors.push("datamerge.js: " + e); }
// Choose Subject (bounding box): object detection + choices, and its window.
try { subjectMod = require("./js/subject.js"); } catch (e) { loadErrors.push("subject.js: " + e); }
try { pickerMod = require("./js/subjectpicker.js"); } catch (e) { loadErrors.push("subjectpicker.js: " + e); }
// Capsule subject source: imported Adobe Capsule JSON + its editor window.
let capsuleMod = null, capsuleEditor = null, capsulePaste = null;
try { capsuleMod = require("./js/capsule.js"); } catch (e) { loadErrors.push("capsule.js: " + e); }
try { capsuleEditor = require("./js/capsuleeditor.js"); } catch (e) { loadErrors.push("capsuleeditor.js: " + e); }
try { capsulePaste = require("./js/capsulepaste.js"); } catch (e) { loadErrors.push("capsulepaste.js: " + e); }
// Optional Auto Text Color palette reader — if it can't load, the palette row just stays empty.
let colorpalette = null;
try { colorpalette = require("./js/colorpalette.js"); } catch (e) { loadErrors.push("colorpalette.js: " + e); }

let excelEntry = null;
let photosEntry = null;
let outputEntry = null;
let manifestRows = [];
// The prepared template set: the <name>_DataMerge.indd from step 1. It
// decides the output type (DANIS or Service) for the whole run, so it holds
// ONE template — preparing another one replaces it.
let templatePaths = [];
// Matched row -> { inddPath, subType, exists } for the current template set
// and output folder (see refreshProducts).
let products = new Map();
// True while Prepare/Generate/Preview/Commit runs, so runs can't overlap.
let busy = false;

const el = {
    loadErrorBanner: document.getElementById("load-error-banner"),
    fontBanner: document.getElementById("font-banner"),
    btnReload: document.getElementById("btn-reload"),
    btnDmPrepare: document.getElementById("btn-dm-prepare"),
    dmSummary: document.getElementById("dm-summary"),
    btnExcel: document.getElementById("btn-excel"),
    excelPath: document.getElementById("excel-path"),
    btnPhotos: document.getElementById("btn-photos"),
    photosPath: document.getElementById("photos-path"),
    btnMatch: document.getElementById("btn-match"),
    matchSummary: document.getElementById("match-summary"),
    resultsBody: document.getElementById("results"),
    templateList: document.getElementById("template-list"),
    btnOutput: document.getElementById("btn-output"),
    outputPath: document.getElementById("output-path"),
    btnPalette: document.getElementById("btn-palette"),
    palettePath: document.getElementById("palette-path"),
    paletteSwatches: document.getElementById("palette-swatches"),
    btnGenerate: document.getElementById("btn-generate"),
    btnCommitAll: document.getElementById("btn-commit-all"),
    btnExtendAll: document.getElementById("btn-extend-all"),
    btnExport: document.getElementById("btn-export"),
    statusCounts: document.getElementById("status-counts"),
    genProgress: document.getElementById("gen-progress"),
    genProgressFill: document.getElementById("gen-progress-fill"),
    genProgressLabel: document.getElementById("gen-progress-label"),
    genMessage: document.getElementById("gen-message"),
    exportMessage: document.getElementById("export-message"),
    progress: document.getElementById("progress"),
    progressFill: document.getElementById("progress-fill"),
    progressLabel: document.getElementById("progress-label"),
    activeProduct: document.getElementById("active-product"),
    activeName: document.getElementById("active-name"),
    modeAuto: document.getElementById("mode-auto"),
    modeFrames: document.getElementById("mode-frames"),
    framesActions: document.getElementById("frames-actions"),
    btnAddFrames: document.getElementById("btn-add-frames"),
    btnResetFrames: document.getElementById("btn-reset-frames"),
    btnSaveFrames: document.getElementById("btn-save-frames"),
    framesUnsaved: document.getElementById("frames-unsaved"),
    framesSummary: document.getElementById("frames-summary"),
    srcCapsule: document.getElementById("src-capsule"),
    srcApi: document.getElementById("src-api"),
    capsuleActions: document.getElementById("capsule-actions"),
    btnCapsuleImport: document.getElementById("btn-capsule-import"),
    btnCapsulePaste: document.getElementById("btn-capsule-paste"),
    capsulePasteText: document.getElementById("capsule-paste-text"),
    capsulePasteStatus: document.getElementById("capsule-paste-status"),
    capsulePastePhoto: document.getElementById("capsule-paste-photo"),
    btnCapsulePasteImport: document.getElementById("btn-capsule-paste-import"),
    capsuleSummary: document.getElementById("capsule-summary"),
    capsuleMessage: document.getElementById("capsule-message"),
    activeActions: document.getElementById("active-actions"),
    activeStatus: document.getElementById("active-status"),
    dialog: document.getElementById("action-dialog"),
};

// ---------- remembered selections + product statuses ----------
//
// Kept in localStorage so they survive closing / reopening the panel. The
// ⟳ Reload button deliberately clears all of it (see resetPanel).

const STORE = {
    excel: "posterBatch.excelPath",
    photos: "posterBatch.photosPath",
    output: "posterBatch.outputPath",
    templates: "posterBatch.templatePaths",
    palette: "posterBatch.palette", // { path, selected: [swatch ids] } — Auto Text Color
    statuses: "posterBatch.inddStatuses",
    placementMode: "posterBatch.placementMode",
    subjectSource: "posterBatch.subjectSource", // "capsule" (default) | "api"
};

function remember(key, value) {
    try { localStorage.setItem(key, JSON.stringify(value)); } catch (e) {}
}

function recall(key) {
    try { return JSON.parse(localStorage.getItem(key)); } catch (e) { return null; }
}

// Features that exist in the code but are switched off in the panel.
//   chooseSubject: ⋯ → Choose Subject (pick objects with mask-objects) —
//   paused; needs the subject-objects backend actions.
const FEATURES = { chooseSubject: false };

// ---------- step 3: Subject Placement ----------
//   "auto"   — Auto Placement: centred in the free area, clear of the text
//   "frames" — Custom Subject Frames: the red frames in the template decide
function placementMode() {
    return recall(STORE.placementMode) === "frames" ? "frames" : "auto";
}

// classList.toggle(name, force) isn't reliable in every UXP version.
function setClass(node, name, on) {
    if (on) node.classList.add(name); else node.classList.remove(name);
}

function showPlacementMode() {
    if (!el.modeAuto) return;
    const frames = placementMode() === "frames";
    setClass(el.modeAuto, "mode-selected", !frames);
    setClass(el.modeFrames, "mode-selected", frames);
    setClass(el.framesActions, "hidden", !frames);
    if (!frames) el.framesSummary.textContent = "";
    else if (!el.framesSummary.textContent) {
        el.framesSummary.textContent = templatePaths.length ? "" : "Prepare the template in step 2 first.";
    }
}

function setPlacementMode(mode) {
    if (busy) return;
    remember(STORE.placementMode, mode === "frames" ? "frames" : "auto");
    el.framesSummary.textContent = "";
    showPlacementMode();
    updateButtons();
}

// UXP Entry for a remembered path, or null if it's gone.
async function entryFor(path) {
    if (!path) return null;
    try { return await fs.getEntryWithUrl("file:" + path); } catch (e) { return null; }
}

// ---------- product status model ----------
//
// Per product INDD (keyed by its path):
//   status "ready"  — the latest check found no warnings
//          "review" — the latest check found warnings (empty image frame,
//                     text that doesn't fit its frame, …) — fix, then Preview
//          "failed" — generation failed (an older INDD may still be on disk)
//   committedAt — set by Commit: the INDD was saved + checked and approved
//                 (no JPGs exported). Cleared by Generate / Regenerate, or
//                 when a later Preview finds warnings.
//   exportedAt  — set by "Export All Committed" once its final JPGs exist.
//                 Cleared by a new Commit (which re-queues it for export).
// Flow: Not generated → Ready / Review → Committed → Exported.
// Checks happen on Generate, Preview and Commit. An INDD on disk with no
// record is "Unchecked" and is NOT treated as Ready.

let statuses = recall(STORE.statuses) || {};

function statusKey(inddPath) {
    return String(inddPath).toLowerCase();
}

function getStatus(inddPath) {
    return statuses[statusKey(inddPath)] || null;
}

function setStatus(inddPath, patch) {
    const key = statusKey(inddPath);
    statuses[key] = Object.assign({}, statuses[key] || {}, patch, { updatedAt: new Date().toISOString() });
    remember(STORE.statuses, statuses);
}

// "ready" | "review" | "committed" | "exported" | "failed" | "unchecked" | "not-generated" | "no-asset"
function rowState(rec) {
    if (rec.status !== "matched") return "no-asset";
    const p = products.get(rec);
    if (!p) return "not-generated";
    const s = getStatus(p.inddPath);
    if (s && s.status === "failed") return "failed";
    if (!p.exists) return "not-generated";
    if (!s) return "unchecked";
    if (s.exportedAt) return "exported";
    if (s.committedAt) return "committed";
    return s.status === "review" ? "review" : "ready";
}

// ---------- restore ----------

async function restoreSelections() {
    excelEntry = await entryFor(recall(STORE.excel));
    if (excelEntry) el.excelPath.textContent = excelEntry.name;
    photosEntry = await entryFor(recall(STORE.photos));
    if (photosEntry) el.photosPath.textContent = photosEntry.nativePath;
    outputEntry = await entryFor(recall(STORE.output));
    await restorePalette();
    const paths = recall(STORE.templates) || [];
    templatePaths = [];
    // One template set; older versions may have stored several — keep the last.
    for (const p of paths.slice(-1)) if (await entryFor(p)) templatePaths.push(p);
    showContext();
    showPlacementMode();
    showSubjectSource();
    await loadCapsule();
    refreshCapsuleSummary();
    updateButtons();
}

// ---------- context line (template set + output) and buttons ----------

function templateTypeOf(path) {
    try { return render ? render.typeOfTemplate(path) : null; } catch (e) { return null; }
}

function showContext() {
    if (templatePaths.length) {
        const t = templateTypeOf(templatePaths[0]);
        const label = t && render ? render.typeFolder(t) : "?";
        el.templateList.textContent = `${label} (${templatePaths[0].split("/").pop()})`;
    } else {
        el.templateList.textContent = "None yet — open the client template and prepare it";
    }
    if (outputEntry) {
        // The folder the user picked (step 1); JPGs go to output/<type>/ in it.
        el.outputPath.textContent = outputEntry.nativePath;
    } else {
        el.outputPath.textContent = "No folder selected";
    }
}

function hasMatchedRows() {
    return manifestRows.some((r) => r.status === "matched");
}

function readyRows() {
    return manifestRows.filter((r) => rowState(r) === "ready");
}

function committedRows() {
    return manifestRows.filter((r) => rowState(r) === "committed");
}

function updateButtons() {
    if (el.btnAddFrames) {
        const noFrames = busy || !templatePaths.length || placementMode() !== "frames";
        el.btnAddFrames.disabled = noFrames;
        el.btnResetFrames.disabled = noFrames;
        el.btnSaveFrames.disabled = noFrames;
    }
    el.btnMatch.disabled = busy || !(excelEntry && photosEntry);
    el.btnGenerate.disabled = busy || !(hasMatchedRows() && outputEntry && templatePaths.length);
    el.btnCommitAll.disabled = busy || readyRows().length === 0;
    el.btnExtendAll.disabled = busy || !outputEntry || extendableRows().length === 0;
    el.btnExport.disabled = busy || !outputEntry || committedRows().length === 0;
    el.btnDmPrepare.disabled = busy || !excelEntry;
    if (el.btnCapsuleImport) el.btnCapsuleImport.disabled = busy || !outputEntry;
    if (el.btnCapsulePaste) el.btnCapsulePaste.disabled = busy;
    if (el.btnCapsulePasteImport) updatePasteState(true);
}

function setBusy(on) {
    busy = on;
    if (!on) hideProgress();
    updateButtons();
    renderTable();
}

function setTemplate(path) {
    templatePaths = [path];
    remember(STORE.templates, templatePaths);
    showContext();
    // New template set: the step 3 hint starts over.
    if (el.framesSummary) el.framesSummary.textContent = "";
    showPlacementMode();
}

function showFontBanner(message) {
    el.fontBanner.textContent = "⚠ " + message;
    el.fontBanner.classList.remove("banner-hidden");
}

// require("indesign").app can still be undefined right after the panel
// shows (the bridge is mid-attach). Polls until it's there, so the first real
// call (font check, Prepare, Generate) doesn't fail on a missing app.
const NOT_READY = "InDesign isn't responding to the plugin. Close any open InDesign " +
    "dialog, then close and reopen this panel (Window menu) and try again.";

// "Error: Error: …" otherwise — String(e) already starts with "Error:".
function errorText(e) {
    return "Error: " + String((e && e.message) || e).replace(/^Error:\s*/, "");
}

async function waitForInDesign(timeoutMs = 10000) {
    for (let waited = 0; waited <= timeoutMs; waited += 100) {
        try {
            if (require("indesign").app) return true;
        } catch (e) {}
        await new Promise((resolve) => setTimeout(resolve, 100));
    }
    return false;
}

// ---------- progress + messages ----------
//
// Two places, each next to its action:
//   generate — below the product table (Generate All, Regenerate):
//              "Generating 6 / 10 — Product"
//   export   — step 4 (Export All Ready, row Preview / Commit):
//              "Exporting 23 / 87 — Product" / "Previewing 1 / 1 — Product"
// The progress shows only while a run is going; afterwards a short result
// replaces it. No idle text.

const channels = {
    generate: { box: el.genProgress, fill: el.genProgressFill, label: el.genProgressLabel, message: el.genMessage },
    export: { box: el.progress, fill: el.progressFill, label: el.progressLabel, message: el.exportMessage },
};

// A meaningful success / warning / error only; "" hides it.
function setMessage(text, channel) {
    const node = (channel || channels.export).message;
    node.textContent = text || "";
    if (text) node.classList.add("has-message");
    else node.classList.remove("has-message");
}

function startProgress(channel, verb, label) {
    setMessage("", channel);
    channel.verb = verb;
    channel.box.classList.remove("progress-hidden");
    channel.fill.style.width = "0%";
    channel.label.textContent = label;
}

// Progress callback for render.js: "<verb> 6 / 10 — Product".
function progressTo(channel) {
    return (done, total, message) => {
        const pct = total ? Math.round((done / total) * 100) : 0;
        channel.fill.style.width = pct + "%";
        const product = String(message || "").split(" — ")[0];
        channel.label.textContent = `${channel.verb} ${done} / ${total} — ${product}`;
    };
}

function hideProgress() {
    for (const ch of Object.values(channels)) ch.box.classList.add("progress-hidden");
}

// Short result: one headline line, then at most a few problems (the log
// files have the rest).
function summarize(headline, result, channel, extraLine) {
    const lines = [headline];
    if (extraLine) lines.push(extraLine);
    const failures = (result && result.failures) || [];
    for (const f of failures.slice(0, 5)) lines.push(`✗ ${f.headline} — ${f.message}`);
    if (failures.length > 5) lines.push(`…and ${failures.length - 5} more — see the log.`);
    setMessage(lines.join("\n"), channel);
}

// ---------- modal dialog (⋯ More menu, confirmations) ----------
//
// UXP panels have no reliable dropdown menus or window.confirm(), so both use
// one <dialog>. Resolves with the clicked button's value, or null (Cancel /
// Esc) — but only once the modal has FULLY closed: UXP refuses to open a
// second modal while the first is still closing, which is why ⋯ → Regenerate
// (whose confirmation is a second dialog) used to do nothing.
// The UXP modal window does not grow with its content, and InDesign keeps the
// window size of a <dialog> element from its first showing — reusing one
// element made later, longer dialogs clip their text and hide their buttons.
// So every dialog is a FRESH copy of the #action-dialog template, sized
// explicitly (element style + uxpShowModal size) from a conservative
// estimate (≈ 46 characters per 18 px line, 34 px per button, 96 px for an
// input box), and removed after it closes. The text wraps to the window's
// real width, and the body scrolls if the estimate is ever short.
const DIALOG_WIDTH = 440;
function dialogSize(message, buttonCount, hasInput, entries) {
    const lines = String(message || "").split("\n")
        .reduce((n, line) => n + Math.max(1, Math.ceil(line.length / 46)), 0);
    // Product-actions entries: headings, status lines, prompt box, details toggle.
    let extra = 0, plainButtons = buttonCount;
    for (const e of entries || []) {
        if (e.header) { extra += 24; plainButtons--; }
        else if (e.status) { extra += e.status.length * 18 + 6; plainButtons--; }
        else if (e.prompt) { extra += 70; plainButtons--; }
        else if (e.details) { extra += 34; plainButtons--; }
    }
    const height = (message ? 70 + lines * 18 : 60) + plainButtons * 34 + extra + (hasInput ? 96 : 0);
    return { width: DIALOG_WIDTH, height: Math.min(780, height) };
}

// options.input: { label, placeholder } — adds an optional multi-line text
// box; the promise then resolves with { value, text } instead of the value.
function showDialog(title, message, buttons, options) {
    const input = options && options.input;
    const dlg = el.dialog.cloneNode(true);
    dlg.removeAttribute("id");
    document.body.appendChild(dlg);
    const native = typeof dlg.uxpShowModal === "function";
    const titleNode = dlg.querySelector(".dialog-title");
    // UXP shows the title in the window's title bar; don't repeat it.
    titleNode.textContent = native ? "" : title;
    titleNode.style.display = native ? "none" : "";
    dlg.querySelector(".dialog-message").textContent = message || "";
    dlg.querySelector(".dialog-message").style.display = message ? "" : "none";
    let textBox = null;
    const inputBox = dlg.querySelector(".dialog-input");
    if (input) {
        dlg.querySelector(".dialog-input-label").textContent = input.label || "";
        textBox = dlg.querySelector(".dialog-input-text");
        textBox.setAttribute("placeholder", input.placeholder || "");
        inputBox.style.display = "";
    } else {
        inputBox.style.display = "none";
    }
    const buttonBox = dlg.querySelector(".dialog-buttons");
    buttonBox.innerHTML = "";
    const size = dialogSize(message, buttons.length + 1, !!input, buttons);
    dlg.style.width = size.width + "px";
    dlg.style.height = size.height + "px";
    return new Promise((resolve) => {
        let chosen = null;
        let text = "";
        let settled = false;
        const settle = () => {
            if (settled) return;
            settled = true;
            setTimeout(() => {
                try { dlg.remove(); } catch (e) {}
                resolve(input || (options && options.withText) ? { value: chosen, text } : chosen);
            }, 100);
        };
        let inlineBox = null; // an inline prompt box (Product actions)
        const closeLabel = (options && options.closeLabel) || "Cancel";
        for (const b of buttons.concat([{ label: closeLabel, value: null }])) {
            if (b.header) { // a small group heading, not a button (⋯ More actions)
                const h = document.createElement("div");
                h.className = "dialog-group";
                h.textContent = b.header;
                buttonBox.appendChild(h);
                continue;
            }
            if (b.status) { // short "Subject ✓ Detected" style lines
                for (const [cls, text] of b.status) {
                    const line = document.createElement("div");
                    line.className = "dialog-status " + (cls || "");
                    line.textContent = text;
                    buttonBox.appendChild(line);
                }
                continue;
            }
            if (b.prompt) { // optional text box inside the button list
                const lab = document.createElement("div");
                lab.className = "dialog-input-label";
                lab.textContent = b.prompt.label || "";
                inlineBox = document.createElement("textarea");
                inlineBox.className = "dialog-input-text";
                inlineBox.setAttribute("rows", "2");
                inlineBox.setAttribute("maxlength", "1024");
                inlineBox.setAttribute("placeholder", b.prompt.placeholder || "");
                buttonBox.appendChild(lab);
                buttonBox.appendChild(inlineBox);
                continue;
            }
            if (b.details) { // collapsed by default; toggling doesn't close the dialog
                const box = document.createElement("div");
                box.className = "dialog-details";
                box.textContent = b.details;
                box.style.display = "none";
                const toggle = document.createElement("button");
                toggle.type = "button";
                toggle.className = "dialog-details-toggle";
                toggle.textContent = "View details ▸";
                toggle.addEventListener("click", () => {
                    const open = box.style.display === "none";
                    box.style.display = open ? "" : "none";
                    toggle.textContent = open ? "Hide details ▾" : "View details ▸";
                });
                buttonBox.appendChild(toggle);
                buttonBox.appendChild(box);
                continue;
            }
            const btn = document.createElement("button");
            btn.type = "button";
            btn.textContent = b.label;
            if (b.danger) btn.className = "danger";
            btn.addEventListener("click", () => {
                chosen = b.value;
                if (textBox) text = String(textBox.value || "").trim();
                if (inlineBox) text = String(inlineBox.value || "").trim();
                try { dlg.close(b.value || "cancel"); } catch (e) { settle(); }
            });
            buttonBox.appendChild(btn);
        }
        dlg.addEventListener("close", settle, { once: true });
        try {
            if (native) dlg.uxpShowModal({ title, resize: "both", size }).then(settle, settle);
            else dlg.showModal();
        } catch (e) {
            settle();
        }
    });
}

// ---------- step 3: Subject Placement handlers ----------

if (el.modeAuto) {
    el.modeAuto.addEventListener("click", () => setPlacementMode("auto"));
    el.modeFrames.addEventListener("click", () => setPlacementMode("frames"));
    el.btnAddFrames.addEventListener("click", () => addFrames(false));
    el.btnSaveFrames.addEventListener("click", saveFrames);
    el.btnResetFrames.addEventListener("click", async () => {
        const go = await showDialog("Reset Frames?",
            "Every layout gets a new default red frame — frames you moved or resized are replaced.",
            [{ label: "Reset Frames", value: "go", danger: true }]);
        if (go === "go") await addFrames(true);
    });
}

// Draws default red subject frames in the Template Set (keeps existing ones
// unless reset), opens the template in front so they can be adjusted.
async function addFrames(reset) {
    if (!render || !templatePaths.length) return;
    setBusy(true);
    el.framesSummary.textContent = reset ? "Replacing the red frames…" : "Adding red frames to the template…";
    try {
        if (!(await waitForInDesign())) throw new Error(NOT_READY);
        const r = await render.addDefaultSubjectFrames(templatePaths[0], { reset });
        const added = r.pages.filter((p) => p.action !== "kept").length;
        const kept = r.pages.length - added;
        const lines = [
            added ? `✓ ${added} red frame${added === 1 ? "" : "s"} ${reset ? "replaced" : "added"} in ${r.name}` : `✓ Every layout of ${r.name} already has a red frame`,
        ];
        if (kept && added) lines.push(`${kept} layout${kept === 1 ? "" : "s"} kept ${kept === 1 ? "its" : "their"} frame`);
        const onParent = r.pages.filter((p) => p.onParent).length;
        if (onParent) lines.push(`⚠ ${onParent} frame${onParent === 1 ? " is" : "s are"} on a parent (master) page — change ${onParent === 1 ? "it" : "them"} there`);
        lines.push("Now move or resize the red frames in the template (it's open in InDesign), then click Save Frame Changes.");
        if (r.hadEdits) lines.push("The template had other unsaved changes, so it wasn't saved — check it, then click Save Frame Changes.");
        else if (!r.saved) lines.push("⚠ The template couldn't be saved — press Cmd+S in InDesign.");
        el.framesSummary.textContent = lines.join("\n");
    } catch (e) {
        el.framesSummary.textContent = errorText(e);
    } finally {
        setBusy(false);
    }
}

// "Save Frame Changes": saves the open template so the next Generate /
// Regenerate uses the moved red frames (Generate reads the template from disk).
async function saveFrames() {
    if (!render || !templatePaths.length) return;
    setBusy(true);
    try {
        if (!(await waitForInDesign())) throw new Error(NOT_READY);
        const r = await render.saveTemplate(templatePaths[0]);
        const name = templatePaths[0].split("/").pop();
        el.framesSummary.textContent = !r.open
            ? `${name} isn't open in InDesign — nothing to save. Click Add Default Frames to open it with its red frames.`
            : r.saved
                ? `✓ Frame changes saved in ${name}. Click Generate All (or ⋯ → Regenerate .indd) to apply them.`
                : `✓ No unsaved changes in ${name} — the red frames are up to date. Click Generate All to apply them.`;
    } catch (e) {
        el.framesSummary.textContent = "Couldn't save the template: " + errorText(e) + " — press Cmd+S in InDesign.";
    } finally {
        setBusy(false);
        pollTemplateFrames();
    }
}

// Every second (Custom Subject Frames only): warn while the template has
// unsaved changes, so moved frames aren't forgotten.
function pollTemplateFrames() {
    if (!el.framesUnsaved || !render || typeof render.templateState !== "function") return;
    let unsaved = false;
    if (!busy && placementMode() === "frames" && templatePaths.length) {
        try { unsaved = render.templateState(templatePaths[0]).modified; } catch (e) {}
    }
    setClass(el.framesUnsaved, "hidden", !unsaved);
    setClass(el.btnSaveFrames, "btn-attention", unsaved);
}

setInterval(pollTemplateFrames, 1000);

// ---------- step 3: subject detection source (Capsule JSON / Backend API) ----------
//
// Capsule JSON (default): the subject box comes from the JSON Adobe Capsule
// downloads per photo (capsule.js, <output>/capsule_subjects.json). The
// backend API is never called in this mode. Backend API: the original
// automatic detection. Either way the SAME placement runs (Auto Placement or
// Custom Subject Frames above).

function subjectSource() {
    return recall(STORE.subjectSource) === "api" ? "api" : "capsule";
}

function showSubjectSource() {
    if (!el.srcCapsule) return;
    const capsule = subjectSource() === "capsule";
    setClass(el.srcCapsule, "source-selected", capsule);
    setClass(el.srcApi, "source-selected", !capsule);
    setClass(el.capsuleActions, "hidden", !capsule);
}

let capsuleStore = null; // capsule.js store of the output folder, or null

async function loadCapsule() {
    capsuleStore = null;
    if (!capsuleMod || !outputEntry) return null;
    try { capsuleStore = await capsuleMod.loadCapsuleStore(outputEntry.nativePath); } catch (e) { capsuleStore = null; }
    return capsuleStore;
}

function capsuleEntryFor(rec) {
    return capsuleStore && rec && rec.imagePath ? capsuleStore.items[capsuleMod.storeKey(rec.imagePath)] || null : null;
}

function matchedPhotos() {
    return manifestRows.filter((r) => r.status === "matched" && r.imagePath).map((r) => r.imagePath);
}

// "A6 Avant/car_01.jpg" — enough to tell photos apart in a list.
function photoLabel(path) {
    return String(path || "").split("/").slice(-2).join("/");
}

function setCapsuleMessage(text) {
    if (!el.capsuleMessage) return;
    el.capsuleMessage.textContent = text || "";
    setClass(el.capsuleMessage, "has-message", !!text);
}

// Capsule status of every matched photo: Map(storeKey → "auto"|"manual"|"missing"|"stale").
async function capsuleStatuses(rows) {
    const out = new Map();
    for (const rec of rows || []) {
        if (rec.status !== "matched" || !rec.imagePath) continue;
        const key = capsuleMod.storeKey(rec.imagePath);
        if (out.has(key)) continue;
        const entry = capsuleEntryFor(rec);
        const fp = entry ? await capsuleMod.photoFingerprint(rec.imagePath) : null;
        out.set(key, capsuleMod.entryStatus(entry, fp));
    }
    return out;
}

async function refreshCapsuleSummary() {
    if (!el.capsuleSummary) return;
    if (subjectSource() !== "capsule") { el.capsuleSummary.textContent = ""; return; }
    if (!capsuleMod) { el.capsuleSummary.textContent = "capsule.js failed to load — see the banner above."; return; }
    if (!outputEntry) { el.capsuleSummary.textContent = "Select the output folder (step 1) first — Capsule data is saved there."; return; }
    if (!capsuleStore) await loadCapsule();
    if (capsuleStore && capsuleStore.error) { el.capsuleSummary.textContent = "⚠ " + capsuleStore.error; return; }
    const stored = capsuleStore ? Object.keys(capsuleStore.items).length : 0;
    if (!hasMatchedRows()) {
        fillPastePhotos(null);
        el.capsuleSummary.textContent = `Capsule data for ${stored} photo${stored === 1 ? "" : "s"} in this output folder — Match (step 4) to see which products still need it.`;
        return;
    }
    const st = await capsuleStatuses(manifestRows);
    const n = { auto: 0, manual: 0, missing: 0, stale: 0 };
    for (const v of st.values()) n[v]++;
    const ok = n.auto + n.manual;
    const parts = [`Capsule data: ${ok} of ${st.size} photo${st.size === 1 ? "" : "s"}`];
    if (n.manual) parts.push(`${n.manual} adjusted`);
    if (n.missing) parts.push(`⚠ ${n.missing} Missing Detection Data`);
    if (n.stale) parts.push(`⚠ ${n.stale} photo${n.stale === 1 ? "" : "s"} changed since import`);
    el.capsuleSummary.textContent = parts.join(" · ");
    fillPastePhotos(st);
}

function setSubjectSource(source) {
    if (busy) return;
    remember(STORE.subjectSource, source === "api" ? "api" : "capsule");
    showSubjectSource();
    refreshCapsuleSummary();
}

if (el.srcCapsule) {
    el.srcCapsule.addEventListener("click", () => setSubjectSource("capsule"));
    el.srcApi.addEventListener("click", () => setSubjectSource("api"));
    el.btnCapsuleImport.addEventListener("click", () => importCapsuleFiles());
    if (el.btnCapsulePaste) el.btnCapsulePaste.addEventListener("click", () => pasteFromClipboard());
    if (el.capsulePasteText) {
        el.capsulePasteText.addEventListener("input", () => updatePasteState());
        el.capsulePasteText.addEventListener("change", () => updatePasteState());
        el.capsulePastePhoto.addEventListener("change", () => updatePasteState());
        el.btnCapsulePasteImport.addEventListener("click", () => importPasted());
    }
}

// Before Generate / Regenerate in Capsule mode: photos without valid
// Capsule data are named, and only placed (with the original default
// placement, marked Review / Missing Detection Data) when the designer says
// so. Never falls back to the backend API. Returns true to go on.
async function confirmCapsuleCoverage(rows) {
    if (subjectSource() !== "capsule") return true;
    if (!capsuleMod) {
        const go = await showDialog("Missing Detection Data", "capsule.js failed to load, so no Capsule data can be used. " +
            "Products would be placed with the original default placement and marked Review.",
            [{ label: "Continue with Default Placement", value: "go", danger: true }]);
        return go === "go";
    }
    await loadCapsule();
    const st = await capsuleStatuses(rows);
    const byStatus = (s) => (rows || []).filter((r) => r.status === "matched" && r.imagePath && st.get(capsuleMod.storeKey(r.imagePath)) === s);
    const missing = byStatus("missing"), stale = byStatus("stale");
    if (!missing.length && !stale.length) return true;
    const list = (rs) => rs.slice(0, 8).map((r) => `• ${r.headline} — ${photoLabel(r.imagePath)}`).join("\n") + (rs.length > 8 ? `\n…and ${rs.length - 8} more` : "");
    const lines = [];
    if (capsuleStore && capsuleStore.error) lines.push("⚠ " + capsuleStore.error + "\n");
    if (missing.length) lines.push(`${missing.length} product${missing.length === 1 ? " has" : "s have"} no Capsule JSON for the photo:\n${list(missing)}`);
    if (stale.length) lines.push(`${stale.length} photo${stale.length === 1 ? "" : "s"} changed after the Capsule JSON was imported:\n${list(stale)}`);
    lines.push("\nYou can continue with the original plugin's default placement (no subject box). These products are marked Review — Missing Detection Data. The backend API is not used.");
    const answer = await showDialog("Missing Detection Data", lines.join("\n\n"), [
        { label: "Import Capsule JSON Files…", value: "import" },
        { label: "Continue with Default Placement", value: "go", danger: true },
    ]);
    if (answer === "import") { await importCapsuleFiles(); return false; }
    return answer === "go";
}

async function pickJsonFiles(multiple) {
    const picked = await fs.getFileForOpening({ allowMultiple: !!multiple, types: ["json"] });
    if (!picked) return [];
    return Array.isArray(picked) ? picked : (typeof picked.length === "number" && !picked.nativePath ? Array.from(picked) : [picked]);
}

// The matched photos; when Match hasn't run yet, matches first (same as the
// Match button). null (with a message in step 3) when there are none.
async function ensureMatchedPhotos() {
    let photos = matchedPhotos();
    if (!photos.length && excelEntry && photosEntry && matcher) {
        setCapsuleMessage("Matching products to photos first…");
        setBusy(true);
        try {
            manifestRows = await matcher.buildManifest(excelEntry, photosEntry);
            await refreshProducts();
        } catch (e) {
            setCapsuleMessage("Match failed: " + errorText(e));
            return null;
        } finally {
            setBusy(false);
        }
        setCapsuleMessage("");
        await refreshCapsuleSummary();
        photos = matchedPhotos();
    }
    if (!photos.length) {
        setCapsuleMessage(excelEntry && photosEntry ? "No product could be matched to a photo — check the Excel file and the photos folder (step 1)."
            : "Select the Excel file and the photos folder (step 1) first, so the plugin knows which photo each product uses.");
        return null;
    }
    return photos;
}

// Step 3 → Import JSON Files…: several JSONs at once, each paired
// with a matched photo by FILE NAME only (car_01.json → car_01.jpg). Nothing
// ambiguous, unmatched or duplicated is imported; the pairing is confirmed first.
async function importCapsuleFiles() {
    if (!capsuleMod) { setCapsuleMessage("capsule.js failed to load — see the banner above."); return; }
    if (!outputEntry) { setCapsuleMessage("Select the output folder (step 1) first — Capsule data is saved there."); return; }
    const photos = await ensureMatchedPhotos();
    if (!photos) return;
    let files;
    try { files = await pickJsonFiles(true); } catch (e) { setCapsuleMessage(errorText(e)); return; }
    if (!files.length) return;
    await loadCapsule();
    if (capsuleStore && capsuleStore.error) { setCapsuleMessage("⚠ " + capsuleStore.error + " — nothing imported."); return; }
    const m = capsuleMod.matchJsonFilesToPhotos(files.map((x) => x.nativePath), photos);
    const name = (p) => String(p).split("/").pop();
    const lines = [];
    if (m.matched.length) lines.push(`${m.matched.length} file${m.matched.length === 1 ? "" : "s"} match a photo:\n` +
        m.matched.slice(0, 10).map((x) => `• ${name(x.json)} → ${photoLabel(x.photo)}`).join("\n") + (m.matched.length > 10 ? `\n…and ${m.matched.length - 10} more` : ""));
    const skipped = [];
    for (const j of m.unmatched) skipped.push(`• ${name(j)} — no matched photo with that name`);
    for (const a of m.ambiguous) skipped.push(`• ${name(a.json)} — ${a.photos.length} photos have that name (use ⋯ → Paste / Import Capsule JSON per product)`);
    for (const d of m.duplicates) skipped.push(`• ${d.jsons.map(name).join(" + ")} — several files for ${photoLabel(d.photo)}`);
    if (skipped.length) lines.push("Not imported:\n" + skipped.join("\n"));
    if (!m.matched.length) {
        await showDialog("Import Capsule JSON", lines.join("\n\n") || "No file matched a photo.", []);
        return;
    }
    const st = new Map();
    for (const x of m.matched) st.set(x.photo, capsuleMod.entryStatus(capsuleStore.items[capsuleMod.storeKey(x.photo)], null));
    const replacing = m.matched.filter((x) => st.get(x.photo) !== "missing").length;
    const withEdits = m.matched.filter((x) => st.get(x.photo) === "manual").length;
    if (replacing) lines.push(`${replacing} photo${replacing === 1 ? " already has" : "s already have"} Capsule data — it will be replaced` +
        (withEdits ? `; ${withEdits} of them ${withEdits === 1 ? "has" : "have"} your adjustments.` : "."));
    const buttons = withEdits
        ? [{ label: "Import — Keep My Adjustments", value: "keep" }, { label: "Import — Discard My Adjustments", value: "drop", danger: true }]
        : [{ label: `Import ${m.matched.length} File${m.matched.length === 1 ? "" : "s"}`, value: "keep" }];
    const answer = await showDialog("Import Capsule JSON", lines.join("\n\n"), buttons);
    if (answer !== "keep" && answer !== "drop") return;
    const done = [], failed = [], notes = [];
    for (const x of m.matched) {
        const r = await capsuleMod.importFile(capsuleStore, x.photo, x.json, answer === "keep");
        if (r.ok) { done.push(x); for (const w of r.warnings) notes.push(`${photoLabel(x.photo)}: ${w}`); }
        else failed.push(`✗ ${name(x.json)}: ${r.errors.join("; ")}`);
    }
    try {
        if (done.length) await capsuleMod.saveCapsuleStore(capsuleStore);
    } catch (e) {
        setCapsuleMessage("Couldn't save the Capsule data: " + errorText(e));
        await loadCapsule();
        return;
    }
    setCapsuleMessage([`✓ Imported ${done.length} Capsule JSON file${done.length === 1 ? "" : "s"}` +
        (failed.length ? ` · ✗ ${failed.length} rejected` : "") + (done.length ? " — Generate (or ⋯ → Regenerate .indd) to apply." : "")]
        .concat(failed.slice(0, 5), notes.slice(0, 5).map((n) => "Note — " + n), skipped.length ? [`${skipped.length} file(s) not imported (see the list before).`] : []).join("\n"));
    await refreshCapsuleSummary();
    renderTable();
}

// Before new Capsule data replaces a photo's data: true = keep the
// designer's adjustments, false = discard them, null = Cancel.
async function confirmReplaceCapsule(imagePath) {
    const old = capsuleStore && capsuleStore.items[capsuleMod.storeKey(imagePath)];
    if (!old) return true;
    const edited = capsuleMod.entryStatus(old, null) === "manual";
    const answer = await showDialog("Replace Capsule data?",
        `${photoLabel(imagePath)} already has Capsule data (from ${old.auto.sourceFile || "an earlier import"}).` +
        (edited ? "\n\nYou adjusted the box or focal point for this photo." : ""),
        edited ? [{ label: "Replace — Keep My Adjustments", value: "keep" }, { label: "Replace — Discard My Adjustments", value: "drop", danger: true }]
            : [{ label: "Replace", value: "keep" }]);
    if (answer !== "keep" && answer !== "drop") return null;
    return answer === "keep";
}

// ---------- Step 3 → Paste Capsule JSON (the box under the button) ----------
// The JSON copied from the Capsule workflow's Preview node. Pasted text has no
// file name, so the photo is never guessed: the designer chooses it in the
// list ("Choose the photo…" until then) before Import for This Photo.

// The photo list: one entry per matched photo, with its products and status.
//   st: capsuleStatuses() Map, or null (not matched yet)
function fillPastePhotos(st) {
    const sel = el.capsulePastePhoto;
    if (!sel || !capsuleMod) return;
    const current = pasteSelectedPhoto();
    const choices = [];
    const seen = new Set();
    for (const r of st ? manifestRows : []) {
        if (r.status !== "matched" || !r.imagePath) continue;
        const key = capsuleMod.storeKey(r.imagePath);
        if (seen.has(key)) continue;
        seen.add(key);
        const names = manifestRows.filter((x) => x.status === "matched" && x.imagePath && capsuleMod.storeKey(x.imagePath) === key).map((x) => x.headline).filter(Boolean);
        const status = st.get(key) || "missing";
        choices.push({ imagePath: r.imagePath, label: (names.length ? names.slice(0, 2).join(", ") + (names.length > 2 ? ` +${names.length - 2}` : "") + " — " : "") +
            photoLabel(r.imagePath) + (status === "missing" ? " · no data" : status === "stale" ? " · photo changed" : " · has data") });
    }
    sel.innerHTML = "";
    const add = (value, label) => {
        const o = document.createElement("option");
        o.setAttribute("value", value);
        o.textContent = label;
        sel.appendChild(o);
    };
    add("", choices.length ? "Choose the photo this JSON was made from…" : "No matched photos yet — Match (step 4) first");
    for (const c of choices) add(c.imagePath, c.label);
    try { sel.value = choices.some((c) => c.imagePath === current) ? current : ""; } catch (e) {}
    updatePasteState(true);
}

function pasteSelectedPhoto() {
    try { return el.capsulePastePhoto ? String(el.capsulePastePhoto.value || "") : ""; } catch (e) { return ""; }
}

// Status line + Import button. A valid paste before Match runs Match (once),
// so the photo list fills. noMatch: don't start Match (from setBusy etc.).
let pasteMatching = false;
function updatePasteState(noMatch) {
    if (!el.capsulePasteText || !capsuleMod || !capsulePaste) return null;
    const state = capsulePaste.pasteState(el.capsulePasteText.value, capsuleMod.parseCapsuleJson, capsuleMod.cleanPastedText);
    const photo = pasteSelectedPhoto();
    let text = capsulePaste.pasteStatusText(state);
    if (state.ok && !photo && hasMatchedRows()) text += "\n→ Choose the photo it was made from, then Import for This Photo.";
    el.capsulePasteStatus.textContent = text;
    el.capsulePasteStatus.className = "paste-status" + (state.ok ? " paste-ok" : state.empty ? "" : " paste-bad");
    el.btnCapsulePasteImport.disabled = busy || !outputEntry || !state.ok || !photo;
    if (!noMatch && state.ok && !hasMatchedRows() && !pasteMatching && !busy && excelEntry && photosEntry) {
        pasteMatching = true;
        ensureMatchedPhotos().finally(() => { pasteMatching = false; });
    }
    return state;
}

// Paste Capsule JSON: the clipboard into the box (⌘V in the box works too).
async function pasteFromClipboard() {
    if (!capsulePaste || !el.capsulePasteText) return;
    let text = "";
    try { text = await capsulePaste.readClipboardText(); } catch (e) {
        setCapsuleMessage("Couldn't read the clipboard — click in the box below and press ⌘V.");
        return;
    }
    if (!String(text || "").trim()) { setCapsuleMessage("The clipboard is empty — click Copy on the Capsule workflow's Preview node first."); return; }
    setCapsuleMessage("");
    el.capsulePasteText.value = text;
    updatePasteState();
    try { el.capsulePasteText.focus(); } catch (e) {}
}

// Import for This Photo
async function importPasted() {
    if (!capsuleMod || !capsulePaste) { setCapsuleMessage("capsule.js / capsulepaste.js failed to load — see the banner above."); return; }
    if (!outputEntry) { setCapsuleMessage("Select the output folder (step 1) first — Capsule data is saved there."); return; }
    const state = updatePasteState(true);
    if (!state || !state.ok) return;
    const imagePath = pasteSelectedPhoto();
    if (!imagePath) { setCapsuleMessage("Choose the photo this JSON was made from."); return; }
    await loadCapsule();
    if (capsuleStore && capsuleStore.error) { setCapsuleMessage("⚠ " + capsuleStore.error + " — nothing imported."); return; }
    const keep = await confirmReplaceCapsule(imagePath);
    if (keep === null) return;
    const r = await capsuleMod.importText(capsuleStore, imagePath, capsuleMod.cleanPastedText(el.capsulePasteText.value), capsuleMod.pastedLabel(), keep);
    if (!r.ok) {
        await loadCapsule(); // drop the unsaved in-memory change
        setCapsuleMessage("✗ The pasted JSON was not imported:\n• " + r.errors.join("\n• "));
        return;
    }
    try { await capsuleMod.saveCapsuleStore(capsuleStore); } catch (e) {
        setCapsuleMessage("Couldn't save the Capsule data: " + errorText(e));
        await loadCapsule();
        return;
    }
    const users = manifestRows.filter((x) => x.status === "matched" && x.imagePath && capsuleMod.storeKey(x.imagePath) === capsuleMod.storeKey(imagePath));
    const anyIndd = users.some((x) => { const p = products.get(x); return p && p.exists; });
    setCapsuleMessage([`✓ Capsule data pasted for ${photoLabel(imagePath)}` + (users.length ? ` (${users.map((x) => x.headline).join(", ")})` : "") +
        (anyIndd ? " — ⋯ → Edit Subject Placement to check it, Regenerate .indd to apply it." : " — check it with ⋯ → Edit Subject Placement; applied on Generate.")]
        .concat(r.warnings.map((w) => "Note — " + w)).join("\n"));
    el.capsulePasteText.value = "";
    try { el.capsulePastePhoto.value = ""; } catch (e) {}
    await refreshCapsuleSummary();
    updatePasteState(true);
    renderTable();
}

// ⋯ → Paste Capsule JSON: selects this product's photo in the step 3 box.
async function pasteForRow(rec) {
    await refreshCapsuleSummary();
    try { el.capsulePastePhoto.value = rec.imagePath; } catch (e) {}
    updatePasteState(true);
    try { el.capsulePasteText.focus(); } catch (e) {}
    setMessage(`Paste the Capsule JSON into the box in step 3 — ${photoLabel(rec.imagePath)} (${rec.headline}) is selected there.`, channels.generate);
}

// ⋯ → Import Capsule JSON File…: one JSON for THIS product's photo. A file named
// differently from the photo is only used after an explicit confirmation.
async function importCapsuleForRow(rec) {
    if (!capsuleMod) { setMessage("capsule.js failed to load — see the banner above.", channels.generate); return; }
    if (!outputEntry) { setMessage("Select the output folder (step 1) first — Capsule data is saved there.", channels.generate); return; }
    let files;
    try { files = await pickJsonFiles(false); } catch (e) { setMessage(errorText(e), channels.generate); return; }
    if (!files.length) return;
    const jsonPath = files[0].nativePath;
    const jsonName = String(jsonPath).split("/").pop();
    if (capsuleMod.baseName(jsonPath) !== capsuleMod.baseName(rec.imagePath)) {
        const go = await showDialog("Use this JSON for this photo?",
            `The file "${jsonName}" is named differently from the photo "${photoLabel(rec.imagePath)}".\n\n` +
            "Only continue if this JSON was made from this exact photo — a box from another photo would place the product wrongly.",
            [{ label: "Use for This Photo", value: "go", danger: true }]);
        if (go !== "go") return;
    }
    await loadCapsule();
    if (capsuleStore && capsuleStore.error) { setMessage("⚠ " + capsuleStore.error + " — nothing imported.", channels.generate); return; }
    const keep = await confirmReplaceCapsule(rec.imagePath);
    if (keep === null) return;
    const r = await capsuleMod.importFile(capsuleStore, rec.imagePath, jsonPath, keep);
    if (!r.ok) {
        await loadCapsule(); // drop the unsaved in-memory change
        setMessage(`✗ ${jsonName} was not imported:\n• ` + r.errors.join("\n• "), channels.generate);
        return;
    }
    try { await capsuleMod.saveCapsuleStore(capsuleStore); } catch (e) {
        setMessage("Couldn't save the Capsule data: " + errorText(e), channels.generate);
        await loadCapsule();
        return;
    }
    const p = products.get(rec);
    setMessage([`✓ Capsule data imported for ${rec.headline} (${jsonName})` +
        (p && p.exists ? " — ⋯ → Edit Subject Placement to check it, Regenerate .indd to apply it." : " — applied on Generate.")]
        .concat(r.warnings.map((w) => "Note — " + w)).join("\n"), channels.generate);
    await refreshCapsuleSummary();
    renderTable();
}

// ⋯ → Keep Capsule Data for Changed Photo
async function acceptChangedPhotoRow(rec) {
    await loadCapsule();
    if (!capsuleEntryFor(rec)) return;
    const go = await showDialog("Keep Capsule data?",
        `${photoLabel(rec.imagePath)} changed after its Capsule JSON was imported. Keep the data only if the photo still shows the product at the same place (e.g. it was only re-saved).`,
        [{ label: "Keep Data for the Changed Photo", value: "go", danger: true }]);
    if (go !== "go") return;
    capsuleMod.acceptChangedPhoto(capsuleStore, rec.imagePath, await capsuleMod.photoFingerprint(rec.imagePath));
    try { await capsuleMod.saveCapsuleStore(capsuleStore); } catch (e) { setMessage("Couldn't save the Capsule data: " + errorText(e), channels.generate); return; }
    setMessage(`✓ Capsule data kept for ${rec.headline} — Regenerate .indd to apply it.`, channels.generate);
    await refreshCapsuleSummary();
    renderTable();
}

// Image Extension results on a product (any page, shown or hidden).
function hasExtensionResults(s) {
    const image = (s && s.image) || {};
    return !!image.extension || EXTENDED.indexOf(image.status) !== -1 || image.status === "extension_hidden" || (image.versions || []).length > 0;
}

const EXTENSION_AFTER_SUBJECT_CHANGE = "Extension results from before the subject change exist — extend again or validate them before Commit";

// ⋯ → Edit Subject Placement…: the editor window, then (on Apply) save the
// edit and rebuild the affected product INDDs with the EXISTING Regenerate.
async function editSubjectRow(rec) {
    if (!capsuleMod || !capsuleEditor || !render) { setMessage("capsule.js / capsuleeditor.js failed to load — see the banner above.", channels.generate); return; }
    if (!templatePaths.length) { setMessage("Prepare the template first (step 2) — the preview needs its layouts.", channels.generate); return; }
    await loadCapsule();
    const entry = capsuleEntryFor(rec);
    const status = capsuleMod.entryStatus(entry, entry ? await capsuleMod.photoFingerprint(rec.imagePath) : null);
    if (status === "missing") { setMessage(`${rec.headline}: paste the Capsule JSON in step 3 or import it (⋯ → Import Capsule JSON File…).`, channels.generate); return; }
    if (status === "stale") {
        const a = await showDialog("Photo changed", `${photoLabel(rec.imagePath)} changed after its Capsule JSON was imported.`,
            [{ label: "Import New JSON…", value: "import" }, { label: "Keep Data for the Changed Photo…", value: "keep" }]);
        if (a === "import") await importCapsuleForRow(rec);
        if (a === "keep") await acceptChangedPhotoRow(rec);
        return;
    }
    const p = products.get(rec);
    let pixelSize = entry.pixelSize;
    if (!pixelSize) { try { pixelSize = (await capsuleMod.photoHeaderInfo(rec.imagePath)).pixelSize; } catch (e) {} }
    if (!pixelSize) { setMessage(`${rec.headline}: the photo's pixel size can't be read (JPG / PNG / WebP only).`, channels.generate); return; }
    let geometry;
    setBusy(true);
    startProgress(channels.generate, "Reading", `Reading the layouts of ${rec.headline}…`);
    try {
        if (!(await waitForInDesign())) throw new Error(NOT_READY);
        geometry = await render.readPlacementGeometry(p && p.exists ? p.inddPath : "", templatePaths[0]);
    } catch (e) {
        setMessage("Couldn't read the layouts: " + errorText(e), channels.generate);
        return;
    } finally {
        setBusy(false);
    }
    const layouts = geometry.pages.map((pg) => ({ layoutId: pg.layoutId, label: `${pg.layout.size} ${pg.layout.position} (page ${pg.page})` }));
    const edited = Object.keys(entry.layouts || {});
    const currentLayoutId = (layouts.find((l) => edited.indexOf(l.layoutId) !== -1) || layouts[0] || {}).layoutId || "";
    const framesMode = placementMode() === "frames";
    const subjectFor = (v) => ({ box: v.boundingBox, source: "capsule-manual", wholePhoto: capsuleMod.isWholePhotoBox(v.boundingBox),
        focalPoint: v.focalPoint, capsule: { boxSource: "edited" } });
    const info = [
        `Photo: ${photoLabel(rec.imagePath)} (${pixelSize.width} × ${pixelSize.height} px) · imported from ${entry.auto.sourceFile || "Capsule JSON"}` +
            (entry.auto.importedAt ? ` on ${shortTime(entry.auto.importedAt)}` : ""),
        status === "manual" ? `Adjusted${edited.length ? ` (layout-specific: ${edited.join(", ")})` : ""} — Reset to Auto brings back the imported values.` : "As imported from Capsule.",
    ].concat((entry.auto.warnings || []).map((w) => "Note — " + w));
    const result = await capsuleEditor.showCapsuleEditor({
        title: `Edit Subject Placement — ${rec.headline}`,
        imagePath: rec.imagePath, pixelSize,
        auto: { boundingBox: entry.auto.boundingBox, focalPoint: entry.auto.focalPoint },
        current: capsuleMod.effectiveValues(entry, currentLayoutId),
        info, layouts, currentLayoutId,
        preview: (v) => geometry.pages.map((pg) => Object.assign({ layoutId: pg.layoutId }, render.previewPlacementForPage(pg, subjectFor(v), pixelSize, framesMode))),
        previewNote: (geometry.source === "product" ? "Layouts of the generated product INDD (saved version)." : "Layouts of the Template Set — text areas from its placeholder text; generate the product for its real text.") +
            ` Placement: ${framesMode ? "Custom Subject Frames" : "Auto Placement"}.`,
    });
    if (!result) return;
    await applyCapsuleEdit(rec, result, layouts);
}

// Saves an editor result and (if the designer agrees) regenerates every
// product that uses this photo — with the existing Regenerate warnings plus
// what would be lost: completed (Committed / Exported) artwork and Image
// Extension results made for the old placement. The Template Set is never changed.
async function applyCapsuleEdit(rec, result, layouts) {
    const key = capsuleMod.storeKey(rec.imagePath);
    const affected = manifestRows.filter((r) => r.status === "matched" && r.imagePath && capsuleMod.storeKey(r.imagePath) === key);
    const existing = affected.filter((r) => products.get(r) && products.get(r).exists);
    const layoutLabel = result.layoutId ? ((layouts || []).find((l) => l.layoutId === result.layoutId) || { label: result.layoutId }).label : "";
    const names = (rs) => rs.slice(0, 6).map((r) => r.headline).join(", ") + (rs.length > 6 ? ` …(+${rs.length - 6})` : "");
    const completed = existing.filter((r) => { const s = getStatus(products.get(r).inddPath); return !!(s && (s.committedAt || s.exportedAt)); });
    const extended = existing.filter((r) => hasExtensionResults(getStatus(products.get(r).inddPath)));
    if (!(await stopIfUnsaved(existing))) return;
    const open = [];
    for (const r of existing) if ((await render.inddOpenState(products.get(r).inddPath)).open) open.push(r);
    const lines = [`Subject change for ${photoLabel(rec.imagePath)} — ${result.action === "apply_layout" ? `layout ${layoutLabel} only` : "all layouts"}.`,
        `Products using this photo: ${names(affected)}.`];
    if (existing.length) lines.push("Regenerating will replace the current INDD and may discard manual edits.");
    if (completed.length) lines.push(`⚠ Completed artwork: ${names(completed)} ${completed.length === 1 ? "is" : "are"} Committed / Exported. Regenerating sends ${completed.length === 1 ? "it" : "them"} back for review — commit and export again. JPGs already exported are not deleted.`);
    if (extended.length) lines.push(`⚠ Image Extension results exist for ${names(extended)}. They were made for the old placement: the regenerated INDD starts without them — extend again (or check Use Existing Extension) before Commit.`);
    if (open.length) lines.push(`Open in InDesign (no unsaved changes): ${names(open)} — closed first.`);
    if (existing.length) lines.push("A copy of every INDD that is replaced is kept in InDesign/_backup/<date_time>/ in the output folder.");
    lines.push("The Template Set is not changed. Save Only keeps the INDDs as they are until the next Generate / Regenerate.");
    const answer = await showDialog("Apply subject change?", lines.join("\n\n"), [
        { label: existing.length ? "Save & Regenerate" : "Save & Generate", value: "go", danger: existing.length > 0 },
        { label: "Save Only", value: "save" },
    ]);
    if (answer !== "go" && answer !== "save") { setMessage(`${rec.headline}: subject change discarded — nothing saved.`, channels.generate); return; }
    await loadCapsule();
    try {
        if (!capsuleMod.saveEdit(capsuleStore, rec.imagePath, result.values, result.layoutId || "")) throw new Error("no Capsule data for this photo");
        await capsuleMod.saveCapsuleStore(capsuleStore);
    } catch (e) {
        setMessage("Couldn't save the subject change: " + errorText(e), channels.generate);
        await loadCapsule();
        return;
    }
    await refreshCapsuleSummary();
    if (answer === "save") {
        setMessage(`✓ Subject change saved for ${photoLabel(rec.imagePath)} — applied on the next Generate / Regenerate .indd.`, channels.generate);
        renderTable();
        return;
    }
    let backup = null;
    try {
        backup = await render.backupIndds(existing.map((r) => products.get(r).inddPath), outputEntry.nativePath);
    } catch (e) {
        setMessage(`✓ Subject change saved, but NOT regenerated: the backup of the current INDD(s) failed (${errorText(e)}).`, channels.generate);
        renderTable();
        return;
    }
    try {
        // closeIndd refuses an INDD that got unsaved changes since the check above.
        for (const r of open) await render.closeIndd(products.get(r).inddPath);
        const extendedPaths = extended.map((r) => products.get(r).inddPath.toLowerCase());
        const res = await runGenerate(affected, `Applying the subject change to ${affected.length} product(s)…`);
        for (const g of res.generated) {
            if (extendedPaths.indexOf(String(g.inddPath).toLowerCase()) === -1) continue;
            const s = getStatus(g.inddPath) || {};
            setStatus(g.inddPath, { status: "review", warnings: (s.warnings || []).concat([EXTENSION_AFTER_SUBJECT_CHANGE]) });
        }
        renderTable();
        if (res.generated.length === 1) { try { await render.openIndd(res.generated[0].inddPath); } catch (e) {} }
        summarize(res.generated.length ? `✓ Subject change applied — regenerated ${res.generated.length} INDD(s)` +
            (extended.length ? " · ⚠ re-check Image Extension" : "") : "✗ Regenerate failed", res, channels.generate,
            backup && backup.copied.length ? `Previous INDD(s) backed up to ${backup.folder}` : "");
    } catch (e) {
        setMessage(`✓ Subject change saved, but NOT regenerated: ${errorText(e)}`, channels.generate);
    }
}

// ---------- init ----------

async function init() {
    if (loadErrors.length) {
        el.loadErrorBanner.textContent = "⚠ Plugin module load error(s):\n" + loadErrors.join("\n");
        el.loadErrorBanner.classList.remove("banner-hidden");
    }
    await restoreSelections();
    if (!render) return; // font check needs render.js; skip if it failed to load

    if (!(await waitForInDesign())) {
        showFontBanner(NOT_READY);
        return;
    }
    const fontCheck = render.checkAudiFont();
    if (!fontCheck.ok) showFontBanner(fontCheck.message);
}

// ---------- Reload = full reset ----------
//
// Returns the panel to a clean start, as if just opened: forgets every
// selection (Excel / CSV, photos, template set, output folder), the matched
// rows, all product statuses, counts, progress and messages — including
// what's stored in localStorage to restore them. Files on disk (INDDs, JPGs,
// output) are NOT touched. After the reset, inputs must be selected and
// Match run again.
//
// The in-memory reset happens first, so the panel is clean even if
// location.reload() doesn't reload it; the reload then re-runs the scripts.
// The panel is already visible after a reload, so its show() callback may not
// fire again — the flag makes the reloaded script run init() itself.
const RELOAD_FLAG = "posterBatch.reloading";

function resetPanel() {
    for (const key of Object.values(STORE)) {
        try { localStorage.removeItem(key); } catch (e) {}
    }
    excelEntry = photosEntry = outputEntry = null;
    palette = null;
    paletteSelected = [];
    paletteExpanded = false;
    renderPalette();
    manifestRows = [];
    templatePaths = [];
    products = new Map();
    statuses = {};
    activeRec = null;
    el.excelPath.textContent = "No file selected";
    el.photosPath.textContent = "No folder selected";
    for (const node of [el.dmSummary, el.matchSummary, el.statusCounts]) {
        node.textContent = "";
    }
    for (const ch of Object.values(channels)) {
        setMessage("", ch);
        ch.fill.style.width = "0%";
        ch.label.textContent = "";
    }
    hideProgress();
    el.resultsBody.innerHTML = "";
    showContext();
    if (el.framesSummary) el.framesSummary.textContent = "";
    showPlacementMode();
    capsuleStore = null;
    if (el.capsuleSummary) el.capsuleSummary.textContent = "";
    setCapsuleMessage("");
    showSubjectSource();
    updateButtons();
}

el.btnReload.addEventListener("click", () => {
    if (busy) {
        setMessage("A run is still in progress — wait for it to finish, then reload.");
        return;
    }
    resetPanel();
    remember(RELOAD_FLAG, true);
    try { location.reload(); } catch (e) {}
});

// ---------- step 1: inputs ----------

el.btnExcel.addEventListener("click", async () => {
    let entry;
    try {
        entry = await fs.getFileForOpening({ types: ["xlsx"] });
    } catch (e) {
        el.excelPath.textContent = errorText(e);
        return;
    }
    if (!entry) return;
    excelEntry = entry;
    remember(STORE.excel, entry.nativePath);
    el.excelPath.textContent = entry.name;
    updateButtons();
});

el.btnPhotos.addEventListener("click", async () => {
    let entry;
    try {
        entry = await fs.getFolder();
    } catch (e) {
        el.photosPath.textContent = errorText(e);
        return;
    }
    if (!entry) return;
    photosEntry = entry;
    remember(STORE.photos, entry.nativePath);
    el.photosPath.textContent = entry.nativePath;
    updateButtons();
});

// ---------- step 1: color palette (optional, Auto Text Color) ----------
//
// An .ase palette; the selected swatches are the ONLY colours Auto Text
// Color may use for Headline/Subline. No palette or nothing selected → the
// template's own text colours are kept. Everything after this is automatic
// (render.js, per page, on the final composition).

let palette = null;          // { path, name, swatches } (colorpalette.js)
let paletteSelected = [];    // selected swatch ids
let paletteExpanded = false; // all swatches shown, or the first few
const PALETTE_VISIBLE = 5;

function rememberPalette() {
    remember(STORE.palette, palette ? { path: palette.path, selected: paletteSelected } : null);
}

// The selected swatches, for render.js ({ swatches } or null).
function textColorOptions() {
    if (!palette || !colorpalette) return null;
    const swatches = colorpalette.selectedSwatches(palette, paletteSelected);
    return swatches.length ? { swatches } : null;
}

function renderPalette() {
    el.paletteSwatches.innerHTML = "";
    if (!palette) {
        el.btnPalette.textContent = "Select Color Palette…";
        el.palettePath.textContent = "Optional — template text colours are kept";
        return;
    }
    el.btnPalette.textContent = "Change…";
    const n = paletteSelected.length;
    el.palettePath.textContent = `${palette.name} · ${n ? n + " selected" : "none selected — template colours kept"}`;
    const list = paletteExpanded ? palette.swatches : palette.swatches.slice(0, PALETTE_VISIBLE);
    for (const sw of list) {
        const b = document.createElement("div");
        b.className = "swatch" + (paletteSelected.indexOf(sw.id) !== -1 ? " selected" : "");
        b.style.backgroundColor = sw.hex;
        b.title = sw.name;
        b.addEventListener("click", () => {
            const i = paletteSelected.indexOf(sw.id);
            if (i === -1) paletteSelected.push(sw.id); else paletteSelected.splice(i, 1);
            rememberPalette();
            renderPalette();
        });
        el.paletteSwatches.appendChild(b);
    }
    const hidden = palette.swatches.length - PALETTE_VISIBLE;
    if (hidden > 0) {
        const more = document.createElement("div");
        more.className = "swatch-more";
        more.textContent = paletteExpanded ? "less" : `+${hidden}`;
        more.title = paletteExpanded ? "Show fewer swatches" : "Show all swatches";
        more.addEventListener("click", () => { paletteExpanded = !paletteExpanded; renderPalette(); });
        el.paletteSwatches.appendChild(more);
    }
}

async function loadPaletteFrom(path, selected) {
    palette = await colorpalette.loadPalette(path);
    const ids = new Set(palette.swatches.map((x) => x.id));
    paletteSelected = (selected || []).filter((id) => ids.has(id));
    rememberPalette();
    renderPalette();
}

async function restorePalette() {
    const saved = recall(STORE.palette);
    if (!saved || !saved.path || !colorpalette || !(await entryFor(saved.path))) { renderPalette(); return; }
    try { await loadPaletteFrom(saved.path, saved.selected); } catch (e) { palette = null; renderPalette(); }
}

el.btnPalette.addEventListener("click", async () => {
    if (!colorpalette) { el.palettePath.textContent = "colorpalette.js failed to load — see the banner above."; return; }
    let entry;
    try {
        entry = await fs.getFileForOpening({ types: ["ase"] });
    } catch (e) {
        el.palettePath.textContent = errorText(e);
        return;
    }
    if (!entry) return;
    try {
        await loadPaletteFrom(entry.nativePath, []);
    } catch (e) {
        palette = null;
        renderPalette();
        el.palettePath.textContent = "Couldn't read the palette: " + errorText(e) + " — template text colours are kept";
    }
});

// ---------- step 2: template (prepare) ----------

el.btnDmPrepare.addEventListener("click", async () => {
    if (!datamerge) {
        el.dmSummary.textContent = "datamerge.js failed to load — see the banner above.";
        return;
    }
    // Same Excel file as Match (step 1).
    const source = excelEntry;
    setBusy(true);
    el.dmSummary.textContent = "Saving a working copy and preparing it…";

    try {
        if (!(await waitForInDesign())) throw new Error(NOT_READY);
        // Data Merge only reads CSV/TXT: convert the Excel first. The photos
        // folder (step 1) fills @MainImage only if it's chosen already —
        // preparing the template never requires it.
        let csvPath = source.nativePath;
        if (/\.xlsx$/i.test(source.name)) {
            el.dmSummary.textContent = "Converting Excel to a Data Merge CSV…";
            const conv = await datamerge.excelToDataSource(source, photosEntry);
            csvPath = conv.csvPath;
            el.dmSummary.textContent = "Saving a working copy and preparing it…";
        }
        const result = await datamerge.prepareActiveDocument(csvPath);
        // The prepared copy becomes the template set Generate renders from.
        if (result.saved) {
            setTemplate(result.copyPath);
            await refreshProducts();
        }
        // Short, user-facing summary: one line per page. A page that failed
        // also shows what went wrong; full details stay out of the panel.
        const pageLines = result.pages.map((pg) => {
            if (pg.ok) return `✓ Page ${pg.page}` + (pg.zone ? " · red subject frame ▣" : "");
            const problems = pg.notes.filter((n) => n.startsWith("⚠")).map((n) => "    " + n.replace(/^⚠\s*/, ""));
            return [`⚠ Page ${pg.page}`].concat(problems).join("\n");
        });
        if (!result.saved) pageLines.push("⚠ The template couldn't be saved — press Cmd+S in InDesign.");
        // Layouts are discovered from the template itself — no fixed set.
        if (result.saved && render) {
            try {
                const t = await render.detectTemplateLayouts(result.copyPath);
                if (t.problems.length) pageLines.unshift("⚠ Template structure: " + t.problems.join("; "));
                else pageLines.unshift(t.detected);
            } catch (e) {
                pageLines.push("Layouts not checked: " + errorText(e));
            }
        }
        el.dmSummary.textContent = pageLines.join("\n");
    } catch (e) {
        el.dmSummary.textContent = errorText(e);
    } finally {
        setBusy(false);
    }
});

// ---------- step 1: output folder ----------

el.btnOutput.addEventListener("click", async () => {
    let entry;
    try {
        entry = await fs.getFolder();
    } catch (e) {
        el.outputPath.textContent = errorText(e);
        return;
    }
    if (!entry) return;
    outputEntry = entry;
    remember(STORE.output, entry.nativePath);
    showContext();
    await refreshProducts();
    await loadCapsule(); // Capsule data lives in the output folder
    setCapsuleMessage("");
    await refreshCapsuleSummary();
    renderTable();
    updateButtons();
});

// Where each matched product's INDD lives for the current template set and
// output folder, and whether it's on disk — so INDDs generated earlier (or
// before a Reload) show up with their remembered status.
async function refreshProducts() {
    products = new Map();
    if (!render || !outputEntry || !templatePaths.length) return;
    for (const rec of manifestRows) {
        if (rec.status !== "matched") continue;
        let found;
        try { found = render.inddPathFor(rec, templatePaths[0], outputEntry.nativePath); } catch (e) { continue; }
        products.set(rec, {
            inddPath: found.inddPath,
            subType: found.subType,
            exists: await render.pathExists(found.inddPath),
        });
    }
}

el.btnMatch.addEventListener("click", async () => {
    if (!matcher) {
        el.matchSummary.textContent = "matcher.js failed to load — see the banner above.";
        return;
    }
    setBusy(true);
    el.matchSummary.textContent = "Matching…";
    el.resultsBody.innerHTML = "";

    try {
        manifestRows = await matcher.buildManifest(excelEntry, photosEntry);
        await refreshProducts();
    } catch (e) {
        el.matchSummary.textContent = errorText(e);
    } finally {
        setBusy(false);
    }
    await refreshCapsuleSummary();
});

// ---------- product table ----------

const STATE_LABEL = {
    "ready": ["✓ Ready", "status-ready"],
    "committed": ["✓ Committed", "status-ready"],
    "exported": ["✓ Exported", "status-ready"],
    "review": ["⚠ Review", "status-review"],
    "failed": ["Failed", "status-failed"],
    "unchecked": ["Unchecked", "status-muted"],
    "not-generated": ["Not generated", "status-muted"],
    "no-asset": ["No asset", "status-muted"],
};

// Button labels, shared by the product list, the "Working in" bar and ⋯.
const LABEL = {
    open: "Open .indd",
    preview: "Preview Image Batch",
    commit: "Commit .indd",
    more: "⋯",
    extend: "Extend Image",
    reextend: "Re-extend Image",
    useExisting: "Use Existing Extension",
    hide: "Hide Extension",
    show: "Show Extension",
};

function div(className, text) {
    const d = document.createElement("div");
    if (className) d.className = className;
    if (text) d.textContent = text;
    return d;
}

function button(label, onClick, title) {
    const btn = document.createElement("button");
    btn.className = "btn-small";
    btn.textContent = label;
    btn.disabled = busy;
    if (title) btn.title = title;
    btn.addEventListener("click", onClick);
    return btn;
}

// "2026-10-13 14:20" — readable without relying on toLocaleString in UXP.
function shortTime(iso) {
    const d = new Date(iso);
    if (isNaN(d)) return "";
    const p = (n) => String(n).padStart(2, "0");
    return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
}

// Image Extension status of a product (worst page). The image warnings are
// shown by this line instead of the generic warning list.
const IMAGE_WARNING = /image (doesn't cover|needs review)|image \+ extension|image extension|Image check unavailable/i;
const EXTENDED = ["extended", "extended_cached", "re_extended"];
function versionText(image) {
    const v = (image.versions || []).map((x) => "v" + String(x.version).padStart(3, "0"));
    return v.length ? ` (${v.join(", ")})` : "";
}
// One short line per product; details live in ⋯ More actions and the logs.
function imageLine(image) {
    switch (image.status) {
        case "not_required": return ["detail-muted", "Image ✓ Covered"];
        case "extension_available":
        case "extension_required":
        case "awaiting_user":
        case "skipped": return ["detail-warning", "Image ↗ Extension available"];
        case "extending": return ["detail-muted", "Image ⟳ Extending…"];
        case "extended":
        case "extended_cached": return ["detail-muted", "Image ✓ Extended"];
        case "re_extended": return ["detail-muted", "Image ↻ Re-extended"];
        case "extension_hidden": return ["detail-warning", "Image ◌ Extension hidden"];
        case "needs_review": return ["detail-warning", image.overridable
            ? "Image ⚠ Large gap — Extend Image by hand (over the auto limit)" : "Image ⚠ Needs review"];
        default: return ["detail-error", "Image ✗ Check failed"];
    }
}

// Pages that still need an extension (for "Image ↗ 5 pages need extension").
function pagesNeedingExtension(s) {
    const image = (s && s.image) || {};
    if (typeof image.pages === "number" && image.pages > 0 && !image.extension) return image.pages;
    return ((s && s.warnings) || []).filter((w) => /image doesn't cover its frame/.test(w)).length;
}

// Bounding-box (subject) result of the last Generate — status only.
//   Subject ✓ Chosen: Car + Person | Subject ⚠ Whole photo — use Choose Subject |
//   Subject ✓ Detected | Subject — Default placement   (+ "· red frame" when used)
//   Subject ✓ In red frame | Subject ✓ Auto-centred | Subject — Busy photo, normal placement |
//   Subject — Default placement
function subjectLine(s) {
    const subj = s && s.subject;
    if (!subj) return null;
    const c = subj.capsule;
    if (c && (c.status === "missing" || c.status === "stale")) {
        return ["detail-warning", c.status === "stale" ? "Subject ⚠ Missing Detection Data — photo changed since the Capsule import"
            : "Subject ⚠ Missing Detection Data — default placement"];
    }
    const line = originalSubjectLine(subj);
    if (c && line) line[1] += c.status === "manual" ? " · Capsule (adjusted)" : " · Capsule";
    return line;
}

// The original plugin's subject status line (any subject source).
function originalSubjectLine(subj) {
    if (subj.inFrame) return ["detail-muted", "Subject ✓ In red frame"];
    // Custom Subject Frames chosen, but no frame could be used for this product.
    if (subj.mode === "frames" && subj.zones) {
        return ["detail-warning", subj.wholePhoto
            ? "Subject — Red frame not used: busy photo (adjust by hand if needed)"
            : "Subject — Red frame not used: no subject found" + (subj.reason ? ` (${String(subj.reason).slice(0, 60)})` : "")];
    }
    if (subj.wholePhoto) {
        return [subj.mode === "frames" && subj.zones ? "detail-warning" : "detail-muted",
            "Subject — Busy photo, normal placement (adjust by hand if needed)"];
    }
    return subj.detected ? ["detail-muted", "Subject ✓ Auto-centred"] : ["detail-muted", "Subject — Default placement"];
}

// Capsule mode: the stored Capsule data changed after this INDD was made
// (imported for a photo that had none, or edited) → "Regenerate to apply".
function capsulePendingLine(rec, s) {
    if (subjectSource() !== "capsule" || !capsuleMod || !s || !s.subject || !s.updatedAt) return null;
    const entry = capsuleEntryFor(rec);
    if (!entry || !entry.auto) return null;
    const changed = [entry.auto.importedAt, entry.manual && entry.manual.editedAt]
        .concat(Object.values(entry.layouts || {}).map((l) => l.editedAt)).filter(Boolean).some((t) => t > s.updatedAt);
    return changed ? ["detail-warning", "Subject ↻ Capsule data changed — Regenerate .indd to apply"] : null;
}

// Which Image Extension controls a product shows.
function extensionControls(s) {
    const image = (s && s.image) || {};
    const st = image.status;
    // needs_review + overridable: only over the automatic limit — still
    // extendable by hand (after a warning, see extendRow).
    const extend = st === "extension_available" || st === "extension_required" || st === "skipped" || st === "awaiting_user" ||
        (st === "needs_review" && !!image.overridable);
    // An extension is on the INDD (also when only some pages are extended).
    const hasExt = !!image.extension || EXTENDED.indexOf(st) !== -1 || st === "extension_hidden";
    return {
        extend,
        reextend: hasExt && !extend, // same dialog — one button is enough
        hide: hasExt && st !== "extension_hidden",
        show: st === "extension_hidden",
    };
}

// Short status lines under a product name: image status, an error, or a
// count of other warnings. The full text is in ⋯ More actions.
function detailLines(rec, state, s) {
    const lines = [];
    if (rec.status !== "matched") {
        lines.push(["detail-muted", rec.notes || "No image matched this row"]);
        return lines;
    }
    if (state === "unchecked") lines.push(["detail-muted", "Existing .indd — not checked yet"]);
    if (s && s.error) lines.push(["detail-error", "✗ " + String(s.error).split(" — ")[0].slice(0, 80)]);
    const image = s && s.image;
    if (image) lines.push(imageLine(image));
    if (s && s.subject && s.subject.mode === "frames" && s.subject.zones && !s.subject.inFrame) lines.push(subjectLine(s));
    // Capsule data imported / edited after this INDD was generated.
    const pending = capsulePendingLine(rec, s);
    if (pending) lines.push(pending);
    lines.push(...warningSummary(s));
    return lines;
}

// Warnings grouped by what the designer has to do, one short line per group
// with a count (page-level texts stay in ⋯ → View details):
//   ✗ technical failure (red) · ⚠ design / readability review (yellow) ·
//   ⚠ quality note (muted — not an error). Image coverage warnings are left
//   out: the Image line already says it.
const WARNING_GROUPS = [
    { test: /MainImage frame is empty/i, cls: "detail-error", text: "✗ Image missing" },
    { test: /Missing Detection Data/i, cls: "detail-warning", text: "⚠ Missing Detection Data" },
    { test: /before the subject change/i, cls: "detail-warning", text: "⚠ Re-check image extension (subject changed)" },
    { test: /low text contrast/i, cls: "detail-warning", text: "⚠ Text contrast needs review" },
    { test: /doesn't fit its frame|broken across lines/i, cls: "detail-warning", text: "⚠ Text doesn't fit" },
    { test: /red subject frame|subject is bigger|part of the subject|busy image|covers the whole photo/i, cls: "detail-warning", text: "⚠ Subject placement needs review" },
    { test: /resolution|\bppi\b/i, cls: "detail-muted", text: "⚠ Low effective resolution" },
];

function warningSummary(s) {
    const image = s && s.image;
    const warnings = ((s && s.warnings) || []).filter((w) => !(image && IMAGE_WARNING.test(w)) &&
        !(s.subject && s.subject.wholePhoto && /covers the whole photo/.test(w)));
    const counts = new Map();
    let other = 0;
    for (const w of warnings) {
        const g = WARNING_GROUPS.find((x) => x.test.test(w));
        if (g) counts.set(g, (counts.get(g) || 0) + 1); else other++;
    }
    const lines = [];
    // Pages whose Firefly request failed (last Extend), while still not covered.
    const failed = Number((s && s.extendFailed) || 0);
    if (failed && image && ["extension_available", "extension_required", "needs_review", "failed"].indexOf(image.status) !== -1) {
        lines.push(["detail-error", `✗ Image extension failed · ${failed}`]);
    }
    for (const g of WARNING_GROUPS) if (counts.has(g)) lines.push([g.cls, `${g.text} · ${counts.get(g)}`]);
    if (other) lines.push(["detail-warning", `⚠ Needs review · ${other}`]);
    return lines;
}

// Short status for the Product actions dialog:
//   Subject ✓ Detected | Subject — Default placement
//   Image ↗ Extension available · 5 pages · 4 plans | Image ✓ Extended · 5 pages
function productStatusLines(s) {
    const out = [];
    const subj = subjectLine(s);
    if (subj) out.push(subj);
    const image = s && s.image;
    if (image) {
        const [cls, text] = imageLine(image);
        const extendedPages = (image.versions || []).length;
        const need = pagesNeedingExtension(s);
        const plans = (image.plans || []).length;
        let counts = "";
        if (extendedPages && image.status !== "extension_available") counts = `${extendedPages} page${extendedPages === 1 ? "" : "s"}`;
        else if (need) counts = `${need} page${need === 1 ? "" : "s"}` + (plans ? ` · ${plans} plan${plans === 1 ? "" : "s"}` : "");
        out.push([cls, counts ? `${text} · ${counts}` : text]);
    }
    return out.concat(warningSummary(s));
}

// Page-level details for "View details" (collapsed): readable, without plan
// ids or pixel numbers — those stay in the logs.
function productDetailText(rec, p, s) {
    const out = [p.inddPath.split("/").pop()];
    if (rec.imagePath) out.push("Photo: " + rec.imagePath.split("/").pop());
    if (s && s.subject && !s.subject.detected && s.subject.reason) out.push("Subject: " + s.subject.reason);
    const c = s && s.subject && s.subject.capsule;
    if (c && c.status !== "missing" && c.status !== "stale") {
        out.push(`Capsule: ${c.file || "imported"} · box ${c.boxSource === "auto" ? "as imported" : "adjusted"} · focal point ${c.focalSource === "auto" ? "as imported" : "adjusted"} (not used by placement)` +
            (c.edges && c.edges.length ? ` · box touches the photo's ${c.edges.join(" / ")} edge` : "") +
            (c.layoutEdits && c.layoutEdits.length ? ` · layout-specific: ${c.layoutEdits.join(", ")}` : ""));
    }
    for (const w of ((s && s.warnings) || []).slice(0, 8)) {
        out.push("• " + String(w)
            .replace(/\s*—\s*extension required.*$/i, "")
            .replace(/\s*\(?plan EXT_[0-9a-f]{8}\)?/gi, "")
            .replace(/[,;]?\s*[+−-]?\d+(\.\d+)?\s*px/gi, ""));
    }
    if (s && s.error) out.push("✗ " + s.error);
    if (s && s.exportedAt) out.push("Exported " + shortTime(s.exportedAt));
    else if (s && s.committedAt) out.push("Committed " + shortTime(s.committedAt));
    return out.join("\n");
}

// The product list: one block per Excel row / photo folder —
//   line 1: product name · status
//   then  : detail lines (image, warnings, errors, commit time)
//   last  : actions (Open .indd · Preview Image Batch · Commit .indd · ⋯),
//           wrapping onto more lines in a narrow panel.
function renderTable() {
    el.resultsBody.innerHTML = "";
    for (const rec of manifestRows) {
        const row = div("product-row " + (rec.status === "matched" ? "row-matched" : "row-skipped") +
            (activeRec === rec ? " row-active" : ""));
        const state = rowState(rec);
        const p = products.get(rec);
        const s = p ? getStatus(p.inddPath) : null;

        const head = div("product-head");
        head.appendChild(div("product-name", rec.headline || "(no headline)"));
        const [label, cls] = STATE_LABEL[state];
        head.appendChild(div("product-status " + cls, label));
        row.appendChild(head);

        for (const [cls2, text] of detailLines(rec, state, s)) row.appendChild(div("product-detail " + cls2, text));

        if (rec.status === "matched") {
            const actions = div("product-actions");
            const hasIndd = !!(p && p.exists);
            const open = button(LABEL.open, () => openRow(rec), p ? p.inddPath : "");
            const commit = button(LABEL.commit, () => commitRow(rec),
                "Save + check this .indd and mark it Committed (no JPG export — that's step 4)");
            open.disabled = busy || !hasIndd;
            commit.disabled = busy || !hasIndd;
            actions.appendChild(open);
            actions.appendChild(commit);
            const more = button(LABEL.more, () => moreMenu(rec), "More actions");
            more.disabled = busy || !p;
            actions.appendChild(more);
            row.appendChild(actions);
        }
        el.resultsBody.appendChild(row);
    }
    renderActiveProduct();
    updateCounts();
}

// ---------- the product INDD the designer is working in ----------
//
// When InDesign's front document is one of the product INDDs, its row is
// highlighted and its actions (Preview · Commit · ⋯) appear in the bottom
// bar — no need to find it in a long table. Polled once a second (cheap; no
// reliable document-activation event in this UXP DOM), skipped during runs.

let activeRec = null;

function renderActiveProduct() {
    el.activeActions.innerHTML = "";
    el.activeStatus.innerHTML = "";
    if (!activeRec || !products.get(activeRec)) {
        el.activeProduct.classList.add("hidden");
        return;
    }
    const rec = activeRec;
    const p = products.get(rec);
    const s = getStatus(p.inddPath);
    el.activeName.textContent = rec.headline;
    const subj = subjectLine(s);
    if (subj) el.activeStatus.appendChild(div(subj[0], subj[1]));
    const c = extensionControls(s);
    if (s && s.image) {
        const need = c.extend ? pagesNeedingExtension(s) : 0;
        el.activeStatus.appendChild(need
            ? div("detail-warning", `Image ↗ ${need} page${need === 1 ? "" : "s"} need${need === 1 ? "s" : ""} extension`)
            : div(...imageLine(s.image)));
    }
    // Inline: the one image action that applies now; the rest is in ⋯.
    if (c.extend) el.activeActions.appendChild(button(LABEL.extend, () => productActions(rec))); // prompt + Extend live there
    if (c.hide) el.activeActions.appendChild(button(LABEL.hide, () => toggleExtension(rec, false), "Turn the extension off to see the original layout"));
    if (c.show) el.activeActions.appendChild(button(LABEL.show, () => toggleExtension(rec, true)));
    el.activeActions.appendChild(button(LABEL.more, () => moreMenu(rec), "More actions"));
    el.activeProduct.classList.remove("hidden");
}

function pollActiveDocument() {
    if (busy || !render || !products.size) return;
    const path = String(render.activeDocumentPath() || "").toLowerCase();
    let found = null;
    if (path) {
        for (const [rec, p] of products) {
            if (p.inddPath.toLowerCase() === path) { found = rec; break; }
        }
    }
    if (found !== activeRec) {
        activeRec = found;
        renderTable();
    }
}

setInterval(pollActiveDocument, 1000);

// "10 rows · 10 matched · 10 existing INDDs found" — the INDD count only once
// a template set and output folder say where to look.
function updateMatchSummary() {
    if (!manifestRows.length) return;
    const matched = manifestRows.filter((r) => r.status === "matched").length;
    const parts = [`${manifestRows.length} rows`, `${matched} matched`];
    if (outputEntry && templatePaths.length) {
        const existing = [...products.values()].filter((p) => p.exists).length;
        parts.push(`${existing} existing INDD${existing === 1 ? "" : "s"} found`);
    }
    el.matchSummary.textContent = parts.join(" · ");
}

function updateCounts() {
    const n = { ready: 0, review: 0, committed: 0, exported: 0, failed: 0, unchecked: 0, "not-generated": 0 };
    for (const rec of manifestRows) {
        const st = rowState(rec);
        if (st in n) n[st]++;
    }
    const parts = [`${n.ready} Ready`, `${n.review} Need Review`];
    if (n.committed) parts.push(`${n.committed} Committed`);
    if (n.exported) parts.push(`${n.exported} Exported`);
    if (n.failed) parts.push(`${n.failed} Failed`);
    if (n.unchecked) parts.push(`${n.unchecked} Unchecked`);
    if (n["not-generated"]) parts.push(`${n["not-generated"]} Not generated`);
    el.statusCounts.textContent = manifestRows.length ? parts.join(" · ") : "";
    updateMatchSummary();
    updateButtons();
}

// ---------- generate (all / one product) ----------

// New image status from a fresh check, keeping what the check can't know:
// the flavour of "extended" (cached / re-extended), versions, plans, and a
// needs_review / skipped decision while the image still doesn't cover.
function mergeImageStatus(old, fresh) {
    const keep = (extra) => Object.assign({}, fresh, {
        versions: fresh.versions || (old && old.versions) || null,
        plans: fresh.plans || (old && old.plans) || null,
    }, extra || {});
    if (!old) return keep();
    // Remember the flavour while hidden, restore it when shown again.
    const flavour = EXTENDED.indexOf(old.status) !== -1 ? old.status : old.extendedAs;
    if (fresh.status === "extension_hidden") return keep({ extendedAs: flavour || "extended" });
    if (fresh.status === "extended" && flavour) return keep({ status: flavour });
    if (fresh.status === "extension_available" && !fresh.extension &&
        ["needs_review", "skipped", "failed"].indexOf(old.status) !== -1) {
        return keep({ status: old.status, text: old.text, overridable: !!old.overridable, maxRatio: old.maxRatio || 0 });
    }
    return keep();
}

// Records a generateIndds() result in the status store.
function recordGeneration(result) {
    for (const g of result.generated) {
        setStatus(g.inddPath, {
            status: g.warnings.length ? "review" : "ready",
            warnings: g.warnings.map((w) => w.replace(/^WARNING /, "")),
            error: "",
            committedAt: null,
            exportedAt: null,
            image: g.image || null,
            subject: g.subject || null,
            extendFailed: 0,
        });
    }
    for (const f of result.failed) {
        // An INDD that's open in InDesign was not touched — keep its status.
        if (/is open in InDesign/.test(f.error)) continue;
        setStatus(f.inddPath, { status: "failed", error: f.error, warnings: [] });
    }
}

async function runGenerate(rows, title) {
    setBusy(true);
    startProgress(channels.generate, "Generating", title);
    try {
        if (!(await waitForInDesign())) throw new Error(NOT_READY);
        const result = await render.generateIndds(rows, templatePaths, outputEntry.nativePath,
            progressTo(channels.generate), { placementMode: placementMode(), useChoices: FEATURES.chooseSubject, textColor: textColorOptions(),
                subjectSource: subjectSource() });
        recordGeneration(result);
        await refreshProducts();
        return result;
    } finally {
        setBusy(false);
    }
}

el.btnGenerate.addEventListener("click", async () => {
    if (!render) {
        setMessage("render.js failed to load — see the banner above.", channels.generate);
        return;
    }
    // Generate All replaces existing INDDs — including any manual edits.
    await refreshProducts();
    // Capsule mode: photos without Capsule data only with an explicit OK.
    if (!(await confirmCapsuleCoverage(manifestRows))) return;
    const existing = [...products.values()].filter((p) => p.exists).length;
    if (existing) {
        const go = await showDialog("Generate All .indd",
            `${existing} product INDD(s) already exist and will be replaced — manual edits in them will be lost.\n\n` +
            "To rebuild just one product, use its ⋯ → Regenerate .indd instead.",
            [{ label: "Replace and Generate All .indd", value: "go", danger: true }]);
        if (go !== "go") return;
    }
    try {
        const result = await runGenerate(manifestRows, "Generating INDDs…");
        const logPath = outputEntry.nativePath + "/generation_log.csv";
        await render.writeLog(result.logLines, logPath);
        // Image Extension (phases 1–2): one record per page — frame / graphic
        // bounds, detected underfill, source-pixel expansion, status.
        await render.writeLog([JSON.stringify(result.imageChecks || [], null, 2)],
            outputEntry.nativePath + "/image_extension_log.json");
        await render.writeLog([result.imageReport || ""], outputEntry.nativePath + "/image_extension_log.txt");
        const review = result.generated.filter((g) => g.warnings.length).length;
        const toExtend = result.generated.filter((g) => g.image && g.image.status === "extension_available").length;
        const extendPages = (result.imageChecks || []).filter((r) => r.status === "extension_required").length;
        summarize(`✓ Generated ${result.generated.length} INDD(s)` +
            (review ? ` · ⚠ ${review} need review` : "") +
            (result.failed.length ? ` · ✗ ${result.failed.length} failed` : "") +
            (toExtend ? ` · ↗ ${toExtend} product(s) can be extended — use Extend Image` : "") +
            (extendPages ? ` (${extendPages} page(s); one shared Firefly generation per product on Extend)` : "") +
            " — logs: generation_log.csv, image_extension_log.txt / .json", result, channels.generate,
            (result.templates || []).map((t) => t.detected).join("\n"));
    } catch (e) {
        setMessage(errorText(e), channels.generate);
    }
});

// ---------- per-product actions ----------

function itemFor(rec) {
    const p = products.get(rec);
    return p ? { rec, subType: p.subType, inddPath: p.inddPath } : null;
}

async function openRow(rec) {
    const p = products.get(rec);
    try {
        if (!(await waitForInDesign())) throw new Error(NOT_READY);
        await render.openIndd(p.inddPath);
    } catch (e) {
        setMessage(errorText(e), channels.generate);
    }
}

// Runs exportFromIndds() for one or more products and records the outcome.
// Runs exportFromIndds() for one or more products in one of three modes and
// records the outcome:
//   "preview" — temporary low-res JPGs (step 4 area)
//   "commit"  — save + check, mark Committed, NO JPGs (step 3 area)
//   "export"  — final JPGs of Committed products, mark Exported (step 4 area)
async function runExport(items, mode, title, skipIfWarnings) {
    const channel = mode === "commit" ? channels.generate : channels.export;
    const verb = { preview: "Previewing", commit: "Committing", export: "Exporting" }[mode];
    setBusy(true);
    startProgress(channel, verb, title);
    try {
        if (!(await waitForInDesign())) throw new Error(NOT_READY);
        const result = await render.exportFromIndds(items, outputEntry.nativePath, progressTo(channel), {
            preview: mode === "preview",
            checkOnly: mode === "commit",
            skipIfWarnings: !!skipIfWarnings,
        });
        const now = new Date().toISOString();
        for (const o of result.items) {
            if (o.error && !o.warnings.length) continue; // couldn't check — keep the old status
            const patch = { status: o.warnings.length ? "review" : "ready", warnings: o.warnings, error: "" };
            // Image coverage (original + extension) re-checked on every page.
            const old = getStatus(o.inddPath);
            if (o.image) patch.image = mergeImageStatus(old && old.image, o.image);
            if (mode === "preview" && o.warnings.length) {
                patch.committedAt = null; // a problem found after Commit needs a new Commit
                patch.exportedAt = null;
            }
            if (mode === "commit") {
                patch.committedAt = o.committed ? now : null; // not committed = skipped for warnings
                patch.exportedAt = null;
            }
            if (mode === "export" && o.exported) patch.exportedAt = now;
            setStatus(o.inddPath, patch);
        }
        return result;
    } finally {
        setBusy(false);
    }
}

async function previewRow(rec) {
    const item = itemFor(rec);
    try {
        const result = await runExport([item], "preview", `Previewing ${rec.headline}…`);
        const o = result.items[0];
        let opened = "";
        if (o.folder) {
            try {
                // "" = opened; otherwise an error text (e.g. permission denied).
                opened = await uxp.shell.openPath(o.folder, "Show the preview JPGs");
            } catch (e) {
                opened = String(e);
            }
        }
        const head = o.error ? `✗ Preview of ${rec.headline} failed`
            : o.warnings.length ? `⚠ Preview of ${rec.headline} — ${o.warnings.length} warning(s)`
            : `✓ Preview of ${rec.headline} — no warnings`;
        summarize(head, result, channels.export,
            [o.warnings.length ? "⚠ " + o.warnings.join("\n⚠ ") : "",
                opened ? `Couldn't open ${o.folder} automatically: ${opened}` : ""].filter(Boolean).join("\n"));
    } catch (e) {
        setMessage(errorText(e), channels.export);
    }
}

// Commit = save + check this INDD and mark it Committed. No JPGs (step 4).
async function commitRow(rec) {
    const item = itemFor(rec);
    try {
        // First pass refuses to commit a product with warnings…
        let result = await runExport([item], "commit", `Committing ${rec.headline}…`, true);
        let o = result.items[0];
        if (!o.committed && !o.error && o.warnings.length) {
            // …so the designer decides explicitly.
            const go = await showDialog(`Commit ${rec.headline}?`,
                `This product has warnings:\n• ${o.warnings.join("\n• ")}\n\nCommit it anyway?`,
                [{ label: "Commit Anyway", value: "go", danger: true }]);
            if (go !== "go") {
                setMessage(`⚠ Not committed: ${rec.headline} needs review.`, channels.generate);
                return;
            }
            result = await runExport([item], "commit", `Committing ${rec.headline}…`, false);
            o = result.items[0];
        }
        summarize(o.committed ? `✓ Committed ${rec.headline} — ready for Export` : `✗ Commit of ${rec.headline} failed`,
            result, channels.generate);
    } catch (e) {
        setMessage(errorText(e), channels.generate);
    }
}

// ---------- Image Extension (per product, the designer's choice) ----------
//
// Nothing is generated or changed in an INDD without this choice:
//   no existing extension:  Extend image · Skip
//   existing extension:     Use existing extension · Re-extend image · Skip
// Extend image and Re-extend image both make NEW Firefly generation(s) — in
// the default consistent batch mode ONE master generation for the product,
// clipped by every eligible page (more only if one can't serve them all).
// No automatic reuse; every generation is a new version in generated_assets/.
// Only "Use existing extension" applies stored versions. The result appears
// on the INDD's extendImage layer; the original Image layer is never changed.
//   mode: "extend" (Extend Image) · "regenerate" (Re-extend Image) ·
//         "use_existing" (Use Existing Extension, no Firefly call)
//   prompt: optional Firefly prompt, typed in the Product actions dialog
// No dialog of its own — the choice and the prompt come from productActions().
async function extendRow(rec, mode, prompt) {
    const p = products.get(rec);
    const s = getStatus(p.inddPath) || {};
    const previous = s.image || {};
    const choice = mode || "extend";
    prompt = choice === "use_existing" ? "" : String(prompt || "").slice(0, 1024); // Firefly's limit
    const item = itemFor(rec);
    // Over the automatic limit: say so and let the designer decide.
    if (choice !== "use_existing" && previous.status === "needs_review" && previous.overridable) {
        const pct = previous.maxRatio ? Math.round(previous.maxRatio * 100) : null;
        const go = await showDialog("Large extension",
            (pct ? `This photo needs about ${pct}% new image` : "This photo needs a lot of new image") +
            " — more than the 50% automatic limit. Firefly can still try, but the generated part may look less natural. " +
            "Check it before Commit.",
            [{ label: "Extend Anyway", value: "go" }]);
        if (go !== "go") return;
    }
    setBusy(true);
    setStatus(p.inddPath, { image: Object.assign({}, previous, { status: "extending" }) });
    startProgress(channels.generate, choice === "regenerate" ? "Re-extending" : "Extending", `Extending ${rec.headline}…`);
    try {
        if (!(await waitForInDesign())) throw new Error(NOT_READY);
        const result = await render.extendProductImage(item, outputEntry.nativePath, choice, progressTo(channels.generate),
                { prompt, allowLarge: true, textColor: textColorOptions() });
        try {
            await render.writeLog(result.logLines, outputEntry.nativePath + "/image_extension_apply_log.jsonl");
        } catch (e) {}
        setMessage(recordExtendResult(rec, previous, result, choice).join("\n"), channels.generate);
    } catch (e) {
        setStatus(p.inddPath, { image: previous });
        setMessage(errorText(e), channels.generate);
    } finally {
        setBusy(false);
    }
}

// Stores an extendProductImage() result as the product's status (Ready when
// nothing else needs review) and returns the message lines for it.
function recordExtendResult(rec, previous, result, choice) {
    const p = products.get(rec);
    const failedPages = result.generations.filter((x) => x.error);
    setStatus(p.inddPath, {
        status: result.warnings.length ? "review" : "ready",
        warnings: result.warnings, error: "", committedAt: null, exportedAt: null,
        image: mergeImageStatus(previous, result.image),
        // for the row's "✗ Image extension failed · n" (real failures only —
        // not test-limit skips or "no stored extension" for Use Existing)
        extendFailed: failedPages.filter((x) => !/^skipped|no existing extension/i.test(String(x.error))).length,
    });
    const applied = result.pages.filter((x) => x.applied).length;
    const head = applied
        ? `✓ ${choice === "regenerate" ? "Re-extended" : "Extended"} ${rec.headline} — ${applied} page(s)` +
          (result.newGenerations ? ` · ${result.newGenerations} new Firefly generation(s)` : " · existing extension, no Firefly call") +
          (result.batchMode === "consistent" && result.units.length ? ` · ${result.units.length === 1 ? "1 shared master" : result.units.length + " masters"}` : "") +
          (result.newGenerations && result.prompt ? ` · prompt "${result.prompt}"` : "") +
          (result.warnings.length ? ` · ⚠ ${result.warnings.length} warning(s) — Review` : " · Ready")
        : `✗ ${rec.headline} was not extended`;
    return [head].concat(failedPages.map((x) => `✗ ${x.layout} (${x.planId}): ${x.error}`));
}

// ---------- Extend All Images ----------
//
// One deliberate click for every product whose image doesn't cover its frame
// yet (status "extension available"): the same Extend image as the product's
// own button, product after product — default consistent batch = one Firefly
// generation per product. Products already extended, skipped by the designer,
// needing review or without an INDD are left alone. The INDDs are opened in
// the background, saved and closed again (an INDD that is open stays open).
function extendableRows() {
    return manifestRows.filter((rec) => {
        const p = products.get(rec);
        if (!p || !p.exists) return false;
        const st = ((getStatus(p.inddPath) || {}).image || {}).status;
        return st === "extension_available" || st === "extension_required";
    });
}

el.btnExtendAll.addEventListener("click", async () => {
    const rows = extendableRows();
    if (!rows.length) return;
    const answer = await showDialog("Extend All Images",
        `${rows.length} product${rows.length === 1 ? "" : "s"} need${rows.length === 1 ? "s" : ""} image extension.`,
        [{ label: `Extend ${rows.length} product${rows.length === 1 ? "" : "s"}`, value: "go" }],
        { input: { label: "Prompt (optional)", placeholder: "e.g. wet asphalt road, evening light" } });
    if (answer.value !== "go") return;
    const prompt = answer.text.slice(0, 1024);
    setBusy(true);
    startProgress(channels.generate, "Extending", `Extending ${rows.length} product(s)…`);
    const lines = [];
    const log = [];
    let extended = 0, failed = 0;
    try {
        if (!(await waitForInDesign())) throw new Error(NOT_READY);
        for (let i = 0; i < rows.length; i++) {
            const rec = rows[i];
            const p = products.get(rec);
            const previous = (getStatus(p.inddPath) || {}).image || {};
            progressTo(channels.generate)(i, rows.length, rec.headline);
            setStatus(p.inddPath, { image: Object.assign({}, previous, { status: "extending" }) });
            renderTable();
            try {
                const result = await render.extendProductImage(itemFor(rec), outputEntry.nativePath, "extend", null,
                    { prompt, background: true, textColor: textColorOptions() });
                log.push(...result.logLines);
                const msg = recordExtendResult(rec, previous, result, "extend");
                if (result.pages.some((x) => x.applied)) extended++; else failed++;
                lines.push(...msg.filter((l) => l.startsWith("✗")));
            } catch (e) {
                failed++;
                setStatus(p.inddPath, { image: previous });
                lines.push(`✗ ${rec.headline}: ${errorText(e)}`);
            }
            progressTo(channels.generate)(i + 1, rows.length, rec.headline);
        }
        try { await render.writeLog(log, outputEntry.nativePath + "/image_extension_apply_log.jsonl"); } catch (e) {}
        const ready = rows.filter((r) => rowState(r) === "ready").length;
        setMessage([`✓ Extended ${extended} of ${rows.length} product(s)` + (failed ? ` · ✗ ${failed} not extended` : "") +
            ` · ${ready} now Ready — log: image_extension_apply_log.jsonl`].concat(lines.slice(0, 8),
            lines.length > 8 ? [`…and ${lines.length - 8} more — see the log.`] : []).join("\n"), channels.generate);
    } catch (e) {
        setMessage(errorText(e), channels.generate);
    } finally {
        setBusy(false);
    }
});

// Show / Hide Extension: toggles the INDD's extendImage layer (the original
// Image layer is untouched either way). Hidden = the JPG would show the
// uncovered strip, so the product goes back to Review until shown again.
async function toggleExtension(rec, visible) {
    const p = products.get(rec);
    const old = (getStatus(p.inddPath) || {}).image;
    setBusy(true);
    try {
        if (!(await waitForInDesign())) throw new Error(NOT_READY);
        const result = await render.setExtensionVisible(itemFor(rec), visible);
        setStatus(p.inddPath, {
            status: result.warnings.length ? "review" : "ready",
            warnings: result.warnings, committedAt: null, exportedAt: null,
            image: mergeImageStatus(old, result.image),
        });
        setMessage(`${visible ? "Extension shown" : "Extension hidden"} — ${rec.headline}` +
            (result.saved ? "" : " (INDD has other unsaved edits — not saved; Commit saves it)"), channels.generate);
    } catch (e) {
        setMessage(errorText(e), channels.generate);
    } finally {
        setBusy(false);
    }
}

// ⋯ Product actions — ONE dialog for a product:
//   status (Subject / Image, short), then the groups that apply now —
//   IMAGE EXTENSION: optional prompt + Extend / Re-extend / Use Existing /
//                    Show-Hide (the prompt is read from this dialog; no
//                    second dialog)
//   DOCUMENT:        Preview · Regenerate .indd · Open Output Folder
//   (Image Extension first once an extension exists) and a collapsed
//   "View details" with page-level information. Plan ids and pixel numbers
//   stay in the logs.
async function productActions(rec) {
    const p = products.get(rec);
    const s = getStatus(p.inddPath);
    const c = extensionControls(s);
    const image = (s && s.image) || {};
    const stored = (image.plans || []).some((x) => x.cachedVersion) || EXTENDED.indexOf(image.status) !== -1 ||
        image.status === "extension_hidden" || !!image.extension;
    const subjectGroup = FEATURES.chooseSubject && rec.imagePath && subjectMod && pickerMod
        ? [{ header: "Subject" }, { label: "Choose Subject…", value: "choose_subject" }] : [];
    // Capsule mode: import / edit this photo's Capsule data (live status).
    if (subjectSource() === "capsule" && capsuleMod && rec.imagePath && outputEntry) {
        await loadCapsule();
        const entry = capsuleEntryFor(rec);
        const cst = capsuleMod.entryStatus(entry, entry ? await capsuleMod.photoFingerprint(rec.imagePath) : null);
        const text = {
            missing: ["detail-warning", "Capsule ⚠ Missing Detection Data — paste or import the JSON"],
            stale: ["detail-warning", "Capsule ⚠ The photo changed after the import"],
            auto: ["detail-muted", `Capsule ✓ ${entry && entry.auto.sourceFile ? entry.auto.sourceFile : "imported"}`],
            manual: ["detail-muted", `Capsule ✓ ${entry && entry.auto.sourceFile ? entry.auto.sourceFile : "imported"} · adjusted`],
        }[cst];
        subjectGroup.push({ header: "Subject (Capsule)" }, { status: [text] },
            { label: "Paste Capsule JSON (Step 3)", value: "capsule_paste" },
            { label: cst === "missing" ? "Import Capsule JSON File…" : "Re-import Capsule JSON File…", value: "capsule_import" });
        if (cst === "auto" || cst === "manual") subjectGroup.push({ label: "Edit Subject Placement…", value: "capsule_edit" });
        if (cst === "stale") subjectGroup.push({ label: "Keep Capsule Data for Changed Photo…", value: "capsule_keep" });
    }
    const doc = [{ header: "Document" }];
    if (p.exists) doc.push({ label: "Preview", value: "preview" });
    doc.push({ label: p.exists ? "Regenerate .indd" : "Generate .indd", value: "regenerate", danger: p.exists });
    doc.push({ label: "Open Output Folder", value: "output" });
    const ext = [];
    if (p.exists && s && s.image) {
        const firefly = [];
        if (c.extend) firefly.push({ label: LABEL.extend, value: "extend" });
        if (stored && !c.extend) firefly.push({ label: LABEL.reextend, value: "reextend" });
        const other = [];
        if (stored) other.push({ label: LABEL.useExisting, value: "use_existing" });
        if (c.hide) other.push({ label: LABEL.hide, value: "hide" });
        if (c.show) other.push({ label: LABEL.show, value: "show" });
        if (firefly.length || other.length) {
            ext.push({ header: "Image extension" });
            if (firefly.length) ext.push({ prompt: { label: "Prompt (optional)", placeholder: "e.g. wet asphalt road, evening light" } }, ...firefly);
            ext.push(...other);
        }
    }
    const status = productStatusLines(s);
    const entries = (status.length ? [{ status }] : [])
        .concat(subjectGroup)
        .concat(stored && ext.length ? ext.concat(doc) : doc.concat(ext))
        .concat([{ details: productDetailText(rec, p, s) }]);
    const answer = await showDialog(rec.headline, "", entries, { withText: true, closeLabel: stored ? "Close" : "Cancel" });
    const choice = answer.value;
    if (choice === "choose_subject") await chooseSubjectRow(rec);
    if (choice === "capsule_paste") await pasteForRow(rec);
    if (choice === "capsule_import") await importCapsuleForRow(rec);
    if (choice === "capsule_edit") await editSubjectRow(rec);
    if (choice === "capsule_keep") await acceptChangedPhotoRow(rec);
    if (choice === "preview") await previewRow(rec);
    if (choice === "regenerate") await regenerateRow(rec);
    if (choice === "output") await openOutputFolder(p.subType);
    if (choice === "extend") await extendRow(rec, "extend", answer.text);
    if (choice === "reextend") await extendRow(rec, "regenerate", answer.text);
    if (choice === "use_existing") await extendRow(rec, "use_existing");
    if (choice === "hide") await toggleExtension(rec, false);
    if (choice === "show") await toggleExtension(rec, true);
}

// Kept name for the ⋯ buttons.
const moreMenu = productActions;

// ⋯ → Choose Subject: finds every object in the product photo (once; stored
// in <output>/subject_choices.json), lets the designer tick the one(s) for
// the red subject frame, and saves the choice. It is used by the next
// Generate / Regenerate of this product (every page and template).
//   forceDetect: run object detection again (the old choice is cleared)
async function chooseSubjectRow(rec, forceDetect) {
    if (!subjectMod || !pickerMod) {
        setMessage("Choose Subject isn't available — subject.js / subjectpicker.js failed to load (see the banner above).", channels.generate);
        return;
    }
    if (!outputEntry) {
        setMessage("Select the output folder first (step 1) — the subject choice is saved there.", channels.generate);
        return;
    }
    const photoName = String(rec.imagePath).split("/").pop();
    let store, key, entry;
    setBusy(true);
    try {
        store = await subjectMod.loadSubjectChoices(outputEntry.nativePath);
        key = await subjectMod.photoKey(rec.imagePath);
        entry = store.items[key];
        // An earlier detection that found nothing is retried automatically.
        if (forceDetect || !entry || !Array.isArray(entry.objects) || !entry.objects.length) {
            const sc = await subjectMod.loadSubjectConfig({ forObjects: true });
            if (!sc.config) throw new Error("Choose Subject needs the team backend — " + sc.reason);
            setMessage(`Finding the objects in ${photoName}… (about 10–30 s)`, channels.generate);
            const found = await subjectMod.detectSubjectObjects(rec.imagePath, sc.config);
            entry = { imagePath: rec.imagePath, objects: found.objects, selected: null, detectedAt: new Date().toISOString() };
            if (found.debug) entry.debug = found.debug;
            store.items[key] = entry;
            await subjectMod.saveSubjectChoices(store);
        }
        setMessage("", channels.generate);
    } catch (e) {
        setMessage(errorText(e), channels.generate);
        setBusy(false);
        return;
    }

    // Still busy while the photo loads into the window (a few seconds for a
    // big file), so no other run can start meanwhile.
    let answer = null;
    try {
        answer = await pickerMod.showSubjectPicker({
            title: `Choose Subject — ${rec.headline}`,
            imagePath: rec.imagePath,
            objects: entry.objects,
            selected: entry.selected,
            chosenBefore: !!(entry.selected && entry.selected.length),
            unionBox: subjectMod.unionBox,
            debug: entry.debug || "",
        });
    } catch (e) {
        setMessage(errorText(e), channels.generate);
    } finally {
        setBusy(false);
    }
    if (!answer) return;
    if (answer.action === "redetect") return chooseSubjectRow(rec, true);
    entry.selected = answer.action === "auto" ? null : answer.selected;
    entry.chosenAt = new Date().toISOString();
    store.items[key] = entry;
    try {
        await subjectMod.saveSubjectChoices(store);
    } catch (e) {
        setMessage("Couldn't save the subject choice: " + errorText(e), channels.generate);
        return;
    }
    const names = entry.objects.filter((o) => (entry.selected || []).indexOf(o.id) !== -1).map((o) => o.label);
    if (answer.action === "save_regenerate") {
        await regenerateRow(rec);
        return;
    }
    setMessage(answer.action === "auto"
        ? `${rec.headline}: back to the automatic subject — Regenerate .indd to apply it.`
        : `${rec.headline}: subject = ${names.join(" + ")} — Regenerate .indd (⋯) or Generate All to apply it.`, channels.generate);
}

// Product INDDs open in InDesign WITH unsaved changes are never closed or
// replaced: names them and returns false (the designer saves or closes them
// first). True when none of the rows' INDDs has unsaved changes.
async function stopIfUnsaved(rows) {
    const unsaved = [];
    for (const r of rows) {
        const p = products.get(r);
        if (p && p.exists && (await render.inddOpenState(p.inddPath)).modified) unsaved.push(r);
    }
    if (!unsaved.length) return true;
    await showDialog("Unsaved changes",
        `${unsaved.map((r) => products.get(r).inddPath.split("/").pop()).join(", ")} ${unsaved.length === 1 ? "is" : "are"} open in InDesign with unsaved changes.\n\n` +
        "Save (File → Save) or close " + (unsaved.length === 1 ? "it" : "them") + " yourself, then try again. Nothing was changed.", [], { closeLabel: "OK" });
    setMessage(`Nothing regenerated: ${unsaved.map((r) => r.headline).join(", ")} ha${unsaved.length === 1 ? "s" : "ve"} unsaved changes in InDesign.`, channels.generate);
    return false;
}

// Rebuilds ONE product's INDD, then opens it ("jumps" to it) in InDesign.
// An INDD that's open is closed first — only after the user confirmed that
// manual edits will be discarded, and never with unsaved changes: then
// nothing happens until the designer saves or closes it.
async function regenerateRow(rec) {
    const p = products.get(rec);
    if (p.exists && !(await stopIfUnsaved([rec]))) return;
    if (!(await confirmCapsuleCoverage([rec]))) return;
    const open = p.exists && (await render.inddOpenState(p.inddPath)).open;
    if (p.exists) {
        const go = await showDialog("Regenerate .indd?",
            "Regenerating will replace the current INDD and may discard manual edits. Continue?" +
            (open ? "\n\nThis INDD is open in InDesign (no unsaved changes) — it will be closed first." : ""),
            [{ label: "Regenerate", value: "go", danger: true }]);
        if (go !== "go") return;
    }
    try {
        if (open) await render.closeIndd(p.inddPath);
        const result = await runGenerate([rec], `Regenerating ${rec.headline}…`);
        if (result.generated.length) {
            await render.openIndd(result.generated[0].inddPath);
            summarize(`✓ Regenerated ${rec.headline} — opened in InDesign`, result, channels.generate);
        } else {
            summarize(`✗ Regenerate of ${rec.headline} failed`, result, channels.generate);
        }
    } catch (e) {
        setMessage(errorText(e), channels.generate);
    }
}

// Opens output/<type> — or, before anything was committed, the nearest
// folder that exists (output/, then the selected root).
async function openOutputFolder(subType) {
    const root = outputEntry.nativePath.replace(/\/+$/, "");
    const candidates = [render.outputFolderFor(root, subType), root + "/output", root];
    let folder = root;
    for (const c of candidates) {
        if (await render.pathExists(c)) { folder = c; break; }
    }
    let opened = "";
    try { opened = await uxp.shell.openPath(folder, "Show the output folder"); } catch (e) { opened = String(e); }
    if (opened) setMessage(`Couldn't open ${folder} automatically: ${opened}`, channels.export);
}

// ---------- step 3: Commit All Ready ----------

// Saves + checks every Ready (not yet committed) INDD and marks it Committed
// — no JPGs. A product with warnings now is skipped and marked Review.
el.btnCommitAll.addEventListener("click", async () => {
    const items = readyRows().map(itemFor).filter(Boolean);
    try {
        const result = await runExport(items, "commit", `Committing ${items.length} ready product(s)…`, true);
        const committed = result.items.filter((o) => o.committed).length;
        const toReview = result.items.filter((o) => !o.committed && o.warnings.length).length;
        const failed = result.items.filter((o) => !o.committed && !o.warnings.length).length;
        summarize(`✓ Committed ${committed} product(s)` +
            (toReview ? ` · ⚠ ${toReview} need review (skipped)` : "") +
            (failed ? ` · ✗ ${failed} failed` : "") +
            (committed ? " — ready for Export" : ""), result, channels.generate);
    } catch (e) {
        setMessage(errorText(e), channels.generate);
    }
});

// ---------- step 4: Export All Committed ----------

// Exports the final JPGs of every Committed product (they were checked and
// approved at Commit, so nothing is skipped for warnings here) and marks
// them Exported. To re-export a product after editing it: Commit it again.
el.btnExport.addEventListener("click", async () => {
    const items = committedRows().map(itemFor).filter(Boolean);
    try {
        const result = await runExport(items, "export", `Exporting ${items.length} committed product(s)…`, false);
        const exported = result.items.filter((o) => o.exported).length;
        const failed = result.items.length - exported;
        await render.writeLog(result.logLines, outputEntry.nativePath + "/export_log.csv");
        summarize(`✓ Exported ${exported} product(s)` +
            (failed ? ` · ✗ ${failed} failed` : "") +
            " — log: export_log.csv", result, channels.export);
    } catch (e) {
        setMessage(errorText(e), channels.export);
    }
});

// Registering entrypoints.setup() is what actually makes InDesign bind
// require("indesign")'s "app" — confirmed via Adobe community reports: without
// it, "app" can come back undefined indefinitely, not just briefly during a
// startup race. init() (which touches "app" via the font check) now runs from
// the panel's own show() lifecycle callback instead of unconditionally at
// script-load time.
let shown = false;
function initOnce() {
    if (shown) return;
    shown = true;
    init();
}
try {
    uxp.entrypoints.setup({
        panels: {
            posterBatchPanel: {
                show() { initOnce(); },
            },
        },
    });
} catch (e) {
    // setup() can only be registered once per plugin load; after a panel
    // Reload it may refuse — the bridge is already bound by then.
}
if (recall(RELOAD_FLAG)) {
    try { localStorage.removeItem(RELOAD_FLAG); } catch (e) {}
    initOnce();
}
