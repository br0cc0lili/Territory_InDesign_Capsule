// subjectzone.js — the RED SUBJECT FRAME ("subject zone") of a page.
//
// The designer draws a frame in the template where the product must sit
// (usually a thick red rectangle). It is found again on EVERY Generate /
// Regenerate, straight from the page — never stored, renamed or converted by
// Prepare — so it can be moved, resized or redrawn freely in InDesign at any
// time: in the client template (then Prepare again) or directly in the
// prepared template (<client>_DataMerge.indd, the Template Set; just save it).
//
// A page item counts as the subject zone when ANY of these is true:
//   1. its name (Layers panel) is one of: subject, subject zone, subject frame,
//      subject box, <<SubjectZone>>, bounding box, bbox  (any case, - _ or
//      space between the words)
//   2. it sits on a layer with one of those names (e.g. layer "subject")
//   3. it is an EMPTY graphic frame (rectangle / oval / polygon) with a RED
//      stroke on the "Image" layer — so a red frame drawn next to the photo
//      frame no longer breaks Prepare ("2 graphic frames on layer Image").
// Items on the page's parent (master) page count too.
//
// The zone is only a guide: it is removed from every generated product INDD,
// so it never shows in a JPG. The Template Set keeps it.
//
// Geometry: geometricBounds [top, left, bottom, right] in points.

/* global require */

const ZONE_WORDS = "(subject([\\s_-]*(zone|frame|box|area))?|bounding[\\s_-]*box|bbox)";
const ZONE_NAME = new RegExp(`^\\s*(<<\\s*)?${ZONE_WORDS}(\\s*>>)?\\s*$`, "i");
const ZONE_LAYER = new RegExp(`^\\s*${ZONE_WORDS}\\s*$`, "i");
const IMAGE_LAYER = /^\s*image\s*$/i;
const PLACEHOLDER_NAMES = ["<<MainImage>>", "<<Headline>>", "<<Footer>>"];
const GRAPHIC_FRAMES = ["Rectangle", "Polygon", "Oval"];
// Item types that can be a zone (placed images, text and their children never are).
const ZONE_TYPES = ["Rectangle", "Polygon", "Oval", "GraphicLine", "Group"];

let _id = null;
function indesign() {
    if (!_id || !_id.app) {
        try { _id = require("indesign"); } catch (e) { _id = {}; }
    }
    return _id;
}

function itemAt(collection, i) {
    return typeof collection.item === "function" ? collection.item(i) : collection[i];
}

function typeName(it) {
    try { return it.constructor.name; } catch (e) { return ""; }
}

function nameOf(it) {
    try { return String(it.name || ""); } catch (e) { return ""; }
}

function layerNameOf(it) {
    try { return String(it.itemLayer.name || ""); } catch (e) { return ""; }
}

function boundsOf(it) {
    try {
        const b = Array.from(it.geometricBounds, Number);
        return b.length === 4 && b.every(isFinite) && b[2] > b[0] && b[3] > b[1] ? b : null;
    } catch (e) { return null; }
}

// ---------- pure helpers (tested offline) ----------

function isZoneName(name) { return ZONE_NAME.test(String(name || "")); }
function isZoneLayerName(name) { return ZONE_LAYER.test(String(name || "")); }

// colour: { space: "RGB"|"CMYK"|"LAB"|"", values: number[], name: string }
// True for a clearly red colour (not orange, pink-ish magenta or brown).
function isRedColor(colour) {
    if (!colour) return false;
    const name = String(colour.name || "");
    if (/^(none|paper|registration|black)$/i.test(name.trim())) return false;
    const v = (colour.values || []).map(Number);
    const space = String(colour.space || "").toUpperCase();
    if (space.indexOf("RGB") !== -1 && v.length >= 3) {
        const [r, g, b] = v;
        return r >= 150 && g <= 110 && b <= 110 && r - Math.max(g, b) >= 80;
    }
    if (space.indexOf("CMYK") !== -1 && v.length >= 4) {
        const [c, m, y, k] = v;
        return m >= 60 && y >= 50 && c <= 35 && k <= 45;
    }
    if (space.indexOf("LAB") !== -1 && v.length >= 3) {
        const [l, a, b] = v;
        return a >= 40 && l >= 25 && l <= 75 && b >= -10;
    }
    return /\b(red|rot|rouge|rosso|rojo)\b/i.test(name);
}

function area(b) { return (b[2] - b[0]) * (b[3] - b[1]); }

