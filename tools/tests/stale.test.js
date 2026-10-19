// Offline regression test (Node, no InDesign). Run: node tools/tests/run.js
const PLUGIN_JS = require("path").resolve(__dirname, "../../plugin/js");
const Module=require("module"),fs=require("fs");const P=PLUGIN_JS;
const o=Module._load;Module._load=function(r){return r==="uxp"?{storage:{}}:r==="indesign"?{}:o.apply(this,arguments)};
const m=new Module(P+"/render.js");m.filename=P+"/render.js";m.paths=Module._nodeModulePaths(P);
m._compile(fs.readFileSync(P+"/render.js","utf8")+"\nmodule.exports.__t={staleSublineReplacement,OPTIONAL_SUBLINE_TOKEN};",P+"/render.js");
const {staleSublineReplacement:r}=m.exports.__t;let f=0;const ok=(c,msg)=>{console.log((c?"PASS ":"FAIL ")+msg);if(!c)f++};
ok(r("<<SERVICE SUBLINE>>","Audi Original Teile")==="Audi Original Teile","stale <<SERVICE SUBLINE>> + stored original → original restored");
ok(r("<<SERVICE SUBLINE>>","")==="","stale <<SERVICE SUBLINE>>, no original → token removed");
ok(r("<<WINTER SUBLINE>>","Winterzeit")==="Winterzeit"&&r("<<winter subline>>",null)==="","generic <<WINTER SUBLINE>> handled (any case)");
ok(r("Audi Original Teile","x")===null,"real subline text → kept (null)");
ok(r("<<DANIS + SERVICE HEADLINE +PRODUCT NAMING>>","x")===null&&r("<<MainImage>>","x")===null,"required placeholders are never treated as optional");
ok(r("<<SERVICE SUBLINE>>","<<SERVICE SUBLINE>>")==="","an original that is itself a token is not restored");
console.log(f?f+" FAILED":"all passed");
