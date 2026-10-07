# Branch changes

Files to overwrite in the branch:

- `03_Plugin/js/render.js`
- `03_Plugin/js/matcher.js`
- `03_Plugin/js/index.js`
- `03_Plugin/js/merge.js`

Main changes:

1. Render directly from two selected INDD template files instead of requiring a single master INDD.
2. Supports 7 Service + 3 Denis page layouts.
3. Supports Denis split layout with separate `<<Headline>>` and `<<Subline>>` frames.
4. Keeps replaceable `<<MainImage>>` background/image behavior.
5. Accepts CSV as well as the existing Excel input.
6. Output filenames include the page label so the two Service 1200×1200 top variants cannot overwrite each other.
7. Legacy `Poster_Master.indd` remains as a fallback when no INDD files are selected.
