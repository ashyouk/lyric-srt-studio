import assert from "node:assert/strict";
import {readFile,writeFile,mkdir} from "node:fs/promises";
import {resolve} from "node:path";
import {execFileSync} from "node:child_process";
import {launchBrowser} from "./browser.mjs";
import {FONTS} from "../video/font-catalog.js";
const base=process.env.STUDIO_BASE_URL||"http://127.0.0.1:8765",folder=resolve(".studio-data/verification/fonts");await mkdir(folder,{recursive:true});
const project=JSON.parse(await readFile(".studio-data/verification/browser/scroll-project.json","utf8"));
async function api(path,body){const r=await fetch(base+path,body?{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify(body)}:{});const j=await r.json();if(!r.ok)throw new Error(j.detail);return j;}
async function upload(file){const form=new FormData();form.append("file",new Blob([await readFile(file)]),file.split(/[\\/]/).at(-1));const r=await fetch(base+"/api/media",{method:"POST",body:form});assert.ok(r.ok);return r.json();}
const speech=await upload(resolve(".studio-data/verification/japanese-speech.wav")),background=await upload(resolve(".studio-data/verification/background.png"));project.assets.media=speech;project.assets.background=background;project.style.width=.4;project.style.fontSize=85;
const browser=await launchBrowser(),page=await browser.newPage({viewport:{width:1920,height:1080}}),results=[];
try{
  await page.goto(base+"/video/render.html");await page.waitForFunction(()=>window.renderReady);
  for(const font of FONTS){
    project.style.fontId=font.id;let submitted;
    for(let i=0;i<900;i++){const r=await fetch(base+"/api/jobs/export",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({mediaId:speech.id,backgroundId:background.id,project})});if(r.status===409){await new Promise(r=>setTimeout(r,1000));continue;}submitted=await r.json();assert.ok(r.ok,JSON.stringify(submitted));break;}
    assert.ok(submitted);let job;
    for(let i=0;i<900;i++){job=await api("/api/jobs/"+submitted.id);if(job.status==="failed")throw new Error(job.message);if(job.status==="complete")break;await new Promise(r=>setTimeout(r,500));}
    assert.equal(job.status,"complete");const mp4=resolve(folder,font.id+".mp4");await writeFile(mp4,Buffer.from(await (await fetch(base+job.result.url)).arrayBuffer()));
    const metrics=[];
    for(const time of [1,6.7,10]){
      const imagePath=resolve(folder,`${font.id}-${time}.png`);execFileSync("ffmpeg",["-loglevel","error","-y","-ss",String(time),"-i",mp4,"-frames:v","1",imagePath]);
      const url="data:image/png;base64,"+(await readFile(imagePath)).toString("base64");
      const m=await page.evaluate(async({project,time,url})=>{
        await window.prepareFrame(project);window.drawFrame(project,time);
        const expected=document.createElement("canvas"),actual=document.createElement("canvas");expected.width=actual.width=1920;expected.height=actual.height=1080;
        const ec=expected.getContext("2d"),ac=actual.getContext("2d");ec.fillStyle="#243d55";ec.fillRect(0,0,1920,1080);ec.drawImage(document.querySelector("canvas"),0,0);
        const image=new Image();image.src=url;await image.decode();ac.drawImage(image,0,0);
        const a=ec.getImageData(0,0,1920,1080).data,b=ac.getImageData(0,0,1920,1080).data;let intersection=0,union=0,error=0;
        for(let i=0;i<a.length;i+=4){error+=Math.abs(a[i]-b[i])+Math.abs(a[i+1]-b[i+1])+Math.abs(a[i+2]-b[i+2]);const x=a[i]>200&&a[i+1]>200&&a[i+2]>200,y=b[i]>200&&b[i+1]>200&&b[i+2]>200;if(x&&y)intersection++;if(x||y)union++;}
        return {iou:intersection/Math.max(1,union),brightPixels:union,meanRgbError:error/(1920*1080*3)};
      },{project,time,url});
      assert.ok(m.brightPixels>500&&m.iou>.9&&m.meanRgbError<4,`${font.id} @ ${time}: glyphs/layout match actual MP4`);metrics.push({time,...m});console.log("PASS "+font.id+" MP4 glyph/layout @ "+time+"s "+JSON.stringify(m));
    }
    const python=process.platform==="win32"?resolve(".venv/Scripts/python.exe"):resolve(".venv/bin/python");execFileSync(python,["engine/verify_output.py",mp4,resolve(".studio-data/verification/japanese-speech.wav")],{stdio:"inherit"});
    results.push({fontId:font.id,elapsedSeconds:job.elapsedSeconds,video:job.result,metrics});
  }
  await writeFile(resolve(folder,"results.json"),JSON.stringify(results,null,2));console.log("COMPLETE 3 font MP4 exports, 9 glyph checks, 9 audio drift checks");
}finally{await browser.close();}
