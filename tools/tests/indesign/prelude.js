// Phase 4 test harness — loads the plugin's own modules (relative require).
const uxp = require("uxp");
const { app } = require("indesign");
const render = require("../../../plugin/js/render.js");
const ext = require("../../../plugin/js/imageextension.js");
const ROOT = "__ROOT__";
const OUT = "__OUT__";
// Local fixture paths (tools/tests/indesign/config.local.json, gitignored).
const CFG = __CONFIG__;
const item = { rec: { headline: "Aerowischer", year: "2026" }, subType: "service",
    inddPath: ROOT + "/InDesign/Service/Service_Herbst_2026_Aerowischer.indd" };
async function readJson(path) {
    const e = await uxp.storage.localFileSystem.getEntryWithUrl("file:" + path);
    return JSON.parse(await e.read());
}
async function writeOut(name, obj) {
    const f = await uxp.storage.localFileSystem.createEntryWithUrl("file:" + OUT + "/" + name, { type: uxp.storage.types.file, overwrite: true });
    await f.write(JSON.stringify(obj, null, 2));
}
// Same connection as the panel (plugin/backend.config.json), limited to ONE plan.
async function useBackend(onlyPlanId, maxPlans) {
    const c = await readJson("__REPO__/plugin/backend.config.json");
    ext.loadBackendConfig = async () => ({ config: { baseUrl: c.baseUrl.replace(/\/+$/, ""), pluginKey: c.pluginKey, maxPlansPerRun: maxPlans === undefined ? 1 : maxPlans, onlyPlanId }, reason: "" });
}
// Path of an open document ("" if unsaved). In a UXP script document.fullName
// can be a Promise, so it is awaited.
async function docPath(d) {
    try {
        const f = await d.fullName;
        return String(typeof f === "string" ? f : (f && (f.nativePath || f.fsName)) || "").replace(/^file:(\/\/)?/, "");
    } catch (e) {
        // The file was deleted while open: the error still names its URL.
        const m = String(e).match(/file:\/\/(\/[^'"]+)/);
        try { return m ? decodeURIComponent(m[1]) : ""; } catch (err) { return ""; }
    }
}
// Closes (without saving) ONLY test documents: open documents whose file
// lies inside the test root (never an unsaved or user document).
async function closeTestDocuments() {
    const { SaveOptions } = require("indesign");
    // Back to front: closing a document shifts the live collection.
    for (let i = app.documents.length - 1; i >= 0; i--) {
        const d = app.documents.item(i);
        const p = await docPath(d);
        if (p && p.indexOf(ROOT + "/") === 0) { try { d.close(SaveOptions.NO); } catch (e) {} }
    }
}
function itemsAt(c) { const n = c ? c.length : 0; const a = []; for (let i = 0; i < n; i++) a.push(typeof c.item === "function" ? c.item(i) : c[i]); return a; }
// Inspect the open product document: layer stack, original image + extension items per page.
function inspect(doc) {
    const layers = itemsAt(doc.layers).map((l) => (l.visible ? "" : "(hidden) ") + l.name);
    const pages = itemsAt(doc.pages).map((page, i) => {
        const items = itemsAt(page.allPageItems);
        const frame = items.find((it) => String(it.name) === "<<MainImage>>");
        const g = frame ? itemsAt(frame.allGraphics)[0] : null;
        const extItems = ext.extensionItemsOnPage(page).map((x) => ({
            name: x.item.name, layer: x.item.itemLayer.name, bounds: Array.from(x.item.geometricBounds, Number).map((v) => +v.toFixed(2)),
            graphicBounds: Array.from(itemsAt(x.item.allGraphics)[0].geometricBounds, Number).map((v) => +v.toFixed(2)),
            link: String(itemsAt(x.item.allGraphics)[0].itemLink.filePath), version: x.label.version, cacheHit: x.label.cacheHit }));
        return {
            page: i + 1, size: Math.round(page.bounds[3] - page.bounds[1]) + "x" + Math.round(page.bounds[2] - page.bounds[0]),
            frame: frame ? Array.from(frame.geometricBounds, Number).map((v) => +v.toFixed(2)) : null,
            frameLayer: frame ? frame.itemLayer.name : null,
            original: g ? { bounds: Array.from(g.geometricBounds, Number).map((v) => +v.toFixed(3)), link: String(g.itemLink.filePath),
                hScale: g.horizontalScale, vScale: g.verticalScale } : null,
            coverage: frame ? ext.checkExtendedCoverage(page, frame).state : null,
            extension: extItems,
        };
    });
    return { layers, pages };
}
