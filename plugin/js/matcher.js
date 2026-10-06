// matcher.js — JS port of 02_System/scripts/01_build_manifest.py
//
// Reads the Excel sheet (via vendored SheetJS) and the picked photos folder,
// fuzzy-matches each headline row to a product photo folder, and returns an
// in-memory array of manifest rows — the panel's equivalent of manifest.csv.
//
// Faithful port: same normalize(), same containment(0.95)/SequenceMatcher-ratio(>=0.6)
// matching, same image preference/exclusion rules, same folder-name stripping.
// Read-only against the picked Excel file / photos folder — never writes to them.

/* global require, XLSX */
// XLSX is loaded globally via a <script> tag (js/lib/xlsx.full.min.js) in
// index.html — no bundler/require needed for the vendored SheetJS build.

const SHEET_NAME = "AOZ+AOT";

const IMAGE_PREFERENCE = [/\(web_1080p\)\.jpe?g$/i];
const EXCLUDE_PATTERNS = [/Bildschirmfoto/i, /^\./];
const IMAGE_EXTS = new Set([".jpg", ".jpeg", ".png", ".tif", ".tiff"]);

const MATCH_THRESHOLD = 0.6;
const CONTAINMENT_SCORE = 0.95;

// ---------- normalize ----------

function normalize(text) {
    text = String(text).toLowerCase();
    text = text
        .replace(/ä/g, "ae")
        .replace(/ö/g, "oe")
        .replace(/ü/g, "ue")
        .replace(/ß/g, "ss");
    text = text.replace(/[^a-z0-9]+/g, " ");
    return text.trim();
}

// ---------- difflib.SequenceMatcher.ratio() port (Ratcliff/Obershelp) ----------
// No junk heuristics needed: headline/folder strings are always short (<200 chars),
// well under difflib's autojunk threshold, so this matches Python's default behavior.

function buildB2J(b) {
    const b2j = {};
    for (let i = 0; i < b.length; i++) {
        const c = b.charAt(i);
        if (!b2j[c]) b2j[c] = [];
        b2j[c].push(i);
    }
    return b2j;
}

function findLongestMatch(a, alo, ahi, b, blo, bhi, b2j) {
    let besti = alo, bestj = blo, bestsize = 0;
    let j2len = {};
    for (let i = alo; i < ahi; i++) {
        const newj2len = {};
        const c = a.charAt(i);
        const indices = b2j[c] || [];
        for (let k = 0; k < indices.length; k++) {
            const j = indices[k];
            if (j < blo) continue;
            if (j >= bhi) break;
            const kLen = (j2len[j - 1] || 0) + 1;
            newj2len[j] = kLen;
            if (kLen > bestsize) {
                besti = i - kLen + 1;
                bestj = j - kLen + 1;
                bestsize = kLen;
            }
        }
        j2len = newj2len;
    }
    return { a: besti, b: bestj, size: bestsize };
}

function totalMatchingChars(a, b) {
    const b2j = buildB2J(b);
    const queue = [[0, a.length, 0, b.length]];
    let matches = 0;
    while (queue.length) {
        const [alo, ahi, blo, bhi] = queue.pop();
        const m = findLongestMatch(a, alo, ahi, b, blo, bhi, b2j);
        if (m.size > 0) {
            matches += m.size;
            if (alo < m.a && blo < m.b) queue.push([alo, m.a, blo, m.b]);
            if (m.a + m.size < ahi && m.b + m.size < bhi) {
                queue.push([m.a + m.size, ahi, m.b + m.size, bhi]);
            }
        }
    }
    return matches;
}

function sequenceMatcherRatio(a, b) {
    if (a.length === 0 && b.length === 0) return 1.0;
    const matches = totalMatchingChars(a, b);
    return (2.0 * matches) / (a.length + b.length);
}

// ---------- Excel reading ----------

async function readExcelRows(excelEntry) {
    const buffer = await excelEntry.read({ format: require("uxp").storage.formats.binary });
    const wb = XLSX.read(buffer, { type: "array" });
    const ws = wb.Sheets[SHEET_NAME];
    if (!ws) throw new Error(`Sheet "${SHEET_NAME}" not found in ${excelEntry.name}`);

    const raw = XLSX.utils.sheet_to_json(ws, { header: 1, defval: "" });
    if (!raw.length) return [];

    // Columns are looked up by header text rather than position, since the
    // sheet layout has already changed once (picture name / add-on / year
    // columns were inserted between the sublines).
    const header = raw[0].map((h) => String(h).trim().toUpperCase());
    const col = (name) => header.indexOf(name);
    const COLS = {
        headline: col("DANIS + SERVICE HEADLINE +PRODUCT NAMING"),
        picture: col("PICTURE NAME"),
        danisSubline: col("DANIS SUBLINE"),
        danisAddOn: col("DANIS ADD ON"),
        serviceSubline: col("SERVICE SUBLINE"),
        year: col("YEAR"),
    };
    if (COLS.headline === -1) COLS.headline = 0;
    for (const key of ["danisSubline", "serviceSubline"]) {
        if (COLS[key] === -1) throw new Error(`Column for "${key}" not found in sheet "${SHEET_NAME}"`);
    }

    // "n/a" in the sheet means "no text for this field".
    const cell = (row, idx) => {
        if (idx === -1) return "";
        const v = String(row[idx] == null ? "" : row[idx]).trim();
        return v.toLowerCase() === "n/a" ? "" : v;
    };

    const rows = [];
    for (let r = 1; r < raw.length; r++) { // skip header row
        const headline = cell(raw[r], COLS.headline);
        if (!headline) continue;
        rows.push({
            headline,
            picture_name: cell(raw[r], COLS.picture),
            danis_subline: cell(raw[r], COLS.danisSubline),
            danis_addon: cell(raw[r], COLS.danisAddOn),
            service_subline: cell(raw[r], COLS.serviceSubline),
            year: cell(raw[r], COLS.year) || String(new Date().getFullYear()),
        });
    }
    return rows;
}

