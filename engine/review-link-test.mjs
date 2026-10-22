import assert from 'node:assert/strict';
import http from 'node:http';
import {createReadStream} from 'node:fs';
import {readFile,mkdir,stat} from 'node:fs/promises';
import {resolve,extname,sep} from 'node:path';
import {execFileSync} from 'node:child_process';
import {launchBrowser} from './browser.mjs';
import {newProject} from '../video/core.js';
import {encodeReviewLink,decodeReviewFragment} from '../video/review-link.js';

const root=resolve('.'),prefix='/lyric-srt-studio/',output=resolve('.studio-data/verification/review-link');
await mkdir(output,{recursive:true});const requests=[];
const server=http.createServer(async(req,res)=>{
  requests.push(req.url);
  const rel=decodeURIComponent(new URL(req.url,'http://local').pathname.slice(prefix.length)),path=resolve(root,rel);
  if(!['GET','HEAD'].includes(req.method)||!new URL(req.url,'http://local').pathname.startsWith(prefix)||
    !(rel==='srt-core.js'||path.startsWith(resolve('video')+sep))){res.writeHead(404);res.end();return;}
  try{const s=await stat(path);if(!s.isFile())throw Error();res.writeHead(200,{'content-type':({'.html':'text/html; charset=utf-8','.js':'text/javascript; charset=utf-8','.css':'text/css','.ttf':'font/ttf'}[extname(path)]||'application/octet-stream')});createReadStream(path).pipe(res);}catch{res.writeHead(404);res.end();}
});
await new Promise(r=>server.listen(0,'127.0.0.1',r));
const base=process.env.STUDIO_REVIEW_URL||`http://127.0.0.1:${server.address().port}${prefix}`;
let link;
if(process.env.STUDIO_REVIEW_LINK_FILE)link=await readFile(process.env.STUDIO_REVIEW_LINK_FILE,'utf8');
else{
  const p=newProject('日本語の歌詞\nHello 日本語');p.name='確認用 <img src=x> プロジェクト';p.duration=3;p.style.y=.2;
  p.lines.forEach((l,i)=>Object.assign(l,{start:.3+i*1.3,end:1.2+i*1.3,auto:{start:.3+i*1.3,end:1.2+i*1.3}}));
  link=await encodeReviewLink(p,base+'video/index.html?mode=browser&v=0.4.3');
}
const hash=new URL(link).hash,expected=await decodeReviewFragment(hash);
const url=base+'video/index.html?mode=browser&v=0.4.3'+hash;
const noMedia=Boolean(process.env.STUDIO_REVIEW_NO_MEDIA);
let media=process.env.STUDIO_REVIEW_MEDIA;
if(!noMedia&&!media){media=resolve(output,'reference.mov');execFileSync('ffmpeg',['-v','error','-y','-f','lavfi','-i','color=c=0x101622:s=640x360:r=12','-f','lavfi','-i','sine=frequency=330:sample_rate=48000','-t','3','-c:v','libx264','-pix_fmt','yuv420p','-c:a','aac',media]);}
const browser=await launchBrowser(),context=await browser.newContext({viewport:{width:390,height:844},hasTouch:true,isMobile:true});
const page=await context.newPage(),errors=[],checks=[];let blocked=0;page.on('pageerror',e=>errors.push(e.message));
await context.route('**/*',route=>{const r=route.request(),u=r.url();
  if(/^https?:/.test(u)&&(!u.startsWith(base)||!['GET','HEAD'].includes(r.method())||u.includes('/api/'))){blocked++;return route.abort();}return route.continue();});
