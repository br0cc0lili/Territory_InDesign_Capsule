// Offline regression test (Node, no InDesign). Run: node tools/tests/run.js
// Auto Text Color: ASE parsing (colorpalette.js) and contrast ranking (textcolor.js).
const PLUGIN_JS = require("path").resolve(__dirname, "../../plugin/js");
const Module = require("module");
const o = Module._load; Module._load = function (r) { return r === "uxp" ? { storage: {} } : o.apply(this, arguments); };
const cp = require(PLUGIN_JS + "/colorpalette.js");
const tc = require(PLUGIN_JS + "/textcolor.js");
let f = 0; const ok = (c, m) => { console.log((c ? "PASS " : "FAIL ") + m); if (!c) f++; };

// Synthetic ASE: group "Brand" with RGB white, CMYK black, LAB colour, Gray.
function ase(entries) {
    const parts = [];
    const u16 = (n) => { const b = Buffer.alloc(2); b.writeUInt16BE(n); return b; };
    const u32 = (n) => { const b = Buffer.alloc(4); b.writeUInt32BE(n); return b; };
    const name = (s) => Buffer.concat([u16(s.length + 1), Buffer.from((s + "\0").split("").map((c) => [0, c.charCodeAt(0)]).flat())]);
    for (const e of entries) {
        let body;
        if (e.group) body = name(e.group);
        else if (e.end) body = Buffer.alloc(0);
        else body = Buffer.concat([name(e.name), Buffer.from(e.model), Buffer.concat(e.values.map((v) => { const b = Buffer.alloc(4); b.writeFloatBE(v); return b; })), u16(2)]);
        parts.push(Buffer.concat([u16(e.group ? 0xC001 : e.end ? 0xC002 : 0x0001), u32(body.length), body]));
    }
    return Buffer.concat([Buffer.from("ASEF"), u16(1), u16(0), u32(entries.length), ...parts]);
}
const bytes = ase([{ group: "Brand" }, { name: "White", model: "RGB ", values: [1, 1, 1] }, { name: "Black", model: "CMYK", values: [0, 0, 0, 1] },
    { name: "Red", model: "LAB ", values: [0.5, 75, 50] }, { name: "Grey", model: "Gray", values: [0.5] }, { end: true }, { name: "Loose", model: "RGB ", values: [0, 0, 1] }]);
const sw = cp.parseASE(bytes);
ok(sw.length === 5 && sw[0].name === "White" && sw[0].group === "Brand" && sw[4].group === "", "ASE: 5 colours, group names kept, group end respected");
ok(sw[0].hex === "#ffffff" && sw[1].hex === "#000000" && sw[3].hex === "#808080" && sw[4].hex === "#0000ff", "ASE → sRGB for RGB / CMYK / Gray");
ok(sw[2].rgb[0] > 180 && sw[2].rgb[1] < 80, "ASE LAB → a red sRGB approximation " + sw[2].hex);
ok(JSON.stringify(cp.inDesignColor(sw[1])) === JSON.stringify({ space: "CMYK", values: [0, 0, 0, 100] }), "CMYK kept as CMYK (0–100 %) for InDesign");
ok(cp.selectedSwatches({ swatches: sw }, [sw[0].id, sw[1].id]).length === 2 && cp.selectedSwatches({ swatches: sw }, []).length === 0, "only selected swatches are candidates; none selected → none");
let bad = ""; try { cp.parseASE(Buffer.from("not an ase file")); } catch (e) { bad = e.message; }
ok(/not an Adobe Swatch Exchange/.test(bad), "non-ASE file → clear error (caller keeps template colours)");

// Contrast ranking on synthetic backgrounds
const bg = (rgb, w = 40, h = 20) => ({ width: w, height: h, data: Uint8Array.from({ length: w * h * 4 }, (_, i) => (i % 4 === 3 ? 255 : rgb[i % 4])) });
const cand = [sw[0], sw[1], sw[3]];
const dark = tc.chooseTextColor(tc.sampleLuminances(bg([20, 20, 30]), { x: 0, y: 0, width: 40, height: 20 }), cand);
const light = tc.chooseTextColor(tc.sampleLuminances(bg([235, 235, 240]), { x: 0, y: 0, width: 40, height: 20 }), cand);
ok(dark.swatch.name === "White" && light.swatch.name === "Black", `dark background → White (${dark.score}), light → Black (${light.score})`);
// mostly light with a few dark pixels: the 10th-percentile score ignores the small dark spot
const mixed = bg([240, 240, 240]); for (let i = 0; i < 40 * 20 * 4 * 0.05; i += 4) { mixed.data[i] = mixed.data[i + 1] = mixed.data[i + 2] = 10; }
ok(tc.chooseTextColor(tc.sampleLuminances(mixed, { x: 0, y: 0, width: 40, height: 20 }), cand).swatch.name === "Black", "a small dark area doesn't flip a light background to White");
ok(Math.abs(tc.contrastRatio(tc.relativeLuminance(255, 255, 255), tc.relativeLuminance(0, 0, 0)) - 21) < 1e-9, "WCAG white/black contrast = 21");
ok(tc.chooseTextColor(new Float32Array(0), cand) === null && tc.chooseTextColor(tc.sampleLuminances(bg([0, 0, 0]), { x: 0, y: 0, width: 40, height: 20 }), []) === null, "no pixels / no candidates → null (template colour kept)");
const part = tc.sampleLuminances(bg([0, 0, 0], 100, 100), { x: 90, y: 90, width: 50, height: 50 });
ok(part.length === 100, "text box clipped to the rendered page");

// Order: text colour only where the image already covers its frame
const render = require(PLUGIN_JS + "/render.js");
const waiting = render.pagesAwaitingExtension([
    { page: 1, status: "not_required", needsExtension: false },
    { page: 2, status: "extension_required", needsExtension: true },
    { page: 3, status: "needs_review", needsExtension: true, overridable: true },
    { page: 4, status: "needs_review", needsExtension: false },
]);
ok(waiting.has(1) && waiting.has(2) && !waiting.has(0) && !waiting.has(3), "covered page coloured now; uncovered pages (also over the limit) wait for Extend");
console.log(f ? f + " FAILED" : "all passed");
