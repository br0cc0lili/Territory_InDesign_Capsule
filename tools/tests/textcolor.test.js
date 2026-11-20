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
const neu = tc.chooseTextColorByZones(zones, cand3, tc.readabilityThreshold(87, "wcag2"), { method: "wcag2" });
ok(old.swatch.name === "Black", `old whole-box P10 picks Black (${old.score}) — unreadable over the cable`);
const blackRank = neu.ranking.find((x) => x.swatch.name === "Black");
ok(neu.swatch.name === "Red" && blackRank.weakest.zone === 4 && blackRank.score < 1.5,
    `weakest-zone scoring picks ${neu.swatch.name} (weakest ${neu.score}); Black drops to ${blackRank.score} — its weakest zone is the cable (zone ${blackRank.weakest.zone})`);
ok(neu.score <= neu.overall, "score = min(overall P10, weakest zone P10)");
// Headline and subline decided independently
const darkLine = tc.sampleZones(line(300, 30, 0), [{ x: 0, y: 0, width: 300, height: 30 }]);
const brightLine = tc.sampleZones(line(300, 30, 9999), [{ x: 0, y: 0, width: 300, height: 30 }]);
ok(tc.chooseTextColorByZones(darkLine, cand, 3, { method: "wcag2" }).swatch.name === "White" && tc.chooseTextColorByZones(brightLine, cand, 3, { method: "wcag2" }).swatch.name === "Black",
    "headline over a dark area → White, subline over a bright area → Black (separate decisions)");
// Threshold: large text 3:1, normal 4.5:1; below it → best still returned, readable false
ok(tc.readabilityThreshold(87, "wcag2") === 3 && tc.readabilityThreshold(18, "wcag2") === 3 && tc.readabilityThreshold(14, "wcag2") === 4.5, "WCAG threshold: ≥ 18 pt → 3:1, smaller → 4.5:1");
const brightOnly = tc.sampleZones(bg([238, 238, 238], 200, 20), [{ x: 0, y: 0, width: 200, height: 20 }]);
const g = tc.chooseTextColorByZones(brightOnly, [sw[0], red], 4.5, { method: "wcag2" }); // only White + Red selected, small text
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

// ---------- APCA (default method) + template colour preference ----------
// Reference values from the APCA-W3 0.0.98G-4g test suite.
const lc = (t, b) => tc.apcaContrast(tc.apcaY(...t), tc.apcaY(...b));
const near = (a, b, d) => Math.abs(a - b) <= d;
ok(near(lc([0, 0, 0], [255, 255, 255]), 106.04, 0.1) && near(lc([255, 255, 255], [0, 0, 0]), -107.88, 0.1),
    `APCA black on white Lc ${lc([0, 0, 0], [255, 255, 255]).toFixed(2)} (106.04), white on black ${lc([255, 255, 255], [0, 0, 0]).toFixed(2)} (-107.88)`);
ok(near(lc([136, 136, 136], [255, 255, 255]), 63.06, 0.1) && near(lc([255, 255, 255], [136, 136, 136]), -68.54, 0.1),
    "APCA #888 on #fff Lc 63.06, #fff on #888 Lc -68.54");
ok(lc([128, 128, 128], [128, 128, 128]) === 0, "same colour → Lc 0");
ok(tc.DEFAULT_METHOD === "apca", "APCA is the default contrast method");
ok(tc.readabilityThreshold(87) === 45 && tc.readabilityThreshold(36) === 45 && tc.readabilityThreshold(30) === 60 && tc.readabilityThreshold(14) === 75,
    "APCA thresholds: ≥ 36 pt Lc 45, ≥ 24 pt Lc 60, smaller Lc 75");

// The real case: the grey-pink winter sky behind "Ski- und Snowboardhalter1"
// (average rgb 170,161,160 measured on the exported poster).
const sky = tc.sampleZones(bg([170, 161, 160], 400, 40), [{ x: 0, y: 0, width: 400, height: 40 }]);
const bw = [sw[0], sw[1]]; // White, Black
const w2 = tc.chooseTextColorByZones(sky, bw, tc.readabilityThreshold(87, "wcag2"), { method: "wcag2" });
const w2White = w2.ranking.find((x) => x.swatch.name === "White");
ok(w2.swatch.name === "Black" && w2.score > 3 * w2White.score && w2White.score < 3,
    `mid-tone sky, WCAG 2: Black ${w2.score}:1 vs White ${w2White.score}:1 ("fails") — the old bias`);
