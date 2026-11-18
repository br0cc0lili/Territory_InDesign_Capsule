# Capsule Subject Placement

Adobe Capsule finds the car in each photo. The plugin places it, with the same placement logic as before.

```
Adobe Capsule (Detect Focal Point) → JSON → Import → existing Subject Placement → InDesign layouts
```

Capsule replaces only **where the subject box comes from**: the backend API is swapped for an imported JSON. Everything after that is the original plugin's behaviour, unchanged:

- occupancy (a small product is enlarged to 75–80%);
- text avoidance;
- Fill / Extend layout policies;
- red subject frames;
- warnings;
- Image Extension;
- Auto Text Color;
- Export.

## The JSON

```json
{
  "focalPoint":  { "x": 0.533717114, "y": 0.649771365, "normalized": true },
  "boundingBox": { "x": 0.067434214, "y": 0.2995427, "width": 0.9325658, "height": 0.70045733, "normalized": true }
}
```

- **Coordinates:** all values are shares (0..1) of the photo, measured from the top-left corner.
  - `x` / `y` are the box's left and top edges.
  - This is the same convention the plugin's subject box already uses, so the values are used as they are.
- **The import refuses:**
  - malformed JSON;
  - a missing `boundingBox` or `focalPoint`;
  - `normalized` that isn't `true`;
  - values that aren't numbers, or are outside 0..1;
  - a zero width or height;
  - `x + width > 1` or `y + height > 1`.

  Every reason is listed.
- **Accepted, with a note:**
  - a box touching a photo edge (the car is probably cut off in the photo);
  - a focal point outside the box;
  - a box covering nearly the whole photo (≥ 95% on both axes). Such a box is treated like any whole-photo box: no subject shift and no red-frame placement, as in the original;
  - a photo with an EXIF rotation flag (check the box in the editor).
- **Focal point:** imported, validated, stored, shown and editable. It does **not** move the placement yet. Using it would change the original centring logic.

## How to use it

