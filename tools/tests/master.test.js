// Offline regression test (Node, no InDesign). Run: node tools/tests/run.js
const PLUGIN_JS = require("path").resolve(__dirname, "../../plugin/js");
const Module=require("module");const o=Module._load;Module._load=function(r){return r==="uxp"?{storage:{}}:o.apply(this,arguments)};
const ext=require(PLUGIN_JS+"/imageextension.js");
let fails=0;const ok=(c,m)=>{console.log((c?"PASS ":"FAIL ")+m);if(!c)fails++};
const SRC="/Pictures/aero.jpeg";
function page(frame, graphic, srcPath, w, h){
  const d=ext.calculateRequiredExpansion(frame,graphic);
  const px=ext.convertExpansionToSourcePixels(d.missing,graphic,w,h);
  const plan=ext.createExtensionPlan({sourcePath:srcPath,sourceWidth:w,sourceHeight:h,format:"jpeg",missingLayout:d.missing,graphicBounds:graphic,expansionPixels:px.expansionPixels});
  return {plan,graphicBounds:graphic,missing:d.missing,frame};
}
// Aerowischer real geometry (from the InDesign test)
const pages=[
 page([0,0,1200,1200],[0,0,874.199,1200],SRC,2965,2160),
 page([0,0,1200,1200],[0,0,874.199,1200],SRC,2965,2160),
 page([0.5,0.5,604.5,799.5],[0.5,0.5,582.571,799.5],SRC,2965,2160),
 page([-2,0.5,602,799.5],[-2,0.5,580.071,799.5],SRC,2965,2160),
 page([0,0,250,250],[0,0,182.125,250],SRC,2965,2160)];
console.log("page plans:",pages.map(p=>p.plan.id+" b+"+p.plan.expansionPixels.bottom).join(", "));
let g=ext.groupIntoMasterPlans(pages.map((p,i)=>Object.assign({ref:i},p)));
ok(g.length===1,"Aerowischer: 5 pages → 1 master ("+g[0].master.id+", bottom +"+g[0].master.expansionPixels.bottom+" px, Firefly "+g[0].master.working.size.width+"x"+g[0].master.working.size.height+", "+g[0].master.working.pxPerPt+" px/pt min)");
const M=g[0].master;
// every page's required strip is inside the master canvas
for(const p of pages){const c=ext.computeExtensionCanvasBounds(p.graphicBounds,M.working);
  ok(c[2]>=p.frame[2]-1e-6&&c[0]<=p.frame[0]+1e-6&&c[1]<=p.frame[1]+1e-6&&c[3]>=p.frame[3]-1e-6,`page frame [${p.frame}] inside master canvas [${c.map(v=>v.toFixed(1))}]`)}
// different source → split
const other=page([0,0,600,800],[0,0,554,800],"/Pictures/other.jpeg",3118,2160);
g=ext.groupIntoMasterPlans(pages.concat([other]).map((p,i)=>Object.assign({ref:i},p)));
ok(g.length===2,"different source image → 2 masters");
// combined over the 50% limit → split (left 30% on one page, right 30% on another)
const L=page([0,0,1000,1300],[0,300,1000,1300],"/s.jpg",1000,1000), R=page([0,0,1000,1300],[0,0,1000,1000],"/s.jpg",1000,1000);
ok(L.plan.ratio.max<=0.5&&R.plan.ratio.max<=0.5,"each page alone eligible (30%)");
g=ext.groupIntoMasterPlans([L,R].map((p,i)=>Object.assign({ref:i},p)));
ok(g.length===2,"left 30% + right 30% = 60% combined → split into 2 masters");
console.log(fails?fails+" FAILED":"all passed");
