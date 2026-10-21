// Opt-in real-model verification. Downloads model files, NEVER uploads test media.
import http from 'node:http';
import assert from 'node:assert/strict';
import {createReadStream,existsSync} from 'node:fs';
import {stat,mkdir,writeFile,readFile} from 'node:fs/promises';
import {resolve,extname,sep} from 'node:path';
import {launchBrowser} from './browser.mjs';
const root=resolve('.'),out=resolve('.studio-data/verification/browser-sync');await mkdir(out,{recursive:true});
const server=http.createServer(async(req,res)=>{
  const path=resolve(root,'.'+decodeURIComponent(new URL(req.url,'http://local').pathname));
  if(!path.startsWith(resolve('video')+sep)&&path!==resolve('srt-core.js')){res.writeHead(404);res.end();return;}
  try{const s=await stat(path);res.writeHead(200,{'content-type':({'.js':'text/javascript','.html':'text/html','.css':'text/css','.wasm':'application/wasm','.mjs':'text/javascript'}[extname(path)]||'application/octet-stream')});createReadStream(path).pipe(res);}catch{res.writeHead(404);res.end();}
});await new Promise(r=>server.listen(0,'127.0.0.1',r));
const origin=process.env.STUDIO_SYNC_URL||`http://127.0.0.1:${server.address().port}`,browser=await launchBrowser(),context=await browser.newContext({viewport:{width:390,height:844}}),page=await context.newPage();
const network=[],errors=[];page.on('pageerror',e=>errors.push(e.message));page.on('console',m=>{if(m.type()==='log')console.log(m.text());});
page.on('dialog',d=>d.accept());const checks=[];const check=(name,value)=>{assert.ok(value,name);checks.push(name);console.log('PASS '+name);};
await context.route('**/*',route=>{const r=route.request(),url=new URL(r.url());network.push({host:url.hostname,method:r.method(),path:url.pathname});
  if(!['GET','HEAD'].includes(r.method())||(!r.url().startsWith(origin)&&!['huggingface.co','cdn-lfs.huggingface.co','cdn-lfs-us-1.hf.co','cas-bridge.xethub.hf.co'].includes(url.hostname)))return route.abort();
  return route.continue();
});
try{
  await page.goto(origin+'/video/auto.html');await page.waitForFunction(()=>window.studio);
  check('experimental entry exposes real local sync without PC API',await page.locator('#align').isVisible());
  await page.locator('#align').click();check('model download requires explicit confirmation',await page.locator('#message').textContent().then(t=>t.includes('注意事項')));
  check('no model files requested before consent',!network.some(r=>r.host==='huggingface.co'));
  const lyrics=(JSON.parse(await readFile('.studio-data/verification/short-request.json','utf8'))).lines.slice(0,4).map(l=>l.text).join('\n');
  await page.locator('#media-file').setInputFiles(resolve('.studio-data/verification/twinkle-short.wav'));
  const result=await page.evaluate(async lyrics=>{
    const {decodeForAlignment,BrowserSync}=await import('./browser-sync.js');const {parseLyrics}=await import('./core.js');
    const blob=await fetch(studio.snapshot().assets.media.url).then(r=>r.blob());const samples=await decodeForAlignment(blob,30);
    const sync=new BrowserSync();window.syncTestCancel=()=>sync.cancel();
    return sync.run(samples,parseLyrics(lyrics),'en',s=>console.log(s));
  },lyrics);
  await writeFile(resolve(out,'twinkle-browser.json'),JSON.stringify(result,null,2));
  const placed=result.lines.filter(l=>Number.isFinite(l.start)&&l.end>l.start);
  check('real acoustic model places lyric rows',placed.length>0);
  await page.locator('#lyrics').fill(lyrics);await page.locator('#sync-language').selectOption('en');await page.locator('#model-consent').check();await page.locator('#align').click();
  await page.waitForFunction(()=>studio.snapshot().alignment?.engine==='browser-whisper-tiny-q8-word-blocks',{},{timeout:180000});
  check('UI applies real worker output to canonical lyrics',await page.evaluate(expected=>studio.snapshot().lyrics===expected&&studio.snapshot().lines.every(l=>l.review&&l.start!==null),lyrics));
  await page.locator('#fixed-undo').click();check('alignment is a single Undo operation',await page.evaluate(()=>studio.snapshot().lines.every(l=>l.start===null)));
  await page.locator('#fixed-redo').click();check('Redo restores all alignment candidates',await page.evaluate(()=>studio.snapshot().lines.every(l=>l.start!==null)));
  const first=await page.evaluate(()=>studio.snapshot().lines[0]);
  await page.locator(`[data-id="${first.id}"] [data-action="shift"][data-delta=".1"]`).click();
  const adjusted=await page.evaluate(()=>studio.snapshot().lines[0].start);
  await page.locator(`[data-id="${first.id}"] [data-action="confirm"]`).click();
  const pending=page.waitForEvent('download');await page.locator('#edit-srt').click();const file=await pending;
  check('SRT downloads real corrected canonical lyrics',(await readFile(await file.path(),'utf8')).includes(first.text));
  await page.locator('#tab-production').click();await page.locator('#align').click();
  await page.waitForFunction(()=>document.querySelector('#align').disabled===false,{},{timeout:180000});
  check('reanalysis protects manually corrected intervals',await page.evaluate(expected=>studio.snapshot().lines[0].start===expected,adjusted));
  const beforeCancel=await page.evaluate(()=>JSON.stringify(studio.snapshot()));
  await page.locator('#tab-production').click();await page.locator('#align').click();await page.locator('#cancel').click();
  await page.waitForFunction(()=>!document.querySelector('#align').disabled);
  check('cancellation leaves project unchanged and allows retry',await page.evaluate(expected=>JSON.stringify(studio.snapshot())===expected,beforeCancel));
  const actualFolder=resolve('.studio-data/user-check/yellow-tape-20261001');
  if(!process.env.STUDIO_SYNC_QUICK&&existsSync(resolve(actualFolder,'source.wav'))){
    const actual=JSON.parse(await readFile(resolve(actualFolder,'yellow-tape.candidate.lyricvideo.json'),'utf8'));
    await page.locator('#lyrics').fill(actual.lyrics);await page.locator('#apply-lyrics').click();
    await page.locator('#media-file').setInputFiles(resolve(actualFolder,'source.wav'));await page.locator('#sync-language').selectOption('ja');await page.locator('#sync-range').selectOption('300');
    await page.locator('#align').click();await page.waitForFunction(()=>!document.querySelector('#align').disabled,{},{timeout:300000});
    const project=await page.evaluate(()=>studio.snapshot());await writeFile(resolve(out,'yellow-tape-browser.json'),JSON.stringify(project,null,2));
    check('Japanese full-song run uses browser engine and preserves supplied lyrics',project.alignment?.engine==='browser-whisper-tiny-q8-word-blocks'&&project.lyrics===actual.lyrics);
    if(project.lines.every(l=>l.start===null)){
      check('real zero-candidate run stays on production and reports failure beside fixed controls',await page.evaluate(()=>studio.inspection().activeTab==='production'&&!document.querySelector('#console-message').hidden&&document.querySelector('#console-message').textContent.includes('SRTはまだ作成できていません')));
      await page.locator('#tab-editing').click();
      check('real zero-candidate result keeps an explicit warning in editing',await page.locator('#alignment-summary').isVisible()&&await page.locator('#alignment-summary').textContent().then(t=>t.includes('有効な時刻を得られませんでした')));
    }
    console.log(JSON.stringify({song:'provided Japanese song',rows:project.lines.length,placed:project.lines.filter(l=>l.start!==null).length,seconds:project.alignment?.elapsedSeconds,humanBoundaryAccuracy:'not measured'}));
    await page.setViewportSize({width:390,height:844});await page.screenshot({path:resolve(out,'editing-390.png')});
  }
  const mixed=JSON.parse(await readFile('.studio-data/verification/japanese-request.json','utf8'));
  await page.locator('#tab-production').click();await page.locator('#lyrics').fill(mixed.lines.map(l=>l.text).join('\n'));await page.locator('#apply-lyrics').click();
  await page.locator('#media-file').setInputFiles(resolve('.studio-data/verification/japanese-speech.wav'));await page.locator('#sync-language').selectOption('mixed');
  await page.locator('#align').click();await page.waitForFunction(()=>!document.querySelector('#align').disabled,{},{timeout:180000});
  const mixedProject=await page.evaluate(()=>studio.snapshot());await writeFile(resolve(out,'mixed-speech-browser.json'),JSON.stringify(mixedProject,null,2));
  check('mixed-language processing preserves original repeated Japanese/English lines',mixedProject.lines.length===4&&mixedProject.lines.every((l,i)=>l.text===mixed.lines[i].text));
  console.log(JSON.stringify({fixture:'mixed synthesized speech, NOT singing',rows:4,placed:mixedProject.lines.filter(l=>l.start!==null).length,seconds:mixedProject.alignment?.elapsedSeconds}));
  const savePending=page.waitForEvent('download');await page.locator('#edit-save-project').click();const saved=await savePending;const savedProject=JSON.parse(await readFile(await saved.path(),'utf8'));
  check('project saves model provenance, inferred times and review state without media URL',savedProject.alignment.modelRevision&&savedProject.alignment.runtime==='wasm-single-thread'&&!savedProject.assets.media.url&&savedProject.lines.every(l=>l.auto&&l.review));
  await page.locator('#tab-production').click();await page.locator('#align').click();await page.locator('#lyrics').fill('Changed lyrics');await page.locator('#apply-lyrics').click();
  await page.waitForFunction(()=>!document.querySelector('#align').disabled,{},{timeout:180000});
  check('lyrics changed during inference reject stale results',await page.evaluate(()=>studio.snapshot().lyrics==='Changed lyrics'&&studio.snapshot().lines[0].start===null&&document.querySelector('#message').textContent.includes('結果は反映していません')));
  assert.equal(network.filter(r=>!['GET','HEAD'].includes(r.method)).length,0);
  assert.equal(errors.length,0,errors.join('\n'));
  console.log(JSON.stringify({checks:checks.length,song:'CC0 Twinkle 27s',rows:result.lines.length,placed:placed.length,elapsedSeconds:result.elapsedSeconds,errors,networkHosts:[...new Set(network.map(r=>r.host))],physicalIOS:false}));
}finally{await context.close();await browser.close();await new Promise(r=>server.close(r));}
