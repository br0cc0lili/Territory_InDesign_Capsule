#!/usr/bin/env python3
"""
Build manifest.csv by matching Excel headline rows to image subfolders.

Read-only against source data. Never modifies the Excel or Pictures folder.
Output: 02_System/data/manifest.csv  (human-reviewable / editable before rendering)

Usage:
    python3 01_build_manifest.py
"""
import csv
import re
import difflib
from pathlib import Path
from typing import Optional, List, Dict, Any
import openpyxl

ROOT = Path(__file__).resolve().parents[2]  # Bertelsmann_ID_Plugin/
EXCEL_PATH = ROOT / "01_Assets" / "Excel" / "00_Text_DANIS+Service.xlsx"
PICTURES_DIR = ROOT / "01_Assets" / "Pictures"
MANIFEST_PATH = ROOT / "02_System" / "data" / "manifest.csv"

# Preferred image filename patterns, in priority order (first match wins)
IMAGE_PREFERENCE = [
    re.compile(r"\(web_1080p\)\.jpe?g$", re.IGNORECASE),
]
# Explicitly excluded filenames (never pick these as the product photo)
EXCLUDE_PATTERNS = [
    re.compile(r"Bildschirmfoto", re.IGNORECASE),
    re.compile(r"^\.", re.IGNORECASE),  # dotfiles like .DS_Store
]

# Allow limiting the test run to specific headlines. Set to None to process everything.
TEST_HEADLINES = [
    "Ski- und Snowboardhalter",
    "Allwetterfußmatten",
    "Grundträger",
]


def normalize(text: str) -> str:
    text = text.lower()
    text = text.replace("ä", "ae").replace("ö", "oe").replace("ü", "ue").replace("ß", "ss")
    text = re.sub(r"[^a-z0-9]+", " ", text)
    return text.strip()


def read_excel_rows():
    wb = openpyxl.load_workbook(EXCEL_PATH, data_only=True)
    ws = wb["AOZ+AOT"]
    rows = []
    for row in ws.iter_rows(min_row=2, max_col=3, values_only=True):
        headline, danis_subline, service_subline = row
        if not headline:
            continue
        rows.append({
            "headline": str(headline).strip(),
            "danis_subline": (danis_subline or "").strip(),
            "service_subline": (service_subline or "").strip(),
        })
    return rows


def list_product_folders():
    folders = []
    for p in sorted(PICTURES_DIR.iterdir()):
        if p.is_dir():
            # strip leading "NN_" index and part-number token, keep descriptive name
            name = p.name
            # remove leading number+underscore e.g. "01_"
            name = re.sub(r"^\d+_", "", name)
            # remove a leading part-number-like token (alnum, no spaces, followed by underscore)
            name = re.sub(r"^[A-Za-z0-9]{5,}\s*_?\s*", "", name)
            folders.append({"path": p, "descriptive_name": name.strip()})
    return folders


def find_best_image(folder: Path) -> Optional[Path]:
    candidates = [f for f in folder.rglob("*") if f.is_file()]
    candidates = [f for f in candidates if not any(pat.search(f.name) for pat in EXCLUDE_PATTERNS)]
    for pattern in IMAGE_PREFERENCE:
        for f in candidates:
            if pattern.search(f.name):
                return f
    # fallback: any non-excluded image file
    image_exts = {".jpg", ".jpeg", ".png", ".tif", ".tiff"}
    for f in candidates:
        if f.suffix.lower() in image_exts:
            return f
    return None


def match_headline_to_folder(headline: str, folders: List[Dict[str, Any]]) -> Optional[Dict[str, Any]]:
    norm_headline = normalize(headline)
    best = None
    best_score = 0.0
    for folder in folders:
        norm_folder = normalize(folder["descriptive_name"])
        if not norm_folder:
            continue
        # containment check first (strong signal)
        if norm_headline in norm_folder or norm_folder in norm_headline:
            score = 0.95
        else:
            score = difflib.SequenceMatcher(None, norm_headline, norm_folder).ratio()
        if score > best_score:
            best_score = score
            best = folder
    if best and best_score >= 0.6:
        return {"folder": best, "score": best_score}
    return None


def main():
    excel_rows = read_excel_rows()
    folders = list_product_folders()

    if TEST_HEADLINES:
        excel_rows = [r for r in excel_rows if r["headline"] in TEST_HEADLINES]

    matched_folder_paths = set()
    manifest_rows = []

    for row in excel_rows:
        match = match_headline_to_folder(row["headline"], folders)
        if match is None:
            manifest_rows.append({
                **row,
                "image_path": "",
                "status": "skipped_no_image",
                "notes": "no confident folder match",
            })
            continue
        folder = match["folder"]
        matched_folder_paths.add(folder["path"])
        image = find_best_image(folder["path"])
        if image is None:
            manifest_rows.append({
                **row,
                "image_path": "",
                "status": "skipped_no_image",
                "notes": f"matched folder '{folder['path'].name}' but no usable image file found",
            })
            continue
        manifest_rows.append({
            **row,
            "image_path": str(image.relative_to(ROOT)),
            "status": "matched",
            "notes": f"folder='{folder['path'].name}' score={match['score']:.2f}",
        })

    # Report unmatched folders only when doing a full run (not the limited test run)
    if not TEST_HEADLINES:
        for folder in folders:
            if folder["path"] not in matched_folder_paths:
                manifest_rows.append({
                    "headline": "",
                    "danis_subline": "",
                    "service_subline": "",
                    "image_path": str(folder["path"].relative_to(ROOT)),
                    "status": "skipped_no_excel_row",
                    "notes": f"folder '{folder['path'].name}' has no matching Excel headline",
                })

    MANIFEST_PATH.parent.mkdir(parents=True, exist_ok=True)
    with open(MANIFEST_PATH, "w", newline="", encoding="utf-8") as f:
        writer = csv.DictWriter(f, fieldnames=["headline", "danis_subline", "service_subline", "image_path", "status", "notes"])
        writer.writeheader()
        writer.writerows(manifest_rows)

    matched = sum(1 for r in manifest_rows if r["status"] == "matched")
    print(f"Wrote {len(manifest_rows)} rows to {MANIFEST_PATH} ({matched} matched)")
    for r in manifest_rows:
        print(f"  [{r['status']}] {r['headline'] or '(no headline)'} -> {r['image_path']}")


if __name__ == "__main__":
    main()
