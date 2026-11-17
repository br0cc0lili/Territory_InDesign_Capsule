// Offline regression test (Node, no InDesign). Run: node tools/tests/run.js
// The "Paste Capsule JSON" window (plugin/js/capsulepaste.js): validation of
// pasted text, the photo it belongs to, the clipboard, and the window on a
// minimal fake DOM.
const path = require("path");
const REPO = path.resolve(__dirname, "../..");
const paste = require(REPO + "/plugin/js/capsulepaste.js");
const capsule = require(REPO + "/plugin/js/capsule.js");
let f = 0;
const ok = (c, m) => { console.log((c ? "PASS " : "FAIL ") + m); if (!c) f++; };

const COPIED = '{"focalPoint":{"x":0.533717114,"y":0.649771365,"normalized":true},"boundingBox":{"x":0.067434214,"y":0.2995427,"width":0.9325658,"height":0.70045733,"normalized":true}}';
const st = (t) => paste.pasteState(t, capsule.parseCapsuleJson, capsule.cleanPastedText);

// ---------- pure helpers ----------
ok(st("").empty && !st("").ok, "empty → not valid, no error shown");
const good = st(COPIED);
ok(good.ok && /^✓ Valid — box x 0\.067 y 0\.3 · 0\.933 × 0\.7 · focal point 0\.534, 0\.65$/.test(good.line), "copied Capsule JSON → valid: " + good.line);
ok(good.notes.some((n) => /edge/i.test(n)), "box touching the photo edge → note shown (same as file import)");
ok(st("  \n```json\n" + COPIED + "\n```\n ").ok, "surrounding blanks and a ```json fence are tolerated");
const cut = st(COPIED.slice(0, 80));
ok(!cut.ok && /not valid JSON/.test(cut.notes[0]), "half-copied text → 'not valid JSON'");
const bad = st(COPIED.replace('"width":0.9325658', '"width":1.2'));
ok(!bad.ok && bad.notes.length >= 1, "box outside the photo → rejected with the reason: " + bad.notes.join("; "));
ok(!st('{"focalPoint":{"x":0.5,"y":0.5,"normalized":false},"boundingBox":{"x":0,"y":0,"width":1,"height":1,"normalized":true}}').ok, "normalized:false → rejected");

const photos = [{ imagePath: "/a.jpg", status: "auto" }, { imagePath: "/b.jpg", status: "missing" }, { imagePath: "/c.jpg", status: "missing" }];
ok(paste.startPhoto(photos, "") === "/b.jpg", "starts on the first photo without Capsule data");
ok(paste.startPhoto(photos, "/a.jpg") === "/a.jpg", "a requested photo wins");
ok(paste.startPhoto(photos, "/zzz.jpg") === "/b.jpg" && paste.startPhoto([], "") === "", "unknown request / no photos handled");
const t = paste.thumbSize({ width: 6000, height: 4000 });
ok(t.width === 360 && t.height === 240, "thumbnail fits 420×240 with the aspect kept: " + t.width + "×" + t.height);

