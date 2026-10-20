import assert from 'node:assert/strict';
import {readFile,writeFile,mkdir} from 'node:fs/promises';
import {resolve} from 'node:path';
import {launchBrowser} from './browser.mjs';
import {newProject,applyAlignment,confirmLine} from '../video/core.js';

const base='http://127.0.0.1:8765', folder=resolve('.studio-data/verification/browser');
await mkdir(folder,{recursive:true});
const checks=[];
const check=(name,value)=>{assert.ok(value,name);checks.push(name);console.log('PASS '+name);};
const pause=ms=>new Promise(r=>setTimeout(r,ms));
async function api(path,body){const r=await fetch(base+path,body?{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body)}:{});const j=await r.json();if(!r.ok)throw new Error(j.detail);return j;}
async function upload(name){const form=new FormData();form.append('file',new Blob([await readFile(resolve('.studio-data/verification',name))]),name);const r=await fetch(base+'/api/media',{method:'POST',body:form});assert.ok(r.ok);return r.json();}
async function submit(kind,body){
  // Another full-song verification may still own the single worker.
  for(let attempt=0;attempt<900;attempt++){
    const r=await fetch(base+'/api/jobs/'+kind,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body)});
    if(r.status===409){await pause(1000);continue;}
    const j=await r.json();assert.ok(r.ok,JSON.stringify(j));return j.id;
  }throw new Error('worker wait timed out');
}
async function complete(id){for(let attempt=0;attempt<900;attempt++){const j=await api('/api/jobs/'+id);if(j.status==='complete')return j;if(j.status==='failed')throw new Error(j.message);await pause(500);}throw new Error('job timed out');}
const browser=await launchBrowser();
const page=await browser.newPage({viewport:{width:390,height:844}});
const errors=[];page.on('pageerror',e=>errors.push(e.message));
try {
  await page.goto(base+'/video/');await page.waitForFunction(()=>window.studio);
  for(const name of ['twinkle-short.wav','test.mp3','test.m4a','test-mv.mp4']){
    await page.locator('#media-file').setInputFiles(resolve('.studio-data/verification',name));
    await page.waitForFunction(name=>window.studio.snapshot().assets.media?.name===name,name);
    await page.waitForFunction(()=>{const p=window.studio.snapshot();return Number.isFinite(document.querySelector(p.assets.media.kind==='video'?'#video':'#audio').duration);});
    await page.locator('#play').click();
    await page.waitForFunction(()=>window.studio.currentTime()>.05,{},{timeout:15000});
    await page.locator('#play').click();
    check(name+' uploads and plays',await page.evaluate(()=>window.studio.currentTime()>0));
  }
  await page.locator('#media-file').setInputFiles(resolve('.studio-data/verification/silent-mv.mp4'));
  await page.waitForFunction(()=>window.studio.snapshot().assets.media?.name==='silent-mv.mp4');
  check('silent MV explicitly requests separate audio',await page.locator('#extra-audio-field').isVisible());
  await page.locator('#audio-file').setInputFiles(resolve('.studio-data/verification/twinkle-short.wav'));
  await page.waitForFunction(()=>window.studio.snapshot().assets.audio?.id);
  await page.evaluate(()=>window.studio.seekTo(3.5));
  await page.locator('#play').click();await page.waitForTimeout(300);await page.locator('#play').click();
  check('silent MV and separate audio use video time',await page.evaluate(()=>Math.abs(document.querySelector('#video').currentTime-document.querySelector('#audio').currentTime)<.15));
  check('separate audio mutes original video',await page.evaluate(()=>document.querySelector('#video').muted));
  await page.screenshot({path:resolve(folder,'mobile-top.png')});
  const media=await upload('test-mv.mp4');
  const text=(JSON.parse(await readFile('.studio-data/verification/full-request.json','utf8'))).lines.slice(0,2);
  const alignId=await submit('align',{mediaId:media.id,method:'asr',lines:text});
  const alignment=(await complete(alignId)).result;
  check('MV audio actually reaches alignment worker',alignment.lines.every(l=>l.start!==null&&l.end>l.start));
  let p=applyAlignment(newProject(text.map(l=>l.text).join('\n')),alignment);
  p.duration=media.duration;p.assets.media=media;
  for(const row of p.lines)p=confirmLine(p,row.id);
  const cancelId=await submit('export',{mediaId:media.id,project:p});
  for(let i=0;i<180;i++){const j=await api('/api/jobs/'+cancelId);if(j.stage==='render')break;await pause(500);}
  await api('/api/jobs/'+cancelId+'/cancel',{});
  check('active export is cancelled', (await api('/api/jobs/'+cancelId)).status==='cancelled');
  await pause(1200);
  const exportId=await submit('export',{mediaId:media.id,project:p});
  const result=await complete(exportId);
  const r=await fetch(base+result.result.url);await writeFile(resolve(folder,'mv-subtitles.mp4'),Buffer.from(await r.arrayBuffer()));
  check('MV retries after cancellation and exports audio/video',result.result.hasAudio&&result.result.hasVideo&&result.result.width===1920&&result.result.height===1080);
  check('MV length is retained',Math.abs(result.result.duration-media.duration)<.04);
  const speech=await upload('japanese-speech.wav');
  const jpInput=JSON.parse(await readFile('.studio-data/verification/japanese-request.json','utf8'));
  const jpResult=JSON.parse(await readFile('.studio-data/verification/japanese-alignment.json','utf8'));
  let jp=applyAlignment(newProject(jpInput.lines.map(l=>l.text).join('\n')),
    {...jpResult,lines:jpResult.lines.map((l,i)=>({...l,id:'line-'+i}))});
  jp.duration=speech.duration;jp.assets.media=speech;jp.style.mode='scroll';jp.style.y=.5;
  check('Japanese/English speech returns four real intervals',jp.lines.length===4&&jp.lines.every(l=>l.start!==null));
  for(const row of jp.lines)jp=confirmLine(jp,row.id);
  const bg=await upload('background.png');jp.assets.background=bg;
  await writeFile(resolve(folder,'scroll-project.json'),JSON.stringify(jp,null,2));
  const scrollId=await submit('export',{mediaId:speech.id,backgroundId:bg.id,project:jp});
  const scroll=await complete(scrollId);
  const sr=await fetch(base+scroll.result.url);await writeFile(resolve(folder,'japanese-scroll.mp4'),Buffer.from(await sr.arrayBuffer()));
  check('Japanese/English scrolling lyrics export to real MP4',scroll.result.hasAudio&&scroll.result.hasVideo&&Math.abs(scroll.result.duration-speech.duration)<.04);
  await page.locator('#project-file').setInputFiles(resolve(folder,'scroll-project.json'));
  await page.waitForFunction(()=>window.studio.snapshot().style.mode==='scroll');
  await page.locator('#media-file').setInputFiles(resolve('.studio-data/verification/japanese-speech.wav'));
  await page.waitForFunction(()=>window.studio.snapshot().assets.media?.id);
  await page.locator('#background-file').setInputFiles(resolve('.studio-data/verification/background.png'));
  await page.waitForFunction(()=>window.studio.snapshot().assets.background?.id);
  await page.waitForFunction(()=>Number.isFinite(document.querySelector('#audio').duration));
  await page.evaluate(()=>window.studio.seekTo(6.7));
  await page.locator('#stage').screenshot({path:resolve(folder,'scroll-preview.png')});
  check('scroll style restores without reanalysis',await page.evaluate(()=>window.studio.snapshot().alignment.engine.includes('Qwen')));
  check('integration UI has no uncaught errors',errors.length===0);
  await writeFile(resolve(folder,'integration-results.json'),JSON.stringify({checks,errors,mv:result,scroll},null,2));
  console.log(`COMPLETE ${checks.length} integration checks`);
} finally {await browser.close();}
