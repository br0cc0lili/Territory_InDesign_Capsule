// Offline regression test (Node, no InDesign). Run: node tools/tests/run.js
// Headline/Subline fitting: no hyphenation, template size when it fits,
// otherwise the LARGEST headline size that fits the fixed frame (binary
// search) — the subline keeps its template size; fixed leading scaled, auto
// leading kept, frame untouched.
const PLUGIN_JS = require("path").resolve(__dirname, "../../plugin/js");
const Module = require("module"); const o = Module._load;
const Leading = { AUTO: 1635019116 };
const AutoSizingTypeEnum = { OFF: 1, HEIGHT_ONLY: 2 };
Module._load = function (r) {
    if (r === "indesign") return { app: {}, Leading, AutoSizingTypeEnum };
    if (r === "uxp") return { storage: { localFileSystem: {} } };
    return o.apply(this, arguments);
};
const render = require(PLUGIN_JS + "/render.js");
let f = 0; const ok = (c, m) => { console.log((c ? "PASS " : "FAIL ") + m); if (!c) f++; };

// PURE search
const at = (limit) => (s) => s <= limit;
ok(render.largestFittingScale(at(1), 60) === 1, "fits already → scale 1 (template size kept)");
const s = render.largestFittingScale(at(0.6137), 60);
ok(s <= 0.6137 && (0.6137 - s) * 60 <= 0.1, `largest fitting scale found within 0.1 pt (${s.toFixed(4)} for limit 0.6137)`);
ok(render.largestFittingScale(at(0.1), 60) === null, "doesn't fit even at the minimum → null");
let calls = 0; render.largestFittingScale((x) => { calls++; return x <= 0.5; }, 60);
ok(calls <= 16, `binary search, not a fixed-step loop (${calls} checks)`);

// PURE broken-word check
ok(!render.wordSplitAcrossLines(["Ski- und ", "Snowboardhalter\r", "Subline"]), "breaks at space / paragraph end are whole-word breaks");
ok(!render.wordSplitAcrossLines(["Allwetter-", "fußmatten"]), "a break after an existing hyphen is allowed");
ok(render.wordSplitAcrossLines(["Allwetterfuß", "matten"]), "a word broken across lines is detected (incl. ß)");
// Lines cut from the story text by start index: an automatic hyphen is not
// part of the text, so "Snowboard-|halter1" is "Snowboard" + "halter1".
const cut = render.linesFromStarts("Ski- und Snowboardhalter1\rAudi Original Zubehör", [0, 9, 18, 26]);
ok(JSON.stringify(cut) === JSON.stringify(["Ski- und ", "Snowboard", "halter1\r", "Audi Original Zubehör"]), "lines cut from the story by start index");
ok(render.wordSplitAcrossLines(cut), "auto-hyphenated Snowboard-|halter1 is caught");
ok(!render.wordSplitAcrossLines(render.linesFromStarts("Ski- und Snowboardhalter1\rAudi Original Zubehör", [0, 9, 26])), "Ski- und | Snowboardhalter1 is a whole-word break");

// Mock frame: paragraph 0 = headline, 1 = subline; the text oversets while
// the headline is over `capacity` pt.
function mockFrame(runsSpec, capacity, opts) {
    const chars = [];
    for (const r of runsSpec) for (let i = 0; i < r.len; i++) chars.push({ pointSize: r.size, leading: r.leading, hyphenation: true, para: r.para || 0 });
    const runsOf = (para) => {
        const out = []; let i = 0;
        while (i < chars.length) {
            if (chars[i].para !== para) { i++; continue; }
            let j = i; while (j + 1 < chars.length && chars[j + 1].para === para && chars[j + 1].pointSize === chars[i].pointSize && chars[j + 1].leading === chars[i].leading) j++;
            const a = i, b = j;
            const sub = { length: b - a + 1, item: (k) => ({ index: a + k }) };
            out.push({ characters: sub, pointSize: chars[a].pointSize, leading: chars[a].leading });
            i = j + 1;
        }
        return out;
    };
    const story = {
        set hyphenation(v) { chars.forEach((c) => { c.hyphenation = v; }); },
        paragraphs: {
            get length() { return Math.max(...chars.map((c) => c.para)) + 1; },
            item: (p) => ({
                contents: p ? "Subline" : "Headline\r",
                set hyphenation(v) { chars.filter((c) => c.para === p).forEach((c) => { c.hyphenation = v; }); },
                get hyphenation() { return chars.filter((c) => c.para === p).every((c) => c.hyphenation === false) ? false : true; },
                get textStyleRanges() { const r = runsOf(p); return { length: r.length, item: (i) => r[i] }; },
            }),
        },
        characters: {
            itemByRange: (a, b) => ({
                set pointSize(v) { for (let k = a; k <= b; k++) chars[k].pointSize = v; },
                set leading(v) { for (let k = a; k <= b; k++) chars[k].leading = v; },
            }),
        },
        recompose() {},
        get contents() { return frameLines().join(""); },
    };
    const frameLines = () => (opts && opts.splitAbove && max() > opts.splitAbove ? ["Allwetterfuß", "matten\r", "Subline"] : ["Headline\r", "Subline"]);
    const max = () => Math.max(...chars.filter((c) => c.para === 0).map((c) => c.pointSize));
    const frame = {
        geometricBounds: [10, 10, 110, 410],
        parentStory: story,
        textFramePreferences: { autoSizingType: (opts && opts.autoSize) || AutoSizingTypeEnum.OFF },
        get overflows() { return max() > capacity; },
        get lines() {
            const l = frameLines(); const starts = []; let at = 0;
            for (const t of l) { starts.push(at); at += t.length; }
            return { length: l.length, item: (i) => ({ contents: l[i], characters: { item: () => ({ index: starts[i] }) } }) };
        },
    };
    return { frame, chars };
}

