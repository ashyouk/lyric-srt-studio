import {test} from "node:test";
import assert from "node:assert/strict";
import {BrowserMedia,attachBrowserAsset,mediaKind,isBrowserEditor,playableBlob,wavDuration} from "./browser-media.js";
import {newProject,saveProject,loadProject,History,shiftTiming,confirmLine,exportSrt} from "./core.js";

test("browser runtime is explicit or GitHub Pages; local PC retains its engine",()=>{
  assert.equal(isBrowserEditor("http://127.0.0.1:8765/video/"),false);
  assert.equal(isBrowserEditor("http://192.168.11.3:8766/video/?mode=browser"),true);
  assert.equal(isBrowserEditor("https://ashyouk.github.io/lyric-srt-studio/video/"),true);
  assert.equal(isBrowserEditor("https://github.io.evil.test/video/"),false);
});
test("iOS-style empty MIME uses extension without accept restrictions",()=>{
  for(const name of ["song.WAV","song.MP3","song.m4a"])assert.equal(mediaKind({name,type:""}),"audio");
  assert.equal(mediaKind({name:"mv.MP4",type:""}),"video");
  assert.equal(mediaKind({name:"cover.jpeg",type:""}),"image");
  assert.throws(()=>mediaKind({name:"archive.zip",type:"application/zip"}));
});
const file={name:"song.wav",type:"audio/wav",size:100,lastModified:123};
function waveFile({format=1,truncated=false}={}){
  const bytes=new Uint8Array(truncated?44:32044),view=new DataView(bytes.buffer);
  for(const [offset,text] of [[0,'RIFF'],[8,'WAVE'],[12,'fmt '],[36,'data']])bytes.set(new TextEncoder().encode(text),offset);
  view.setUint32(4,32036,true);view.setUint32(16,16,true);view.setUint16(20,format,true);view.setUint16(22,1,true);view.setUint32(24,16000,true);view.setUint32(28,32000,true);view.setUint16(32,2,true);view.setUint16(34,16,true);view.setUint32(40,32000,true);
  return new File([bytes],'song.WAV',{type:'application/octet-stream'});
}
test('PCM WAV duration is read from a bounded local header without media metadata events',async()=>{
  const env=environment();env.document.createElement=()=>{throw new Error('No metadata probe needed');};
  const asset=await new BrowserMedia(env).open(waveFile(),'media');
  assert.equal(asset.duration,1);assert.equal(asset.durationSource,'wav-header');assert.equal(await wavDuration(waveFile()),1);
});
test('compressed or truncated WAV does not receive an invented duration',async()=>{
  assert.equal(await wavDuration(waveFile({format:6})),null);assert.equal(await wavDuration(waveFile({truncated:true})),null);
});
test('empty and incorrect provider MIME is normalized without changing file bytes',async()=>{
  const original=new File(['audio-data'],'song.m4a',{type:'video/mp4'}),normalized=playableBlob(original);
  assert.equal(mediaKind(original),'audio');assert.equal(normalized.type,'audio/mp4');assert.equal(await normalized.text(),await original.text());
});
test('zero-byte cloud placeholder is rejected before creating any blob URL',async()=>{
  const env=environment(),media=new BrowserMedia(env);await assert.rejects(media.open(new File([],'cloud.wav'),'media'),/ファイルが空/);assert.equal(media.urls.size,0);assert.equal(env.elements.length,0);
});
test('metadata probe is attached, waits through initial NaN, then cleans up on durationchange',async()=>{
  let attached=false,removed=false;
  const element={duration:NaN,style:{},setAttribute(){},pause(){},removeAttribute(){delete this.src;},remove(){removed=true;attached=false;},load(){if(!this.src)return;queueMicrotask(()=>{assert.equal(attached,true);this.onloadedmetadata?.();setTimeout(()=>{this.duration=9;this.ondurationchange?.();},1);});}};
  const media=new BrowserMedia({document:{body:{append(){attached=true;}},createElement(){return element;}},url:{createObjectURL(){return 'blob:test';},revokeObjectURL(){}},timeoutMs:100});
  const asset=await media.open({name:'song.mp3',type:'audio/mpeg',size:10},'media');assert.equal(asset.duration,9);assert.equal(removed,true);assert.equal(element.ondurationchange,null);assert.equal(element.src,undefined);
});
test('stalled audio metadata falls back to local decoding without playing media',async()=>{
  const env=environment('timeout');let calls=0;
  const media=new BrowserMedia({...env,timeoutMs:100,fallbackDelayMs:1,decodeDuration:async()=>{calls++;return 12;}});
  const asset=await media.open({name:'song.mp3',type:'audio/mpeg',size:10},'media');
  assert.equal(calls,1);assert.equal(asset.duration,12);assert.equal(asset.durationSource,'audio-decode');assert.equal(env.elements[0].src,undefined);
});
test('metadata plus decode failure rejects and releases only the newly selected asset',async()=>{
  const env=environment('error'),media=new BrowserMedia({...env,timeoutMs:100,decodeDuration:async()=>{throw new Error('bad codec');}});
  await assert.rejects(media.open(file,'media'),/音源を読み込めません/);assert.equal(env.revoked.length,1);assert.equal(media.urls.size,0);
});
function environment(outcome="success"){
  const revoked=[],elements=[];let count=0;
  const url={createObjectURL:()=>`blob:test-${++count}`,revokeObjectURL:value=>revoked.push(value)};
  const document={createElement:()=>{const element={duration:12.5,removeAttribute(){delete this.src;},load(){if(!this.src)return;queueMicrotask(()=>{if(outcome==="error")this.onerror?.();else if(outcome!=="timeout")this.onloadedmetadata?.();});}};elements.push(element);return element;}};
  return {url,document,revoked,elements};
}
test("local metadata probing retains replaced blobs for Undo then revokes on disposal",async()=>{
  const env=environment(),media=new BrowserMedia(env);
  const first=await media.open(file,"media"),second=await media.open(file,"media");
  assert.equal(first.duration,12.5);assert.equal(first.source,"browser-file");assert.notEqual(first.id,second.id);
  assert.equal(env.revoked.length,0);assert.equal(env.elements[0].src,undefined);
  media.dispose();assert.deepEqual(env.revoked,[first.url,second.url]);assert.equal(media.urls.size,0);
});
test("failed or timed-out media is revoked and doesn't leave a timer/source behind",async()=>{
  for(const outcome of ["error","timeout"]){const env=environment(outcome),media=new BrowserMedia({...env,timeoutMs:5});await assert.rejects(media.open(file,"media"));assert.equal(env.revoked.length,1);assert.equal(media.urls.size,0);assert.equal(env.elements[0].src,undefined);}
});
test("invalid media slots and non-finite duration are rejected without modifying project",()=>{
  const p=newProject("日本語 Hello");
  for(const asset of [{kind:"image",duration:0},{kind:"audio",duration:Infinity},{kind:"audio",duration:0}])assert.throws(()=>attachBrowserAsset(p,asset,"media"));
  assert.equal(p.assets.media,null);assert.throws(()=>attachBrowserAsset(p,{kind:"video",duration:12},"audio"));
});
test("PC result -> local attachment -> edit/Undo/Redo -> save/reload -> SRT preserves canonical estimates",()=>{
  const pc=newProject("[Verse]\n日本語 Hello\n\n同じ歌詞\n同じ歌詞");pc.duration=12.5;
  pc.lines.forEach((line,i)=>Object.assign(line,{start:1+i*3,end:2+i*3,auto:{candidateStart:1+i*3,candidateEnd:2+i*3,evidence:{matchedCharacters:4}},reasons:["自動候補を確認してください"]}));
  pc.assets.media={id:"server-private-id",url:"/api/media/private",name:"song.wav",duration:12.5};
  let local=loadProject(saveProject(pc));
  local=attachBrowserAsset(local,{id:"browser-1",url:"blob:local",name:"song.wav",duration:12.5,kind:"audio",hasAudio:true,source:"browser-file"},"media");
  assert.deepEqual(local.lines,pc.lines);assert.equal(pc.assets.media.id,"server-private-id");
  const history=new History(),before=local;
  local=history.change(local,shiftTiming(local,local.lines[0].id,.1));
  local=history.undo(local);assert.deepEqual(local,before);local=history.redo(local);
  assert.equal(local.lines[0].start,1.1);assert.equal(local.lines[0].end,2.1);
  local=confirmLine(local,local.lines[0].id);
  const saved=saveProject(local),restored=loadProject(saved);
  assert.equal(saved.assets.media.url,undefined);assert.equal(saved.assets.media.id,undefined);
  assert.deepEqual(restored.lines,local.lines);assert.equal(restored.lyrics,pc.lyrics);
  assert.match(exportSrt(restored),/00:00:01,100 --> 00:00:02,100\n日本語 Hello/);
  assert.doesNotMatch(exportSrt(restored),/同じ歌詞/);
});
