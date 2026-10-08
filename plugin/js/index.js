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
let dmCsvEntry = null;
// Prepared <name>_DataMerge.indd files that Generate renders from (step 4).
let templatePaths = [];

const el = {
    loadErrorBanner: document.getElementById("load-error-banner"),
    fontBanner: document.getElementById("font-banner"),
    btnDmCsv: document.getElementById("btn-dm-csv"),
    dmCsvPath: document.getElementById("dm-csv-path"),
    btnDmPrepare: document.getElementById("btn-dm-prepare"),
    dmSummary: document.getElementById("dm-summary"),
    btnExcel: document.getElementById("btn-excel"),
    excelPath: document.getElementById("excel-path"),
    btnPhotos: document.getElementById("btn-photos"),
    photosPath: document.getElementById("photos-path"),
    btnMatch: document.getElementById("btn-match"),
    matchSummary: document.getElementById("match-summary"),
    resultsBody: document.querySelector("#results tbody"),
    templateList: document.getElementById("template-list"),
    btnOutput: document.getElementById("btn-output"),
    outputPath: document.getElementById("output-path"),
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
    el.btnGenerate.disabled = !(hasMatchedRows && outputEntry && templatePaths.length);
}

function showTemplateList() {
    el.templateList.innerHTML = "";
    for (const path of templatePaths) {
        const li = document.createElement("li");
        li.textContent = path.split("/").pop();
        el.templateList.appendChild(li);
    }
}

function addTemplatePath(path) {
    if (!templatePaths.some((p) => p.toLowerCase() === path.toLowerCase())) templatePaths.push(path);
    showTemplateList();
    updateGenerateButtonState();
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

async function init() {
    if (loadErrors.length) {
        el.loadErrorBanner.textContent = "⚠ Plugin module load error(s):\n" + loadErrors.join("\n");
        el.loadErrorBanner.classList.remove("banner-hidden");
    }
    if (!render) return; // font check needs render.js; skip if it failed to load

    if (!(await waitForInDesign())) {
        showFontBanner(NOT_READY);
        return;
    }
    const fontCheck = render.checkAudiFont();
    if (!fontCheck.ok) showFontBanner(fontCheck.message);
}

el.btnDmCsv.addEventListener("click", async () => {
    let entry;
    try {
        entry = await fs.getFileForOpening({ types: ["xlsx", "csv", "txt"] });
    } catch (e) {
        el.dmCsvPath.textContent = errorText(e);
        return;
    }
    if (!entry) return;
    dmCsvEntry = entry;
    el.dmCsvPath.textContent = entry.name;
    el.btnDmPrepare.disabled = false;
    el.dmSummary.textContent = "";
});

el.btnDmPrepare.addEventListener("click", async () => {
    if (!datamerge) {
        el.dmSummary.textContent = "datamerge.js failed to load — see the banner above.";
        return;
    }
    el.btnDmPrepare.disabled = true;
    el.dmSummary.textContent = "Saving a working copy and preparing it…";

    try {
        if (!(await waitForInDesign())) throw new Error(NOT_READY);
        // Data Merge only reads CSV/TXT: convert an Excel pick first. Step 2's
        // photos folder is used to fill @MainImage only if it happens to be
        // chosen already — preparing the template never requires it.
        let csvPath = dmCsvEntry.nativePath;
        if (/\.xlsx$/i.test(dmCsvEntry.name)) {
            el.dmSummary.textContent = "Converting Excel to a Data Merge CSV…";
            const conv = await datamerge.excelToDataSource(dmCsvEntry, photosEntry);
            csvPath = conv.csvPath;
            el.dmSummary.textContent = "Saving a working copy and preparing it…";
        }
        const result = await datamerge.prepareActiveDocument(csvPath);
        // The prepared copy is what Generate renders from.
        if (result.saved) addTemplatePath(result.copyPath);
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
        el.btnDmPrepare.disabled = false;
    }
});

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
    el.excelPath.textContent = entry.name;
    updateMatchButtonState();
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
    el.photosPath.textContent = entry.nativePath;
    updateMatchButtonState();
});

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
        el.matchSummary.textContent = errorText(e);
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
        if (!(await waitForInDesign())) throw new Error(NOT_READY);
        const result = await render.renderAll(
            manifestRows,
            templatePaths,
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
        el.generateSummary.textContent = errorText(e);
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
