import assert from 'node:assert/strict';
import http from 'node:http';
import {createReadStream,existsSync} from 'node:fs';
import {readFile,mkdir,stat} from 'node:fs/promises';
import {resolve,extname,sep} from 'node:path';
import {execFileSync} from 'node:child_process';
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
const base=process.env.STUDIO_BROWSER_EDITOR_URL||`http://127.0.0.1:${server.address().port}${prefix}`,browser=await launchBrowser();
const checks=[],errors=[];const check=(name,value)=>{assert.ok(value,name);checks.push(name);console.log('PASS '+name);};
const audioPath=resolve(process.env.STUDIO_EDIT_AUDIO||'.studio-data/verification/twinkle-short.wav');
const pickerMp3=resolve(output,'picker-test.mp3'),pickerM4a=resolve(output,'picker-test.m4a');
execFileSync('ffmpeg',['-v','error','-y','-i',audioPath,'-t','3','-c:a','libmp3lame',pickerMp3]);
execFileSync('ffmpeg',['-v','error','-y','-i',audioPath,'-t','3','-c:a','aac',pickerM4a]);
const fixture=newProject('[Verse]\n日本語 Hello\n\n同じ歌詞\n同じ歌詞');fixture.duration=27;
fixture.lines.forEach((line,i)=>Object.assign(line,{start:1+i*5,end:3+i*5,auto:{candidateStart:1+i*5,candidateEnd:3+i*5,evidence:{matchedCharacters:3}},reasons:['検証用の時刻。同期精度の評価には使いません。']}));
fixture.assets.media={name:'PC reference',id:'old-server-id',url:'https://must-not-fetch.invalid/audio.wav',kind:'audio',duration:27};
const context=await browser.newContext({viewport:{width:390,height:844},isMobile:true,hasTouch:true});
const page=await context.newPage();page.on('pageerror',error=>errors.push(error.message));page.on('dialog',dialog=>dialog.accept());
let offOrigin=0;context.on('request',request=>{if(/^https?:/.test(request.url())&&!request.url().startsWith(base))offOrigin++;});
// An optional live static-host check is fail-closed: never send test media to an
// API or another origin even if the hosted code unexpectedly regresses.
if(process.env.STUDIO_BROWSER_EDITOR_URL)await context.route('**/*',route=>{
  const request=route.request(),url=request.url();
  if(!/^https?:/.test(url))return route.continue();
  if(new URL(url).pathname.includes('/api/')){apiRequests++;return route.abort();}
  if(!['GET','HEAD'].includes(request.method())){posts++;return route.abort();}
  if(!url.startsWith(base)){offOrigin++;return route.abort();}
  return route.continue();
});
async function download(button){const pending=page.waitForEvent('download');await page.locator(button).click();const file=await pending;assert.equal(await file.failure(),null);return {name:file.suggestedFilename(),text:await readFile(await file.path(),'utf8')};}
try{
  await page.goto(base+'video/editor.html');await page.waitForFunction(()=>window.studio);
  check('static entry works under a GitHub Pages-style subdirectory',page.url().includes('/lyric-srt-studio/video/index.html?mode=browser'));
  check('browser mode hides unavailable automatic sync/MP4 and declares local processing',await page.evaluate(()=>studio.inspection().runtime==='browser'&&document.querySelector('#align').hidden&&document.querySelector('#export').hidden&&document.querySelector('.privacy').textContent.includes('外部へ送信しません')));
  check('guides default OFF without hiding status messages',await page.evaluate(()=>document.querySelector('#guide-toggle').getAttribute('aria-pressed')==='false'&&getComputedStyle(document.querySelector('#engine-state')).display==='none'&&getComputedStyle(document.querySelector('#message')).display!=='none'));
  await page.locator('#guide-toggle').click();
  check('guide switch reveals supplementary copy',await page.evaluate(()=>document.querySelector('#guide-toggle').getAttribute('aria-pressed')==='true'&&getComputedStyle(document.querySelector('#engine-state')).display!=='none'));
  await page.reload();await page.waitForFunction(()=>window.studio);
  check('guide preference survives reload',await page.locator('#guide-toggle').getAttribute('aria-pressed')==='true');
  await page.locator('#guide-toggle').click();
  const initial=await page.evaluate(()=>JSON.stringify(studio.snapshot()));
  await page.locator('#editor-help-open').click();
  check('help dialog opens with illustrated instructions',await page.locator('#editor-help').isVisible()&&await page.locator('#editor-help .ui-icon').count()>3);
  await page.keyboard.press('Escape');
  await page.waitForFunction(()=>!document.querySelector('#editor-help').open&&document.activeElement.id==='editor-help-open');
  check('help closes and restores focus without changing project',await page.evaluate(expected=>!document.querySelector('#editor-help').open&&document.activeElement.id==='editor-help-open'&&JSON.stringify(studio.snapshot())===expected,initial));
  check('compact controls retain visible labels and accessible names',await page.evaluate(()=>['play','record-start','fixed-undo','save-project'].every(id=>{const b=document.getElementById(id);return b.querySelector('.ui-icon')&&b.querySelector('.control-label')?.textContent&&b.getAttribute('aria-label');})));
  await page.locator('#record-start').click();
  check('recording error remains visible with guides OFF',await page.evaluate(()=>document.querySelector('#message').classList.contains('error')&&document.querySelector('#message').textContent.length>0&&getComputedStyle(document.querySelector('#message')).display!=='none'));
  await page.evaluate(()=>window.scrollTo(0,0));await page.screenshot({path:resolve(output,'top-390.png')});
  await page.locator('#browser-project-file').setInputFiles({name:'pc-result.json',mimeType:'application/json',buffer:Buffer.from(JSON.stringify(fixture))});
  await page.waitForFunction(()=>studio.snapshot().lines.length===3);
  check('PC project imports canonical repeated lyrics and estimates, never saved remote URLs',await page.evaluate(()=>studio.snapshot().lines[1].text===studio.snapshot().lines[2].text&&!studio.snapshot().assets.media.url&&studio.snapshot().lines[0].auto.evidence.matchedCharacters===3));
  await page.locator('#media-file').setInputFiles(audioPath);
  await page.waitForFunction(()=>studio.snapshot().assets.media?.source==='browser-file'&&document.querySelector('#audio').readyState>=1);
  check('real WAV metadata loads through a local blob, not a server upload',await page.evaluate(()=>studio.snapshot().assets.media.url.startsWith('blob:')&&studio.snapshot().duration>20&&studio.snapshot().lines[0].start===1));
  check('WAV duration bypasses metadata preload and selection feedback is near the picker',await page.evaluate(()=>studio.snapshot().assets.media.durationSource==='wav-header'&&document.querySelector('#media-load-status').textContent.includes('選択しました')&&document.querySelector('#media-file').getAttribute('aria-busy')==='false'));
  for(const [name,mimeType,path] of [['ios-picker.MP3','',pickerMp3],['ios-picker.m4a','video/mp4',pickerM4a]]){
    await page.locator('#media-file').setInputFiles({name,mimeType,buffer:await readFile(path)});
    await page.waitForFunction(name=>studio.snapshot().assets.media?.name===name&&document.querySelector('#audio').readyState>=1,name);
    await page.locator('#play').click();await page.waitForFunction(()=>studio.currentTime()>.05);await page.locator('#play').click();
    check(`${name} with provider MIME opens and actually plays`,await page.evaluate(()=>studio.inspection().paused&&studio.currentTime()>.05));
  }
  const beforeBad=await page.evaluate(()=>JSON.stringify(studio.snapshot()));
  await page.locator('#media-file').setInputFiles({name:'broken.mp3',mimeType:'audio/mpeg',buffer:Buffer.from('not audio')});
  await page.waitForFunction(()=>document.querySelector('#media-load-status').classList.contains('error'));
  check('invalid audio reports beside picker without replacing current media or lyrics',await page.evaluate(expected=>JSON.stringify(studio.snapshot())===expected&&document.querySelector('#media-load-status').textContent.includes('broken.mp3'),beforeBad));
  await page.locator('#media-file').setInputFiles({name:'cloud.wav',mimeType:'audio/wav',buffer:Buffer.alloc(0)});
  check('empty cloud file shows actionable message and preserves current work',await page.evaluate(expected=>JSON.stringify(studio.snapshot())===expected&&document.querySelector('#media-load-status').textContent.includes('ファイルが空'),beforeBad));
  await page.locator('#media-file').setInputFiles(audioPath);await page.waitForFunction(()=>studio.snapshot().duration>20&&document.querySelector('#audio').readyState>=1);
  const beforeHelp=await page.evaluate(()=>({project:JSON.stringify(studio.snapshot()),past:studio.inspection().past}));
  await page.locator('#editor-help-open').click();await page.keyboard.press('e');await page.keyboard.press('Space');await page.locator('#editor-help-close').click();
  check('help prevents editing shortcuts from modifying project or history',await page.evaluate(expected=>JSON.stringify(studio.snapshot())===expected.project&&studio.inspection().past===expected.past,beforeHelp));
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
  check('playback, history and detached controls keep their icons after updates',await page.evaluate(()=>['edit-play','fixed-undo','edit-open-preview'].every(id=>document.getElementById(id).querySelector('.ui-icon'))));
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
  await page.goto(base+'video/auto.html');await page.waitForFunction(()=>window.studio);
  check('auto-sync experiment serves mobile-editing patch version',await page.locator('header .tag').textContent().then(t=>t.includes('0.4.2')));
  await page.locator('#media-file').setInputFiles(audioPath);await page.waitForFunction(()=>studio.snapshot().assets.media?.url?.startsWith('blob:')&&document.querySelector('#audio').readyState>=1);
  await page.locator('#play').click();await page.waitForFunction(()=>studio.currentTime()>.05);await page.locator('#play').click();
  check('experimental entry also selects and plays local WAV with inline status',await page.evaluate(()=>studio.inspection().paused&&document.querySelector('#media-load-status').textContent.includes('選択しました')&&!document.querySelector('#media-load-status').classList.contains('error')));
  // UI fixtures below have no model-generated timestamps: test real manual
  // capture/touch interactions, not automatic synchronization accuracy.
  await page.locator('#browser-project-file').setInputFiles({name:'empty.json',mimeType:'application/json',buffer:Buffer.from(JSON.stringify(newProject('')))});
  await page.locator('#media-file').setInputFiles(audioPath);await page.waitForFunction(()=>document.querySelector('#audio').readyState>=1);
  await page.locator('#record-start').tap();
  check('missing lyrics reports at the fixed console instead of silently doing nothing',await page.locator('#console-message').isVisible()&&await page.locator('#console-message').textContent().then(t=>t.includes('反映')));
  await page.locator('#lyrics').fill(Array.from({length:40},(_,i)=>`長い歌詞の確認 ${i+1}行目`).join('\n'));
  await page.locator('#record-start').tap();
  check('unapplied lyrics cannot capture a stale selected row',await page.locator('#console-message').textContent().then(t=>t.includes('未反映'))&&await page.evaluate(()=>studio.snapshot().lines.length===0));
  await page.locator('#apply-lyrics').click();await page.locator('#tab-editing').click();
  const last=page.locator('.lyric-row').last();
  check('unplaced rows distinguish unavailable fine adjustment from available selection',await last.locator('[data-action="shift"]').first().isDisabled()&&await last.locator('[data-action="adjust"]').first().isDisabled()&&await last.locator('[data-action="listen"]').isDisabled()&&await last.locator('[data-action="select"]').isEnabled()&&await last.locator('.empty-timing-hint').count()===1);
  for(const [width,height] of [[320,740],[390,844],[844,390],[932,430],[1024,500]]){
    await page.setViewportSize({width,height});await last.locator('[data-action="select"]').tap();
    check(`phone preview scrolls away and last-row touch reaches selection at ${width}x${height}`,await page.evaluate(()=>{const p=studio.snapshot();return getComputedStyle(document.querySelector('.edit-monitor')).position==='static'&&document.querySelector('.edit-monitor').getBoundingClientRect().bottom<0&&studio.inspection().selected===p.lines.at(-1).id;}));
  }
  await page.setViewportSize({width:390,height:844});
  await page.evaluate(()=>studio.seekTo(1.25));await page.locator('#record-start').tap();
  check('touch captures start on a scrolled last row and immediately enables edge adjustment',await page.evaluate(()=>studio.snapshot().lines.at(-1).start===1.25&&studio.snapshot().lines.at(-1).manual.start)&&await last.locator('[data-field="start"][data-action="adjust"]').first().isEnabled()&&await page.locator('#console-message').textContent().then(t=>t.includes('40行目の開始')));
  await page.evaluate(()=>studio.seekTo(2.75));await page.locator('#record-end').tap();
  check('touch captures end without changing selection or playback position',await page.evaluate(()=>{const p=studio.snapshot();return p.lines.at(-1).end===2.75&&p.lines.at(-1).manual.end&&studio.currentTime()===2.75&&studio.inspection().selected===p.lines.at(-1).id;}));
  await last.locator('[data-action="shift"][data-delta=".1"]').tap();
  check('newly recorded row can shift as a whole with preserved duration',await page.evaluate(()=>{const l=studio.snapshot().lines.at(-1);return l.start===1.35&&l.end===2.85&&Math.abs(l.end-l.start-1.5)<1e-9;}));
  await page.locator('#fixed-undo').tap();await page.locator('#fixed-undo').tap();
  check('multiple touch Undo restores partial capture',await page.evaluate(()=>{const l=studio.snapshot().lines.at(-1);return l.start===1.25&&l.end===null;}));
  await page.locator('#fixed-redo').tap();await page.locator('#fixed-redo').tap();
  check('multiple touch Redo restores complete timing and active controls',await last.locator('[data-action="confirm"]').isEnabled()&&await page.evaluate(()=>studio.snapshot().lines.at(-1).end===2.85));
  await last.locator('[data-action="confirm"]').tap();
  const capturedSrt=await download('#edit-srt');
  check('manual touch capture through confirmation exports real SRT',capturedSrt.text.includes('00:00:01,350 --> 00:00:02,850')&&capturedSrt.text.includes('長い歌詞の確認 40行目'));
  for(const [width,height] of [[768,1024],[1024,768],[1365,900]]){
    await page.setViewportSize({width,height});
    check(`tablet/desktop preview keeps existing sticky behavior at ${width}`,await page.locator('.edit-monitor').evaluate(el=>getComputedStyle(el).position==='sticky'));
  }
  const unmatched=newProject('自動未配置の行\n繰り返し\n繰り返し');unmatched.duration=27;unmatched.alignment={engine:'ui-zero-result-fixture',elapsedSeconds:0};
  await page.locator('#tab-production').click();await page.locator('#browser-project-file').setInputFiles({name:'zero-result-ui-only.json',mimeType:'application/json',buffer:Buffer.from(JSON.stringify(unmatched))});
  await page.locator('#tab-editing').click();await page.setViewportSize({width:390,height:844});
  check('zero-candidate result explicitly says SRT has not been automatically created',await page.locator('#alignment-summary').isVisible()&&await page.locator('#alignment-summary').textContent().then(t=>t.includes('SRTはまだ自動作成できていません')));
  await page.locator('.lyric-row').last().locator('[data-action="select"]').tap();
  await page.screenshot({path:resolve(output,'editing-phone-no-sticky.png')});
  check('browser editor never calls API, posts files or contacts remote asset URLs',apiRequests===0&&posts===0&&offOrigin===0);
  check('no uncaught browser errors',errors.length===0);
  console.log(JSON.stringify({checks:checks.length,apiRequests,posts,offOrigin,realAudio:true,newAlignment:false,physicalIOS:false}));
}catch(error){console.log('DIAGNOSTIC '+JSON.stringify(await page.evaluate(()=>({media:window.studio?.snapshot().assets.media,audio:{src:document.querySelector('#audio').getAttribute('src'),readyState:document.querySelector('#audio').readyState,error:document.querySelector('#audio').error?.message},status:document.querySelector('#media-load-status')?.textContent,wav:document.createElement('audio').canPlayType('audio/wav'),mp3:document.createElement('audio').canPlayType('audio/mpeg')}))));throw error;
}finally{await context.close();await browser.close();await new Promise(resolve=>server.close(resolve));}
