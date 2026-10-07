// templatetype.js — the ONE rule for telling DANIS and Service templates
// apart. Shared by datamerge.js (Prepare: which subline field) and render.js
// (Render: output rules + output/InDesign routing), so the same template can
// never be classified differently in the two steps.
//
// File name only — any folder part is stripped, so neither the template's
// folders nor the selected output folder can influence it. Case-insensitive:
//   contains "DANIS"   -> "danis"
//   contains "SERVICE" -> "service"
//   neither / both     -> throws, instead of guessing
// "Denis" is deliberately NOT accepted as an alias.

function detectTemplateType(filename) {
    const name = String(filename).split(/[\\/]/).pop().toUpperCase();
    const isDanis = name.indexOf("DANIS") !== -1;
    const isService = name.indexOf("SERVICE") !== -1;
    if (isDanis && isService) {
        throw new Error("Template name contains both DANIS and SERVICE — rename it so it contains only one.");
    }
    if (isDanis) return "danis";
    if (isService) return "service";
    throw new Error("Could not determine template type from filename. Template name must contain DANIS or SERVICE.");
}

module.exports = { detectTemplateType };
