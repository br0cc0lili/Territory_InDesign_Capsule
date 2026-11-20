// textcolor.js — AUTO TEXT COLOR: which of the designer's selected palette
// colours reads best on the final composition behind the Headline/Subline
// (render.js uses the weakest-zone scoring further down, per text role).
//
// Pure functions (no InDesign): render.js renders the page with the text
// hidden, decodes the JPG and passes the pixels + the text area here.
//
// Readability = WCAG 2 contrast ratio between the text colour and each
// background pixel ((L1 + 0.05) / (L2 + 0.05), L = relative luminance). A
// colour's score is the contrast that 90 % of the text area reaches (10th
// percentile) — one bright highlight or dark corner doesn't decide it; the
// mean contrast breaks ties.

/* global require */

const SCORE_PERCENTILE = 0.10;
const MAX_SAMPLES = 40000; // pixels sampled per text area (evenly spaced)

const lin = (c) => { c /= 255; return c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4); };
// PURE. WCAG relative luminance of an sRGB colour (0–255).
function relativeLuminance(r, g, b) {
    return 0.2126 * lin(r) + 0.7152 * lin(g) + 0.0722 * lin(b);
}

// PURE. WCAG contrast ratio of two luminances (1 … 21).
function contrastRatio(l1, l2) {
    const hi = Math.max(l1, l2), lo = Math.min(l1, l2);
    return (hi + 0.05) / (lo + 0.05);
}

// PURE. Luminances of the pixels inside `box` ({ x, y, width, height } in
// image pixels) of an RGBA image ({ width, height, data }), evenly
// sub-sampled to at most MAX_SAMPLES. Returns a Float32Array.
function sampleLuminances(image, box) {
    const x0 = Math.max(0, Math.floor(box.x)), y0 = Math.max(0, Math.floor(box.y));
    const x1 = Math.min(image.width, Math.ceil(box.x + box.width)), y1 = Math.min(image.height, Math.ceil(box.y + box.height));
    const w = x1 - x0, h = y1 - y0;
    if (w <= 0 || h <= 0) return new Float32Array(0);
    const step = Math.max(1, Math.ceil(Math.sqrt((w * h) / MAX_SAMPLES)));
    const out = [];
    for (let y = y0; y < y1; y += step) {
        for (let x = x0; x < x1; x += step) {
            const i = (y * image.width + x) * 4;
            out.push(relativeLuminance(image.data[i], image.data[i + 1], image.data[i + 2]));
        }
    }
    return Float32Array.from(out);
}

function percentile(sorted, p) {
    if (!sorted.length) return 0;
    return sorted[Math.min(sorted.length - 1, Math.max(0, Math.floor(p * (sorted.length - 1))))];
}

// PURE. Ranks candidate swatches ({ rgb:[r,g,b], … }) on a background
// (luminances). Returns [{ swatch, score, mean }], best first.
function rankColors(luminances, candidates) {
    const ranked = [];
    for (const swatch of candidates || []) {
        if (!swatch || !swatch.rgb) continue;
        const lt = relativeLuminance(swatch.rgb[0], swatch.rgb[1], swatch.rgb[2]);
        const cr = Array.from(luminances, (lb) => contrastRatio(lt, lb)).sort((a, b) => a - b);
        const mean = cr.reduce((s, v) => s + v, 0) / (cr.length || 1);
        ranked.push({ swatch, score: Math.round(percentile(cr, SCORE_PERCENTILE) * 100) / 100, mean: Math.round(mean * 100) / 100 });
    }
    return ranked.sort((a, b) => b.score - a.score || b.mean - a.mean);
}

// PURE. The best candidate, or null (no candidates / no pixels).
function chooseTextColor(luminances, candidates) {
    if (!luminances || !luminances.length) return null;
    const ranked = rankColors(luminances, candidates);
    return ranked.length ? Object.assign({ ranking: ranked }, ranked[0]) : null;
}

