// Offline regression test (Node, no InDesign). Run: node tools/tests/run.js
// The "Paste Capsule JSON" box helpers (plugin/js/capsulepaste.js): validation
// of pasted text and the clipboard. The box itself: capsulepanel.test.js.
const path = require("path");
const REPO = path.resolve(__dirname, "../..");
const paste = require(REPO + "/plugin/js/capsulepaste.js");
const capsule = require(REPO + "/plugin/js/capsule.js");
let f = 0;
const ok = (c, m) => { console.log((c ? "PASS " : "FAIL ") + m); if (!c) f++; };

const COPIED = '{"focalPoint":{"x":0.533717114,"y":0.649771365,"normalized":true},"boundingBox":{"x":0.067434214,"y":0.2995427,"width":0.9325658,"height":0.70045733,"normalized":true}}';
const st = (t) => paste.pasteState(t, capsule.parseCapsuleJson, capsule.cleanPastedText);

// ---------- pure helpers ----------
ok(st("").empty && !st("").ok && paste.pasteStatusText(st("")) === "", "empty → not valid, no status shown");
const good = st(COPIED);
ok(good.ok && /^✓ Valid — box x 0\.067 y 0\.3 · 0\.933 × 0\.7 · focal point 0\.534, 0\.65$/.test(good.line), "copied Capsule JSON → valid: " + good.line);
ok(good.notes.some((n) => /edge/i.test(n)), "box touching the photo edge → note shown (same as file import)");
ok(/^✓ Valid.*\nNote — the bounding box touches/.test(paste.pasteStatusText(good)), "status text: ✓ line + notes");
ok(st("  \n```json\n" + COPIED + "\n```\n ").ok, "surrounding blanks and a ```json fence are tolerated");
const cut = st(COPIED.slice(0, 80));
ok(!cut.ok && /not valid JSON/.test(cut.notes[0]) && /^✗ Not a valid Capsule JSON:\n• not valid JSON/.test(paste.pasteStatusText(cut)), "half-copied text → 'not valid JSON'");
const bad = st(COPIED.replace('"width":0.9325658', '"width":1.2'));
ok(!bad.ok && bad.notes.length >= 1, "box outside the photo → rejected with the reason: " + bad.notes.join("; "));
ok(!st('{"focalPoint":{"x":0.5,"y":0.5,"normalized":false},"boundingBox":{"x":0,"y":0,"width":1,"height":1,"normalized":true}}').ok, "normalized:false → rejected");


// ---------- clipboard (UXP navigator.clipboard) ----------
(async () => {
    global.navigator = { clipboard: { readText: async () => ({ "text/plain": COPIED }) } };
    ok((await paste.readClipboardText()) === COPIED, "clipboard: UXP { 'text/plain': … } result read");
    global.navigator = { clipboard: { readText: async () => COPIED } };
    ok((await paste.readClipboardText()) === COPIED, "clipboard: plain string result read");
    global.navigator = {};
    let threw = false;
    try { await paste.readClipboardText(); } catch (e) { threw = true; }
    ok(threw, "no clipboard API → error (the panel then asks for ⌘V)");


    console.log(f ? `${f} FAILED` : "all passed");
    process.exit(f ? 1 : 0);
})().catch((e) => { console.log("FAIL harness error: " + (e && e.stack || e)); process.exit(1); });
