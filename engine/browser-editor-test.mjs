import assert from 'node:assert/strict';
import http from 'node:http';
import {createReadStream,existsSync} from 'node:fs';
import {readFile,mkdir,stat} from 'node:fs/promises';
import {resolve,extname,sep} from 'node:path';
import {launchBrowser} from './browser.mjs';
import {newProject} from '../video/core.js';

// Deliberately static: no Python engine, API, uploads or public tunnel.
const root=resolve('.'),prefix='/lyric-srt-studio/',output=resolve('.studio-data/verification/browser-editor');
await mkdir(output,{recursive:true});
let apiRequests=0,posts=0;const requests=[];
const types={'.html':'text/html','.js':'text/javascript','.css':'text/css','.ttf':'font/ttf','.md':'text/plain'};
const server=http.createServer(async(req,res)=>{
  const pathname=new URL(req.url,'http://localhost').pathname;
  requests.push(pathname);if(pathname.includes('/api/'))apiRequests++;if(req.method!=='GET'&&req.method!=='HEAD')posts++;
  const relative=pathname.startsWith(prefix)?decodeURIComponent(pathname.slice(prefix.length)):'';
  const path=resolve(root,relative);
  if(!relative||!['GET','HEAD'].includes(req.method)||!(relative==='srt-core.js'||path.startsWith(resolve('video')+sep))){res.writeHead(404);res.end();return;}
  try{const file=await stat(path);if(!file.isFile())throw new Error('not a file');res.writeHead(200,{'content-type':(types[extname(path)]||'application/octet-stream')+(extname(path)==='.ttf'?'':'; charset=utf-8'),'content-length':file.size});if(req.method==='HEAD')res.end();else createReadStream(path).pipe(res);}catch{res.writeHead(404);res.end();}
});
await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
const base=`http://127.0.0.1:${server.address().port}${prefix}`,browser=await launchBrowser();
const checks=[],errors=[];const check=(name,value)=>{assert.ok(value,name);checks.push(name);console.log('PASS '+name);};
const audioPath=resolve(process.env.STUDIO_EDIT_AUDIO||'.studio-data/verification/twinkle-short.wav');
const fixture=newProject('[Verse]\n日本語 Hello\n\n同じ歌詞\n同じ歌詞');fixture.duration=27;
fixture.lines.forEach((line,i)=>Object.assign(line,{start:1+i*5,end:3+i*5,auto:{candidateStart:1+i*5,candidateEnd:3+i*5,evidence:{matchedCharacters:3}},reasons:['検証用の時刻。同期精度の評価には使いません。']}));
fixture.assets.media={name:'PC reference',id:'old-server-id',url:'https://must-not-fetch.invalid/audio.wav',kind:'audio',duration:27};
const context=await browser.newContext({viewport:{width:390,height:844},isMobile:true,hasTouch:true});
const page=await context.newPage();page.on('pageerror',error=>errors.push(error.message));page.on('dialog',dialog=>dialog.accept());
let offOrigin=0;context.on('request',request=>{if(/^https?:/.test(request.url())&&!request.url().startsWith(base))offOrigin++;});
async function download(button){const pending=page.waitForEvent('download');await page.locator(button).click();const file=await pending;assert.equal(await file.failure(),null);return {name:file.suggestedFilename(),text:await readFile(await file.path(),'utf8')};}
try{
  await page.goto(base+'video/editor.html');await page.waitForFunction(()=>window.studio);
  check('static entry works under a GitHub Pages-style subdirectory',page.url().includes('/lyric-srt-studio/video/index.html?mode=browser'));
  check('browser mode hides unavailable automatic sync/MP4 and declares local processing',await page.evaluate(()=>studio.inspection().runtime==='browser'&&document.querySelector('#align').hidden&&document.querySelector('#export').hidden&&document.querySelector('.privacy').textContent.includes('外部へ送信しません')));
  await page.locator('#browser-project-file').setInputFiles({name:'pc-result.json',mimeType:'application/json',buffer:Buffer.from(JSON.stringify(fixture))});
  await page.waitForFunction(()=>studio.snapshot().lines.length===3);
  check('PC project imports canonical repeated lyrics and estimates, never saved remote URLs',await page.evaluate(()=>studio.snapshot().lines[1].text===studio.snapshot().lines[2].text&&!studio.snapshot().assets.media.url&&studio.snapshot().lines[0].auto.evidence.matchedCharacters===3));
  await page.locator('#media-file').setInputFiles(audioPath);
  await page.waitForFunction(()=>studio.snapshot().assets.media?.source==='browser-file'&&document.querySelector('#audio').readyState>=1);
  check('real WAV metadata loads through a local blob, not a server upload',await page.evaluate(()=>studio.snapshot().assets.media.url.startsWith('blob:')&&studio.snapshot().duration>20&&studio.snapshot().lines[0].start===1));
  await page.locator('#play').click();await page.waitForFunction(()=>studio.currentTime()>.1);await page.locator('#play').click();
  check('real audio plays and pauses without a processing PC',await page.evaluate(()=>studio.inspection().paused&&studio.currentTime()>.1));
  const imported=await page.evaluate(()=>studio.snapshot());
  await page.locator('#tab-editing').click();
  const row=page.locator(`[data-id="${imported.lines[0].id}"]`);
  await row.locator('[data-action="select"]').click();
  await page.waitForFunction(()=>Math.abs(studio.currentTime()-.5)<.05);
  await page.evaluate(()=>studio.seekTo(1.5));
  await row.locator('[data-action="shift"][data-delta=".1"]').click();
  check('whole-row shift preserves duration and paused playback position',await page.evaluate(()=>{const p=studio.snapshot();return p.lines[0].start===1.1&&p.lines[0].end===3.1&&Math.abs(studio.currentTime()-1.5)<.05;}));
  await page.locator('#fixed-undo').click();check('Undo restores imported timing',await page.evaluate(()=>studio.snapshot().lines[0].start===1));
  await page.locator('#fixed-redo').click();check('Redo restores adjustment',await page.evaluate(()=>studio.snapshot().lines[0].start===1.1));
  const selected=await page.evaluate(()=>studio.inspection().selected);
  await page.locator('#tab-production').click();await page.locator('#tab-editing').click();
  check('tab changes preserve media, selection, edits and history',await page.evaluate(id=>studio.inspection().selected===id&&studio.inspection().past>0&&studio.snapshot().assets.media.url.startsWith('blob:')&&studio.snapshot().lines[0].start===1.1,selected));
  await row.locator('[data-action="confirm"]').click();await page.locator('#filter-review').click();
  check('review filter excludes only the confirmed line',await page.locator('.lyric-row').count()===2);
  await page.locator('#filter-all').click();
  const srt=await download('#edit-srt');
  check('SRT download includes corrected confirmed cue and excludes unreviewed repeats',srt.name==='lyrics.srt'&&srt.text.includes('00:00:01,100 --> 00:00:03,100')&&srt.text.includes('日本語 Hello')&&!srt.text.includes('同じ歌詞'));
  const saved=await download('#edit-save-project'),json=JSON.parse(saved.text);
  check('project download keeps estimates/manual flags but no blob URL or media bytes',json.lines[0].manual.start&&json.lines[0].auto.candidateStart===1&&!json.assets.media.url&&!json.assets.media.id&&json.assets.media.reselect);
  await page.reload();await page.waitForFunction(()=>window.studio);
  check('reload restores work without resurrecting stale media URLs',await page.evaluate(()=>studio.snapshot().lines[0].start===1.1&&!studio.snapshot().assets.media.url&&studio.snapshot().assets.media.reselect));
  await page.locator('#browser-project-file').setInputFiles({name:'saved.json',mimeType:'application/json',buffer:Buffer.from(saved.text)});
  await page.locator('#media-file').setInputFiles(audioPath);await page.waitForFunction(()=>studio.snapshot().assets.media?.url?.startsWith('blob:'));
  check('saved project and reselected media retain review state and style',await page.evaluate(()=>studio.snapshot().lines[0].review===false&&studio.snapshot().style.fontId==='noto-sans'));
  await page.locator('#font-choice').selectOption('noto-serif');await page.waitForFunction(()=>studio.snapshot().style.fontId==='noto-serif');
  check('font change preserves timing without API requests',await page.evaluate(()=>studio.snapshot().lines[0].start===1.1));
  const fontSaved=JSON.parse((await download('#save-project')).text);check('selected font is saved in the existing project format',fontSaved.version===1&&fontSaved.style.fontId==='noto-serif');
  await page.locator('#tab-editing').click();await page.evaluate(()=>studio.seekTo(1.5));
  const popupPending=page.waitForEvent('popup');await page.locator('#edit-open-preview').click();const popup=await popupPending;
  await popup.waitForFunction(()=>document.querySelector('#popup-status').textContent.includes('リアルタイム'));
  check('detached preview uses parent media, never a second audio/video player',await popup.locator('audio,video').count()===0);
  await page.locator(`[data-id="${imported.lines[0].id}"] [data-action="shift"][data-delta=".1"]`).click();
  check('paused detached preview sees edited state immediately',await popup.evaluate(()=>opener.studioPreview.getState().project.lines[0].start===1.2));
  await page.locator('#fixed-undo').click();check('Undo reaches the detached preview',await popup.evaluate(()=>opener.studioPreview.getState().project.lines[0].start===1.1));
  await popup.close();await page.waitForFunction(()=>!studio.inspection().detached);
  check('closing detached preview restores embedded editing',await page.locator('#edit-canvas').isVisible());
  for(const [width,height] of [[320,740],[390,844],[768,1024],[1024,768],[1365,900]]){
    await page.setViewportSize({width,height});
    check(`no horizontal overflow and 44px fixed targets at ${width}`,await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth&&[...document.querySelectorAll('.floating button')].every(b=>b.getBoundingClientRect().height>=44)));
  }
  await page.setViewportSize({width:390,height:844});await page.screenshot({path:resolve(output,'editing-390.png'),fullPage:true});
  const actualFolder=resolve('.studio-data/user-check/yellow-tape-20261001');
  if(existsSync(resolve(actualFolder,'yellow-tape.candidate.lyricvideo.json'))&&existsSync(resolve(actualFolder,'source.wav'))){
    const actual=JSON.parse(await readFile(resolve(actualFolder,'yellow-tape.candidate.lyricvideo.json'),'utf8'));
    await page.locator('#tab-production').click();
    await page.locator('#browser-project-file').setInputFiles({name:'actual-song.json',mimeType:'application/json',buffer:Buffer.from(JSON.stringify(actual))});
    await page.waitForFunction(n=>studio.snapshot().lines.length===n,actual.lines.length);
    check('existing actual-song JSON retains all canonical rows and acoustic evidence',await page.evaluate(expected=>studio.snapshot().lines.every((line,i)=>line.text===expected[i].text&&JSON.stringify(line.auto)===JSON.stringify(expected[i].auto)),actual.lines));
    await page.locator('#media-file').setInputFiles(resolve(actualFolder,'source.wav'));
    await page.waitForFunction(()=>document.querySelector('#audio').readyState>=1&&studio.snapshot().duration>100);
    check('actual-song WAV opens locally without changing imported timings',await page.evaluate(expected=>studio.snapshot().lines.every((line,i)=>line.start===expected[i].start&&line.end===expected[i].end),actual.lines));
  }
  check('browser editor never calls API, posts files or contacts remote asset URLs',apiRequests===0&&posts===0&&offOrigin===0);
  check('no uncaught browser errors',errors.length===0);
  console.log(JSON.stringify({checks:checks.length,apiRequests,posts,offOrigin,realAudio:true,newAlignment:false,physicalIOS:false}));
}finally{await context.close();await browser.close();await new Promise(resolve=>server.close(resolve));}
