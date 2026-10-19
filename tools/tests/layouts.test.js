// Offline regression test (Node, no InDesign). Run: node tools/tests/run.js
const PLUGIN_JS = require("path").resolve(__dirname, "../../plugin/js");
const Module=require("module"),fs=require("fs"),path=require("path");
const P=PLUGIN_JS;
const o=Module._load;Module._load=function(r){return r==="uxp"?{storage:{}}:r==="indesign"?{}:o.apply(this,arguments)};
const m=new Module(P+"/render.js");m.filename=P+"/render.js";m.paths=Module._nodeModulePaths(P);
m._compile(fs.readFileSync(P+"/render.js","utf8")+"\nmodule.exports.__t={planPages,describePage,describeTemplateLayouts,buildOutputFileName};",P+"/render.js");
const {planPages,describeTemplateLayouts,buildOutputFileName}=m.exports.__t;
let f=0;const ok=(c,msg)=>{console.log((c?"PASS ":"FAIL ")+msg);if(!c)f++};
class TextFrame{constructor(n,b){this.name=n;this.geometricBounds=b;this.itemLayer={name:"text"}}}
class Rectangle{constructor(n,b){this.name=n;this.geometricBounds=b;this.itemLayer={name:"image"}}}
const pg=(w,h,items,name)=>({bounds:[0,0,h,w],name:name||"1",label:"",allPageItems:items});
const std=(w,h,top=true)=>[new Rectangle("<<MainImage>>",[0,0,h,w]),new TextFrame("<<Headline>>",top?[20,20,120,w-20]:[h-120,20,h-20,w-20])];
const doc=(pages)=>({pages:{length:pages.length,item:i=>pages[i]}});
let p=planPages(doc([pg(1200,1200,std(1200,1200))]),"danis");
ok(!p.problems.length&&p.pages.length===1,"DANIS with only one 1200x1200 page → valid, 1 layout: "+describeTemplateLayouts(p));
p=planPages(doc([pg(1200,1200,std(1200,1200)),pg(800,600,std(800,600,false)),pg(400,500,std(400,500))]),"danis");
ok(!p.problems.length&&p.pages.length===3,"DANIS 1200x1200 + 800x600 + 400x500 → 3 layouts: "+describeTemplateLayouts(p));
ok(p.notes.some(n=>/new layout 800x600/.test(n))&&p.notes.some(n=>/400x500/.test(n)),"new sizes → info notes only: "+p.notes.join(" | "));
p=planPages(doc([pg(800,600,std(800,600)),pg(250,250,std(250,250))]),"service");
ok(!p.problems.length&&p.pages.length===2&&p.pages[1].layout.position==="thumbnail","Service with only 2 layouts → valid; 250x250 keeps 'thumbnail'");
p=planPages(doc([pg(1200,1200,std(1200,1200,false)),pg(1200,1200,std(1200,1200,true))]),"danis");
ok(!p.problems.length&&p.pages.map(x=>x.layout.position).join()==="bottom,up","different page order → valid (bottom, up)");
p=planPages(doc([pg(1200,1200,std(1200,1200).concat([new TextFrame("<<Footer>>",[1100,0,1200,1200])]))]),"danis");
ok(!p.problems.length&&p.pages[0].layout.position==="footer","page with <<Footer>> → footer variant");
p=planPages(doc([pg(1200,1200,std(1200,1200)),pg(1200,1200,[new TextFrame("notes",[0,0,10,10])])]),"danis");
ok(!p.problems.length&&p.pages.length===1&&p.skipped.length===1,"page without placeholders → skipped (info), not an error");
// errors
p=planPages(doc([pg(1200,1200,std(1200,1200).concat([new Rectangle("<<MainImage>>",[0,0,10,10])]))]),"danis");
ok(p.problems.some(x=>/2 <<MainImage>> frames — ambiguous/.test(x)),"two MainImage frames → error: "+p.problems[0]);
p=planPages(doc([pg(1200,1200,[new Rectangle("<<MainImage>>",[0,0,1200,1200])])]),"danis");
ok(p.problems.some(x=>/no <<Headline>>/.test(x)),"image but no headline → error");
p=planPages(doc([pg(1200,1200,[new TextFrame("<<Headline>>",[0,0,100,100])])]),"danis");
ok(p.problems.some(x=>/no <<MainImage>>/.test(x)),"headline but no image frame → error");
p=planPages(doc([pg(1200,1200,[new TextFrame("<<MainImage>>",[0,0,100,100]),new TextFrame("<<Headline>>",[0,0,100,100])])]),"danis");
ok(p.problems.some(x=>/is a text frame/.test(x)),"MainImage that's a text frame → error");
p=planPages(doc([pg(1200,1200,[]) ]),"danis");
ok(p.problems.some(x=>/no generatable page/.test(x)),"no generatable pages at all → error");
p=planPages(doc([pg(1200,1200,std(1200,1200)),pg(1200,1200,std(1200,1200))]),"danis");
ok(!p.problems.length&&p.notes.some(n=>/-2 suffix/.test(n)),"duplicate 1200x1200 up → valid, info about -2 suffix");
ok(buildOutputFileName({headline:"Aerowischer",year:"2026"},{subType:"danis",size:"400x500",position:"up"})==="DANIS_Herbst_2026_Aerowischer_400x500_up.jpg","new size JPG name from geometry");
console.log(f?f+" FAILED":"all passed");
