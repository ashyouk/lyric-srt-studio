import {test} from "node:test";
import assert from "node:assert/strict";
import {parseLyrics, newProject, loadProject, saveProject, applyAlignment, editTiming, confirmLine,
  History, cues, activeCue, exportSrt, layoutScene, wrapText} from "./core.js";

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
test("alignment applies acoustic estimates without replacing display or reading text", () => {
  const p = fixture(), text = p.lines.map(l => l.text);
  p.lines[0].alignmentText = "ほしよ hello world";
  const next = applyAlignment(p, {engine: "real-model", lines: p.lines.map(l => ({id:l.id,start:3,end:4,reasons:["review"]}))});
  assert.deepEqual(next.lines.map(l => l.text), text);
  assert.equal(next.lines[0].alignmentText, "ほしよ hello world");
  assert.equal(next.lines[0].start, 3); assert.equal(next.lines[0].review, true);
  assert.equal(p.lines[0].start, 2);
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
