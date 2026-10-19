// Runs every offline regression test in this folder (Node, no InDesign):
//   node tools/tests/run.js
const { execFileSync } = require("child_process");
const fs = require("fs");
const path = require("path");
let failed = 0;
for (const f of fs.readdirSync(__dirname).filter((n) => n.endsWith(".test.js")).sort()) {
    try {
        const out = execFileSync(process.execPath, [path.join(__dirname, f)], { encoding: "utf8" });
        const last = out.trim().split("\n").pop();
        console.log(`${f.padEnd(22)} ${last}`);
        if (/FAIL/.test(out)) failed++;
    } catch (e) {
        failed++;
        console.log(`${f.padEnd(22)} FAILED\n${e.stdout || e.message}`);
    }
}
process.exit(failed ? 1 : 0);
