// Offline regression test (Node, no InDesign). Run: node tools/tests/run.js
const PLUGIN_JS = require("path").resolve(__dirname, "../../plugin/js");
const pl=require(PLUGIN_JS+"/placement.js");
let f=0;const ok=(c,m)=>{console.log((c?"PASS ":"FAIL ")+m);if(!c)f++};
const src={width:2965,height:2160}; // landscape 1.37
const r=(l,fr)=>pl.resolvePlacementPolicy(l,fr,src);
// known policies unchanged
let p=r({subType:"service",size:"800x600",position:"up"},[0,0,600,800]);
ok(p.known&&p.id==="service/800x600"&&p.placementMode==="extend"&&p.anchor.vertical==="top","known service 800x600 → configured extend/top");
p=r({subType:"service",size:"1080x1920",position:"up"},[0,0,1920,1080]);
ok(p.known&&p.placementMode==="fill","known service 1080x1920 → configured fill");
p=r({subType:"danis",size:"1200x1200",position:"footer"},[0,0,1200,1200]);
ok(p.known&&p.id==="danis/1200x1200","known danis 1200x1200 → configured");
// unknown layouts → geometry
p=r({subType:"service",size:"1000x1000",position:"up"},[0,0,1000,1000]);
ok(!p.known&&p.id==="fallback/geometry"&&p.placementMode==="extend"&&p.anchor.vertical==="top"&&p.gap.axis==="vertical","unknown square → extend, vertical gap "+p.gap.ratio+" → anchor top");
p=r({subType:"service",size:"1080x1350",position:"up"},[0,0,1350,1080]);
ok(p.placementMode==="fill","unknown 4:5 portrait → gap "+p.gap.ratio+" > 0.5 → fill");
p=r({subType:"danis",size:"1600x900",position:"up"},[0,0,900,1600]);
ok(p.placementMode==="extend"&&p.anchor.vertical==="center"&&p.gap.axis==="horizontal","unknown 16:9 → horizontal gap "+p.gap.ratio+" → extend, anchor center/center");
p=r({subType:"newtype",size:"800x600",position:"up"},[0,0,600,800]);
ok(!p.known&&p.placementMode==="extend","unknown template type → geometry fallback");
p=r({subType:"service",size:"2400x600",position:"up"},[0,0,600,2400]);
ok(p.placementMode==="fill","unknown banner 4:1 → gap "+p.gap.ratio+" → fill");
console.log(f?f+" FAILED":"all passed");
