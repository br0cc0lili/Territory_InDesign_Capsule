// index.js — panel UI wiring for the Poster Batch Generator plugin.
// Ties together matcher.js (fuzzy match) and render.js (InDesign render),
// mirroring the CLI pipeline's two steps (build manifest -> render) but
// entirely in-panel, with no Terminal/Python/CSV editing required.

/* global require, document */
const uxp = require("uxp");
const fs = uxp.storage.localFileSystem;

// Each local module is required defensively: if one throws (e.g. a typo, or
// an environment where require("indesign") turns out not to behave as
// expected), we still want every OTHER button in the panel to keep working
// instead of the whole script aborting silently before any listener attaches.
let matcher = null, render = null, merge = null;
const loadErrors = [];
// Note: index.js is loaded via a plain <script src="js/index.js"> tag in
// index.html, so require()'s relative resolution here is anchored at the
// plugin root ("./"), not at this file's own "js/" folder — hence "./js/…".
try { matcher = require("./js/matcher.js"); } catch (e) { loadErrors.push("matcher.js: " + e); }
try { render = require("./js/render.js"); } catch (e) { loadErrors.push("render.js: " + e); }
try { merge = require("./js/merge.js"); } catch (e) { loadErrors.push("merge.js: " + e); }

let excelEntry = null;
let photosEntry = null;
let outputEntry = null;
let manifestRows = [];
let inddFileEntries = [];

const el = {
    loadErrorBanner: document.getElementById("load-error-banner"),
    fontBanner: document.getElementById("font-banner"),
    btnInddFiles: document.getElementById("btn-indd-files"),
    inddFileList: document.getElementById("indd-file-list"),
    btnMerge: document.getElementById("btn-merge"),
    mergeSummary: document.getElementById("merge-summary"),
    btnExcel: document.getElementById("btn-excel"),
    excelPath: document.getElementById("excel-path"),
    btnPhotos: document.getElementById("btn-photos"),
    photosPath: document.getElementById("photos-path"),
    btnMatch: document.getElementById("btn-match"),
    matchSummary: document.getElementById("match-summary"),
    resultsBody: document.querySelector("#results tbody"),
    btnOutput: document.getElementById("btn-output"),
    outputPath: document.getElementById("output-path"),
    debugInfo: document.getElementById("debug-info"),
    btnGenerate: document.getElementById("btn-generate"),
    progress: document.getElementById("progress"),
    progressFill: document.getElementById("progress-fill"),
    progressLabel: document.getElementById("progress-label"),
    generateSummary: document.getElementById("generate-summary"),
};

function updateMatchButtonState() {
    el.btnMatch.disabled = !(excelEntry && photosEntry);
}

function updateGenerateButtonState() {
    const hasMatchedRows = manifestRows.some((r) => r.status === "matched");
    el.btnGenerate.disabled = !(hasMatchedRows && outputEntry);
}

async function resolveMasterPath() {
    const pluginFolder = await fs.getPluginFolder();
    const root = pluginFolder.nativePath.replace(/\/plugin\/?$/, "");
    return root + "/system/templates/Poster_Master.indd";
}

function showFontBanner(message) {
    el.fontBanner.textContent = "⚠ " + message;
    el.fontBanner.classList.remove("banner-hidden");
}

function init() {
    if (loadErrors.length) {
        el.loadErrorBanner.textContent = "⚠ Plugin module load error(s):\n" + loadErrors.join("\n");
        el.loadErrorBanner.classList.remove("banner-hidden");
    }
    if (!render) return; // font check needs render.js; skip if it failed to load

    el.debugInfo.textContent = "indesign module keys: " + render.debugModuleShape();

    const fontCheck = render.checkAudiFont();
    if (!fontCheck.ok) showFontBanner(fontCheck.message);
}

el.btnInddFiles.addEventListener("click", async () => {
    let entries;
    try {
        entries = await fs.getFileForOpening({ types: ["indd"], allowMultiple: true });
    } catch (e) {
        el.mergeSummary.textContent = "Error opening file picker: " + e;
        return;
    }
    if (!entries || entries.length === 0) return;
    inddFileEntries = entries;
    el.inddFileList.innerHTML = "";
    for (const entry of inddFileEntries) {
        const li = document.createElement("li");
        li.textContent = entry.name;
        el.inddFileList.appendChild(li);
    }
    el.btnMerge.disabled = inddFileEntries.length === 0;
    el.mergeSummary.textContent = "";
});

el.btnMerge.addEventListener("click", async () => {
    if (!merge) {
        el.mergeSummary.textContent = "merge.js failed to load — see the banner above.";
        return;
    }
    el.btnMerge.disabled = true;
    el.mergeSummary.textContent = "Importing into the current document…";

    try {
        const result = await merge.mergeTemplates(
            inddFileEntries,
            (done, _total, message) => {
                el.mergeSummary.textContent = `Importing… (${done}) ${message}`;
            }
        );

        const labelLines = result.pageLabels
            .map((pl) => `${pl.file} → "${pl.label}"`)
            .join("\n");
        const dupWarning = result.duplicateLabels.length
            ? ` ⚠ Duplicate labels found: ${result.duplicateLabels.join(", ")} — check before generating.`
            : "";
        el.mergeSummary.textContent =
            `Imported ${result.totalPages} pages into the current document.${dupWarning}\n${labelLines}\n` +
            `Save it yourself (Cmd+S) when ready — nothing was saved automatically.`;
    } catch (e) {
        el.mergeSummary.textContent = "Error: " + e;
    } finally {
        el.btnMerge.disabled = false;
    }
});

