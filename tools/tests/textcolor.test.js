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

// ---------- weakest-zone scoring (per role) ----------
// A text line 400 × 40 px: bright metal, with a dark cable under the last
// 8 % of the line — below the 10 % the old single-box P10 ignores.
const line = (w, h, darkFrom) => ({ width: w, height: h, data: Uint8Array.from({ length: w * h * 4 }, (_, i) => {
    if (i % 4 === 3) return 255; const x = Math.floor(i / 4) % w; return x >= darkFrom ? 12 : 238; }) });
const marder = line(400, 40, 368);
const lineBox = [{ x: 0, y: 0, width: 400, height: 40 }];
const zones = tc.sampleZones(marder, lineBox);
ok(zones.length === 5, `line split into ${zones.length} zones (400 px / (2 × 40 px))`);
const red = sw.find((s) => s.name === "Red");
const cand3 = [sw[0], sw[1], red];
const old = tc.chooseTextColor(tc.sampleLuminances(marder, lineBox[0]), cand3);
const neu = tc.chooseTextColorByZones(zones, cand3, tc.readabilityThreshold(87));
ok(old.swatch.name === "Black", `old whole-box P10 picks Black (${old.score}) — unreadable over the cable`);
const blackRank = neu.ranking.find((x) => x.swatch.name === "Black");
ok(neu.swatch.name === "Red" && blackRank.weakest.zone === 4 && blackRank.score < 1.5,
    `weakest-zone scoring picks ${neu.swatch.name} (weakest ${neu.score}); Black drops to ${blackRank.score} — its weakest zone is the cable (zone ${blackRank.weakest.zone})`);
ok(neu.score <= neu.overall, "score = min(overall P10, weakest zone P10)");
// Headline and subline decided independently
const darkLine = tc.sampleZones(line(300, 30, 0), [{ x: 0, y: 0, width: 300, height: 30 }]);
const brightLine = tc.sampleZones(line(300, 30, 9999), [{ x: 0, y: 0, width: 300, height: 30 }]);
ok(tc.chooseTextColorByZones(darkLine, cand, 3).swatch.name === "White" && tc.chooseTextColorByZones(brightLine, cand, 3).swatch.name === "Black",
    "headline over a dark area → White, subline over a bright area → Black (separate decisions)");
// Threshold: large text 3:1, normal 4.5:1; below it → best still returned, readable false
ok(tc.readabilityThreshold(87) === 3 && tc.readabilityThreshold(18) === 3 && tc.readabilityThreshold(14) === 4.5, "WCAG threshold: ≥ 18 pt → 3:1, smaller → 4.5:1");
const brightOnly = tc.sampleZones(bg([238, 238, 238], 200, 20), [{ x: 0, y: 0, width: 200, height: 20 }]);
const g = tc.chooseTextColorByZones(brightOnly, [sw[0], red], 4.5); // only White + Red selected, small text
ok(g && g.swatch.name === "Red" && g.readable === false && g.score < 4.5, `bright background, only White/Red selected: best ${g.swatch.name} (${g.score}) still returned, readable = false`);
ok(tc.chooseTextColorByZones([], cand, 3) === null && tc.chooseTextColorByZones(brightOnly, [], 3) === null, "no lines / no candidates → null (template colour kept)");
// render.js: warnings, label, summary
const lowLabel = { v: 2, headline: { name: "White RGB", score: 2.1, threshold: 3, readable: false }, subline: { name: "White RGB", score: 6, threshold: 3, readable: true } };
const lw = render.lowContrastWarnings(lowLabel);
ok(lw.length === 1 && /headline White RGB reaches 2.1:1.*needs 3:1/.test(lw[0]), "stored label → one low-contrast warning (headline only): " + lw[0]);
ok(render.lowContrastWarnings({ swatch: "x", score: 2 }).length === 0 && render.lowContrastWarnings(null).length === 0, "old / missing label → no warning");
const results = [{ layout: "service_up 1200x1200", roles: [{ role: "headline", swatch: "White RGB", score: 2.1, overall: 4, threshold: 3, readable: false, ranking: ["White RGB 2.1"] },
    { role: "subline", swatch: "Audi Black RGB", score: 5, overall: 6, threshold: 3, readable: true, ranking: ["Audi Black RGB 5"] }] }, { layout: "x", pending: true }];
const tw = render.textColorWarnings(results);
ok(tw.length === 1 && /^WARNING service_up 1200x1200: low text contrast — headline/.test(tw[0]), "low contrast → a WARNING line (product goes to Review)");
const sum = render.summarizeTextColors(results);
ok(sum.lowContrast === 1 && sum.names.length === 2 && sum.pages === 1 && sum.waitingForExtension === 1, "summary counts colours, low-contrast roles, waiting pages");
ok(/headline White RGB .*LOW.*\| subline Audi Black RGB/.test(render.textColorLogLine(results[0])), "log line names both roles, LOW marked");
console.log(f ? f + " FAILED" : "all passed");
