// templatetype.js — the ONE rule for a template's type. Shared by
// datamerge.js (Prepare: which subline field) and render.js (Render: routing,
// names), so the same template can never be classified differently in the
// two steps.
//
// File name only — any folder part is stripped, so neither the template's
// folders nor the selected output folder can influence it. Case-insensitive:
//   contains "DANIS"   -> "danis"     (known type)
//   contains "SERVICE" -> "service"   (known type)
//   both               -> throws (ambiguous)
//   neither            -> a GENERIC type derived from the name: its first
//                         word, e.g. "WINTER_Template 3_DataMerge_2.indd" ->
//                         "WINTER" (stable across Prepare copies, which only
//                         add "_DataMerge" / "_DataMerge_N")
// "Denis" is deliberately NOT accepted as an alias.
//
// templateTypeInfo(type) says how a type is handled. Known types keep their
// special rules (prefix, subline column, Service thumbnail name, DANIS ADD
// ON footer); a generic type uses its own name for the output folder
// (output/<type>/<WxH>/, InDesign/<type>/) and the JPG/INDD prefix, reads its
// subline from a "<TYPE> SUBLINE" (or "SUBLINE") column if there is one, and
// otherwise behaves exactly like the known types (adaptive page discovery,
// generic geometry placement, Image Extension).

const KNOWN_TYPES = {
    danis: {
        folder: "DANIS", prefix: "DANIS_Herbst",
        sublineColumns: ["DANIS SUBLINE"], sublineKey: "danis_subline",
        variantNames: {},
    },
    service: {
        folder: "Service", prefix: "Service_Herbst",
        sublineColumns: ["SERVICE SUBLINE"], sublineKey: "service_subline",
        variantNames: { "250x250": "thumbnail" },
    },
};

// The generic type of a file name that is neither DANIS nor SERVICE: first
// word of the name (letters, digits, hyphen), "Template" if there is none.
function genericTypeFromName(name) {
    const stem = String(name).replace(/\.[^.]+$/, "").replace(/_DataMerge(_\d+)?$/i, "");
    const first = stem.split(/[_\s]+/).find((w) => /[A-Za-z0-9]/.test(w)) || "";
    return first.replace(/[^A-Za-z0-9-]/g, "") || "Template";
}

function detectTemplateType(filename) {
    const base = String(filename).split(/[\\/]/).pop();
    const name = base.toUpperCase();
    const isDanis = name.indexOf("DANIS") !== -1;
    const isService = name.indexOf("SERVICE") !== -1;
    if (isDanis && isService) {
        throw new Error("Template name contains both DANIS and SERVICE — rename it so it contains only one.");
    }
    if (isDanis) return "danis";
    if (isService) return "service";
    return genericTypeFromName(base);
}

// { type, known, folder, prefix, sublineColumns, sublineKey, variantNames }
function templateTypeInfo(type) {
    const k = KNOWN_TYPES[type];
    if (k) return Object.assign({ type, known: true }, k);
    const upper = String(type).toUpperCase();
    return {
        type, known: false,
        folder: String(type), prefix: String(type),
        sublineColumns: [`${upper} SUBLINE`, "SUBLINE"], sublineKey: null,
        variantNames: {},
    };
}

module.exports = { detectTemplateType, templateTypeInfo, genericTypeFromName, KNOWN_TYPES };
