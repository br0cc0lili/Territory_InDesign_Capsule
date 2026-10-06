# Poster Batch Generator — InDesign Plugin

A UXP panel version of the `02_System/` CLI pipeline: pick the Excel file and
a photos folder, review the auto-matched table in the panel, then click
Generate — no Terminal, Python, or manual CSV editing required.

`02_System/` is left untouched and still works as a scriptable/headless
fallback (e.g. full-catalog batch runs). Both share the same
`02_System/templates/Poster_Master.indd` and the same matching rules, so
they won't drift apart in behavior.

## One-time setup: install UXP Developer Tool

Loading an unpacked plugin folder into InDesign requires Adobe's **UXP
Developer Tool** (a free small app, separate from InDesign itself):

1. Open the **Creative Cloud desktop app** → search for "UXP Developer Tool"
   under apps → Install.
2. Launch UXP Developer Tool.
3. Click **Add Plugin** → select this folder
   (`03_Plugin/manifest.json`).
4. Click **Load** (with InDesign 2026 already running) to load the panel.
5. In InDesign, open the panel via **Plugins → Poster Batch Generator →
   Poster Batch** (menu path may vary slightly by InDesign version).

Re-click **Load** in UXP Developer Tool any time you edit the plugin's JS/CSS
files — it hot-reloads without needing to restart InDesign.

## How to use

1. **(Optional) Import templates** — if your poster layouts live in separate
   `.indd` files (one per format, e.g. a designer's `top_service.indd`,
   `top_denis.indd`, `bottom_denis.indd`, `9x16_top_service.indd`), each
   already carrying the page label the render step looks for:
   - Open (or create) the document you want these pages added to, and make
     it the active/frontmost document in InDesign.
   - **Select .indd Files…** — pick all of them at once (multi-select).
   - **Import into Current Document** — appends one page per source file,
     in the order you picked them, onto the end of the active document,
     with each page's original label preserved. The summary lists each
     file → label it produced, and flags any duplicate labels so you can
     fix them before generating. Nothing is saved automatically — save the
     document yourself (Cmd+S) once you're happy with it.
   - Skip this step entirely if you already have a combined master
     document; in that case Generate falls back to
     `02_System/templates/Poster_Master.indd`.
2. **Select Excel File…** — pick `01_Assets/Excel/00_Text_DANIS+Service.xlsx`
   (must contain a sheet named `AOZ+AOT`).
3. **Select Photos Folder…** — pick `01_Assets/Pictures/` (or any folder
   with the same subfolder-per-product layout).
4. Click **Match**. The table shows every Excel row and every photo folder,
   with matched rows in white and skipped rows greyed out with a reason —
   the in-panel equivalent of reviewing `manifest.csv` before rendering.
5. **Select Output Folder…** — where the rendered JPGs should be written.
6. Click **Generate Posters**. Progress is shown live; a summary
   (success/error counts) and a `generation_log.csv` (same shape as the CLI's
   log) are written to the chosen output folder when done.

If the Audi Type font isn't installed, a warning banner appears at the top
of the panel before you can generate — install it from
`01_Assets/_CI Assets/Audi-CI-Guide/` first (see `02_System/README.md`
troubleshooting section for the font pack details).

## Folder layout

```
03_Plugin/
  manifest.json          UXP plugin manifest (panel entrypoint, permissions)
  index.html              panel markup
  css/style.css
  js/
    index.js              UI wiring: buttons, state, progress, results table
    merge.js               imports pages from separate .indd files into the active document
    matcher.js             JS port of 02_System/scripts/01_build_manifest.py
    render.js              JS port of 02_System/scripts/02_generate_posters.jsx
    lib/xlsx.full.min.js   vendored SheetJS standalone build (MIT licensed)
```

## Known limitation: no real drag-and-drop

Adobe has not implemented native OS drag-and-drop into UXP panels for
InDesign yet (it exists in Photoshop, not InDesign, as of this writing). The
**Select Photos Folder…** button is the closest equivalent — one click opens
the native macOS folder picker. If/when Adobe ships drag-and-drop support,
swapping it in is straightforward since the matching logic in `matcher.js`
only cares about the folder path it's given, not how it arrived.
