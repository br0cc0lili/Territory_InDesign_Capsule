// Offline regression test (Node, no InDesign). Run: node tools/tests/run.js
// Firefly working canvas normalisation (fitWorkingGeometry): never above
// 2688 px after rounding, one factor for everything, generated area always
// covers the required extension.
const PLUGIN_JS = require("path").resolve(__dirname, "../../plugin/js");
const Module = require("module");
const o = Module._load; Module._load = function (r) { return r === "uxp" ? { storage: {} } : o.apply(this, arguments); };
const ext = require(PLUGIN_JS + "/imageextension.js");
let f = 0; const ok = (c, m) => { console.log((c ? "PASS " : "FAIL ") + m); if (!c) f++; };
const fits = (w) => w.size.width <= 2688 && w.size.height <= 2688;
const covers = (w, sw, sh, e) => ["left", "right"].every((k) => w.inset[k] * sw / w.source.width >= e[k] - 1e-6) &&
    ["top", "bottom"].every((k) => w.inset[k] * sh / w.source.height >= e[k] - 1e-6);

// HU-Service (real numbers): source 2732x2160
const hu800 = ext.fitWorkingGeometry(2732, 2160, { top: 0, right: 63, bottom: 0, left: 63 });
ok(fits(hu800) && covers(hu800, 2732, 2160, { top: 0, right: 63, bottom: 0, left: 63 }),
    `HU-Service 800x600 page: target ${hu800.originalTarget.width}x${hu800.originalTarget.height} → Firefly ${hu800.size.width}x${hu800.size.height} (was 2689 wide), scale ${hu800.scale}`);
const huMaster = ext.fitWorkingGeometry(2732, 2160, { top: 0, right: 63, bottom: 572, left: 63 });
ok(fits(huMaster), `HU-Service batch master: target ${huMaster.originalTarget.width}x${huMaster.originalTarget.height} → Firefly ${huMaster.size.width}x${huMaster.size.height}, scale ${huMaster.scale}`);
const ex = ext.fitWorkingGeometry(3000, 2000, { top: 0, right: 200, bottom: 500, left: 200 });
ok(fits(ex) && Math.max(ex.size.width, ex.size.height) >= 2686, `3400x2500 example → ${ex.size.width}x${ex.size.height}, scale ${ex.scale} (≈0.790588)`);
const small = ext.fitWorkingGeometry(1000, 800, { top: 0, right: 0, bottom: 100, left: 0 });
ok(small.scale === 1 && small.size.width === 1000 && small.size.height === 900, "small canvas: not scaled");

// master plan through the real planner (HU-Service geometry) is eligible and fits
const mk = (exp) => ({ plan: { id: "p", source: { path: "/hu.jpg", width: 2732, height: 2160, format: "jpeg" }, expansionPixels: exp }, graphicBounds: [0, 0, 600, 750] });
const master = ext.createMasterExtensionPlan([mk({ top: 0, right: 0, bottom: 572, left: 0 }), mk({ top: 0, right: 63, bottom: 0, left: 63 })]);
ok(master.eligibility.eligible && fits(master.working), `master plan eligible, Firefly ${master.working.size.width}x${master.working.size.height}, original ${master.working.originalTarget.width}x${master.working.originalTarget.height}`);

// randomised: always fits, always covers, longest side close to the limit when scaled
let bad = 0, worstShort = 0;
for (let i = 0; i < 20000; i++) {
    const sw = 800 + Math.floor(Math.random() * 6000), sh = 800 + Math.floor(Math.random() * 6000);
    const e = { top: Math.floor(Math.random() * sh * 0.5), bottom: Math.floor(Math.random() * sh * 0.5), left: Math.floor(Math.random() * sw * 0.5), right: Math.floor(Math.random() * sw * 0.5) };
    const w = ext.fitWorkingGeometry(sw, sh, e);
    if (!fits(w) || !covers(w, sw, sh, e)) bad++;
    if (w.downscaled) worstShort = Math.max(worstShort, 2688 - Math.max(w.size.width, w.size.height));
}
ok(bad === 0, `20000 random sources/extensions: all ≤ 2688 px and covering (longest side at most ${worstShort} px under 2688)`);
console.log(f ? f + " FAILED" : "all passed");
