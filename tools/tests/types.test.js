// Offline regression test (Node, no InDesign). Run: node tools/tests/run.js
const PLUGIN_JS = require("path").resolve(__dirname, "../../plugin/js");
const Module=require("module"),fs=require("fs");const P=PLUGIN_JS;
const o=Module._load;Module._load=function(r){return r==="uxp"?{storage:{}}:r==="indesign"?{}:o.apply(this,arguments)};
const tt=require(P+"/templatetype.js");
const m=new Module(P+"/render.js");m.filename=P+"/render.js";m.paths=Module._nodeModulePaths(P);
m._compile(fs.readFileSync(P+"/render.js","utf8")+"\nmodule.exports.__t={planPages,buildOutputFileName,buildInddFileName,typeFolder,sublineFor,outputFolderFor};",P+"/render.js");
const R=m.exports.__t;let f=0;const ok=(c,msg)=>{console.log((c?"PASS ":"FAIL ")+msg);if(!c)f++};
ok(tt.detectTemplateType("DANIS_Template_DataMerge.indd")==="danis"&&tt.detectTemplateType("/x/SERVICE_Template 2_DataMerge_5.indd")==="service","known types unchanged");
let th="";try{tt.detectTemplateType("DANIS_SERVICE.indd")}catch(e){th=e.message}ok(/both/.test(th),"DANIS+SERVICE still ambiguous → error");
ok(tt.detectTemplateType("WINTER_Template 3.indd")==="WINTER"&&tt.detectTemplateType("WINTER_Template 3_DataMerge.indd")==="WINTER"&&tt.detectTemplateType("WINTER_Template 3_DataMerge_2.indd")==="WINTER","generic type stable across Prepare copies: WINTER");
ok(tt.detectTemplateType("Kampagne-Fruehling Vorlage.indd")==="Kampagne-Fruehling","generic: first word kept with hyphen");
ok(tt.detectTemplateType("___.indd")==="Template","no usable word → 'Template', never fails");
const rec={headline:"Aerowischer",year:"2026",danis_subline:"D",service_subline:"S",columns:{"DANIS SUBLINE":"D","SERVICE SUBLINE":"S","WINTER SUBLINE":"Winterreifen-Check"}};
ok(R.buildOutputFileName(rec,{subType:"WINTER",size:"400x500",position:"up"})==="WINTER_2026_Aerowischer_400x500_up.jpg","generic JPG prefix = type: "+R.buildOutputFileName(rec,{subType:"WINTER",size:"400x500",position:"up"}));
ok(R.buildInddFileName(rec,"WINTER")==="WINTER_2026_Aerowischer.indd","generic INDD name");
ok(R.outputFolderFor("/root","WINTER")==="/root/output/WINTER","generic output folder output/WINTER/<WxH>");
ok(R.buildOutputFileName(rec,{subType:"service",size:"250x250",position:"thumbnail"})==="Service_Herbst_2026_Aerowischer_250x250_thumbnail.jpg"&&R.typeFolder("danis")==="DANIS","known prefixes/folders unchanged");
ok(R.sublineFor(rec,"danis")==="D"&&R.sublineFor(rec,"service")==="S","known sublines unchanged");
ok(R.sublineFor(rec,"WINTER")==="Winterreifen-Check","generic subline from 'WINTER SUBLINE' column");
ok(R.sublineFor({columns:{SUBLINE:"x"}},"SPRING")==="x"&&R.sublineFor({columns:{}},"SPRING")===null,"generic: 'SUBLINE' fallback; none → null (template text kept)");
class TextFrame{constructor(n,b){this.name=n;this.geometricBounds=b;this.itemLayer={name:"text"}}}
class Rectangle{constructor(n,b){this.name=n;this.geometricBounds=b;this.itemLayer={name:"image"}}}
const pg=(w,h)=>({bounds:[0,0,h,w],name:"1",allPageItems:[new Rectangle("<<MainImage>>",[0,0,h,w]),new TextFrame("<<Headline>>",[20,20,120,w-20])]});
const p=R.planPages({pages:{length:2,item:i=>[pg(1200,1200),pg(250,250)][i]}},"WINTER");
ok(!p.problems.length&&p.pages.length===2&&p.pages[1].layout.position==="up","generic type: same discovery; 250x250 is plain 'up' (thumbnail name is a Service override only)");
ok(p.notes.length===2&&p.notes.every(n=>/generic geometry-based placement/.test(n)),"generic type → generic geometry placement for every page");
console.log(f?f+" FAILED":"all passed");
