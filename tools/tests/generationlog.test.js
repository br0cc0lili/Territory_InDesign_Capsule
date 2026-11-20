// Offline regression test (Node, no InDesign). Run: node tools/tests/run.js
// Generation history: generation_log.csv keeps every run (run_id + run_type),
// is archived to logs/ when too big or in the old format, and
// generation_history.csv has one row per run.
const PLUGIN_JS = require("path").resolve(__dirname, "../../plugin/js");
const Module = require("module");

// In-memory UXP file system: path → text. Folders are just recorded.
const files = new Map();
const folders = new Set();
const pathOf = (url) => String(url).replace(/^file:/, "");
const entry = (p) => ({ nativePath: p, read: async () => files.get(p), write: async (t) => { files.set(p, String(t)); } });
const uxp = { storage: {
    types: { file: "file", folder: "folder" },
    formats: { binary: "binary", utf8: "utf8" },
    localFileSystem: {
        getEntryWithUrl: async (url) => { const p = pathOf(url); if (files.has(p) || folders.has(p)) return entry(p); throw new Error("not found: " + p); },
        createEntryWithUrl: async (url, o) => { const p = pathOf(url); if (o && o.type === "folder") folders.add(p); else if (!files.has(p)) files.set(p, ""); return entry(p); },
    },
} };
const o = Module._load; Module._load = function (r) { return r === "uxp" ? uxp : o.apply(this, arguments); };
const render = require(PLUGIN_JS + "/render.js");
let f = 0; const ok = (c, m) => { console.log((c ? "PASS " : "FAIL ") + m); if (!c) f++; };

// csvCell: commas → ";" (as before), line breaks no longer split a row
ok(render.csvCell("a,b") === "a;b" && render.csvCell("Template detected\n· Red frame") === "Template detected · Red frame" && render.csvCell(null) === "",
    "csvCell: comma → ';', line break → ' · ', null → ''");

// run ids sort by time
const id1 = render.newRunId(new Date(2026, 10, 19, 16, 5, 9, 42));
ok(id1 === "20261119-160509-042", "run id = local date-time to the ms: " + id1);

// tagging
const base = ["timestamp,headline,page_label,output_file,status,message", "t1,Aero,subject,,info,ok", "t2,Aero,indd,/x.indd,success,done"];
const tagged = render.tagRunLines(base, "R1", "regenerate");
ok(tagged.header === "timestamp,headline,page_label,output_file,status,message,run_id,run_type", "header: same six columns + run_id, run_type");
ok(tagged.rows.length === 2 && tagged.rows[1] === "t2,Aero,indd,/x.indd,success,done,R1,regenerate", "every row ends with run id + run type");

// planning the append
const first = render.planGenerationLogAppend(null, tagged.header, tagged.rows, "R1");
ok(!first.archive && first.text.split("\n").filter(Boolean).length === 3, "no file yet → header + rows");
const second = render.planGenerationLogAppend(first.text, tagged.header, render.tagRunLines(base, "R2", "generate").rows, "R2");
ok(!second.archive && second.text.split("\n").filter(Boolean).length === 5 && /,R1,regenerate\n.*,R2,generate/s.test(second.text),
    "second run is ADDED after the first (history kept)");
const oldFormat = "timestamp,headline,page_label,output_file,status,message\nt0,Old,indd,,success,x\n";
const fromOld = render.planGenerationLogAppend(oldFormat, tagged.header, tagged.rows, "R3");
ok(fromOld.archive && fromOld.archive.reason === "older log format" && fromOld.archive.name === "generation_log_before_R3.csv" && fromOld.archive.text === oldFormat,
    "old-format file → archived unchanged as generation_log_before_<run>.csv");
ok(fromOld.text.startsWith(tagged.header + "\n") && fromOld.text.split("\n").filter(Boolean).length === 3, "…and the new file starts with the new header");
const big = render.planGenerationLogAppend(second.text, tagged.header, tagged.rows, "R4", second.text.length + 10);
ok(big.archive && /^over/.test(big.archive.reason) && big.archive.name === "generation_log_R1_to_R2.csv", "too big → archived as generation_log_<first>_to_<last>.csv: " + (big.archive && big.archive.name));
ok(big.text.split("\n").filter(Boolean).length === 3, "…and the new file holds only the new run");

// history line
const result = { generated: [{ warnings: [] }, { warnings: ["WARNING x"] }], failed: [{}], logLines: base };
const hl = render.historyLine("R1", "2026-11-19T16:05:09.042Z", "generate", ["Aerowischer", "Ski, und Box"], result, 2);
ok(hl === "R1,2026-11-19T16:05:09.042Z,generate,Aerowischer | Ski; und Box,2,1,1,2", "history row: id, time, type, products, generated, failed, with warnings, rows: " + hl);

// end to end on the fake file system
(async () => {
    const root = "/out";
    files.set(root + "/generation_log.csv", oldFormat); // a log written by the previous plugin version
    const a = await render.recordGenerationRun(root, { generated: [{ warnings: [] }], failed: [], logLines: base }, "generate", ["Aerowischer"]);
    ok(a.archived === `generation_log_before_${a.runId}.csv` && files.get(`${root}/logs/${a.archived}`) === oldFormat && folders.has(root + "/logs"),
        "first run after the update: old log moved to logs/, not lost");
    const b = await render.recordGenerationRun(root, { generated: [{ warnings: ["W"] }], failed: [], logLines: base }, "regenerate", ["Aerowischer"]);
    const log = files.get(root + "/generation_log.csv").trim().split("\n");
    ok(!b.archived && log.length === 5 && log[0].endsWith(",run_id,run_type") && log[2].endsWith(`,${a.runId},generate`) && log[4].endsWith(`,${b.runId},regenerate`),
        "generation_log.csv: one header, rows of BOTH runs, each tagged");
    const hist = files.get(root + "/generation_history.csv").trim().split("\n");
    ok(hist.length === 3 && hist[0] === render.GENERATION_LOG.historyHeader && hist[1].startsWith(a.runId + ",") && /,regenerate,Aerowischer,1,0,1,2$/.test(hist[2]),
        "generation_history.csv: header + one row per run");
    console.log(f ? f + " FAILED" : "all passed");
})().catch((e) => { console.log("FAIL " + e.stack); console.log("1 FAILED"); });
