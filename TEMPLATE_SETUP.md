# New Service + Denis template setup

This branch supports two InDesign template files directly:

- `Service_Template.indd` — 7 template pages
- `Denis_Template.indd` — 3 template pages

You can select both files with the existing **Select .indd Files…** button. The Generate action will render directly from the selected INDD files. If no INDD files are selected, the plugin still falls back to the legacy `02_System/templates/Poster_Master.indd`.

## Required page labels

### Service_Template.indd

| Page | Size | Text layout | Required page label |
|---|---:|---|---|
| 1 | 1200 × 1200 | Headline + subline top, variant A | `service_1200x1200_top_a` |
| 2 | 1200 × 1200 | Headline + subline top, variant B | `service_1200x1200_top_b` |
| 3 | 1080 × 1920 | Headline + subline top | `service_1080x1920_top` |
| 4 | 1080 × 1920 | Headline + subline bottom | `service_1080x1920_bottom` |
| 5 | 800 × 600 | Headline + subline top | `service_800x600_top` |
| 6 | 800 × 600 | Headline + subline bottom | `service_800x600_bottom` |
| 7 | 250 × 250 | Headline + subline top | `service_250x250_top` |

### Denis_Template.indd

| Page | Size | Text layout | Required page label |
|---|---:|---|---|
| 1 | 1200 × 1200 | Headline + subline top | `denis_1200x1200_top` |
| 2 | 1200 × 1200 | Headline + subline bottom | `denis_1200x1200_bottom` |
| 3 | 1200 × 1200 | Headline top + subline bottom | `denis_1200x1200_split` |

## Required InDesign object names

All pages need a replaceable image/background frame named:

- `<<MainImage>>`

For the normal 9 layouts, use one text frame named:

- `<<Headline>>`

The frame contains two paragraphs:

1. Headline
2. Subline

For `denis_1200x1200_split`, use two independent text frames:

- `<<Headline>>` — top text
- `<<Subline>>` — bottom text

## CSV / Excel input

The branch accepts `.xlsx`, `.xls`, and `.csv`.

The first three columns are kept compatible with the existing project:

```text
headline,danis_subline,service_subline
```

For Excel, the existing `AOZ+AOT` worksheet is still used. For CSV, the first sheet/table is used.

## Important

The code cannot create the binary `.indd` files by itself. Build the two INDD files in InDesign using the supplied existing template as the visual/layout reference, and apply the page labels/object names above exactly.
