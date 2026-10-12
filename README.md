# Territory InDesign Plugin (Poster Batch Generator)

An Adobe InDesign UXP panel that combines a client's InDesign layout templates, an Excel copy sheet and a folder of product photos, and **batch-generates poster JPGs plus a matching `.indd` per product**. Everything happens inside an InDesign panel: no Terminal, Python or manual CSV editing.

- Two template types: **DANIS** and **Service**
- For each product × template: one populated `.indd` is saved, and every page of the template is exported as a JPG
- Every run writes a `generation_log.csv` with one line per success or failure

---

## Contents

1. [Repository layout](#repository-layout)
2. [Installation](#installation)
3. [Preparing your inputs](#preparing-your-inputs) (template, Excel and photo folder requirements)
4. [How to use](#how-to-use)
5. [Output](#output)
6. [Troubleshooting](#troubleshooting)
7. [For developers](#for-developers)

---

## Repository layout

```
plugin/      ← the InDesign UXP plugin (the tool in day-to-day use)
system/      ← legacy command-line pipeline (Python + ExtendScript), kept for reference only
docs/
  ARCHITECTURE.md   ← tech stack, architecture and extension guide
```

---

## Installation

**Requirements:** Adobe InDesign 2023 (v18.0) or later; macOS (the only platform it has been used on so far).

The plugin is not packaged yet, so it is loaded with Adobe's **UXP Developer Tool**:

1. Open the **Creative Cloud desktop app** → search apps for "UXP Developer Tool" → Install.
2. Start InDesign first, then start UXP Developer Tool.
3. Click **Add Plugin** → select `plugin/manifest.json` from this repository.
4. Click **Load** on the plugin's row.
5. In InDesign, open **Plugins → Poster Batch Generator → Poster Batch** (the exact menu name may vary slightly between versions).

After editing any JS/CSS, click **Load** (or Reload) again in UXP Developer Tool to hot-reload. There is no need to restart InDesign.

**Font:** **Audi Type Extended Bold** must be installed. If it is missing, an amber warning banner appears at the top of the panel. Install the font before generating.

---

## Preparing your inputs

### 1. Client templates (.indd)

One file per template type: one DANIS and one Service.

**The file name** must contain `DANIS` or `SERVICE` (case-insensitive). This is how the template type is determined:

 File name | Result 

| `DANIS_Template.indd` | Yes DANIS |
| `Service_Template.indd` | Yes Service |
| `Denis_Template.indd` | Fault error: the spelling `Denis` is not accepted |
| `DANIS_Service.indd` | Fault error: contains both |
| Unsaved `Untitled-1` | Fault error: the document must be saved to disk first |

**Layers** (names are case-insensitive), on every page:

| Layer | Requirement | Used for |

| `text` | **Required**, exactly 1 text frame per page | 1st non-empty paragraph = headline; 2nd non-empty paragraph = subline |
| `Image` | **Required**, exactly 1 graphic frame per page (rectangle / polygon / oval) | Main product image |
| `footer` | Optional, 0 or 1 text frame per page | DANIS ADD ON copy |
| Anything else (e.g. `shadow`) | Left untouched | — |

> You can also name frames `<<Headline>>`, `<<Footer>>` and `<<MainImage>>` directly. A named frame takes priority over the layer lookup.
> The plugin **never** guesses a frame by size or position. If a layer holds the wrong number of frames, it reports an error.

**Page sizes (in pt; exported 1 pt = 1 px).** Each template must contain exactly these pages:

| Template | Size | Layouts | Notes |

| DANIS | 1200×1200 | `up`, `bottom` | Required |
| DANIS | 1200×1200 | `footer` | Optional; exported only for products whose DANIS ADD ON has content |
| Service | 250×250 | `thumbnail` | Required |
| Service | 800×600 | `up`, `bottom` | Required |
| Service | 1080×1920 | `up`, `bottom` | Required |
| Service | 1200×1200 | `up`, `bottom` | Required |

- `up` / `bottom` is detected from where the headline frame sits: upper half of the page = `up`, lower half = `bottom`.
- A DANIS page with a footer frame counts as the `footer` layout.
- A missing page, a duplicate page or a size outside these rules is reported as an error before anything is generated.

### 2. Excel copy sheet (.xlsx)

- Must contain a sheet named **`AOZ+AOT`**, with headers in row 1.
- Columns are found **by header name**, so column order does not matter:

| Header | Required | Description |

| `DANIS + SERVICE HEADLINE +PRODUCT NAMING` | Yes | Headline; rows with an empty headline are skipped |
| `DANIS SUBLINE` | Yes | Second paragraph in DANIS templates |
| `SERVICE SUBLINE` | Yes | Second paragraph in Service templates |
| `PICTURE NAME` | Required for step 1 | Image file name (without extension), used for exact image matching |
| `DANIS ADD ON` | Optional | DANIS footer copy; if empty, no footer version is produced |
| `YEAR` | Optional | Used in output file names; defaults to the current year |

- A cell containing `n/a` is treated as empty.

### 3. Product photo folder

Recommended layout: one subfolder per product, for example:

```
Pictures/
  01_4M0071129-Ski- und Snowboardhalter/
    Q5_as_2025_7840/Q5_as_2025_7840 (web_1080p).jpeg
  03_8Y1061501  041_Allwetterfußmatten/
    ...
```

Image matching rules, in order:

1. **Exact file-name match:** search the whole folder tree for an image whose name (without extension, case-insensitive) equals `PICTURE NAME`.
2. **Fuzzy headline match** (if step 1 finds nothing): compare the headline with each subfolder name (with any leading `01_` number and part number removed). A similarity of at least 0.6 counts as a match. Inside the matched folder, `*(web_1080p).jpeg` is preferred; otherwise the first image found is used.
3. Supported extensions: `.jpg .jpeg .png .tif .tiff`. Screenshots (file names containing `Bildschirmfoto`) and hidden files are ignored.

---

## How to use

The panel has four steps, top to bottom.

### Step 1: Turn a client template into a Data Merge template

1. **Open** the client template in InDesign (e.g. `DANIS_Template.indd`) and make it the active document.
2. Click **Select Excel / CSV…** and pick the Excel copy sheet (CSV/TXT also work).
3. Click **Prepare Copy of Current Document**.

The plugin then:

- Saves a copy next to the client file as **`<original name>_DataMerge.indd`** (or `_DataMerge_2`, `_3`… if that name exists). **The client's original file is never modified.**
- If an Excel file was picked, writes `<Excel name>_DataMerge.csv` next to it (Data Merge can only read CSV).
- Replaces the headline, subline, footer and image with Data Merge placeholders and renames the frames to `<<Headline>>` / `<<Footer>>` / `<<MainImage>>`. The client's styles and layout are kept.
- Shows a per-page result in the panel: `✓ Page 1` means success; `⚠ Page 2` lists the problems underneath.

**Do this once for the DANIS template and once for the Service template.** Each prepared template appears in the template list in step 4.

> Tip: if you pick the photo folder in step 2 *before* running step 1, the generated CSV includes image paths (`@MainImage`), which makes previewing in InDesign's Data Merge panel easier. It is not required for generating.

### Step 2: Select inputs

- **Select Excel File…**: pick the same Excel copy sheet.
- **Select Photos Folder…**: pick the top-level product photo folder.

### Step 3: Match

Click **Match**. The table lists every Excel row and every photo folder:

- **White rows** (`matched`) will be generated.
- **Grey rows** are skipped, with the reason:
  - `skipped_no_image`: the Excel row exists but no image was found
  - `skipped_no_excel_row`: a photo folder exists but no Excel row matches it

**Review this table before generating.** It is the only human checkpoint. If a match is wrong, fix `PICTURE NAME` in Excel or the folder name, then click Match again.

### Step 4: Generate

1. Check that the template list shows the `_DataMerge.indd` files from step 1 (DANIS and/or Service).
2. Click **Select Output Folder…** and choose where the results should go.
3. Click **Generate Posters**.

Before generating anything, the plugin checks every template (frames present, page sizes valid). If something is wrong it stops with a list of problems and writes no files.

For each matched product and each template:

- **A. Populate and validate:** open a copy of the template, fill in headline, subline, footer and image, then check every page. The `.indd` is saved only if every check passes.
- **B. Export JPGs:** export every page from the `.indd` that was just saved.

So the INDD and the JPGs always contain the same content. If phase A fails, nothing is saved or exported for that product and template.

When it finishes, the panel shows the success and error counts and lists any failures below.

---

## Output

```
<output folder>/
  generation_log.csv
  InDesign/
    DANIS/    DANIS_Herbst_<year>_<product>.indd
    Service/  Service_Herbst_<year>_<product>.indd
  output/
    DANIS/
      1200x1200/  DANIS_Herbst_<year>_<product>_1200x1200_up.jpg
                  DANIS_Herbst_<year>_<product>_1200x1200_bottom.jpg
                  DANIS_Herbst_<year>_<product>_1200x1200_footer.jpg   ← only with ADD ON
    Service/
      250x250/    …_250x250_thumbnail.jpg
      800x600/    …_800x600_up.jpg / _bottom.jpg
      1080x1920/  …_1080x1920_up.jpg / _bottom.jpg
      1200x1200/  …_1200x1200_up.jpg / _bottom.jpg
```

- Per product: DANIS produces **2 or 3** JPGs; Service produces **7**.
- JPG: 72 dpi, RGB, maximum quality (pixel size = page size in pt).
- **Product name rule:** characters that are illegal in file names, and `_`, are removed. If the headline contains a `-`, spaces become `-`; otherwise spaces are removed.
  - `Audi Airport Service` → `AudiAirportService`
  - `Ski- und Snowboardhalter` → `Ski-und-Snowboardhalter`
- Duplicate names within a run get a suffix so nothing is overwritten.
- Text that overflows its frame (overset) is not a failure, but is logged as a `WARNING`, because part of the text will be cut off in the JPG. Check the log.

`generation_log.csv` columns: `timestamp, headline, page_label, output_file, status, message`. `status` is `success`, `error` or `info`.

---

## Troubleshooting

| Symptom | Cause / fix |

| Red "Plugin module load error" banner | A JS file failed to load; the banner names it. All other buttons still work. |
| Amber "Audi Type font not installed" | Install the Audi Type font, then reopen the panel. |
| "InDesign isn't responding to the plugin" | Close any open InDesign dialog, then close and reopen the panel from the Window menu. |
| "Could not determine template type from filename" | The template file name must contain `DANIS` or `SERVICE` (`Denis` does not work). |
| "Layer(s) not found" | The template is missing the `text` or `Image` layer. |
| "… has no file on disk" | The active document has never been saved. Press Cmd+S first. |
| "Data source is missing column(s)" | An Excel header name is wrong, or the `PICTURE NAME` column is missing. |
| "Sheet "AOZ+AOT" not found" | The sheet must be named exactly `AOZ+AOT`. |
| "more than one DANIS template selected" | Step 1 was run twice for the same template type in one session. Reload the panel and prepare each type once. |
| Generate button is greyed out | Needs at least 1 matched row, an output folder, and a non-empty template list. |
| Template list is empty after reloading the panel | The list only lives in the current panel session. Run step 1 again (it creates a new `_DataMerge_2` copy). |

---

## For developers

The plugin is a plain-JavaScript UXP panel with no build step, no npm dependencies and no server. Load the `plugin/` folder directly with UXP Developer Tool.

See **[docs/ARCHITECTURE.md](docs/ARCHITECTURE.md)** for the tech stack, module structure, template contract, internal flow, InDesign DOM workarounds and an extension guide.

The `system/` folder contains the earlier command-line version of this pipeline. It is kept for reference only and does not run as-is.
