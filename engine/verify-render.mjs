import assert from 'node:assert/strict';
import {readFile,writeFile} from 'node:fs/promises';
import {resolve} from 'node:path';
import {execFileSync} from 'node:child_process';
import {launchBrowser} from './browser.mjs';

const folder=resolve('.studio-data/verification/browser');
const project=JSON.parse(await readFile(resolve(folder,'scroll-project.json'),'utf8'));
const browser=await launchBrowser(), results=[];
const page=await browser.newPage({viewport:{width:1920,height:1080}});
try{
  await page.goto('http://127.0.0.1:8765/video/render.html');await page.waitForFunction(()=>window.renderReady);
  for(const time of [1,6.7,10]){
    const actual=resolve(folder,`scroll-${time}.png`);
    execFileSync('ffmpeg',['-loglevel','error','-y','-ss',String(time),'-i',resolve(folder,'japanese-scroll.mp4'),'-frames:v','1',actual]);
    const url='data:image/png;base64,'+(await readFile(actual)).toString('base64');
    const metrics=await page.evaluate(async({project,time,url})=>{
      window.drawFrame(project,time);
      const expected=document.createElement('canvas');expected.width=1920;expected.height=1080;
      const ec=expected.getContext('2d');ec.fillStyle='#243d55';ec.fillRect(0,0,1920,1080);ec.drawImage(document.querySelector('canvas'),0,0);
      const actual=document.createElement('canvas');actual.width=1920;actual.height=1080;
      const image=new Image();image.src=url;await image.decode();const ac=actual.getContext('2d');ac.drawImage(image,0,0);
      const a=ec.getImageData(0,0,1920,1080).data,b=ac.getImageData(0,0,1920,1080).data;
      let diff=0, intersection=0, union=0;
      for(let i=0;i<a.length;i+=4){diff+=Math.abs(a[i]-b[i])+Math.abs(a[i+1]-b[i+1])+Math.abs(a[i+2]-b[i+2]);const x=a[i]>200&&a[i+1]>200&&a[i+2]>200,y=b[i]>200&&b[i+1]>200&&b[i+2]>200;if(x&&y)intersection++;if(x||y)union++;}
      return {meanAbsoluteRgbError:diff/(1920*1080*3),brightGlyphIntersectionOverUnion:intersection/Math.max(1,union),brightPixels:union};
    },{project,time,url});
    assert.ok(metrics.meanAbsoluteRgbError<3,'preview/export colors and positions match');
    assert.ok(metrics.brightPixels>500&&metrics.brightGlyphIntersectionOverUnion>.9,'real glyph outlines/positions match');
    results.push({time,...metrics});console.log('PASS shared Japanese/English scroll render at '+time+'s '+JSON.stringify(metrics));
  }
  await writeFile(resolve(folder,'render-verification.json'),JSON.stringify(results,null,2));
}finally{await browser.close();}