// ---------- weakest-zone scoring (Headline / Subline separately) ----------
//
// A single score over one big text box can hide a bad part: "Marderabwehr"
// over bright metal AND a dark cable averages out fine but half the word is
// hard to read. So each text role (headline, subline) is scored on its own
// glyph lines, each line cut into horizontal zones, and a colour is only as
// good as its WEAKEST zone:
//   zoneP10(c, z)  = P10 { CR(c, p) : p in zone z }
//   overallP10(c)  = P10 { CR(c, p) : p in all lines of the role }
//   score(c)       = min(overallP10(c), min_z zoneP10(c, z))
// Ties: overallP10, then the mean. Readable when score ≥ the threshold for
// the text size (readabilityThreshold).
//
// CONTRAST METHOD. CR is either
//   "apca"  (default) — APCA Lc (0 … ~106), the perceptual contrast model
//           drafted for WCAG 3. Scored as |Lc|, so light-on-dark and
//           dark-on-light count the same way.
//   "wcag2" — the WCAG 2 ratio (1 … 21) described above.
// Why APCA: WCAG 2 strongly over-rates black on MID-TONE backgrounds. On the
// grey-pink winter sky of "Ski- und Snowboardhalter" (avg rgb 170,161,160)
// WCAG 2 gives black 8.3:1 and white 2.5:1 ("fails"), so Auto Text Color
// kept switching the template's white headline to black. APCA rates the two
// about equal there (Lc 54 / 55), which matches what designers see; on
// clearly light or dark backgrounds both models agree.
const ZONES = { maxPerLine: 12, widthPerHeight: 2, minPixels: 12 };
const READABLE = { large: 3.0, normal: 4.5, largeFromPt: 18 };
// APCA "Bronze" minimums by font size (pt ≈ px in these 72 ppi poster
// layouts): headlines ≥ 36 → Lc 45, large text ≥ 24 → Lc 60, else Lc 75.
const READABLE_APCA = [{ fromPt: 36, lc: 45 }, { fromPt: 24, lc: 60 }, { fromPt: 0, lc: 75 }];
const METHODS = { apca: "apca", wcag2: "wcag2" };
const DEFAULT_METHOD = METHODS.apca;
const methodOf = (m) => (m === METHODS.wcag2 ? METHODS.wcag2 : DEFAULT_METHOD);

// APCA-W3 0.0.98G-4g constants (sRGB). github.com/Myndex/apca-w3
const APCA = { trc: 2.4, r: 0.2126729, g: 0.7151522, b: 0.0721750, normBG: 0.56, normTXT: 0.57, revTXT: 0.62, revBG: 0.65,
    blkThrs: 0.022, blkClmp: 1.414, scale: 1.14, offset: 0.027, loClip: 0.1, deltaYmin: 0.0005 };

// PURE. APCA screen luminance Y of an sRGB colour (0–255), soft-clamped
// near black as APCA specifies.
function apcaY(r, g, b) {
    const y = APCA.r * Math.pow(r / 255, APCA.trc) + APCA.g * Math.pow(g / 255, APCA.trc) + APCA.b * Math.pow(b / 255, APCA.trc);
    return y > APCA.blkThrs ? y : y + Math.pow(APCA.blkThrs - y, APCA.blkClmp);
}

// PURE. APCA lightness contrast Lc of text (Y) on background (Y): positive
// for dark text on light, negative for light text on dark; 0 when too close.
function apcaContrast(txtY, bgY) {
    if (Math.abs(bgY - txtY) < APCA.deltaYmin) return 0;
    if (bgY > txtY) {
        const s = (Math.pow(bgY, APCA.normBG) - Math.pow(txtY, APCA.normTXT)) * APCA.scale;
        return s < APCA.loClip ? 0 : (s - APCA.offset) * 100;
    }
    const s = (Math.pow(bgY, APCA.revBG) - Math.pow(txtY, APCA.revTXT)) * APCA.scale;
    return s > -APCA.loClip ? 0 : (s + APCA.offset) * 100;
}

// PURE. Minimum readable score for text of this size (pt), in the units of
// `method`: WCAG 2 — large text (≥ 18 pt) 3:1, otherwise 4.5:1; APCA — see
// READABLE_APCA.
function readabilityThreshold(pointSize, method) {
    const size = Number(pointSize) || 0;
    if (methodOf(method) === METHODS.wcag2) return size >= READABLE.largeFromPt ? READABLE.large : READABLE.normal;
    return READABLE_APCA.find((t) => size >= t.fromPt).lc;
}

// PURE. Like sampleLuminances, but returns BOTH per-pixel values a zone
// needs: { lum: WCAG relative luminance, ys: APCA screen luminance }.
function sampleBackground(image, box) {
    const x0 = Math.max(0, Math.floor(box.x)), y0 = Math.max(0, Math.floor(box.y));
    const x1 = Math.min(image.width, Math.ceil(box.x + box.width)), y1 = Math.min(image.height, Math.ceil(box.y + box.height));
    const w = x1 - x0, h = y1 - y0;
    if (w <= 0 || h <= 0) return { lum: new Float32Array(0), ys: new Float32Array(0) };
    const step = Math.max(1, Math.ceil(Math.sqrt((w * h) / MAX_SAMPLES)));
    const lum = [], ys = [];
    for (let y = y0; y < y1; y += step) {
        for (let x = x0; x < x1; x += step) {
            const i = (y * image.width + x) * 4;
            const r = image.data[i], g = image.data[i + 1], b = image.data[i + 2];
            lum.push(relativeLuminance(r, g, b));
            ys.push(apcaY(r, g, b));
        }
    }
    return { lum: Float32Array.from(lum), ys: Float32Array.from(ys) };
}