const ap = tc.chooseTextColorByZones(sky, bw, tc.readabilityThreshold(87));
const apW = ap.ranking.find((x) => x.swatch.name === "White"), apB = ap.ranking.find((x) => x.swatch.name === "Black");
ok(ap.method === "apca" && Math.abs(apW.score - apB.score) < 5 && apW.score >= 45 && apB.score >= 45,
    `mid-tone sky, APCA: White Lc ${apW.score} ≈ Black Lc ${apB.score}, both readable for an 87 pt headline`);
// template colour kept while readable — whichever of the two it is
const keepWhite = tc.chooseTextColorByZones(sky, bw, 45, { preferred: [255, 255, 255] });
const keepBlack = tc.chooseTextColorByZones(sky, bw, 45, { preferred: [0, 0, 0] });
ok(keepWhite.swatch.name === "White" && keepBlack.swatch.name === "Black" && keepWhite.readable && keepBlack.readable,
    "template White stays White, template Black stays Black, when readable");
ok(keepBlack.keptTemplate === (apW.score > apB.score) && keepWhite.keptTemplate === (apB.score > apW.score),
    "keptTemplate marks only a pick that overrode a higher-scoring colour");
// …but not when it fails
const brightBg = tc.sampleZones(bg([238, 238, 238], 400, 40), [{ x: 0, y: 0, width: 400, height: 40 }]);
const swap = tc.chooseTextColorByZones(brightBg, bw, 45, { preferred: [255, 255, 255] });
ok(swap.swatch.name === "Black" && !swap.keptTemplate && swap.readable, `bright background: template White fails → Black (Lc ${swap.score})`);
const darkBg = tc.sampleZones(bg([20, 20, 30], 400, 40), [{ x: 0, y: 0, width: 400, height: 40 }]);
ok(tc.chooseTextColorByZones(darkBg, bw, 45, { preferred: [0, 0, 0] }).swatch.name === "White", "dark background: template Black fails → White");
// nothing readable: near-tie keeps the template colour (still flagged), a clear loser doesn't
const tieWhite = tc.chooseTextColorByZones(sky, bw, 60, { preferred: [255, 255, 255] });
const tieBlack = tc.chooseTextColorByZones(sky, bw, 60, { preferred: [0, 0, 0] });
ok(tieWhite.swatch.name === "White" && tieBlack.swatch.name === "Black" && !tieWhite.readable && !tieBlack.readable,
    "nothing reaches Lc 60 on the sky: White ≈ Black, so the template colour stays — and is still flagged unreadable");
const grey = tc.chooseTextColorByZones(brightBg, [sw[0], sw[1]], 120, { preferred: [255, 255, 255] });
ok(grey.swatch.name === "Black" && !grey.keptTemplate && !grey.readable, "nothing readable but template far behind (White on bright) → best colour");
// template colour not among the selected swatches → plain best score
const onlyRed = tc.chooseTextColorByZones(sky, [sw[1], red], 45, { preferred: [255, 255, 255] });
ok(!onlyRed.keptTemplate && onlyRed.swatch === onlyRed.ranking[0].swatch, "template colour not selected → best-scoring swatch");
ok(tc.matchingSwatch(bw, [250, 250, 248]) === sw[0] && tc.matchingSwatch(bw, [128, 128, 128]) === null && tc.matchingSwatch(bw, null) === null,
    "template colour matched to a swatch within the tolerance (Paper ≈ White), else none");
// zones without APCA values (built by hand) fail loudly instead of scoring 0
let noYs = ""; try { tc.scoreZones([{ line: 0, zone: 0, lum: new Float32Array([0.5]) }], [0, 0, 0]); } catch (e) { noYs = e.message; }
ok(/without APCA values/.test(noYs), "zones without APCA samples → clear error");

// render.js: units in warnings / log lines follow the method
const apLabel = { v: 2, method: "apca", headline: { name: "White RGB", score: 38.2, threshold: 45, readable: false } };
ok(/reaches Lc 38.2 .*needs Lc 45/.test(render.lowContrastWarnings(apLabel)[0]), "APCA label → warning in Lc units");
const apResults = [{ layout: "danis_up 1200x1200", roles: [{ role: "headline", swatch: "White RGB", score: 52.1, overall: 55, threshold: 45, readable: true,
    keptTemplate: true, method: "apca", ranking: ["Audi Black RGB 53", "White RGB 52.1"] }] }];
