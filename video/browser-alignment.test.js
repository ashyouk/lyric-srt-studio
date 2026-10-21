import test from 'node:test';import assert from 'node:assert/strict';
import {matchAcousticWords,normalizeMatch} from './browser-alignment.js';
import {newProject,applyAlignment,History,saveProject,loadProject,exportSrt,confirmLine} from './core.js';
const words=[{text:'Hello',timestamp:[3,4]},{text:'世界',timestamp:[4,6]},{text:'Again',timestamp:[12,14]}];
test('canonical Japanese/English, blanks, tags and rests stay intact; acoustic intervals only',()=>{
  const p=newProject('[Verse]\nHello 世界\n\nAgain');const result=matchAcousticWords(p.lines,words,20);
  assert.deepEqual(result.map(l=>[l.start,l.end]),[[3,6],[12,14]]);assert.ok(result.every(l=>l.review));
  const next=applyAlignment(p,{engine:'test-acoustic',lines:result});assert.equal(next.lyrics,p.lyrics);assert.equal(next.lines[0].text,'Hello 世界');assert.equal(p.lines[0].start,null);
});
test('unheard rows and invalid/zero/null timestamps remain unplaced, never evenly distributed',()=>{
  const p=newProject('Hello\nNot sung\nAgain');const out=matchAcousticWords(p.lines,[...words,{text:'Not sung',timestamp:[null,8]}],20);
  assert.equal(out[1].start,null);assert.equal(out[0].start,3);assert.equal(out[2].start,12);
  assert.ok(matchAcousticWords(p.lines,[],20).every(l=>l.start===null));
});
test('repeated lyric occurrences use distinct chronological evidence',()=>{
  const p=newProject('Hello\nHello');const out=matchAcousticWords(p.lines,[{text:'Hello',timestamp:[1,2]},{text:'Hello',timestamp:[8,9]}],12);
  assert.deepEqual(out.map(l=>l.start),[1,8]);
});
test('a contiguous early phrase is not scattered across later unrelated rows',()=>{
  const p=newProject('カーテンを閉じろ\n毎朝\nそれで\n押し込まれたくねえ\nあぁ夜が来た');
  const out=matchAcousticWords(p.lines,[{text:'勝手を閉じろ',timestamp:[4,7]}],30);
  assert.equal(out[0].candidateStart,4);assert.equal(out[0].evidence.matchedCharacters,4);
  assert.ok(out.slice(1).every(l=>l.start===null));
});
test('manual timing is protected; real estimates are undoable, saveable and require confirmation for SRT',()=>{
  const p=newProject('Hello 世界\nAgain');p.duration=20;p.lines[0].manual.start=true;p.lines[0].start=2;p.lines[0].end=7;
  const out={engine:'test-acoustic',lines:matchAcousticWords(p.lines,words,20)};const history=new History();const next=history.change(p,applyAlignment(p,out));
  assert.equal(next.lines[0].start,2);assert.equal(next.lines[1].start,12);assert.equal(history.undo(next).lines[1].start,null);assert.equal(history.redo(p).lines[1].start,12);
  assert.equal(exportSrt(next),'');const restored=loadProject(saveProject(confirmLine(next,next.lines[1].id)));
  assert.match(exportSrt(restored),/00:00:12,000 --> 00:00:14,000/);
});
test('normalization is matching-only and overly large matrices reject rather than freezing the UI',()=>{
  assert.deepEqual(normalizeMatch('Ｈi、世界！'),['h','i','世','界']);
  assert.throws(()=>matchAcousticWords([{id:'x',text:'x'.repeat(6000)}],[{text:'x'.repeat(6000),timestamp:[1,2]}],10),/長すぎ/);
});