// PURE. The zones of a role's lines: each line box ({ x, y, width, height },
// image pixels) cut into n = clamp(round(width / (2 × height)), 1, 12)
// equal horizontal zones (fewer if a zone would have < minPixels pixels).
// Returns [{ line, zone, lum: Float32Array, ys: Float32Array }] (empty
// zones dropped). lum feeds WCAG 2, ys feeds APCA.
function sampleZones(image, lineBoxes) {
    const zones = [];
    (lineBoxes || []).forEach((b, line) => {
        if (!b || !(b.width > 0) || !(b.height > 0)) return;
        let n = Math.max(1, Math.min(ZONES.maxPerLine, Math.round(b.width / (ZONES.widthPerHeight * b.height))));
        while (n > 1 && (b.width / n) * b.height < ZONES.minPixels) n--;
        for (let k = 0; k < n; k++) {
            const s = sampleBackground(image, { x: b.x + (k * b.width) / n, y: b.y, width: b.width / n, height: b.height });
            if (s.lum.length) zones.push({ line, zone: k, lum: s.lum, ys: s.ys });
        }
    });
    return zones;
}

// PURE. Per-pixel contrast of one text colour, in `method` units:
// (background value) → score. Higher is always better.
function contrastFn(rgb, method) {
    if (methodOf(method) === METHODS.wcag2) {
        const lt = relativeLuminance(rgb[0], rgb[1], rgb[2]);
        return { key: "lum", fn: (lb) => contrastRatio(lt, lb) };
    }
    const yt = apcaY(rgb[0], rgb[1], rgb[2]);
    return { key: "ys", fn: (yb) => Math.abs(apcaContrast(yt, yb)) };
}

// PURE. One colour (rgb 0–255) against a role's zones:
// { score, overall, mean, weakest: { line, zone, p10 } } in `method` units
// (default APCA).
function scoreZones(zones, rgb, method) {
    const { key, fn } = contrastFn(rgb, method);
    const all = [];
    let weakest = null;
    for (const z of zones) {
        const values = z[key] || (key === "ys" ? null : z.lum);
        if (!values) throw new Error("zones were sampled without APCA values — use sampleZones()");
        const cr = Array.from(values, fn).sort((a, b) => a - b);
        const p10 = percentile(cr, SCORE_PERCENTILE);
        if (!weakest || p10 < weakest.p10) weakest = { line: z.line, zone: z.zone, p10 };
        for (const v of cr) all.push(v);
    }
    all.sort((a, b) => a - b);
    const overall = percentile(all, SCORE_PERCENTILE);
    const mean = all.reduce((s, v) => s + v, 0) / (all.length || 1);
    const r2 = (v) => Math.round(v * 100) / 100;
    return { score: r2(Math.min(overall, weakest ? weakest.p10 : overall)), overall: r2(overall), mean: r2(mean),
        weakest: weakest && { line: weakest.line, zone: weakest.zone, p10: r2(weakest.p10) } };
}

// Template colour preference: a selected swatch "is" the template's own text
// colour when their sRGB values are this close (Euclidean, 0–255 per channel;
// covers CMYK ↔ RGB rounding of the same brand colour, e.g. Paper vs White).
// nearTie: when NO selected colour is readable, the template colour is still
// kept if it scores within this margin of the best (method units) — the
// "winner" would be just as unreadable, and flipping white ↔ black between
// layouts of one product for a 1-point difference looks like a bug. The
// Review warning stays either way.
const PREFER = { maxRgbDistance: 24, nearTie: { apca: 5, wcag2: 0.3 } };

const rgbDistance = (a, b) => Math.sqrt((a[0] - b[0]) ** 2 + (a[1] - b[1]) ** 2 + (a[2] - b[2]) ** 2);

// PURE. The selected swatch that matches the template colour (nearest within
// PREFER.maxRgbDistance), or null.
function matchingSwatch(candidates, rgb) {
    if (!Array.isArray(rgb) || rgb.length < 3) return null;
    let best = null;
    for (const s of candidates || []) {
        if (!s || !s.rgb) continue;
        const d = rgbDistance(s.rgb, rgb);
        if (d <= PREFER.maxRgbDistance && (!best || d < best.d)) best = { s, d };
    }
    return best ? best.s : null;
}