const apLine = render.textColorLogLine(apResults[0]);
ok(/headline White RGB \(template colour, readable\) \(APCA weakest-zone contrast Lc 52.1;.*needs Lc 45;/.test(apLine), "log line: APCA, Lc units, template colour kept: " + apLine);
ok(/^WARNING x: low text contrast — headline White RGB reaches Lc 30/.test(render.textColorWarnings([{ layout: "x", roles: [{ role: "headline", swatch: "White RGB", score: 30, threshold: 45, readable: false, method: "apca" }] }])[0] || ""),
    "low APCA contrast → WARNING in Lc units");
// ---------- ONE colour for headline + subline (chooseTextColorForRoles) ----------
const zonesOf = (rgb) => tc.sampleZones(bg(rgb, 400, 40), [{ x: 0, y: 0, width: 400, height: 40 }]);
// the grey sky: big headline (Lc 45) on mid-tone, smaller subline (Lc 60) on a lighter part
const headSky = { role: "headline", zones: zonesOf([170, 161, 160]), threshold: 45 };
const subLight = { role: "subline", zones: zonesOf([215, 208, 206]), threshold: 60 };
const joint = tc.chooseTextColorForRoles([headSky, subLight], bw, { preferred: [255, 255, 255] });
const jh = joint.roles.find((r) => r.role === "headline"), js = joint.roles.find((r) => r.role === "subline");
ok(joint.swatch.name === "Black" && joint.readable && jh.readable && js.readable,
    `sky + lighter subline: ONE colour, Black (headline Lc ${jh.score}, subline Lc ${js.score}) — White would fail the subline`);
const whiteRank = joint.ranking.find((r) => r.swatch.name === "White");
ok(whiteRank.margin < 0 && joint.margin >= 0 && !joint.keptTemplate, `White's weakest role is below its minimum (margin ${whiteRank.margin}) → template White not kept`);
// both readable in White → template White kept even if Black scores higher
const darkSub = { role: "subline", zones: zonesOf([40, 40, 50]), threshold: 60 };
const darkHead = { role: "headline", zones: zonesOf([60, 60, 70]), threshold: 45 };
ok(tc.chooseTextColorForRoles([darkHead, darkSub], bw, { preferred: [255, 255, 255] }).swatch.name === "White", "dark behind both → White for both");
// nothing works for both: dark headline area, bright subline area
const brightSub = { role: "subline", zones: zonesOf([240, 240, 240]), threshold: 60 };
const split = tc.chooseTextColorForRoles([darkHead, brightSub], bw, {});
ok(split && !split.readable && split.roles.length === 2 && split.roles.some((r) => !r.readable), "dark headline + bright subline: one colour still chosen, flagged unreadable");
ok(split.ranking.every((r, i, a) => i === 0 || a[i - 1].margin >= r.margin), "ranking sorted by margin (weakest role)");
// near-tie for the joint choice too
const tie = tc.chooseTextColorForRoles([{ role: "headline", zones: sky, threshold: 60 }], bw, { preferred: [255, 255, 255] });
ok(tie.swatch.name === "White" && !tie.readable, "nothing readable, White ≈ Black → template White kept (still flagged)");
ok(tc.chooseTextColorForRoles([{ role: "headline", zones: [], threshold: 45 }], bw, {}) === null && tc.chooseTextColorForRoles([headSky], [], {}) === null,
    "no measured role / no candidates → null (template colours kept)");
const sharedLine = render.textColorLogLine({ layout: "p", roles: [{ role: "headline", swatch: "Audi Black RGB", score: 50, overall: 55, threshold: 45, readable: true, method: "apca", shared: true, ranking: ["Audi Black RGB margin 5"] }] });
ok(/headline Audi Black RGB \[same colour for headline \+ subline\]/.test(sharedLine), "log line marks the shared colour");

// render.js: an InDesign colour → sRGB, whatever shape UXP gives the space enum in
const enums = { RGB: { id: 1 }, CMYK: { id: 2 }, LAB: { id: 3 } };
const toRgb = cp.toRgb;
ok(JSON.stringify(render.colorValueToRgb(enums.RGB, [255, 255, 255], enums, toRgb)) === "[255,255,255]", "RGB enum object → as is");
ok(JSON.stringify(render.colorValueToRgb("ColorSpace.CMYK", [0, 0, 0, 100], enums, toRgb)) === "[0,0,0]", "CMYK by name ('ColorSpace.CMYK') → black");
ok(JSON.stringify(render.colorValueToRgb(1666336578, [0, 0, 0, 0], {}, toRgb)) === "[255,255,255]", "unknown numeric enum, 4 values → CMYK white");
ok(JSON.stringify(render.colorValueToRgb(1666336579, [245, 5, 55], {}, toRgb)) === "[245,5,55]", "unknown numeric enum, 3 values 0–255 → RGB");
const labRed = render.colorValueToRgb("LAB", [50, 75, 50], enums, toRgb);
ok(labRed && labRed[0] > 180 && labRed[1] < 80, "LAB by name → red approximation");
ok(render.colorValueToRgb("RGB", [], enums, toRgb) === null && render.colorValueToRgb("RGB", ["x"], enums, toRgb) === null, "no / bad values → null");
console.log(f ? f + " FAILED" : "all passed");
