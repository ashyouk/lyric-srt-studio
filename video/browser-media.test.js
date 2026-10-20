import {test} from "node:test";
import assert from "node:assert/strict";
import {BrowserMedia,attachBrowserAsset,mediaKind,isBrowserEditor} from "./browser-media.js";
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
