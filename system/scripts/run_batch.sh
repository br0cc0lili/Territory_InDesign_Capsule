#!/bin/bash
# Runs the full poster batch pipeline:
#   1. Build/refresh 02_System/data/manifest.csv from the Excel sheet + Pictures folder
#   2. Drive InDesign to render all 4 poster variants per matched manifest row
#
# Usage: ./run_batch.sh
# Requires: python3 (openpyxl), Adobe InDesign 2026 installed.

set -e

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
SCRIPTS="$ROOT/02_System/scripts"

echo "== Step 1/2: building manifest.csv =="
python3 "$SCRIPTS/01_build_manifest.py"

echo ""
echo "== Step 2/2: rendering posters in InDesign =="
osascript -e "tell application \"Adobe InDesign 2026\" to do script \"$SCRIPTS/02_generate_posters.jsx\" language javascript"

echo ""
echo "Done. Check 02_System/data/manifest.csv and 02_System/logs/generation_log.csv for results."
echo "Rendered images are in 02_System/output/<headline>/."