// The zone a page uses: the largest one. Returns { bounds, count } or null.
function pickZone(zones) {
    const usable = (zones || []).filter((z) => z && z.bounds);
    if (!usable.length) return null;
    const best = usable.reduce((m, z) => (area(z.bounds) > area(m.bounds) ? z : m));
    return { bounds: best.bounds.slice(), via: best.via, count: usable.length };
}

// ---------- InDesign DOM ----------

// The stroke colour of an item as { space, values, name } (tints resolve to
// their base colour). Never throws.
function strokeColourOf(it) {
    let c;
    try { c = it.strokeColor; } catch (e) { return null; }
    if (!c) return null;
    try { if (c.baseColor) c = c.baseColor; } catch (e) {}
    const out = { space: "", values: [], name: "" };
    try { out.name = String(c.name || ""); } catch (e) {}
    try { out.values = Array.from(c.colorValue || [], Number); } catch (e) {}
    try {
        const space = c.space;
        const CS = indesign().ColorSpace;
        if (CS && space === CS.RGB) out.space = "RGB";
        else if (CS && space === CS.CMYK) out.space = "CMYK";
        else if (CS && space === CS.LAB) out.space = "LAB";
        else out.space = String(space || "");
    } catch (e) {}
    return out;
}

function strokeWeightOf(it) {
    try { return Number(it.strokeWeight) || 0; } catch (e) { return 0; }
}

function hasPlacedContent(it) {
    try { return it.allGraphics && it.allGraphics.length > 0; } catch (e) { return false; }
}

function idOf(it) {
    try { return it.id; } catch (e) { return undefined; }
}

// Another graphic frame on the Image layer of the same page (the photo
// frame)? The red-stroke rule only applies then — a page whose ONLY Image
// frame is red-stroked keeps it as its photo frame, as before.
function hasOtherImageFrame(it) {
    let page = null;
    try { page = it.parentPage; } catch (e) {}
    if (!page) return true; // parent-page item: can't tell — accept
    let items;
    try { items = page.allPageItems; } catch (e) { return true; }
    const own = idOf(it);
    for (let i = 0; i < (items ? items.length : 0); i++) {
        const o = itemAt(items, i);
        if (idOf(o) === own) continue;
        if (nameOf(o) === "<<MainImage>>") return true;
        if (IMAGE_LAYER.test(layerNameOf(o)) && GRAPHIC_FRAMES.indexOf(typeName(o)) !== -1 &&
            !(strokeWeightOf(o) > 0 && isRedColor(strokeColourOf(o)) && !hasPlacedContent(o))) return true;
    }
    return false;
}

// Why an item is a subject zone ("name" | "layer" | "red frame"), or "".
function zoneReason(it) {
    const name = nameOf(it);
    if (PLACEHOLDER_NAMES.indexOf(name) !== -1) return "";
    if (ZONE_TYPES.indexOf(typeName(it)) === -1) return "";
    if (isZoneName(name)) return "name";
    const layer = layerNameOf(it);
    if (isZoneLayerName(layer)) return "layer";
    if (IMAGE_LAYER.test(layer) && GRAPHIC_FRAMES.indexOf(typeName(it)) !== -1 && !hasPlacedContent(it) &&
        strokeWeightOf(it) > 0 && isRedColor(strokeColourOf(it)) && hasOtherImageFrame(it)) return "red frame";
    return "";
}

function isSubjectZone(it) { return zoneReason(it) !== ""; }

// Every zone on a page (own items first, then the parent page's):
//   [{ item, bounds, via, onParent }]
function findSubjectZones(page) {
    const out = [];
    const matched = new Set();
    const scan = (items, onParent) => {
        for (let i = 0; i < (items ? items.length : 0); i++) {
            const it = itemAt(items, i);
            // Children of a group that is already a zone are part of it.
            let parentId;
            try { parentId = idOf(it.parent); } catch (e) {}
            if (parentId !== undefined && matched.has(parentId)) { const id = idOf(it); if (id !== undefined) matched.add(id); continue; }
            const via = zoneReason(it);
            const b = via ? boundsOf(it) : null;
            if (b) {
                out.push({ item: it, bounds: b, via, onParent });
                const id = idOf(it);
                if (id !== undefined) matched.add(id);
            }
        }
    };
    try { scan(page.allPageItems, false); } catch (e) {}
    try { scan(page.masterPageItems, true); } catch (e) {}
    return out;
}

// The page's zone: { bounds, via, count } (largest if several) or null.
function zoneForPage(page) {
    return pickZone(findSubjectZones(page));
}