el.btnExcel.addEventListener("click", async () => {
    let entry;
    try {
        entry = await fs.getFileForOpening({ types: ["xlsx"] });
    } catch (e) {
        el.excelPath.textContent = "Error: " + e;
        return;
    }
    if (!entry) return;
    excelEntry = entry;
    el.excelPath.textContent = entry.name;
    updateMatchButtonState();
});

el.btnPhotos.addEventListener("click", async () => {
    let entry;
    try {
        entry = await fs.getFolder();
    } catch (e) {
        el.photosPath.textContent = "Error: " + e;
        return;
    }
    if (!entry) return;
    photosEntry = entry;
    el.photosPath.textContent = entry.nativePath;
    updateMatchButtonState();
});

el.btnOutput.addEventListener("click", async () => {
    let entry;
    try {
        entry = await fs.getFolder();
    } catch (e) {
        el.outputPath.textContent = "Error: " + e;
        return;
    }
    if (!entry) return;
    outputEntry = entry;
    el.outputPath.textContent = entry.nativePath;
    updateGenerateButtonState();
});

el.btnMatch.addEventListener("click", async () => {
    if (!matcher) {
        el.matchSummary.textContent = "matcher.js failed to load — see the banner above.";
        return;
    }
    el.btnMatch.disabled = true;
    el.matchSummary.textContent = "Matching…";
    el.resultsBody.innerHTML = "";

    try {
        manifestRows = await matcher.buildManifest(excelEntry, photosEntry);
    } catch (e) {
        el.matchSummary.textContent = "Error: " + e;
        el.btnMatch.disabled = false;
        return;
    }

    const matchedCount = manifestRows.filter((r) => r.status === "matched").length;
    el.matchSummary.textContent =
        `${manifestRows.length} rows, ${matchedCount} matched.`;

    for (const row of manifestRows) {
        const tr = document.createElement("tr");
        tr.className = row.status === "matched" ? "row-matched" : "row-skipped";

        const folderName = row.notes && row.notes.indexOf("folder=") !== -1
            ? row.notes.split("folder='")[1]?.split("'")[0] || ""
            : "";
        const scoreMatch = row.notes && row.notes.match(/score=([\d.]+)/);
        const score = scoreMatch ? scoreMatch[1] : "";

        tr.innerHTML = `
            <td>${row.headline || "(no headline)"}</td>
            <td>${folderName}</td>
            <td>${row.imagePath ? row.imagePath.split("/").pop() : ""}</td>
            <td>${score}</td>
            <td>${row.status}${row.status !== "matched" ? " — " + row.notes : ""}</td>
        `;
        el.resultsBody.appendChild(tr);
    }

    el.btnMatch.disabled = false;
    updateGenerateButtonState();
});

el.btnGenerate.addEventListener("click", async () => {
    if (!render) {
        el.generateSummary.textContent = "render.js failed to load — see the banner above.";
        return;
    }
    el.btnGenerate.disabled = true;
    el.generateSummary.textContent = "";
    el.progress.classList.remove("progress-hidden");
    el.progressFill.style.width = "0%";
    el.progressLabel.textContent = "Starting…";

    try {
        const masterPath = await resolveMasterPath();
        const result = await render.renderAll(
            manifestRows,
            masterPath,
            outputEntry.nativePath,
            (done, total, message) => {
                const pct = total ? Math.round((done / total) * 100) : 0;
                el.progressFill.style.width = pct + "%";
                el.progressLabel.textContent = `${done}/${total} — ${message}`;
            }
        );

        const logPath = outputEntry.nativePath + "/generation_log.csv";
        await render.writeLog(result.logLines, logPath);

        let summary =
            `Done. success=${result.successCount} errors=${result.errorCount}. ` +
            `Log written to ${logPath}`;
        if (result.failures && result.failures.length) {
            const failureLines = result.failures
                .map((f) => `  ${f.headline} — ${f.label}: ${f.message}`)
                .join("\n");
            summary += `\n\nSkipped (${result.failures.length}):\n${failureLines}`;
        }
        el.generateSummary.textContent = summary;
    } catch (e) {
        el.generateSummary.textContent = "Error: " + e;
    } finally {
        el.btnGenerate.disabled = false;
        updateGenerateButtonState();
    }
});

// Registering entrypoints.setup() is what actually makes InDesign bind
// require("indesign")'s "app" — confirmed via Adobe community reports: without
// it, "app" can come back undefined indefinitely, not just briefly during a
// startup race. init() (which touches "app" via the font check) now runs from
// the panel's own show() lifecycle callback instead of unconditionally at
// script-load time.
let shown = false;
uxp.entrypoints.setup({
    panels: {
        posterBatchPanel: {
            show() {
                if (shown) return;
                shown = true;
                init();
            },
        },
    },
});
