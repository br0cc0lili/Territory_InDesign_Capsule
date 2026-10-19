// placement.js — PLACEMENT stage: where the product image goes in its frame.
//
// Owns subject positioning, scaling, movement and anchor decisions — and
// nothing else. Image Extension (imageextension.js) never calls into this
// file: it starts from whatever FINAL graphic state placement left behind.
//
// This file is the TEMPORARY / default placement method ("extend" = whole
// image, aspect kept, anchored). A bounding-box-driven placement system is
// expected to replace this stage later; the contract it must keep is the
// result of placeProductImage() in render.js:
//     { mode, allowExtension, policy, note }
// — everything from imageextension.js analyzeImageCoverage() onward stays
// unchanged.
//
// Geometry: InDesign geometricBounds are [top, left, bottom, right] in the
// document's ruler units (points — render.js usePoints()).

// ---------- placement policies ----------
//
// Looked up by the layout identifiers render.js already uses (OUTPUT_RULES /
// pageLayout): template type → page size → optionally page position
// (up / bottom / footer / thumbnail). Most specific entry wins; otherwise
// defaultPolicy.
//   placementMode "fill"   — render.js placeImageFill(): enlarge + crop to
//                            cover the frame (never underfills); Image
//                            Extension is NOT allowed for these layouts
//   placementMode "extend" — Preserve Composition: the whole image fits in
//                            the frame (aspect kept, no crop / stretch /
//                            fill-zoom); the remaining strip may be extended
//   anchor — where the original sits inside the frame in "extend" mode.
const PLACEMENT_CONFIG = {
    // Mode/anchor values every known policy starts from.
    defaultPolicy: { placementMode: "extend", anchor: { vertical: "top", horizontal: "center" } },
    // UNKNOWN layouts (no entry below): decided from geometry —
    // geometryFallbackPolicy(). Contain-fit the image; if the gap it leaves is
    // at most maxExtensionRatio of the placed image on that axis → "extend"
    // (vertical gap: anchor top/center = extend downward like the known
    // layouts; horizontal gap: center/center = extend both sides evenly),
    // otherwise → "fill" (more new image than original — a new composition,
    // not an extension). Keep maxExtensionRatio in line with Image
    // Extension's own limit (imageextension.js CONFIG.maxExtensionRatio).
    fallback: {
        maxExtensionRatio: 0.5,
        verticalGapAnchor: { vertical: "top", horizontal: "center" },
        horizontalGapAnchor: { vertical: "center", horizontal: "center" },
    },
    layoutPolicies: {
        service: {
            "250x250": { placementMode: "extend", anchor: { vertical: "top", horizontal: "center" } },
            "800x600": { placementMode: "extend", anchor: { vertical: "top", horizontal: "center" } },
            "1200x1200": { placementMode: "extend", anchor: { vertical: "top", horizontal: "center" } },
            // Portrait: landscape sources would need 58–167% new image —
            // closer to a new composition than an extension. Fill for now.
            "1080x1920": { placementMode: "fill" },
        },
        danis: {
            "1200x1200": { placementMode: "extend", anchor: { vertical: "top", horizontal: "center" } },
        },
    },
};

function itemAt(collection, i) {
    return typeof collection.item === "function" ? collection.item(i) : collection[i];
}

function toBox(b) {
    const [top, left, bottom, right] = [0, 1, 2, 3].map((i) => Number(b[i]));
    return { top, left, bottom, right, width: right - left, height: bottom - top };
}

// The configured placement policy for a layout from render.js:
//   layout: { subType: "service"|"danis", size: "1200x1200", position: "up"|… }
// Returns { id, placementMode, anchor, known } — id names the
// PLACEMENT_CONFIG entry used; anchor is null unless the mode is "extend".
// known: false when the layout has NO entry (then `id` is "unknown" and the
// mode/anchor are only defaultPolicy — use resolvePlacementPolicy(), which
// decides unknown layouts from geometry instead).
function getLayoutPolicy(layout) {
    const bySize = PLACEMENT_CONFIG.layoutPolicies[layout && layout.subType] || {};
    const entry = bySize[layout && layout.size];
    let policy = null, id = "unknown";
    if (entry && entry[layout.position]) { policy = entry[layout.position]; id = `${layout.subType}/${layout.size}/${layout.position}`; }
    else if (entry && entry.placementMode) { policy = entry; id = `${layout.subType}/${layout.size}`; }
    const p = Object.assign({}, PLACEMENT_CONFIG.defaultPolicy, policy || {});
    const anchor = p.placementMode === "extend" ? (p.anchor || PLACEMENT_CONFIG.defaultPolicy.anchor) : null;
    return { id, placementMode: p.placementMode, anchor, known: !!policy };
}