// Removes every zone from a (product) document so it never reaches a JPG.
// Parent-page zones are overridden onto the page first, then removed; a zone
// that can't be removed is hidden and made non-printing. Layers named like
// a zone layer are hidden and made non-printing as well.
// Returns { removed, hidden }.
function removeSubjectZones(doc) {
    let removed = 0, hidden = 0;
    for (let p = 0; p < doc.pages.length; p++) {
        const page = doc.pages.item(p);
        for (const z of findSubjectZones(page)) {
            let target = z.item;
            try {
                if (z.onParent) target = z.item.override(page);
                target.remove();
                removed++;
            } catch (e) {
                try { target.nonprinting = true; } catch (e2) {}
                try { target.visible = false; } catch (e2) {}
                hidden++;
            }
        }
    }
    try {
        for (let i = 0; i < doc.layers.length; i++) {
            const l = doc.layers.item(i);
            if (isZoneLayerName(l.name)) {
                try { l.printable = false; } catch (e) {}
                try { l.visible = false; } catch (e) {}
            }
        }
    } catch (e) {}
    return { removed, hidden };
}

// ---------- default frames (Custom Subject Frames) ----------

const DEFAULT_FRAME = {
    layerName: "subject",
    itemName: "<<SubjectZone>>",
    colorName: "Subject Frame Red",
    rgb: [230, 30, 30],
    strokeWeight: 3,
};

function isValid(o) {
    try { return !!o && o.isValid !== false; } catch (e) { return false; }
}

// The "subject" layer (created red-tagged and on top if missing).
function ensureZoneLayer(doc) {
    let layer = null;
    try {
        for (let i = 0; i < doc.layers.length; i++) {
            const l = doc.layers.item(i);
            if (isZoneLayerName(l.name)) { layer = l; break; }
        }
    } catch (e) {}
    if (!layer) {
        // Adding a layer can make it the active one; keep the designer's
        // active layer, so later drawings don't land on "subject" (where
        // every item counts as a subject frame).
        let active = null;
        try { active = doc.activeLayer; } catch (e) {}
        layer = doc.layers.add({ name: DEFAULT_FRAME.layerName });
        try { layer.layerColor = indesign().UIColors.RED; } catch (e) {}
        try { if (active && isValid(active)) doc.activeLayer = active; } catch (e) {}
    }
    try { layer.locked = false; } catch (e) {}
    try { layer.visible = true; } catch (e) {}
    return layer;
}

// A red stroke colour: our own swatch, else InDesign's default CMYK red.
function zoneColour(doc) {
    try {
        const c = doc.colors.itemByName(DEFAULT_FRAME.colorName);
        if (isValid(c) && c.name === DEFAULT_FRAME.colorName) return c;
    } catch (e) {}
    try {
        const id = indesign();
        return doc.colors.add({ name: DEFAULT_FRAME.colorName, model: id.ColorModel.PROCESS, space: id.ColorSpace.RGB, colorValue: DEFAULT_FRAME.rgb });
    } catch (e) {}
    try {
        const c = doc.swatches.itemByName("C=0 M=100 Y=100 K=0");
        if (isValid(c)) return c;
    } catch (e) {}
    return null;
}

// Draws one default subject frame on a page. Non-printing (never exported),
// named <<SubjectZone>> on layer "subject" — found again by zoneForPage().
function addZoneFrame(page, bounds, layer, colour, none) {
    const props = { geometricBounds: bounds, itemLayer: layer, name: DEFAULT_FRAME.itemName, strokeWeight: DEFAULT_FRAME.strokeWeight };
    if (colour) props.strokeColor = colour;
    if (none) props.fillColor = none;
    const rect = page.rectangles.add(props);
    try { rect.nonprinting = true; } catch (e) {}
    // A default text wrap (object style) would push the headline around.
    try { rect.textWrapPreferences.textWrapMode = indesign().TextWrapModes.NONE; } catch (e) {}
    return rect;
}

// Removes the zones that sit on the page itself (not its parent page).
// Returns how many were removed.
function removeOwnZones(page) {
    let n = 0;
    for (const z of findSubjectZones(page)) {
        if (z.onParent) continue;
        try { z.item.locked = false; } catch (e) {}
        try { z.item.remove(); n++; } catch (e) {}
    }
    return n;
}

module.exports = {
    isZoneName, isZoneLayerName, isRedColor, pickZone,
    zoneReason, isSubjectZone, findSubjectZones, zoneForPage, removeSubjectZones,
    DEFAULT_FRAME, ensureZoneLayer, zoneColour, addZoneFrame, removeOwnZones,
};
