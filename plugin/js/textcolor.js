// textcolor.js — AUTO TEXT COLOR: which of the designer's selected palette
// colours reads best on the final composition behind the Headline/Subline.
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

// Decodes a JPEG (ArrayBuffer / Uint8Array) to { width, height, data: RGBA }.
function decodeJpeg(bytes) {
    let decode = null;
    for (const path of ["./lib/jpeg-decoder.js", "./js/lib/jpeg-decoder.js"]) {
        try { decode = require(path); if (typeof decode === "function") break; } catch (e) {}
    }
    if (typeof decode !== "function") throw new Error("JPEG decoder unavailable");
    return decode(bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes), { useTArray: true, formatAsRGBA: true });
}

module.exports = { relativeLuminance, contrastRatio, sampleLuminances, rankColors, chooseTextColor, decodeJpeg, SCORE_PERCENTILE };
