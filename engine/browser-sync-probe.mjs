// Real browser ASR probe, local fixture only; external requests are GET/HEAD models.
import http from 'node:http';import {createReadStream} from 'node:fs';import {readFile,writeFile,stat} from 'node:fs/promises';import {resolve,extname,sep} from 'node:path';import {launchBrowser} from './browser.mjs';
const root=resolve('.'),folder=resolve('.studio-data/user-check/yellow-tape-20261001');
const actual=JSON.parse(await readFile(resolve(folder,'yellow-tape.candidate.lyricvideo.json'),'utf8'));
const server=http.createServer(async(req,res)=>{const path=resolve(root,'.'+new URL(req.url,'http://local').pathname);if(!path.startsWith(resolve('video')+sep)&&path!==resolve('srt-core.js')){res.writeHead(404);res.end();return;}try{await stat(path);res.writeHead(200,{'content-type':({'.js':'text/javascript','.mjs':'text/javascript','.wasm':'application/wasm','.html':'text/html','.css':'text/css'}[extname(path)]||'application/octet-stream')});createReadStream(path).pipe(res);}catch{res.writeHead(404);res.end();}});
await new Promise(r=>server.listen(0,'127.0.0.1',r));const origin=`http://127.0.0.1:${server.address().port}`,browser=await launchBrowser(),context=await browser.newContext(),page=await context.newPage();
let blocked=0;await context.route('**/*',route=>{const req=route.request(),url=new URL(req.url());if(!['GET','HEAD'].includes(req.method())||(!req.url().startsWith(origin)&&!['huggingface.co','cdn-lfs.huggingface.co','cdn-lfs-us-1.hf.co','cas-bridge.xethub.hf.co'].includes(url.hostname))){blocked++;return route.abort();}return route.continue();});
page.on('console',m=>{if(m.type()==='log')console.log(m.text());});
try{
  await page.goto(origin+'/video/auto.html');await page.waitForFunction(()=>window.studio);await page.locator('#media-file').setInputFiles(resolve(folder,'source.wav'));
  const model=process.env.STUDIO_PROBE_MODEL||'base',seconds=Number(process.env.STUDIO_PROBE_SECONDS||30);
  const result=await page.evaluate(async({lyrics,model,seconds})=>{const {decodeForAlignment,BrowserSync}=await import('./browser-sync.js');const {parseLyrics}=await import('./core.js');const blob=await fetch(studio.snapshot().assets.media.url).then(r=>r.blob());const samples=await decodeForAlignment(blob,seconds);return new BrowserSync().run(samples,parseLyrics(lyrics),'ja',s=>console.log(s),model);},{lyrics:actual.lyrics,model,seconds});
  await writeFile(resolve('.studio-data/verification/browser-sync',`yellow-${model}-${seconds}.json`),JSON.stringify(result,null,2));
  console.log(JSON.stringify({model,seconds,elapsed:result.elapsedSeconds,placed:result.lines.filter(l=>l.start!==null).length,recognized:result.diagnostics.recognizedForMatchingOnly,blocked}));
}finally{await context.close();await browser.close();await new Promise(r=>server.close(r));}