// ---------- clipboard (UXP navigator.clipboard) ----------
(async () => {
    global.navigator = { clipboard: { readText: async () => ({ "text/plain": COPIED }) } };
    ok((await paste.readClipboardText()) === COPIED, "clipboard: UXP { 'text/plain': … } result read");
    global.navigator = { clipboard: { readText: async () => COPIED } };
    ok((await paste.readClipboardText()) === COPIED, "clipboard: plain string result read");
    global.navigator = {};
    let threw = false;
    try { await paste.readClipboardText(); } catch (e) { threw = true; }
    ok(threw, "no clipboard API → error (the window then asks for ⌘V)");

    // ---------- the window on a minimal fake DOM ----------
    function fakeDom() {
        const all = [];
        const mk = (tag) => {
            const n = { tagName: tag, children: [], style: {}, attrs: {}, listeners: {}, className: "", textContent: "", value: "", disabled: false,
                classList: { add(c) { n.className += " " + c; }, remove() {} },
                appendChild(c) { n.children.push(c); c.parent = n; if (c.tagName === "option" && (c.attrs.selected || n.value === "")) n.value = c.attrs.value; return c; },
                setAttribute(k, v) { n.attrs[k] = v; if (k === "selected") n.parent && (n.parent.value = n.attrs.value); },
                addEventListener(t, fn) { (n.listeners[t] = n.listeners[t] || []).push(fn); },
                fire(t, ev) { for (const fn of n.listeners[t] || []) fn(ev || {}); },
                remove() { n.removed = true; }, set innerHTML(v) { n.children = []; }, get innerHTML() { return ""; },
                close() { n.fire("close"); }, showModal() {} };
            all.push(n);
            return n;
        };
        return { all, document: { createElement: mk, body: mk("body") } };
    }
    const wait = () => new Promise((r) => setTimeout(r, 20));
    const PH = [
        { imagePath: "/p/A6/car_01.jpg", label: "A6 Avant — A6/car_01.jpg · has data", status: "auto", pixelSize: { width: 6000, height: 4000 } },
        { imagePath: "/p/A3/car_03.jpg", label: "A3 — A3/car_03.jpg · no data", status: "missing", pixelSize: { width: 1080, height: 1350 } },
    ];
    const base = { photos: PH, parse: capsule.parseCapsuleJson, clean: capsule.cleanPastedText, photoUrl: async () => ({ url: "data:x" }) };

    // 1) a Capsule JSON on the clipboard is filled in on open, for the photo without data
    let dom = fakeDom(); global.document = dom.document;
    let clip = COPIED;
    const btn = (d, label) => d.all.find((n) => n.tagName === "button" && n.textContent === label);
    const cls = (d, c) => d.all.filter((n) => (" " + n.className + " ").indexOf(" " + c + " ") !== -1);
    let open = paste.showCapsulePaste(Object.assign({ readClipboard: async () => clip }, base));
    await wait();
    const select = cls(dom, "paste-photo-select")[0];
    const text = dom.all.find((n) => n.tagName === "textarea");
    ok(!!select && select.value === "/p/A3/car_03.jpg" && select.children.length === 2, "window: photo picker lists the photos, starts on the one without data");
    ok(text.value === COPIED && /^✓ Valid/.test(cls(dom, "paste-status")[0].textContent), "window: Capsule JSON on the clipboard filled in on open");
    ok(!btn(dom, "Import for This Photo").disabled, "window: Import enabled for valid JSON");
    const stage = cls(dom, "paste-stage")[0];
    ok(stage.style.width === "192px" && stage.style.height === "240px", "window: A3 photo (1080×1350) shown at 192×240");
    const box = cls(dom, "paste-box").filter((n) => !n.removed).pop();
    ok(box && box.style.left === "13px" && box.style.top === "72px" && box.style.width === "179px" && box.style.height === "168px", "window: the pasted box is drawn on the photo, to scale");
    // switch the photo → box redrawn at the new scale, Import still targets the chosen photo
    select.value = "/p/A6/car_01.jpg"; select.fire("change");
    await wait();
    ok(stage.style.width === "360px" && /already has Capsule data/.test(cls(dom, "capsule-legend")[0].textContent), "window: other photo → its size, and 'already has data' noted");
    btn(dom, "Import for This Photo").fire("click");
    let res = await open;
    ok(res && res.imagePath === "/p/A6/car_01.jpg" && res.text === COPIED, "Import → { imagePath: chosen photo, text }");

    // 2) something else on the clipboard is NOT filled in on open; typing invalid text blocks Import
    dom = fakeDom(); global.document = dom.document;
    clip = "some unrelated text";
    open = paste.showCapsulePaste(Object.assign({ readClipboard: async () => clip }, base));
    await wait();
    const text2 = dom.all.find((n) => n.tagName === "textarea");
    ok(text2.value === "" && btn(dom, "Import for This Photo").disabled, "window: non-Capsule clipboard ignored on open, Import disabled");
    text2.value = '{"focalPoint":'; text2.fire("input");
    ok(/✗ Not a valid Capsule JSON/.test(cls(dom, "paste-status")[0].textContent) && btn(dom, "Import for This Photo").disabled, "window: invalid paste → reason shown, Import disabled");
    btn(dom, "Import for This Photo").fire("click"); // ignored while invalid
    btn(dom, "Paste from Clipboard").fire("click");
    await wait();
    ok(text2.value === "some unrelated text" && /Not a valid/.test(cls(dom, "paste-status")[0].textContent), "Paste from Clipboard → takes whatever is there, validated");
    clip = "```json\n" + COPIED + "\n```";
    btn(dom, "Paste from Clipboard").fire("click");
    await wait();
    ok(/^✓ Valid/.test(cls(dom, "paste-status")[0].textContent), "Paste from Clipboard → fenced JSON accepted");
    btn(dom, "Cancel").fire("click");
    ok((await open) === null, "Cancel → null (nothing imported)");

    // 3) opened from one product's ⋯ menu: only that photo, no picker; clipboard error explained
    dom = fakeDom(); global.document = dom.document;
    open = paste.showCapsulePaste(Object.assign({ readClipboard: async () => { throw new Error("denied"); }, selected: "/p/A6/car_01.jpg", locked: true }, base));
    await wait();
    ok(!cls(dom, "paste-photo-select").length && /A6 Avant/.test(cls(dom, "paste-photo-name")[0].textContent), "⋯ menu: only that product's photo, no picker");
    ok(cls(dom, "paste-status")[0].textContent === "Paste the JSON copied from the Capsule workflow.", "clipboard unreadable on open → no error, just the hint");
    btn(dom, "Paste from Clipboard").fire("click");
    await wait();
    ok(/Couldn't read the clipboard .*⌘V/.test(cls(dom, "paste-status")[0].textContent), "Paste from Clipboard fails → asks for ⌘V");
    const text3 = dom.all.find((n) => n.tagName === "textarea");
    text3.value = COPIED; text3.fire("input");
    btn(dom, "Import for This Photo").fire("click");
    res = await open;
    ok(res && res.imagePath === "/p/A6/car_01.jpg", "⋯ menu: Import → that product's photo");

    console.log(f ? `${f} FAILED` : "all passed");
    process.exit(f ? 1 : 0);
})().catch((e) => { console.log("FAIL harness error: " + (e && e.stack || e)); process.exit(1); });