const check=(name,value)=>{assert.ok(value,name);checks.push(name);console.log('PASS '+name);};
async function download(selector){const p=page.waitForEvent('download');await page.locator(selector).click();const file=await p;assert.equal(await file.failure(),null);return readFile(await file.path(),'utf8');}
try{
  await page.goto(url);await page.waitForSelector('#open-incoming-review');
  check('link shows an import choice without modifying current project',await page.evaluate(()=>studio.snapshot().lines.length===0&&localStorage.getItem('lyric-srt-browser-editor-v1')===null));
  check('fragment data is removed from address and never sent to the static server',await page.evaluate(()=>location.hash==='')&&requests.every(p=>!p.includes('review=')&&!p.includes('#')));
  check('incoming name renders as text, never markup',await page.locator('#incoming-review h2').textContent()===expected.name.slice(0,160)&&await page.locator('#incoming-review img').count()===0);
  const incoming=JSON.parse(await download('#save-incoming-review'));
  check('optional browser download saves the same project without importing it',incoming.lines.length===expected.lines.length&&await page.evaluate(()=>studio.snapshot().lines.length===0));
  for(const [width,height] of [[320,740],[390,844],[768,1024]]){
    await page.setViewportSize({width,height});check(`review card fits and has usable targets at ${width}`,await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth&&[...document.querySelectorAll('#incoming-review button')].every(b=>b.getBoundingClientRect().height>=44)));
  }
  await page.setViewportSize({width:390,height:844});await page.locator('#open-incoming-review').focus();await page.keyboard.press('Space');
  await page.waitForFunction(n=>studio.snapshot().lines.length===n,expected.lines.length);
  check('keyboard activation imports the exact lyrics and acoustic times without recording',await page.evaluate(lines=>studio.snapshot().lines.every((l,i)=>l.text===lines[i].text&&l.start===lines[i].start&&l.end===lines[i].end&&l.review===lines[i].review),expected.lines));
  check('comparison style is retained and media stays unselected until a local choice',await page.evaluate(y=>studio.snapshot().style.y===y&&!studio.snapshot().assets.media?.url,expected.style.y));
  if(!noMedia){
    await page.locator('#media-file').setInputFiles(media);await page.waitForFunction(()=>studio.snapshot().assets.media?.kind==='video'&&document.querySelector('#video').readyState>=1);
    check('saved MOV can be selected directly with all candidate times preserved',await page.evaluate(lines=>studio.snapshot().assets.media.url.startsWith('blob:')&&studio.snapshot().lines.every((l,i)=>l.start===lines[i].start),expected.lines));
    await page.locator('#play').tap();await page.waitForFunction(()=>studio.currentTime()>.1);await page.locator('#play').tap();
    check('MOV audio really plays and pauses with a single media source',await page.evaluate(()=>studio.inspection().paused&&studio.currentTime()>.1&&!document.querySelector('#audio').getAttribute('src')));
  }
  await page.locator('#tab-editing').click();const row=expected.lines.find(l=>Number.isFinite(l.start)&&l.end>l.start&&l.end+.1<expected.duration);
  const sel=`[data-id="${row.id}"]`;
  await page.locator(sel+' [data-action="select"]').tap();await page.locator(sel+' [data-action="shift"][data-delta=".1"]').tap();
  check('link-imported candidate supports touch correction',await page.evaluate(row=>Math.abs(studio.snapshot().lines.find(l=>l.id===row.id).start-row.start-.1)<1e-6,row));
  await page.locator('#fixed-undo').tap();await page.locator('#fixed-redo').tap();
  check('Undo and Redo preserve imported automatic estimates and manual edits',await page.evaluate(row=>{const l=studio.snapshot().lines.find(l=>l.id===row.id);return l.manual.start&&Math.abs(l.start-row.start-.1)<1e-6&&l.auto.start===row.auto.start;},row));
  await page.locator(sel+' [data-action="confirm"]').tap();const srt=await download('#edit-srt');
  check('existing SRT export works after explicit QA confirmation',srt.includes(row.text)&&(srt.match(/ --> /g)||[]).length===1);
  const saved=JSON.parse(await download('#edit-save-project'));
  check('ordinary project save still retains all imported rows without media URLs',saved.lines.length===expected.lines.length&&!saved.assets.media?.url);
  if(!noMedia){await page.locator('#tab-production').click();await page.evaluate(t=>studio.seekTo(t),Math.min(45,expected.duration*.55));await page.locator('#stage').scrollIntoViewIfNeeded();await page.screenshot({path:resolve(output,'comparison-390.png')});}
  await page.goto(url);await page.waitForSelector('#open-incoming-review');const before=await page.evaluate(()=>JSON.stringify(studio.snapshot()));
  page.once('dialog',d=>d.dismiss());await page.locator('#open-incoming-review').tap();
  check('declining replacement preserves existing work and leaves incoming choice available',await page.evaluate(before=>JSON.stringify(studio.snapshot())===before,before)&&await page.locator('#incoming-review').isVisible());
  await page.locator('#incoming-review button').last().tap();
  check('closing incoming card does not change project state',await page.evaluate(before=>JSON.stringify(studio.snapshot())===before,before));
  await page.goto(base+'video/index.html?mode=browser&v=0.4.3#review=gz1.AA');await page.waitForSelector('#incoming-review .error');
  check('broken review link reports an error without replacing saved work',await page.evaluate(before=>JSON.stringify(studio.snapshot())===before&&location.hash==='',before));
  check('no uploaded media, off-origin traffic or uncaught browser errors',blocked===0&&errors.length===0);
  console.log(JSON.stringify({checks:checks.length,rows:expected.lines.length,media:!noMedia,blocked,errors,physicalIOS:false}));
}finally{await context.close();await browser.close();await new Promise(r=>server.close(r));}
