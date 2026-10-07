import {test} from "node:test";
import assert from "node:assert/strict";
import {parseLyrics, newProject, updateLyrics, loadProject, saveProject, applyAlignment, editTiming, confirmLine,
  History, cues, activeCue, exportSrt, layoutScene, wrapText, videoExportProject, shiftTiming, timingIssues} from "./core.js";
import {FONTS,normalizeFont,fontFamily} from "./font-catalog.js";

const fixture = () => {
  const p = newProject("星よ、Hello world\n同じ歌詞\n同じ歌詞"); p.duration = 20;
  p.lines.forEach((l, i) => {l.start = 2 + i * 5; l.end = 4 + i * 5;}); return p;
};
test("loaded projects cannot load remote assets or reuse runtime IDs", () => {
  const p=fixture();p.assets.media={name:"MV",id:"runtime",url:"https://remote.invalid/music.mp4"};
  const loaded=loadProject(p);
  assert.equal(loaded.assets.media.id,undefined);
  assert.equal(loaded.assets.media.url,undefined);
  assert.equal(loaded.assets.media.reselect,true);
  assert.equal(p.assets.media.id,"runtime");
  const invalid=fixture();invalid.lines[1].id=invalid.lines[0].id;
  assert.throws(()=>loadProject(invalid),/重複/);
});
test("canonical text, mixed language, repeated rows, blanks and section tags survive", () => {
  const raw = "[Verse]\n\n  星よ、Hello world!\n同じ歌詞\n\n[Chorus]\n同じ歌詞\n";
  const p = newProject(raw);
  assert.equal(p.lyrics, raw); assert.equal(p.lines.length, 3);
  assert.equal(p.lines[0].text, "  星よ、Hello world!");
  assert.equal(p.lines[2].section, "[Chorus]");
  assert.notEqual(p.lines[1].id, p.lines[2].id);
  assert.deepEqual(parseLyrics("\n[Verse]\n\n"), []);
});
const correctedLyricsFixture = () => {
  const p=newProject("赤い箱\n青い箱\n青い箱");p.duration=20;
  p.lines.forEach((line,i)=>Object.assign(line,{start:1+i*4,end:3+i*4,
    alignmentText:["あかいはこ","あおいはこ一回目","あおいはこ二回目"][i],
    manual:{start:true,end:i!==1},review:i===1,reasons:[`確認理由${i}`],
    auto:{start:.5+i*4,end:3.5+i*4,evidence:{matchedCharacters:i+1}}}));
  p.alignment={engine:"synthetic",elapsedSeconds:0,asrModel:"small"};
  return p;
};

test("blank-line changes preserve corrected rows through JSON save and reload",()=>{
  const p=correctedLyricsFixture(), original=structuredClone(p);
  for(const raw of ["\n赤い箱\n青い箱\n青い箱", "赤い箱\n\n青い箱\n \n青い箱\n\n",
                   "\r\n赤い箱\r\n\r\n青い箱\r\n青い箱\r\n", p.lyrics]){
    const next=updateLyrics(p,raw), restored=loadProject(JSON.parse(JSON.stringify(saveProject(next))));
    assert.equal(restored.lyrics,raw);
    const parsed=parseLyrics(raw);
    assert.deepEqual(restored.lines,p.lines.map((line,i)=>({...line,sourceLine:parsed[i].sourceLine,section:parsed[i].section})));
    assert.deepEqual(restored.alignment,p.alignment);
    assert.deepEqual(p,original);
  }
});

test("section-tag changes update source metadata without changing row identity",()=>{
  const p=correctedLyricsFixture();
  const tagged=updateLyrics(p,"[Verse]\n赤い箱\n[Chorus]\n青い箱\n\n[Outro]\n青い箱");
  assert.deepEqual(tagged.lines.map(l=>l.section),["[Verse]","[Chorus]","[Outro]"]);
  assert.deepEqual(tagged.lines.map(l=>l.sourceLine),[1,3,6]);
  assert.deepEqual(tagged.lines.map(l=>l.id),p.lines.map(l=>l.id));
  assert.deepEqual(updateLyrics(tagged,p.lyrics),p);
  tagged.lines[0].manual.start=false;
  assert.equal(p.lines[0].manual.start,true);
});

test("repeated subtitle rows retain distinct readings and times across repeated saves",()=>{
  const p=correctedLyricsFixture();
  let next=loadProject(saveProject(updateLyrics(p,"\n赤い箱\n\n青い箱\n青い箱")));
  next=loadProject(saveProject(updateLyrics(next,"[Verse]\n赤い箱\n青い箱\n\n[Chorus]\n青い箱")));
  assert.deepEqual(next.lines.map(({sourceLine,section,...row})=>row),p.lines.map(({sourceLine,section,...row})=>row));
  assert.equal(new Set(next.lines.map(l=>l.id)).size,3);
});

