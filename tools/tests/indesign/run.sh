#!/bin/zsh
# InDesign regression: stale optional subline placeholders.
# Runs the plugin's own modules inside the running InDesign (UXP script via
# AppleScript) on fixtures in tools/test-output/phase4-root — only ever on
# COPIES of your templates.
#
# Setup (once): cp config.example.json config.local.json and fill in your
# local paths (config.local.json is gitignored).
# Usage: tools/tests/indesign/run.sh
#   1 setup    — fixtures (copies of the client template, 2-page old prepared template, CSVs)
#   2 prepare  — Prepare with / without a WINTER / SERVICE SUBLINE column
#   3 generate — the 6 Generate cases; checks the exported sublines
D="$(cd "$(dirname "$0")" && pwd)"; REPO="$(cd "$D/../../.." && pwd)"
CONFIG="$D/config.local.json"
if [ ! -f "$CONFIG" ]; then
  echo "Missing $CONFIG — copy config.example.json to config.local.json and fill in your local fixture paths."; exit 2
fi
OUT="$REPO/tools/test-output/idjs"; ROOT="$REPO/tools/test-output/phase4-root"; mkdir -p "$OUT"
node -e '
const fs=require("fs");const [tpl,out,root,o,repo,cfg]=process.argv.slice(1);
const c=JSON.parse(fs.readFileSync(cfg,"utf8"));
for(const k of ["clientTemplate","preparedTemplate","sourceImage"]) if(!c[k]||/absolute\/path/.test(c[k])||!fs.existsSync(c[k])) { console.error("config.local.json: "+k+" not found: "+c[k]); process.exit(2); }
const local={clientTemplate:c.clientTemplate,preparedTemplate:c.preparedTemplate,sourceImage:c.sourceImage,twoLayoutPages:c.twoLayoutPages||[5,7]};
fs.writeFileSync(out,fs.readFileSync(tpl,"utf8").replace("__ROOT__",root).replace("__OUT__",o).replace("__REPO__",repo).replace("__CONFIG__",JSON.stringify(local)));
' "$D/prelude.js" "$OUT/prelude.js" "$ROOT" "$OUT" "$REPO" "$CONFIG" || exit 2
run() {
  local step=$1 body=$2
  # Dialogs (e.g. InDesign's "Issues with Links") are suppressed for the test
# only — NEVER_INTERACT leaves modified links as they are ("Don't Update
# Links") — and the user's setting is restored in finally.
  { cat "$OUT/prelude.js"; echo "const __out = {};"; echo "const __uil = app.scriptPreferences.userInteractionLevel;"; echo "try {"; echo "app.scriptPreferences.userInteractionLevel = require('indesign').UserInteractionLevels.NEVER_INTERACT;"; cat "$body"; echo "} catch (e) { __out.error = String(e && e.stack || e); } finally { app.scriptPreferences.userInteractionLevel = __uil; }"; echo "await writeOut('$step.json', __out);"; } > "$OUT/$step.idjs"
  rm -f "$OUT/$step.json"
  osascript -e 'with timeout of 900 seconds' -e "tell application id \"com.adobe.InDesign\" to do script \"app.doScript(File('$OUT/$step.idjs'), ScriptLanguage.UXPSCRIPT); 'ok'\" language javascript" -e 'end timeout' >/dev/null 2>&1
  for i in {1..600}; do [ -f "$OUT/$step.json" ] && break; sleep 1; done
}
echo "await closeTestDocuments(); __out.ok = true;" > "$OUT/cleanup.body"
run stale-cleanup "$OUT/cleanup.body"   # close test fixtures left open BEFORE deleting them
rm -rf "$ROOT/stale"
run stale-setup "$D/stale-subline.setup.body"; cat "$OUT/stale-setup.json"; echo
run stale-prepare "$D/stale-subline.prepare.body"; cat "$OUT/stale-prepare.json"; echo
run stale-generate "$D/stale-subline.generate.body"; cat "$OUT/stale-generate.json"; echo
node -e 'const r=require(process.argv[1]);const c0=JSON.parse(require("fs").readFileSync(process.argv[2],"utf8"));
const client=new RegExp(c0.expectedClientSubline||".");const bad=r.cases.filter(c=>c.tokenLeak||c.failed.length||c.nonImageWarnings.length||!c.generated);
const want={"1a":client,"1b":/^""$/,"2":client,"3":client,"4a":/Winter-Check/,"4b":/Audi Original Teile/};
for(const c of r.cases){const k=c.name.split(" ")[0];const okv=c.sublines.some(s=>want[k].test(s));console.log((okv&&!bad.includes(c)?"PASS ":"FAIL ")+c.name+" → "+c.sublines.join(", "));if(!okv)bad.push(c)}
process.exit(bad.length?1:0)' "$OUT/stale-generate.json" "$CONFIG"