// Fits: nothing changes but hyphenation
let m = mockFrame([{ len: 10, size: 48, leading: Leading.AUTO }, { len: 8, size: 24, leading: 28, para: 1 }], 60);
let r = render.fitHeadlineToFrame(m.frame);
ok(r.fits && r.scale === 1 && m.chars[0].pointSize === 48 && m.chars[12].pointSize === 24 && m.chars[12].leading === 28, "text fits → template sizes kept exactly");
ok(m.chars.every((c) => c.hyphenation === false), "hyphenation turned off for the whole headline/subline story");

// Doesn't fit: largest headline size that fits; subline untouched
m = mockFrame([{ len: 10, size: 48, leading: Leading.AUTO }, { len: 8, size: 24, leading: 28, para: 1 }], 36.25, { autoSize: AutoSizingTypeEnum.HEIGHT_ONLY });
const bounds = m.frame.geometricBounds.slice();
r = render.fitHeadlineToFrame(m.frame);
const head = m.chars[0].pointSize, sub = m.chars[12].pointSize;
ok(r.fits && head <= 36.25 && head >= 36.1, `shrunk to the largest fitting size: 48 → ${head} pt (limit 36.25)`);
ok(sub === 24 && m.chars[12].leading === 28, `subline keeps its template size + leading (${sub} pt / ${m.chars[12].leading} pt)`);
ok(m.chars[0].leading === Leading.AUTO, "auto leading stays auto");
ok(m.frame.textFramePreferences.autoSizingType === AutoSizingTypeEnum.OFF && JSON.stringify(m.frame.geometricBounds) === JSON.stringify(bounds), "frame auto-sizing off, geometry unchanged");
ok(/reduced 48 → /.test(r.note) && /hyphenation off/.test(r.note) && /lines \["Headline","Subline"\]/.test(r.note), "note: " + r.note);

// two headline runs (e.g. a bold word): one factor for both, fixed leading scaled
m = mockFrame([{ len: 4, size: 48, leading: 52 }, { len: 6, size: 40, leading: 44 }, { len: 8, size: 24, leading: 28, para: 1 }], 30);
r = render.fitHeadlineToFrame(m.frame);
ok(r.fits && Math.abs(m.chars[5].pointSize / m.chars[0].pointSize - 40 / 48) < 0.01 && Math.abs(m.chars[0].leading / m.chars[0].pointSize - 52 / 48) < 0.01 && m.chars[12].pointSize === 24,
    `headline runs scaled together (${m.chars[0].pointSize} / ${m.chars[5].pointSize} pt), fixed leading with them; subline 24 pt`);

// No overset at 40 pt, but a long word only stays whole at ≤ 30 pt
m = mockFrame([{ len: 10, size: 48, leading: Leading.AUTO }], 40, { splitAbove: 30 });
r = render.fitHeadlineToFrame(m.frame);
ok(r.fits && m.chars[0].pointSize <= 30 && m.chars[0].pointSize >= 29.9, `a size that would split a word doesn't count as fitting (${m.chars[0].pointSize} pt)`);

// Never fits: template size restored, reported
m = mockFrame([{ len: 10, size: 48, leading: 50 }], 5);
r = render.fitHeadlineToFrame(m.frame);
ok(!r.fits && m.chars[0].pointSize === 48 && m.chars[0].leading === 50, "doesn't fit even at the minimum → template size + leading restored exactly");
console.log(f ? f + " FAILED" : "all passed");