test("ordinary lyric updates reject meaningful edits without altering saved corrections",()=>{
  const p=correctedLyricsFixture(),original=structuredClone(p);
  const saved=JSON.stringify(saveProject(p));
  for(const raw of ["赤い袋\n青い箱\n青い箱", "赤い箱\n緑の箱\n青い箱\n青い箱",
                   "赤い箱\n青い箱", "赤い箱\n青い箱\n青い箱\n青い箱", " 赤い箱\n青い箱\n青い箱"]){
    assert.throws(()=>updateLyrics(p,raw),/変更はまだ反映していません/);
    assert.deepEqual(p,original);
    assert.equal(JSON.stringify(saveProject(p)),saved);
    assert.deepEqual(loadProject(JSON.parse(saved)).lines,p.lines);
  }
});

test("explicit timing reset applies edits without guessing matches for repeated rows",()=>{
  const p=correctedLyricsFixture(),original=structuredClone(p);
  for(const raw of ["赤い袋\n青い箱\n青い箱", "赤い箱\n緑の箱\n青い箱\n青い箱",
                   "赤い箱\n青い箱", "赤い箱\n青い箱\n青い箱\n青い箱"]){
    const next=updateLyrics(p,raw,{resetTiming:true});
    assert.deepEqual(next.lines,parseLyrics(raw));
    assert.equal(next.alignment,null);
    assert.deepEqual(loadProject(saveProject(next)).lines,next.lines);
    assert.deepEqual(p,original);
  }
});

test("reordering repeated rows requires explicit reset even when a row stays in place",()=>{
  const p=correctedLyricsFixture();
  assert.throws(()=>updateLyrics(p,"青い箱\n赤い箱\n青い箱"),/変更はまだ反映していません/);
  const next=updateLyrics(p,"青い箱\n赤い箱\n青い箱",{resetTiming:true});
  assert.deepEqual(next.lines,parseLyrics(next.lyrics));
  assert.ok(next.lines.every(l=>l.start===null&&l.end===null&&l.review));
});

test("lyrics updates remain single Undo steps and redo retains saved corrections",()=>{
  const p=correctedLyricsFixture(),h=new History();
  const formatted=h.change(p,updateLyrics(p,"\n[Verse]\n"+p.lyrics));
  assert.deepEqual(h.undo(formatted),p);
  assert.deepEqual(h.redo(p),formatted);
  assert.throws(()=>updateLyrics(formatted,"赤い袋\n青い箱\n青い箱"),/変更はまだ反映していません/);
  assert.equal(h.past.length,1);
  const edited=h.change(formatted,updateLyrics(formatted,"赤い袋\n青い箱\n青い箱",{resetTiming:true}));
  assert.deepEqual(h.undo(edited),formatted);
  const redone=h.redo(formatted);
  assert.deepEqual(redone,edited);
  assert.ok(redone.lines.every(l=>l.start===null));
});

test("empty or tag-only lyric updates are rejected without changing the project",()=>{
  const p=correctedLyricsFixture(),original=structuredClone(p);
  for(const raw of ["", " \n\n", "[Verse]\n\n[Chorus]"])assert.throws(()=>updateLyrics(p,raw),/1行以上/);
  assert.deepEqual(p,original);
});

test("first lyric entry needs no reset permission and formatting never resets corrections",()=>{
  const initial=updateLyrics(newProject(),"赤い箱\n青い箱");
  assert.deepEqual(initial.lines,parseLyrics(initial.lyrics));
  const p=correctedLyricsFixture();
  const next=updateLyrics(p,"\n"+p.lyrics,{resetTiming:true});
  assert.deepEqual(next.lines.map(({sourceLine,...line})=>line),p.lines.map(({sourceLine,...line})=>line));
});

