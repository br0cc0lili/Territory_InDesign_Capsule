# Poster Batch Generator: User Guide

Poster Batch Generator is a panel for Adobe InDesign. It takes a client's InDesign template, the Excel copy sheet and a folder of product photos, and creates one editable InDesign file per product. You review and approve each one, then export all the final poster images in one go.

This guide is for designers who received the plugin as a **`.ccx` file**. You don't need any developer tools.

---

## Contents

1. [What you need](#what-you-need)
2. [Install the plugin](#install-the-plugin)
3. [Prepare your files](#prepare-your-files)
4. [Make posters, step by step](#make-posters-step-by-step)
5. [What the statuses mean](#what-the-statuses-mean)
6. [Where your files are saved](#where-your-files-are-saved)
7. [Update or uninstall](#update-or-uninstall)
8. [Troubleshooting](#troubleshooting)

---

## What you need

- **Adobe InDesign 2023 (version 18) or newer**, on a Mac.
- **The Creative Cloud desktop app**, signed in with your Adobe account. It installs the plugin.
- **The font Audi Type Extended Bold**, installed on your Mac.
- **The plugin file**, e.g. `PosterBatchGenerator_1.0.0.ccx`.

---

## Install the plugin

> For a fully detailed walkthrough, including loading the plugin folder with the UXP Developer Tool, see the **[Installation Guide](INSTALL_GUIDE.md)**.

1. **Quit InDesign** if it's open.
2. **Double-click** the `.ccx` file. The Creative Cloud desktop app opens.
3. Creative Cloud warns that the plugin doesn't come from Adobe's marketplace. That's expected for an in-house tool: click **Install** (or **OK**) to continue.
4. Wait for the "installed" confirmation.
5. Start InDesign and open the panel from the **Plugins** menu → **Poster Batch**.

> The panel can be docked like any InDesign panel. It remembers your selections, so you can close and reopen it at any time.

If you see an amber banner saying the **Audi Type font is not installed**, install the font and reopen the panel before you generate anything.

---

## Prepare your files

You need three things. The plugin checks them and tells you exactly what's wrong if something doesn't fit.

**1. The client template (`.indd`)**

- The file name must contain **`DANIS`** or **`SERVICE`**, e.g. `DANIS_Template.indd`. (The spelling `Denis` isn't recognised.)
- Every page needs a layer called **`text`** (headline and subline in one text frame) and a layer called **`Image`** (one picture frame). A **`footer`** layer is optional and holds the DANIS ADD ON text.
- The template must have been saved at least once.

**2. The Excel copy sheet (`.xlsx`)**

- It needs a sheet named exactly **`AOZ+AOT`**.
- Row 1 holds the column names: `DANIS + SERVICE HEADLINE +PRODUCT NAMING`, `DANIS SUBLINE`, `SERVICE SUBLINE`, `PICTURE NAME`, and optionally `DANIS ADD ON` and `YEAR`.
- `PICTURE NAME` is the photo's file name without the extension, e.g. `Q5_as_2025_7840 (web_2160p)`.
- Write `n/a` in a cell that should stay empty.

**3. The photos folder**

- One folder containing the product photos (sub-folders are fine).
- Photos are found by their file name (`PICTURE NAME`), or otherwise by a folder name that resembles the product headline.

---

## Make posters, step by step

The panel has four steps from top to bottom. **Step 4 (Export) always stays at the bottom of the panel.**

### Step 1: Inputs

Click each button and pick the file or folder:

| Button | Pick |
|---|---|
| **Select Excel File…** | The Excel copy sheet |
| **Select Photos Folder…** | The folder with the product photos |
| **Select Output Folder…** | Where the results should be saved (an empty folder is best) |

### Step 2: Template

1. In InDesign, **open the client template** (e.g. `DANIS_Template.indd`) so it's the document in front.
2. In the panel, click **Prepare Copy of Current Document**.

The plugin saves a working copy next to the client file, named `…_DataMerge.indd`, and prepares it. **The client's original file is never changed.** The panel shows a tick per page:

```
✓ Page 1
✓ Page 2
✓ Page 3
```

A `⚠` next to a page explains what's missing, e.g. a layer or frame. Fix it in the client template and click Prepare again.

**One type at a time:** the panel works with either DANIS **or** Service. To switch, open the other client template and click Prepare again.

### Step 3: Subject Placement

**Subject detection** — where the plugin learns where the car is in each photo:

- **Capsule JSON** (default): click **Detect with Adobe Workflow** in step 3. The published Adobe Workflow detects the subject in the photos you already selected, through the team backend: no second upload and no copying. Each photo gets ✓ or ✗; paste or import the JSON for any that fail. Fallback: run **Detect Focal Point** in Adobe Capsule for each original photo. Click **Copy** on the workflow's Preview node, then **Paste Capsule JSON** in step 3: the JSON appears in the box under the button. Choose the photo it belongs to and click **Import for This Photo**. Or download the JSON files, name them like the photos (`car_01.jpg` → `car_01.json`) and click **Import JSON Files…**. Per product, use **⋯ → Paste Capsule JSON (Step 3)** or **⋯ → Import Capsule JSON File…**. Check or adjust the box and focal point with **⋯ → Edit Subject Placement…**. A product without a JSON is reported as **Missing Detection Data** before generating; you can import it or continue with the default placement (the product is then marked ⚠ Review). See [Capsule Subject Placement](CAPSULE_SUBJECT_PLACEMENT.md).
- **Backend API** — the original automatic detection through the team backend.

The placement itself is the same with both. Then pick one of two options:

- **Auto Placement** — nothing to do. Each product is found in its photo and put in the middle of the empty part of the picture, never under the text. A small product is enlarged to 70–80% of the picture. If the text takes up so much room that this isn't possible next to it, the product overlaps the text area a little — check those pages and move the text or the photo by hand if needed.
- **Custom Subject Frames** — click **Add Default Frames**. The template opens with a red frame on every page. Move or resize the red frames to where the product should go, click **Save Frame Changes**, then click **Generate**. While a change isn't saved yet, the panel shows a yellow reminder. The red frames never appear in the final images. **Reset Frames** brings the default frames back.

Want to change just one product? Open its INDD, scale or move the photo by hand, then click **Commit**.

### Step 4: Match, Generate & Review

**Match.** Click **Match**. Every product from the Excel sheet appears in a list:

```
Ski- und Snowboardhalter                          ⚠ Review
Image: Q5_as_2025_7840 (web_2160p).jpeg
⚠ danis_up 1200x1200: headline/subline doesn't fit its frame
[Open .indd] [Preview Image Batch] [Commit .indd] [⋯]
```

Check that each product found the right photo (the *Image:* line). A product without a photo shows **No asset** and the reason. Fix the Excel or the photo name, then click **Match** again.

**Generate.** Click **Generate All .indd**. The plugin creates one InDesign file per product. No images are exported yet. If files from an earlier run exist, it asks before replacing them, because any manual edits in them would be lost.

**Review.** For each product you can:

| Button | What it does |
|---|---|
| **Open .indd** | Opens the product's InDesign file so you can adjust it (move the photo, shorten text, …). |
| **Preview Image Batch** | Exports quick low-resolution images of all the product's formats and opens the folder, so you can check them. |
| **Commit .indd** | Saves the file, checks it again and marks it **✓ Committed**, ready for export. |
| **⋯** | **Regenerate .indd** (rebuild this one product from the template, which discards your manual edits) or **Open Output Folder**. |

While a product's InDesign file is the document in front, the panel also shows its buttons in the bottom bar (*Working in: …*), so you don't need to look for it in the list.

**Commit All Ready .indd** commits every product marked **✓ Ready** in one click. Products with warnings are skipped. Check those, then commit them one by one. If you commit a product that still has warnings, the panel lists them and asks **Commit Anyway?**

### Step 5: Export

Click **Export All Committed Images**. The final poster images of every **✓ Committed** product are exported, including any changes you made in the InDesign files.

**Changed something after exporting?** Edit the product's InDesign file, click **Commit .indd** again, then **Export All Committed Images**.

---

## What the statuses mean

| Status | Meaning | What to do |
|---|---|---|
| Not generated | No InDesign file yet | Click **Generate All .indd** |
| Unchecked | A file from an earlier session was found | Preview or commit it to check it |
| ✓ Ready | Generated and checked, no problems | Commit it |
| ⚠ Review | A problem was found; it's listed under the product | Open the file, fix it, then preview or commit |
| ✓ Committed | Approved | Export in step 4 |
| ✓ Exported | Final images exist | Done (commit again after any change) |
| Failed | The file couldn't be created; the error is listed | See [Troubleshooting](#troubleshooting) |
| No asset | No photo was found for this product | Fix `PICTURE NAME` or the photo, then Match again |

The most common warnings:

- **"doesn't fit its frame"**: the text is too long and part of it would be cut off. Shorten the text or enlarge the frame in the product's file.
- **"MainImage frame is empty"**: the photo is missing on that page. Place it again, or regenerate the product.
- **"Missing Detection Data"** (Capsule JSON mode): no Capsule JSON was imported for the photo, or the photo changed after the import. The product was placed the default way. Paste or import the JSON (**⋯ → Paste Capsule JSON (Step 3)**) and regenerate.

---

## Where your files are saved

Everything goes into the output folder you picked in step 1:

```
Output folder/
  InDesign/                    ← one editable file per product
    DANIS/    DANIS_Herbst_2026_<product>.indd
    Service/  Service_Herbst_2026_<product>.indd
  preview/                     ← quick previews (replaced each time)
  output/                      ← FINAL images, sorted by size
    DANIS/    1200x1200/ …
    Service/  250x250/ · 800x600/ · 1080x1920/ · 1200x1200/ …
  capsule_subjects.json        ← imported Capsule detections + your adjustments (Capsule JSON mode)
  generation_log.csv           ← details of the last Generate
  export_log.csv               ← details of the last Export
```

- **DANIS** creates 2 or 3 images per product (the footer version only when the Excel has DANIS ADD ON text). **Service** creates 7.
- Image names look like `DANIS_Herbst_2026_Ski-und-Snowboardhalter_1200x1200_up.jpg`: type, year, product, size and layout (`up`, `bottom`, `footer` or `thumbnail`).
- The `.csv` logs open in Excel. They list every file and every problem, which is useful when asking for help.

---

## Update or uninstall

**Update:** quit InDesign and double-click the newer `.ccx` file (it has a higher version number in its name). Creative Cloud replaces the old version. Your output folders and files are not affected.

**Uninstall:** in the Creative Cloud desktop app, open the plugin management page (**Stock & Marketplace → Plugins → Manage plugins**; the exact place can vary by Creative Cloud version), find **Poster Batch Generator** and choose **Uninstall**.

**Start fresh:** the **⟳ Reload** button at the top of the panel clears all selections and statuses, as if the panel had just been installed. It **never deletes files**.

---

## Troubleshooting

| What you see | What to do |
|---|---|
| The panel isn't in the Plugins menu | Restart InDesign. If it's still missing, install the `.ccx` again. |
| "InDesign isn't responding to the plugin" | Close any open InDesign dialog box, then close the panel and reopen it from the Plugins menu. |
| Amber banner: Audi Type font not installed | Install Audi Type Extended Bold, then reopen the panel. |
| "Could not determine template type from filename" | Rename the template so its name contains `DANIS` or `SERVICE`. |
| "Layer(s) not found" | The template is missing the `text` or `Image` layer. |
| "… has no file on disk" | Save the client template once (Cmd+S), then Prepare again. |
| "Sheet "AOZ+AOT" not found" | Rename the Excel sheet to exactly `AOZ+AOT`. |
| "Data source is missing column(s)" | A column name in row 1 of the Excel is misspelled or missing. |
| "this INDD is open in InDesign" | Close that product's file in InDesign, then try again. |
| A button is greyed out | A previous step is missing: **Generate All .indd** needs steps 1 and 2 plus Match; **Commit All Ready .indd** needs at least one ✓ Ready product; **Export All Committed Images** needs at least one ✓ Committed product. |
| The wrong type was generated (DANIS instead of Service) | Open the other client template and click **Prepare Copy of Current Document** again. |

**Still stuck?** Send the plugin team a screenshot of the panel and the `generation_log.csv` or `export_log.csv` from your output folder.