// ---------- photo folder scanning ----------

async function listProductFolders(picturesFolder) {
    const entries = await picturesFolder.getEntries();
    const folders = [];
    for (const entry of entries) {
        if (!entry.isFolder) continue;
        let name = entry.name;
        // remove leading number+underscore, e.g. "01_"
        name = name.replace(/^\d+_/, "");
        // remove a leading part-number-like token (alnum, no spaces, followed by underscore)
        name = name.replace(/^[A-Za-z0-9]{5,}\s*_?\s*/, "");
        folders.push({ entry, descriptiveName: name.trim() });
    }
    return folders;
}

async function walkFiles(folder) {
    const out = [];
    const entries = await folder.getEntries();
    for (const entry of entries) {
        if (entry.isFolder) {
            const nested = await walkFiles(entry);
            out.push(...nested);
        } else {
            out.push(entry);
        }
    }
    return out;
}

async function findBestImage(folderEntry) {
    let candidates = await walkFiles(folderEntry);
    candidates = candidates.filter(
        (f) => !EXCLUDE_PATTERNS.some((pat) => pat.test(f.name))
    );

    for (const pattern of IMAGE_PREFERENCE) {
        const hit = candidates.find((f) => pattern.test(f.name));
        if (hit) return hit;
    }
    // fallback: any non-excluded image file
    for (const f of candidates) {
        const ext = "." + (f.name.split(".").pop() || "").toLowerCase();
        if (IMAGE_EXTS.has(ext)) return f;
    }
    return null;
}

// ---------- matching ----------

function matchHeadlineToFolder(headline, folders) {
    const normHeadline = normalize(headline);
    let best = null;
    let bestScore = 0.0;
    for (const folder of folders) {
        const normFolder = normalize(folder.descriptiveName);
        if (!normFolder) continue;
        let score;
        if (normHeadline.indexOf(normFolder) !== -1 || normFolder.indexOf(normHeadline) !== -1) {
            score = CONTAINMENT_SCORE;
        } else {
            score = sequenceMatcherRatio(normHeadline, normFolder);
        }
        if (score > bestScore) {
            bestScore = score;
            best = folder;
        }
    }
    if (best && bestScore >= MATCH_THRESHOLD) {
        return { folder: best, score: bestScore };
    }
    return null;
}

// ---------- main entry point ----------

// excelEntry: UXP file Entry (picked via getFileForOpening)
// picturesFolderEntry: UXP folder Entry (picked via getFolder)
// Returns: array of { headline, danis_subline, service_subline, imagePath, imageEntry, status, notes }
async function buildManifest(excelEntry, picturesFolderEntry) {
    const excelRows = await readExcelRows(excelEntry);
    const folders = await listProductFolders(picturesFolderEntry);
    const allFiles = (await walkFiles(picturesFolderEntry))
        .filter((f) => !EXCLUDE_PATTERNS.some((p) => p.test(f.name)));

    const matchedFolderPaths = new Set();
    const manifestRows = [];

    for (const row of excelRows) {
        // New sheet layout names the exact picture file (without extension),
        // so use that directly when present instead of fuzzy folder matching.
        if (row.picture_name) {
            const wanted = row.picture_name.toLowerCase();
            const image = allFiles.find((f) => {
                const base = f.name.replace(/\.[^.]+$/, "").toLowerCase();
                return base === wanted;
            });
            if (image) {
                manifestRows.push({
                    ...row,
                    imagePath: image.nativePath,
                    imageEntry: image,
                    status: "matched",
                    notes: `picture='${image.name}' score=1.00`,
                });
                continue;
            }
        }

        const match = matchHeadlineToFolder(row.headline, folders);
        if (!match) {
            manifestRows.push({
                ...row,
                imagePath: "",
                imageEntry: null,
                status: "skipped_no_image",
                notes: "no confident folder match",
            });
            continue;
        }
        const folder = match.folder;
        matchedFolderPaths.add(folder.entry.nativePath);
        const image = await findBestImage(folder.entry);
        if (!image) {
            manifestRows.push({
                ...row,
                imagePath: "",
                imageEntry: null,
                status: "skipped_no_image",
                notes: `matched folder '${folder.entry.name}' but no usable image file found`,
            });
            continue;
        }
        manifestRows.push({
            ...row,
            imagePath: image.nativePath,
            imageEntry: image,
            status: "matched",
            notes: `folder='${folder.entry.name}' score=${match.score.toFixed(2)}`,
        });
    }

    // Report unmatched folders too, same as the full-catalog CLI run, so nothing
    // is silently dropped from the review table.
    for (const folder of folders) {
        if (!matchedFolderPaths.has(folder.entry.nativePath)) {
            manifestRows.push({
                headline: "",
                danis_subline: "",
                service_subline: "",
                imagePath: folder.entry.nativePath,
                imageEntry: null,
                status: "skipped_no_excel_row",
                notes: `folder '${folder.entry.name}' has no matching Excel headline`,
            });
        }
    }

    return manifestRows;
}

module.exports = { buildManifest, normalize, sequenceMatcherRatio };