test("alignment applies acoustic estimates without replacing display or reading text", () => {
  const p = fixture(), text = p.lines.map(l => l.text);
  p.lines[0].alignmentText = "ほしよ hello world";
  const next = applyAlignment(p, {engine: "real-model", lines: p.lines.map(l => ({id:l.id,start:3,end:4,reasons:["review"]}))});
  assert.deepEqual(next.lines.map(l => l.text), text);
  assert.equal(next.lines[0].alignmentText, "ほしよ hello world");
  assert.equal(next.lines[0].start, 3); assert.equal(next.lines[0].review, true);
  assert.equal(p.lines[0].start, 2);
});
test("recognizer choice survives save/load without accepting changed canonical text", () => {
  const p = fixture();
  const next = applyAlignment(p, {engine: "Qwen", elapsedSeconds: 90,
    diagnostics: {asrModel: "large-v3-turbo"}, lines: p.lines.map(l => ({id:l.id,start:l.start,end:l.end,reasons:[]}))});
  const restored = loadProject(saveProject(next));
  assert.equal(restored.alignment.asrModel, "large-v3-turbo");
  assert.equal(restored.alignment.elapsedSeconds, 90);
  assert.deepEqual(restored.lines.map(l => l.text), p.lines.map(l => l.text));
});
test("audition includes valid unreviewed cues without approving or mutating the project", () => {
  const p=fixture();p.lines[1].end=null;
  const original=structuredClone(p);
  const audition=videoExportProject(p,true);
  assert.equal(audition.lines.length,2);
  assert.ok(audition.lines.every(l=>l.review));
  assert.equal(videoExportProject(p).lines.length,0);
  assert.deepEqual(p,original);
  const confirmed=confirmLine(p,'line-0');
  assert.deepEqual(videoExportProject(confirmed).lines.map(l=>l.id),['line-0']);
  assert.equal(exportSrt(confirmed).split('\n').filter(l=>l.includes('-->')).length,1);
});
test("reanalysis protects an entire manually corrected row", () => {
  let p = editTiming(fixture(), "line-0", "start", 2.5);
  p = confirmLine(p, "line-0");
  const next = applyAlignment(p, {engine:"new",lines:[{id:"line-0",start:8,end:9,reasons:[]}]});
  assert.equal(next.lines[0].start, 2.5); assert.equal(next.lines[0].end, 4);
  assert.equal(next.lines[0].manual.start, true); assert.equal(next.lines[0].auto.start, 8);
});
test("invalid, missing and reversed times are excluded and cannot be confirmed", () => {
  const p = fixture(); p.lines[0].end = null; p.lines[1].end = 4;
  assert.equal(cues(p).length, 1); assert.throws(() => confirmLine(p,"line-0"));
  assert.throws(() => editTiming(p,"line-0","start",-1));
  assert.throws(() => editTiming(p,"line-0","end",21));
  p.lines[0].start=-1;p.lines[0].end=2;assert.throws(()=>confirmLine(p,"line-0"));
  assert.throws(()=>editTiming(p,"line-0","start",false));
});
test("subtitle clears during intro, interlude, outro and half-open cue ends", () => {
  const p = fixture();
  [0,4,6,19].forEach(t => assert.equal(activeCue(p,t),null));
  assert.equal(activeCue(p,2).id,"line-0");
  assert.equal(activeCue(p,13).id,"line-2");
  assert.deepEqual(layoutScene(p,6,s=>s.length*10), []);
});
test("scroll positions are deterministic under arbitrary seek order and inactivity", () => {
  const p = fixture(); p.style.mode="scroll";
  const measure=s=>s.length*30;
  const expected=layoutScene(p,12.15,measure);
  layoutScene(p,18,measure); layoutScene(p,0,measure);
  assert.deepEqual(layoutScene(p,12.15,measure),expected);
  assert.equal(expected.filter(l=>l.active).length,1);
  assert.equal(layoutScene(p,11,measure).some(l=>l.active),false);
});
test("wrapping keeps Japanese characters intact and accounts for multiline height", () => {
  assert.deepEqual(wrapText("あいうえお",2,s=>s.length),["あい","うえ","お"]);
  assert.deepEqual(wrapText("Hello world",7,s=>s.length),["Hello","world"]);
  const p=fixture(); p.style.mode="scroll"; p.lines[0].text="あ\nい\nう";
  const layout=layoutScene(p,7.5,s=>s.length*10);
  const active=layout.find(l=>l.active);
  assert.equal(active.y,1080*p.style.y);
});
test("multiple Undo/Redo preserves timing and review state", () => {
  const h=new History(); let p=fixture();
  p=h.change(p,editTiming(p,"line-0","start",2.2));
  p=h.change(p,confirmLine(p,"line-0"));
  p=h.undo(p); assert.equal(p.lines[0].review,true);
  p=h.undo(p); assert.equal(p.lines[0].start,2);
  p=h.redo(p); p=h.redo(p); assert.equal(p.lines[0].review,false);
});
test("project round-trip saves estimates, manual timing, style and asset references", () => {
  const p=fixture(); p.assets.media={id:"server-id",name:"mv.mp4",url:"/api/private"};
  p.lines[0].auto={start:1,end:4,evidence:{matchedCharacters:7}};
  p.lines[0].manual.start=true; p.style.mode="scroll";
  const saved=saveProject(p), restored=loadProject(JSON.parse(JSON.stringify(saved)));
  assert.equal(restored.assets.media.name,"mv.mp4"); assert.equal(restored.assets.media.id,undefined);
  assert.equal(restored.lines[0].auto.start,1); assert.equal(restored.lines[0].manual.start,true);
  assert.equal(restored.style.mode,"scroll"); assert.equal(p.assets.media.id,"server-id");
});
test("old project imports without mutation and retains Japanese/English SRT", () => {
  const old={type:"lyric-srt-studio-project",version:2,duration:10,lines:[{jp:"星",en:"Star",start:1,end:3}]};
  const before=JSON.stringify(old), p=loadProject(old);
  assert.equal(JSON.stringify(old),before); assert.deepEqual(p.legacy,old);
  assert.match(exportSrt(p,"jp"),/星/); assert.match(exportSrt(p,"en"),/Star/);
  assert.match(exportSrt(p,"bilingual"),/星\nStar/);
});
test("SRT and final video consume only the same confirmed cue intervals", () => {
  let p=fixture(); p=confirmLine(p,"line-0");
  assert.equal(cues(p,true).length,1);
  assert.match(exportSrt(p),/00:00:02,000 --> 00:00:04,000/);
  assert.doesNotMatch(exportSrt(p),/同じ歌詞/);
});

