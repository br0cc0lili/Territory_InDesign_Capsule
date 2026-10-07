// merge.js — appends pages from several standalone .indd layout files onto
// the end of whatever document is currently active/open in InDesign, so the
// user can build up their own working master file page by page instead of
// generating a separate new one.
//
// Each source page's existing label (e.g. "top_service") is preserved as-is
// via InDesign's page.duplicate() — this module does not invent or rewrite
// labels, it just reports what it found so the user can catch duplicates
// or missing labels before generating.
//
// Nothing is saved automatically — the active document is left exactly as
// InDesign leaves it after duplicate(), so the user stays in control of when
// (and whether) to save.

/* global require */
// See render.js for why this re-requires instead of trusting a cached
// snapshot: the bridge can still be mid-attach on the first call or two.
let _id = null;
function indesign() {
    if (!_id || !_id.app) _id = require("indesign");
    return _id;
}

// This InDesign version's indesign module doesn't export File/Folder (confirmed
// via render.js's debugModuleShape) — app.open() takes a plain native path
// string directly instead, same as render.js.
//
// Collections like `.pages` also don't support plain bracket indexing here
// (`doc.pages[i]` silently returns undefined) — `.item(i)` is required.

// fileEntries: array of UXP file Entries (picked via getFileForOpening, allowMultiple)
// onProgress: optional callback(current, total, message)
// Returns: { totalPages, pageLabels: [{file, label}], duplicateLabels: string[] }
async function mergeTemplates(fileEntries, onProgress) {
    if (!fileEntries || fileEntries.length === 0) {
        throw new Error("No .indd files selected.");
    }

    const { app, SaveOptions, LocationOptions } = indesign();

    let targetDoc;
    try {
        targetDoc = app.activeDocument;
    } catch (e) {
        targetDoc = null;
    }
    if (!targetDoc) {
        throw new Error("No document is currently open — open the document you want to import these pages into first.");
    }

    const pageLabels = [];
    let totalPages = 0;

    for (const entry of fileEntries) {
        const srcDoc = app.open(entry.nativePath, false);
        try {
            const pageCount = srcDoc.pages.length;
            for (let p = 0; p < pageCount; p++) {
                const srcPage = srcDoc.pages.item(p);

                // Keep the source page size. A master document can contain mixed
                // page sizes (for example 1:1 and 9:16), but some InDesign builds
                // can make a cross-document duplicate inherit the target page size.
                // Read the source bounds before duplicating so we can correct only
                // when that actually happens. bounds = [y1, x1, y2, x2].
                const srcBounds = srcPage.bounds;
                const srcHeight = Number(srcBounds[2]) - Number(srcBounds[0]);
                const srcWidth = Number(srcBounds[3]) - Number(srcBounds[1]);
                const srcLabel = srcPage.label || "";

                // duplicate()'s reference must be a Page/Spread, not a Document —
                // append after the target document's current last page.
                const refPage = targetDoc.pages.item(targetDoc.pages.length - 1);
                srcPage.duplicate(LocationOptions.AFTER, refPage);

                const newPage = targetDoc.pages.item(targetDoc.pages.length - 1);

                // Normally duplicate() already preserves the page dimensions.
                // Only resize if InDesign changed them during the cross-document copy.
                const newBounds = newPage.bounds;
                const newHeight = Number(newBounds[2]) - Number(newBounds[0]);
                const newWidth = Number(newBounds[3]) - Number(newBounds[1]);
                const EPSILON = 0.01;
                if (Math.abs(newWidth - srcWidth) > EPSILON ||
                    Math.abs(newHeight - srcHeight) > EPSILON) {
                    newPage.adjustLayout({
                        width: srcWidth + "pt",
                        height: srcHeight + "pt",
                    });
                }

                // Be explicit about the label because render.js uses it to find
                // pages such as "top_service" and "9x16_top_service".
                if (srcLabel) newPage.label = srcLabel;

                pageLabels.push({
                    file: entry.name,
                    label: newPage.label || "(no label)",
                    width: srcWidth,
                    height: srcHeight,
                });
                totalPages++;
                if (onProgress) {
                    onProgress(
                        totalPages,
                        null,
                        `${entry.name} — page ${p + 1}/${pageCount} (${Math.round(srcWidth)}×${Math.round(srcHeight)} pt)`
                    );
                }
            }
        } finally {
            srcDoc.close(SaveOptions.no);
        }
    }

    const seen = new Set();
    const duplicateLabels = new Set();
    for (const { label } of pageLabels) {
        if (seen.has(label)) duplicateLabels.add(label);
        seen.add(label);
    }

    return { totalPages, pageLabels, duplicateLabels: [...duplicateLabels] };
}

module.exports = { mergeTemplates };