// PURE. The candidate swatch for one role, or null (no zones / no
// candidates): { swatch, score, overall, mean, weakest, threshold, readable,
// method, keptTemplate, ranking: [{ swatch, score, overall, mean }] }.
//   threshold: minimum readable score, in `method` units
//   options.method: "apca" (default) | "wcag2"
//   options.preferred: the template's own text colour (rgb 0–255). When a
//     selected swatch matches it AND that swatch is readable, it is kept even
//     if another swatch scores higher — the designer's colour wins unless it
//     fails (keptTemplate: true). Also kept when nothing is readable and it is
//     within PREFER.nearTie of the best. Otherwise the best-scoring swatch.
// The result is returned even when nothing is readable (readable: false) —
// the caller applies it AND warns.
function chooseTextColorByZones(zones, candidates, threshold, options) {
    if (!zones || !zones.length) return null;
    const method = methodOf(options && options.method);
    const ranked = (candidates || []).filter((s) => s && s.rgb)
        .map((swatch) => Object.assign({ swatch }, scoreZones(zones, swatch.rgb, method)))
        .sort((a, b) => b.score - a.score || b.overall - a.overall || b.mean - a.mean);
    if (!ranked.length) return null;
    const t = threshold || readabilityThreshold(0, method);
    const tmpl = matchingSwatch(ranked.map((r) => r.swatch), options && options.preferred);
    const tr = tmpl && ranked.find((r) => r.swatch === tmpl);
    const kept = tr && (tr.score >= t || (ranked[0].score < t && ranked[0].score - tr.score <= PREFER.nearTie[method])) ? tr : null;
    const pick = kept || ranked[0];
    return Object.assign({ ranking: ranked, threshold: t, method, keptTemplate: !!kept && pick !== ranked[0],
        readable: pick.score >= t }, pick);
}

// PURE. ONE colour for all text roles of a page (Headline + Subline share a
// colour — team decision, 19 Nov 2026).
//   roles: [{ role, zones, threshold }] — each role keeps its OWN minimum
//     (a small subline needs more contrast than a big headline)
//   options: { method, preferred } as chooseTextColorByZones
// A colour's margin = min over roles of (score − threshold): how far its
// WEAKEST role is above (≥ 0, readable everywhere) or below its minimum.
// The best margin wins (ties: higher summed score). Template colour: kept
// when its margin ≥ 0, or when nothing reaches 0 and it is within
// PREFER.nearTie of the best margin — the same rules as for one role.
// Returns null (no role with zones / no candidates) or
//   { swatch, method, margin, readable, keptTemplate,
//     roles: [{ role, score, overall, mean, weakest, threshold, readable }],
//     ranking: [{ swatch, margin, total }] }.
function chooseTextColorForRoles(roles, candidates, options) {
    const method = methodOf(options && options.method);
    const usable = (roles || []).filter((r) => r && r.zones && r.zones.length);
    const swatches = (candidates || []).filter((s) => s && s.rgb);
    if (!usable.length || !swatches.length) return null;
    const ranked = swatches.map((swatch) => {
        const per = usable.map((r) => {
            const t = r.threshold || readabilityThreshold(0, method);
            const s = scoreZones(r.zones, swatch.rgb, method);
            return Object.assign({ role: r.role, threshold: t, readable: s.score >= t }, s);
        });
        const margin = Math.round(Math.min(...per.map((p) => p.score - p.threshold)) * 100) / 100;
        const total = per.reduce((s, p) => s + p.score, 0);
        return { swatch, margin, total, roles: per };
    }).sort((a, b) => b.margin - a.margin || b.total - a.total);
    const tmpl = matchingSwatch(swatches, options && options.preferred);
    const tr = tmpl && ranked.find((r) => r.swatch === tmpl);
    const kept = tr && (tr.margin >= 0 || (ranked[0].margin < 0 && ranked[0].margin - tr.margin <= PREFER.nearTie[method])) ? tr : null;
    const pick = kept || ranked[0];
    return { swatch: pick.swatch, method, margin: pick.margin, readable: pick.margin >= 0,
        keptTemplate: !!kept && pick !== ranked[0], roles: pick.roles,
        ranking: ranked.map((r) => ({ swatch: r.swatch, margin: r.margin, total: r.total })) };
}

// Decodes a JPEG (ArrayBuffer / Uint8Array) to { width, height, data: RGBA }.
function decodeJpeg(bytes) {
    let decode = null;
    for (const path of ["./lib/jpeg-decoder.js", "./js/lib/jpeg-decoder.js"]) {
        try { decode = require(path); if (typeof decode === "function") break; } catch (e) {}
    }
    if (typeof decode !== "function") throw new Error("JPEG decoder unavailable");
    return decode(bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes), { useTArray: true, formatAsRGBA: true });
}

module.exports = { relativeLuminance, contrastRatio, sampleLuminances, rankColors, chooseTextColor, decodeJpeg, SCORE_PERCENTILE,
    readabilityThreshold, sampleZones, scoreZones, chooseTextColorByZones, READABLE, ZONES,
    apcaY, apcaContrast, matchingSwatch, chooseTextColorForRoles, READABLE_APCA, METHODS, DEFAULT_METHOD, PREFER };