1. **Step 1:** choose the Excel file, the photos folder and the output folder.
2. **Step 2:** prepare the template, as before.
3. **Step 3:** set *Subject detection* to **Capsule JSON** (the default).
4. **Step 4:** click **Match**.
5. **Bring in the Capsule data.** Use **Detect with Adobe Workflow** (below), or as a fallback paste the JSON or import files:
   - **Paste (copied from the workflow):** in the Capsule workflow, click **Copy** on the Preview node. In step 3, click **Paste Capsule JSON**, which puts the clipboard into the box under it (or click in the box and press ⌘V).
     - The text is checked as it is pasted: ✓ with the box and focal point values and any notes, or ✗ with every reason.
     - **For photo:** choose the photo it was made from. Pasted text has no file name, so nothing is preselected and the photo is never guessed.
     - Click **Import for This Photo**. The data is shown later as "Pasted <date time>". Check the box on the photo with **⋯ → Edit Subject Placement**.
     - **⋯ → Paste Capsule JSON (Step 3)** selects that product's photo in the box.
     - If you paste before Match, Match runs first so the photo list fills. Text with a ```` ```json ```` fence or extra blanks is accepted.
   - **Several files at once:** in step 3, click **Import JSON Files…**. Each file is paired with a matched photo by **file name only**:
     - `car_01.json`, `car_01.capsule.json` or `car_01_capsule.json` → `car_01.jpg`.
     - Files with no photo of that name, files whose name fits several photos, and several files for one photo are listed and **not** imported.
   - **One product, from a file:** **⋯ → Import Capsule JSON File…**. A file named differently from the photo is only used after you confirm it was made from that photo.
   - **Pasting or importing again** replaces the imported values. If the photo already has data you are asked first, and whether to keep or discard your adjustments.
6. **Optional:** **⋯ → Edit Subject Placement…** (see below).
7. **Generate All .indd**, then Review, Commit and Export as before.

### Detect with Adobe Workflow

Runs the published Adobe Workflow *Territory-Adobe-SubjectPlacement* (Input assets → Detect focal point → Execute Script) on the photos the plugin already has.

- **No second upload.** You don't open Capsule and don't copy anything.
- **One click, one batch.** **Detect with Adobe Workflow** (step 3) or **⋯ → Detect with Adobe Workflow…** (one product) first asks which photos to send:
  - **Detect N photos:** photos without data, or whose file changed;
  - **Re-detect All:** every matched photo.
  - If any of them has your adjustments, you're asked whether to keep or discard them.
- **What happens:**
  - Each photo is uploaded to the team backend, as in Backend API mode.
  - The backend runs **one** workflow batch, one run per photo, with its own Adobe credential, then deletes the uploads.
  - The panel shows progress, then one line per photo: ✓ or ✗ with the reason.
- **Storage:**
  - Results go into `capsule_subjects.json` through the same validation as an imported file, with the source "Adobe Workflow · <date time> · <batch>".
  - A photo whose file changed during the run is not stored.
  - A photo that failed keeps its previous data.
- **Requirements and limits:**
  - It needs `plugin/backend.config.json`, like Backend API mode and Image Extension.
  - JPG and PNG only, at most 100 photos per click.
  - Detection uses Adobe credits.
  - Adobe's Detect focal point step uses the partner service Photoroom.
- **Never automatic:** detection runs only when you click; Generate never starts it.

Backend (territory-app):

| Action | What it does |
|---|---|
| `subject-upload-url` | Upload (existing, unchanged) |
| `capsule-detect` | Checks the uploads, creates read-only links (20 min, internal only), submits the batch and keeps Adobe's result link (`links.result.href`, checked: `run-workflow.adobe.io`, this batch only) under its own job id |
| `capsule-detect-status` | Accepts only those job ids. Reads the result view, takes the **Detect Focal Point node's** structured JSON (the Execute Script text only as a fallback), validates it, matches it by `asset_index` (never by file name), deletes the uploads, and cancels batches still running after 30 minutes |

### Missing Detection Data

Before Generate All or Regenerate, the plugin lists every product whose photo has no Capsule JSON, or whose photo file changed after the import. You can:

- **Detect with Adobe Workflow…** or **Import Capsule JSON Files…** (or close it and paste the JSON in step 3), or
- **Continue with Default Placement.** These products are placed exactly as the original plugin places a photo without a subject box, and are marked **⚠ Review — Missing Detection Data**.

The backend API is **never** called in Capsule mode.

## Edit Subject Placement

The window shows the **original photo** with:

| On the photo | Meaning |
|---|---|
| Dashed box / hollow dot | Imported from Capsule (never overwritten) |
| Solid green box / yellow dot | Used for placement. Drag the box to move it, drag a corner to resize it, drag the dot to move the focal point. The numbers below accept exact values (0..1) |

- **Reset to Auto:** back to the imported values.
- **Preview Placement:** one diagram per layout, computed by the same functions Generate uses. It shows the page, the image frame, the text areas, any red subject frame, the placed photo and the subject box, plus the existing fill numbers and warnings.
  - The layouts come from the generated product INDD (the saved version), or from the Template Set before the first Generate.
  - Fill layouts show "Content-Aware Fit": InDesign decides that crop itself, as before.
- **Apply to Current Layout:** the adjustment is used on the selected layout only.
- **Apply to All Relevant Layouts:** the adjustment is used on every layout, and replaces any layout-only adjustments.

### What Apply does

Both Apply buttons first ask, listing what is affected:

- **Products:** every product that uses this photo.
- **Manual edits:** the existing warning that regenerating replaces the INDD and may discard manual edits.
- **Completed artwork:** Committed or Exported products go back to review. JPGs already exported are not deleted.
- **Image Extension:** existing results were made for the old placement. After regenerating, the product is marked Review until you extend again (or check *Use Existing Extension*).
- **Open files:** an INDD open in InDesign **with unsaved changes** stops the whole action: nothing is saved or replaced until you save or close it yourself. An open INDD without unsaved changes is closed first.
- **Backup:** every INDD that will be replaced is first copied to `InDesign/_backup/<date_time>/` in the output folder. If the copy fails, nothing is regenerated.

Then:

- **Save & Regenerate:** saves the adjustment and runs the existing Regenerate for those products.
- **Save Only:** saves the adjustment; it is used on the next Generate or Regenerate. The product row shows "Capsule data changed — Regenerate .indd to apply".
- **Cancel:** nothing is saved.

The Template Set is never changed.

## Where the data is kept

`<output folder>/capsule_subjects.json` holds one entry per photo. It is shared by every product, template and layout that uses the photo.

| Field | Content |
|---|---|
| `auto` | What Capsule detected, the JSON file name, import time and import notes |
| `manual` | Your adjustment for all layouts, or `null` |
| `layouts` | Adjustments for single layouts (`service/1200x1200/up`, …) |
| `photo` | Size and modification time of the photo at import. If they change, the data is not applied ("photo changed") until you re-import or choose **Keep Capsule Data for Changed Photo** |

The **final placement** of every layout is stored, as before, on the image frame of the product INDD (script label `posterBatch.placement`) and in `generation_log.csv`. The log also records the Capsule box, the focal point and any layout-only adjustment.

## How the placement measures "occupancy"

This is unchanged from the original plugin (`placement.js` `PLACEMENT_CONFIG.subject`). The subject's size is its larger share of the area it is measured against: max(subject width ÷ area width, subject height ÷ area height).

- **Small subjects are enlarged.** A subject spanning less than 75% of the free area (the image frame minus the text) is enlarged to 78%.
- **Whole-frame limits.** The subject must span at least 70% of the whole image frame (target 75%) and is never enlarged past 80% of it.
- **Text overlap rule.** If staying clear of the text would keep it smaller, it may overlap the text area as little as possible.
- **Large subjects are left as they are.** A subject that is already larger is not made smaller; the photo keeps its contain-fit size.
- **Fill layouts** use InDesign's Content-Aware Fit.
- **Custom Subject Frames:** the subject is fitted into the red frame.

## Tests

| Test | What it covers |
|---|---|
| `node tools/tests/run.js` | All offline tests, including the original suite unchanged, plus:<br>• `workflowdetect.test.js`: Detect with Adobe Workflow — upload, one batch, polling, results by position, failures<br>• `capsulepaste.test.js`: pasted text validation and the clipboard (the paste box itself is in `capsulepanel.test.js`)<br>• `capsule.test.js`: JSON validation, adapter, store, bulk matching, a Capsule box giving identical placement plans to the same API box (48 cases)<br>• `capsulepreview.test.js`: Preview = `placeProductImage` (60 cases)<br>• `capsuleeditor.test.js`: coordinates, drag and resize, typed values, the window on a fake DOM<br>• `capsulepanel.test.js`: the real `index.js` on a fake UXP: import, Missing Detection Data, source switch, Apply / Regenerate warnings |
| `node tools/tests/indesign/capsule-regression.js [git-ref]` | Needs a running InDesign. Runs the ORIGINAL plugin code (default `main`) and this working tree on the same synthetic files and subject boxes: Auto Placement and Custom Subject Frames must give identical pages, warnings, Image Extension analysis and preview export; Capsule mode with the same boxes must equal the original. Network blocked |
| `node tools/tests/indesign/capsule-indesign.js` | Needs a running InDesign. Uses a synthetic Template Set (1200×1200, 800×600, 1080×1920, 1000×700 with a bleeding frame) and synthetic photos (1920×1280, 3000×2000, 1080×1350). It runs the plugin's own Generate, compares every placed graphic with Preview, checks the layout-only edit plus Regenerate, and exports preview JPGs. It only closes documents in its own test folder |

## Limitations

- **The focal point is not used by placement.** That is deliberate: it would change the original logic.
- **The original logic has no special rule for a box that touches the photo edge.** In Extend layouts the original stays top-anchored, and Image Extension fills the strip, as before.
- **A subject larger than 80% is not shrunk.** That is the original behaviour.
- **Fill layouts:** Preview cannot show InDesign's Content-Aware Fit crop.
- **Preview geometry** is read from the *saved* product INDD. Unsaved changes in an open INDD are not included.
- **Photo identity** is the file path plus its size and modification time. Moving or renaming a photo means importing its JSON again.
- **Pairing:** Capsule's JSON carries no image identity. Bulk pairing relies on file names. Pasting and per-product import rely on your choice of photo or product.
- **Clipboard:** reading it needs the manifest permission `"clipboard": "read"`. The plugin reads it only when you click **Paste Capsule JSON**.
- **Dragging** in the editor uses UXP mouse / pointer events. The numeric fields are the fallback if dragging behaves differently in an InDesign version. The editor window has been tested offline on a fake DOM and has not yet been tried interactively in InDesign.