test("whole-row nudges preserve duration, text and automatic estimate without mutating input",()=>{
  const original=fixture();original.lines[0].auto={start:1.9,end:4.1};
  const later=shiftTiming(original,"line-0",.1),earlier=shiftTiming(later,"line-0",-.1);
  assert.equal(later.lines[0].start,2.1);assert.equal(later.lines[0].end,4.1);
  assert.ok(Math.abs(later.lines[0].end-later.lines[0].start-2)<1e-9);
  assert.equal(original.lines[0].start,2);assert.equal(earlier.lines[0].end,4);
  assert.deepEqual(later.lines[0].auto,original.lines[0].auto);
  assert.deepEqual(later.lines[0].manual,{start:true,end:true});assert.equal(later.lines[0].review,true);
  assert.equal(later.lines[0].text,original.lines[0].text);
  original.lines[0].start=2.123456;original.lines[0].end=4.987654;
  const precise=shiftTiming(original,"line-0",.1);
  assert.ok(Math.abs((precise.lines[0].end-precise.lines[0].start)-(original.lines[0].end-original.lines[0].start))<1e-9);
});
test("whole-row nudge rejects missing, reversed, negative and out-of-media intervals",()=>{
  const p=fixture();assert.throws(()=>shiftTiming(p,"line-0",-2.1));assert.throws(()=>shiftTiming(p,"line-2",7));
  p.lines[0].end=null;assert.throws(()=>shiftTiming(p,"line-0",.1));
  p.lines[0].end=1;assert.throws(()=>shiftTiming(p,"line-0",.1));assert.throws(()=>shiftTiming(p,"line-1",NaN));
});
test("whole-row shifts are one Undo step and report overlap through the existing quality checker",()=>{
  const h=new History();const p=fixture();p.lines[1].start=4.05;
  const later=h.change(p,shiftTiming(p,"line-0",.1));assert.ok(timingIssues(later).some(i=>i.index===0&&i.code==="overlap"));
  const restored=h.undo(later);assert.equal(restored.lines[0].start,2);assert.equal(restored.lines[0].end,4);
  assert.equal(h.redo(restored).lines[0].end,4.1);
});
test("every supported font survives project save/load; old and unknown fonts default to Noto Sans",()=>{
  assert.equal(FONTS.length,3);assert.ok(FONTS.every(f=>f.japanese));
  for(const font of FONTS){const p=fixture();p.style.fontId=font.id;const loaded=loadProject(saveProject(p));assert.equal(loaded.style.fontId,font.id);assert.equal(fontFamily(font.id),font.family);}
  const old=fixture();delete old.style.fontId;assert.equal(loadProject(old).style.fontId,"noto-sans");
  old.style.fontId="nonportable-system-font";assert.equal(loadProject(old).style.fontId,"noto-sans");assert.equal(normalizeFont("invalid"),"noto-sans");
});
test("font-dependent wrapping recalculates scroll geometry without changing timings or lyrics",()=>{
  const p=fixture();p.style.mode="scroll";p.style.width=.3;p.lines[0].text="あいうえおかきくけこさしすせそたちつてと";
  const before=JSON.stringify(p),narrow=layoutScene(p,7.5,s=>s.length*20),wide=layoutScene(p,7.5,s=>s.length*80);
  assert.ok(wide[0].wrapped.length>narrow[0].wrapped.length);assert.notEqual(wide[0].y,narrow[0].y);
  assert.equal(wide.find(l=>l.active).y,1080*p.style.y);assert.equal(JSON.stringify(p),before);
});
