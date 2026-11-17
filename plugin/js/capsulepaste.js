// capsulepaste.js — helpers for the "Paste Capsule JSON" box in step 3
// (Capsule mode). The Capsule workflow shows the detection in its Preview
// node with a Copy button; the designer pastes that text into the box, picks
// the photo it was made from (pasted text has no file name, so the photo is
// never guessed) and imports it. The box itself lives in index.html / index.js.

/* global navigator */

function r3(v) {
    return Math.round(v * 1000) / 1000;
}

// The pasted text → { ok, empty, detection, line, notes }.
//   parse: capsule.js parseCapsuleJson; clean: capsule.js cleanPastedText
function pasteState(text, parse, clean) {
    const s = clean ? clean(text) : String(text || "").trim();
    if (!s) return { ok: false, empty: true, detection: null, line: "", notes: [] };
    const r = parse(s);
    if (!r.ok) return { ok: false, detection: null, line: "✗ Not a valid Capsule JSON:", notes: r.errors.slice() };
    const b = r.detection.boundingBox, f = r.detection.focalPoint;
    return {
        ok: true,
        detection: r.detection,
        line: `✓ Valid — box x ${r3(b.x)} y ${r3(b.y)} · ${r3(b.width)} × ${r3(b.height)} · focal point ${r3(f.x)}, ${r3(f.y)}`,
        notes: r.warnings.slice(),
    };
}

// The status text under the box.
function pasteStatusText(state) {
    if (state.empty) return "";
    return [state.line].concat(state.notes.map((n) => (state.ok ? "Note — " : "• ") + n)).join("\n");
}

// UXP: navigator.clipboard.readText() (needs "clipboard": "read" in the
// manifest) resolves with a string, or with { "text/plain": string }.
async function readClipboardText() {
    if (typeof navigator === "undefined" || !navigator.clipboard) throw new Error("the clipboard is not available here");
    const c = navigator.clipboard;
    const v = typeof c.readText === "function" ? await c.readText()
        : typeof c.getContent === "function" ? await c.getContent() : null;
    if (typeof v === "string") return v;
    if (v && typeof v === "object") return String(v["text/plain"] || v.text || "");
    return "";
}

module.exports = { pasteState, pasteStatusText, readClipboardText };
