// Offline regression test (Node, no InDesign). Run: node tools/tests/run.js
const PLUGIN_JS = require("path").resolve(__dirname, "../../plugin/js");
const Module=require("module"),fs=require("fs");const P=PLUGIN_JS;
let written="";
const uxp={storage:{formats:{binary:"b"},types:{file:"f"},localFileSystem:{createEntryWithUrl:async()=>({write:async(d)=>{written=Buffer.from(d).toString("utf16le")}})}}};
const o=Module._load;Module._load=function(r){return r==="uxp"?uxp:r==="indesign"?{}:o.apply(this,arguments)};
let sheet;
global.XLSX={read:()=>({Sheets:{"AOZ+AOT":{}}}),utils:{sheet_to_json:()=>sheet}};
const load=(f,extra)=>{const m=new Module(P+"/"+f);m.filename=P+"/"+f;m.paths=Module._nodeModulePaths(P);m._compile(fs.readFileSync(P+"/"+f,"utf8")+(extra||""),P+"/"+f);return m.exports};
const matcher=load("matcher.js","\nmodule.exports.__r=readExcelRows;");
const dm=load("datamerge.js");
const render=load("render.js","\nmodule.exports.__s=sublineFor;");
let f=0;const ok=(c,m)=>{console.log((c?"PASS ":"FAIL ")+m);if(!c)f++};
const entry={name:"x.xlsx",nativePath:"/tmp/x.xlsx",read:async()=>new ArrayBuffer(1)};
(async()=>{
  // sheet with ONLY headline + year: no sublines, no picture name, no add-on
  sheet=[["DANIS + SERVICE HEADLINE +PRODUCT NAMING","YEAR"],["Aerowischer","2026"]];
  let rows=null,err="";try{rows=await matcher.__r(entry)}catch(e){err=e.message}
  ok(rows&&rows.length===1&&!err,"Excel without subline / picture / add-on columns → Match reads rows, no error "+err);
  ok(render.__s(rows[0],"danis")===null&&render.__s(rows[0],"service")===null&&render.__s(rows[0],"WINTER")===null,"missing subline columns → null = keep template subline (DANIS, SERVICE, generic)");
  let csv=null;err="";try{csv=await dm.excelToDataSource(entry,null)}catch(e){err=e.message}
  ok(csv&&!err&&/HEADLINE/.test(written)&&!/SUBLINE/.test(written),"Prepare CSV without optional columns → written, no error "+err);
  // only SUBLINE present (generic fallback) + WINTER SUBLINE
  sheet=[["DANIS + SERVICE HEADLINE +PRODUCT NAMING","SUBLINE","SERVICE SUBLINE"],["Aerowischer","gen","svc"]];
  rows=await matcher.__r(entry);
  ok(render.__s(rows[0],"WINTER")==="gen"&&render.__s(rows[0],"service")==="svc"&&render.__s(rows[0],"danis")===null,"present columns used; absent DANIS SUBLINE ignored");
  await dm.excelToDataSource(entry,null);
  ok(/SUBLINE/.test(written)&&/SERVICE SUBLINE/.test(written),"CSV carries the columns that exist");
  // headline missing entirely: falls back to column 0 (identity) — still reads
  sheet=[["NAME"],["Aerowischer"]];
  rows=await matcher.__r(entry);ok(rows.length===1&&rows[0].headline==="Aerowischer","no headline header → first column is the product identity");
  console.log(f?f+" FAILED":"all passed");
})();
