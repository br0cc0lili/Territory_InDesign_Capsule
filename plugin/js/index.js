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
let matcher = null, render = null, datamerge = null;
const loadErrors = [];
// Note: index.js is loaded via a plain <script src="js/index.js"> tag in
// index.html, so require()'s relative resolution here is anchored at the
// plugin root ("./"), not at this file's own "js/" folder — hence "./js/…".
try { matcher = require("./js/matcher.js"); } catch (e) { loadErrors.push("matcher.js: " + e); }
try { render = require("./js/render.js"); } catch (e) { loadErrors.push("render.js: " + e); }
try { datamerge = require("./js/datamerge.js"); } catch (e) { loadErrors.push("datamerge.js: " + e); }

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
    btnGenerate: document.getElementById("btn-generate"),
    btnCommitAll: document.getElementById("btn-commit-all"),
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
    activeActions: document.getElementById("active-actions"),
    dialog: document.getElementById("action-dialog"),
    dialogTitle: document.getElementById("dialog-title"),
    dialogMessage: document.getElementById("dialog-message"),
    dialogButtons: document.getElementById("dialog-buttons"),
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
    statuses: "posterBatch.inddStatuses",
};

function remember(key, value) {
    try { localStorage.setItem(key, JSON.stringify(value)); } catch (e) {}
}

function recall(key) {
    try { return JSON.parse(localStorage.getItem(key)); } catch (e) { return null; }
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
    const paths = recall(STORE.templates) || [];
    templatePaths = [];
    // One template set; older versions may have stored several — keep the last.
    for (const p of paths.slice(-1)) if (await entryFor(p)) templatePaths.push(p);
    showContext();
    updateButtons();
}

// ---------- context line (template set + output) and buttons ----------

function templateTypeOf(path) {
    try { return render ? render.typeOfTemplate(path) : null; } catch (e) { return null; }
}