// PURE. Generic geometry-based policy for a layout with no configured
// policy (see PLACEMENT_CONFIG.fallback).
//   frameBounds: [top, left, bottom, right]; sourceSize: { width, height }
//   (any unit — only the aspect ratio matters)
// Returns { id: "fallback/geometry", placementMode, anchor, known: false,
//           gap: { axis, ratio } }.
function geometryFallbackPolicy(frameBounds, sourceSize) {
    const cfg = PLACEMENT_CONFIG.fallback;
    const f = toBox(frameBounds);
    const scale = Math.min(f.width / sourceSize.width, f.height / sourceSize.height);
    const w = sourceSize.width * scale;
    const h = sourceSize.height * scale;
    const gapX = (f.width - w) / w;
    const gapY = (f.height - h) / h;
    const vertical = gapY >= gapX;
    const ratio = Math.round(Math.max(gapX, gapY) * 1000) / 1000;
    const base = { id: "fallback/geometry", known: false, gap: { axis: vertical ? "vertical" : "horizontal", ratio } };
    if (ratio > cfg.maxExtensionRatio) return Object.assign(base, { placementMode: "fill", anchor: null });
    return Object.assign(base, { placementMode: "extend", anchor: vertical ? cfg.verticalGapAnchor : cfg.horizontalGapAnchor });
}

// The policy placement uses for a page:
//   known layout   → its configured policy (PLACEMENT_CONFIG.layoutPolicies)
//   unknown layout → geometryFallbackPolicy(frameBounds, sourceSize)
function resolvePlacementPolicy(layout, frameBounds, sourceSize) {
    const configured = getLayoutPolicy(layout);
    if (configured.known) return configured;
    return geometryFallbackPolicy(frameBounds, sourceSize);
}

// Places the file once to read its proportions (a freshly placed graphic
// keeps the source aspect). Returns { width, height } in layout units.
function probeSourceSize(frame, imagePath) {
    frame.place(imagePath);
    const graphics = frame.allGraphics;
    if (!graphics || graphics.length < 1) throw new Error("could not place " + imagePath);
    const g = toBox(itemAt(graphics, 0).geometricBounds);
    return { width: g.width, height: g.height };
}

// PURE. Where the graphic should go inside the frame for a policy.
//   frameBounds: [top, left, bottom, right]
//   sourceSize: { width, height } — any unit, only the aspect ratio matters
//   policy: from getLayoutPolicy()
//   subjectBounds: reserved for a subject/content bounding box
//                  ({x, y, width, height} in source px) — null for now and
//                  ignored; the bounding-box system replaces this stage.
// Returns { mode, anchor, graphicBounds, subjectBounds } — graphicBounds is
// null for "fill" (that mode is render.js placeImageFill()'s own fitting).
// "extend": uniform scale so the WHOLE image fits (contain), then aligned by
// the anchor — aspect exact, nothing cropped or stretched.
function planImagePlacement({ frameBounds, sourceSize, policy, subjectBounds = null }) {
    if (policy.placementMode !== "extend") {
        return { mode: policy.placementMode, anchor: null, graphicBounds: null, subjectBounds };
    }
    const a = policy.anchor;
    const f = toBox(frameBounds);
    const scale = Math.min(f.width / sourceSize.width, f.height / sourceSize.height);
    const w = sourceSize.width * scale;
    const h = sourceSize.height * scale;
    const left = a.horizontal === "left" ? f.left
        : a.horizontal === "right" ? f.right - w
        : f.left + (f.width - w) / 2;
    const top = a.vertical === "top" ? f.top
        : a.vertical === "bottom" ? f.bottom - h
        : f.top + (f.height - h) / 2;
    return { mode: "extend", anchor: a, graphicBounds: [top, left, top + h, left + w], subjectBounds };
}

// Moves/scales the placed graphic to the plan's bounds. Proportional by
// construction (the plan keeps the aspect); the frame is never changed.
function applyImagePlacement(graphic, placementPlan) {
    if (!placementPlan.graphicBounds) return;
    graphic.geometricBounds = placementPlan.graphicBounds;
}

// "extend" placement for one frame: place the file, let InDesign fit the
// whole image (Fit Content Proportionally), then apply the exact plan — which
// also covers InDesign versions where the fit call fails.
//   id: the require("indesign") module (FitOptions); policy: getLayoutPolicy()
// Returns { note, placementPlan }.
function placeImageForExtension(frame, imagePath, id, policy) {
    frame.place(imagePath);
    let fitNote = "fit=proportional";
    try {
        frame.fit(id.FitOptions.PROPORTIONALLY);
    } catch (e) {
        fitNote = "fit=computed (Fit Proportionally failed: " + String(e).replace(/,/g, ";") + ")";
    }
    const graphics = frame.allGraphics;
    if (!graphics || graphics.length !== 1) throw new Error(`expected 1 placed graphic, found ${graphics ? graphics.length : 0}`);
    const graphic = itemAt(graphics, 0);
    const g = toBox(graphic.geometricBounds);
    const placementPlan = planImagePlacement({
        frameBounds: frame.geometricBounds,
        sourceSize: { width: g.width, height: g.height }, // freshly placed: source aspect
        policy,
        subjectBounds: null,
    });
    applyImagePlacement(graphic, placementPlan);
    return {
        note: `placement=extend (${fitNote}; policy ${policy.id}; anchor ${policy.anchor.vertical}/${policy.anchor.horizontal}` +
            (policy.gap ? `; ${policy.gap.axis} gap ${Math.round(policy.gap.ratio * 100)}%` : "") + ")",
        placementPlan,
    };
}

module.exports = {
    PLACEMENT_CONFIG, getLayoutPolicy, geometryFallbackPolicy, resolvePlacementPolicy, probeSourceSize,
    planImagePlacement, applyImagePlacement, placeImageForExtension,
};
