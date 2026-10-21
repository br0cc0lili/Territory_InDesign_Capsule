// Offline regression test (Node, no InDesign). Run: node tools/tests/run.js
// Extension over the automatic limit: not eligible, but overridable by hand;
// hard limits are not overridable; masters may be shared when allowLarge.
const PLUGIN_JS = require("path").resolve(__dirname, "../../plugin/js");
const Module = require("module"); const o = Module._load; Module._load = function (r) { return r === "uxp" ? { storage: {} } : o.apply(this, arguments); };
const ext = require(PLUGIN_JS + "/imageextension.js");
let f = 0; const ok = (c, m) => { console.log((c ? "PASS " : "FAIL ") + m); if (!c) f++; };
const base = { source: { format: "jpeg", path: "/a.jpg", width: 2000, height: 1000 }, ratio: { max: 0.3 },
    working: { size: { width: 2000, height: 1300 }, resolutionOk: true, pxPerPt: 2 } };
const e1 = ext.checkAutoExtensionEligibility(base);
ok(e1.eligible && !e1.overridable, "within the limit: eligible");
const e2 = ext.checkAutoExtensionEligibility(Object.assign({}, base, { ratio: { max: 0.8 } }));
ok(!e2.eligible && e2.overridable, "over the 50% limit only: not automatic, but overridable by hand");
const e3 = ext.checkAutoExtensionEligibility(Object.assign({}, base, { ratio: { max: 0.8 }, working: { size: { width: 2000, height: 1300 }, resolutionOk: false, pxPerPt: 0.5 } }));
ok(!e3.eligible && e3.overridable, "over the limit + low resolution: still overridable (soft limits)");
const e4 = ext.checkAutoExtensionEligibility(Object.assign({}, base, { source: Object.assign({}, base.source, { format: "tiff" }), ratio: { max: 0.8 } }));
ok(!e4.eligible && !e4.overridable, "unsupported file type: hard limit, not overridable");
console.log(f ? f + " FAILED" : "all passed");
