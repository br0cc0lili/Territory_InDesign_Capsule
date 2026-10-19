// Offline regression test (Node, no InDesign). Run: node tools/tests/run.js
const PLUGIN_JS = require("path").resolve(__dirname, "../../plugin/js");
const Module=require("module");const o=Module._load;Module._load=function(r){return r==="uxp"?{storage:{}}:o.apply(this,arguments)};
const ext=require(PLUGIN_JS+"/imageextension.js");
let fails=0;const ok=(c,m)=>{console.log((c?"PASS ":"FAIL ")+m);if(!c)fails++};
let nextId=100;
function coll(arr){return{get length(){return arr.length},item:i=>arr[i]}}
function mkLayer(name){return{name,visible:true,locked:false,isValid:true}}
const layers=[mkLayer("Text"),mkLayer("Image"),mkLayer("Shadow")];
const doc={layers:{get length(){return layers.length},item:i=>layers[i],
  itemByName:n=>layers.find(l=>l.name===n)||{isValid:false,name:undefined},
  add:p=>{const l=mkLayer(p.name);l.move=(loc,ref)=>{layers.splice(layers.indexOf(l),1);layers.splice(layers.indexOf(ref),0,l)};layers.unshift(l);return l}},
  swatches:{itemByName:n=>({name:n})}};
function mkGraphic(b,file){return{geometricBounds:b,absoluteRotationAngle:0,absoluteShearAngle:0,absoluteFlip:"NONE",itemLink:{filePath:file,status:"NORMAL"}}}
const pageItems=[];
const original=mkGraphic([0,0,554.2,800],"/src.jpg");
const frame={id:7,name:"<<MainImage>>",geometricBounds:[0,0,600,800],itemLayer:layers[1],allGraphics:coll([original]),absoluteRotationAngle:0,absoluteShearAngle:0,labels:{},extractLabel(k){return this.labels[k]||""}};
pageItems.push(frame);
const artwork={id:8,name:"user art",labels:{},extractLabel(k){return this.labels[k]||""}}; // user item, never touched
const page={get allPageItems(){return coll(pageItems)},rectangles:{add:p=>{const r=Object.assign({id:nextId++,labels:{},visible:true,
  insertLabel(k,v){this.labels[k]=v},extractLabel(k){return this.labels[k]||""},
  remove(){pageItems.splice(pageItems.indexOf(r),1)},frameFittingOptions:{},
  place(f){this.g=mkGraphic(this.geometricBounds.slice(),f);this.allGraphics=coll([this.g])}},p);pageItems.push(r);return r}}};
pageItems.push(artwork);
const plan={working:{source:{width:2688,height:1862},size:{width:2688,height:2017},inset:{top:0,right:0,bottom:155,left:0}}};
const meta={planId:"EXT_7172af30",generationVersion:1,generatedAssetPath:"/out/generated_assets/image_extensions/Service_Herbst_2026_Aerowischer_800x600_bottom_extended/Service_Herbst_2026_Aerowischer_800x600_bottom_extended_v001.jpg",
  workingSource:plan.working.source,target:plan.working.size,inset:plan.working.inset};
const record={missing:{top:0,right:0,bottom:45.8,left:0},snapshot:{graphicBounds:[0,0,554.2,800]}};
const id={LocationOptions:{BEFORE:"before"}};

ok(ext.checkExtendedCoverage(page,frame).state==="underfilled","before: underfilled");
const res=ext.applyExtensionToPage(doc,page,frame,record,meta,false,id);
const L=layers.map(l=>l.name).join(" > ");
ok(L==="Text > extendImage > Image > Shadow","extendImage directly above Image: "+L);
const ours=ext.extensionItemsOnPage(page,7);
ok(ours.length===1&&ours[0].item.name==="<<ImageExtension_bottom>>"&&ours[0].item.itemLayer.name==="extendImage","one <<ImageExtension_bottom>> frame on extendImage");
ok(original.geometricBounds.join()==="0,0,554.2,800"&&original.itemLink.filePath==="/src.jpg","original graphic untouched (bounds + link)");
ok(ours[0].item.g.itemLink.filePath===meta.generatedAssetPath,"strip shows the full expanded asset");
ok(ours[0].item.geometricBounds[0]<554.2&&ours[0].item.geometricBounds[2]===600,"strip clips to the bottom gap (+1pt seam overlap)");
let c=ext.checkExtendedCoverage(page,frame);
ok(c.state==="extended"&&c.extension.version===1,"after: extended (v1)");
layers.find(l=>l.name==="extendImage").visible=false;
ok(ext.checkExtendedCoverage(page,frame).state==="extension_hidden","layer hidden → extension_hidden");
ok(ext.setExtendLayerVisible(doc,true)&&ext.checkExtendedCoverage(page,frame).state==="extended","Show → extended again");
// re-extend: v2 replaces only our item; layer reused; user art untouched
ext.applyExtensionToPage(doc,page,frame,record,Object.assign({},meta,{generationVersion:2,generatedAssetPath:meta.generatedAssetPath.replace(/v001/g,"v002")}),false,id);
const ours2=ext.extensionItemsOnPage(page,7);
ok(ours2.length===1&&JSON.parse(ours2[0].item.labels["posterBatch.imageExtension"]).version===2,"re-extend: still one strip, now v2");
ok(layers.filter(l=>l.name==="extendImage").length===1&&pageItems.includes(artwork),"layer reused once; unrelated artwork kept");
// original moved by hand → misaligned
original.geometricBounds=[0,0,553,800];
ok(ext.checkExtendedCoverage(page,frame).state==="misaligned","original moved → misaligned (Review)");
let threw="";try{ext.applyExtensionToPage(doc,page,frame,record,meta,false,id)}catch(e){threw=e.message}
ok(/moved/.test(threw),"apply refuses when geometry changed since analysis");
console.log(fails?fails+" FAILED":"all passed");