function showContext() {
    if (templatePaths.length) {
        const t = templateTypeOf(templatePaths[0]);
        const label = t && render ? render.TYPE_FOLDER[t] : "?";
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
    el.btnMatch.disabled = busy || !(excelEntry && photosEntry);
    el.btnGenerate.disabled = busy || !(hasMatchedRows() && outputEntry && templatePaths.length);
    el.btnCommitAll.disabled = busy || readyRows().length === 0;
    el.btnExport.disabled = busy || !outputEntry || committedRows().length === 0;
    el.btnDmPrepare.disabled = busy || !excelEntry;
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
function showDialog(title, message, buttons) {
    const dlg = el.dialog;
    const native = typeof dlg.uxpShowModal === "function";
    // UXP shows the title in the window's title bar; don't repeat it.
    el.dialogTitle.textContent = native ? "" : title;
    el.dialogTitle.style.display = native ? "none" : "";
    el.dialogMessage.textContent = message || "";
    el.dialogButtons.innerHTML = "";
    return new Promise((resolve) => {
        let chosen = null;
        let settled = false;
        const settle = () => {
            if (settled) return;
            settled = true;
            setTimeout(() => resolve(chosen), 100);
        };
        for (const b of buttons.concat([{ label: "Cancel", value: null }])) {
            const btn = document.createElement("button");
            btn.type = "button";
            btn.textContent = b.label;
            if (b.danger) btn.className = "danger";
            btn.addEventListener("click", () => {
                chosen = b.value;
                try { dlg.close(b.value || "cancel"); } catch (e) { settle(); }
            });
            el.dialogButtons.appendChild(btn);
        }
        dlg.addEventListener("close", settle, { once: true });
        try {
            if (native) dlg.uxpShowModal({ title, resize: "none" }).then(settle, settle);
            else dlg.showModal();
        } catch (e) {
            settle();
        }
    });
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
            if (pg.ok) return `✓ Page ${pg.page}`;
            const problems = pg.notes.filter((n) => n.startsWith("⚠")).map((n) => "    " + n.replace(/^⚠\s*/, ""));
            return [`⚠ Page ${pg.page}`].concat(problems).join("\n");
        });
        if (!result.saved) pageLines.push("⚠ The template couldn't be saved — press Cmd+S in InDesign.");
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

// Detail lines shown under a product — everything that used to be hidden in
// hover tooltips (UXP panels don't reliably show them).
const MAX_WARNINGS = 3;
function detailLines(rec, state, s) {
    const lines = [];
    if (rec.status !== "matched") {
        lines.push(["detail-muted", rec.notes || "No image matched this row"]);
        return lines;
    }
    if (rec.imagePath) lines.push(["detail-muted", "Image: " + rec.imagePath.split("/").pop()]);
    if (state === "unchecked") lines.push(["detail-muted", "Existing .indd found — not checked yet. Preview or commit it."]);
    if (s && s.error) lines.push(["detail-error", "✗ " + s.error]);
    const warnings = (s && s.warnings) || [];
    for (const w of warnings.slice(0, MAX_WARNINGS)) lines.push(["detail-warning", "⚠ " + w]);
    if (warnings.length > MAX_WARNINGS) {
        lines.push(["detail-warning", `⚠ …and ${warnings.length - MAX_WARNINGS} more (see the log)`]);
    }
    if (s && s.exportedAt) lines.push(["detail-muted", "Exported " + shortTime(s.exportedAt)]);
    else if (s && s.committedAt) lines.push(["detail-muted", "Committed " + shortTime(s.committedAt)]);
    return lines;
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
            if (hasIndd) actions.appendChild(button(LABEL.open, () => openRow(rec), p.inddPath));
            const preview = button(LABEL.preview, () => previewRow(rec), "Export low-res JPGs of this product and show them");
            const commit = button(LABEL.commit, () => commitRow(rec),
                "Save + check this .indd and mark it Committed (no JPG export — that's step 4)");
            preview.disabled = busy || !hasIndd;
            commit.disabled = busy || !hasIndd;
            actions.appendChild(preview);
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
    if (!activeRec || !products.get(activeRec)) {
        el.activeProduct.classList.add("hidden");
        return;
    }
    el.activeName.textContent = activeRec.headline;
    const rec = activeRec;
    const preview = button(LABEL.preview, () => previewRow(rec));
    const commit = button(LABEL.commit, () => commitRow(rec));
    const more = button(LABEL.more, () => moreMenu(rec), "More actions");
    commit.disabled = busy;
    for (const b of [preview, commit, more]) el.activeActions.appendChild(b);
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

// Records a generateIndds() result in the status store.
function recordGeneration(result) {
    for (const g of result.generated) {
        setStatus(g.inddPath, {
            status: g.warnings.length ? "review" : "ready",
            warnings: g.warnings.map((w) => w.replace(/^WARNING /, "")),
            error: "",
            committedAt: null,
            exportedAt: null,
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
            progressTo(channels.generate));
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
        const review = result.generated.filter((g) => g.warnings.length).length;
        summarize(`✓ Generated ${result.generated.length} INDD(s)` +
            (review ? ` · ⚠ ${review} need review` : "") +
            (result.failed.length ? ` · ✗ ${result.failed.length} failed` : "") +
            " — log: generation_log.csv", result, channels.generate);
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

async function moreMenu(rec) {
    const p = products.get(rec);
    const choice = await showDialog(rec.headline, p.inddPath.split("/").pop(), [
        { label: p.exists ? "Regenerate .indd" : "Generate .indd", value: "regenerate", danger: p.exists },
        { label: "Open Output Folder", value: "output" },
    ]);
    if (choice === "regenerate") await regenerateRow(rec);
    if (choice === "output") await openOutputFolder(p.subType);
}

// Rebuilds ONE product's INDD, then opens it ("jumps" to it) in InDesign.
// An INDD that's open is closed WITHOUT saving — only after the user
// confirmed that manual edits will be discarded.
async function regenerateRow(rec) {
    const p = products.get(rec);
    const open = p.exists && render.isInddOpen(p.inddPath);
    if (p.exists) {
        const go = await showDialog("Regenerate .indd?",
            "Regenerating will replace the current INDD and may discard manual edits. Continue?" +
            (open ? "\n\nThis INDD is open in InDesign — it will be closed without saving first." : ""),
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
