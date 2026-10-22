import test from 'node:test';
import assert from 'node:assert/strict';
import {gzipSync} from 'node:zlib';
import {newProject} from './core.js';
import {encodeReviewLink,decodeReviewFragment} from './review-link.js';

function fixture(){const p=newProject('歌詞 日本語\nHello\n歌詞 日本語');p.duration=20;p.lines.forEach((l,i)=>Object.assign(l,{start:i*3,end:i*3+2,auto:{start:i*3,end:i*3+2,evidence:{matchedCharacters:3}}}));p.lines[1].manual.start=true;p.lines[1].review=false;p.assets.media={id:'stale',url:'https://must-not-fetch.invalid/private.wav',kind:'audio',name:'song.wav'};return p;}
const base='https://example.invalid/video/index.html?mode=browser';
test('review link round-trip preserves Japanese, repeats, timing, review and estimates without asset URLs',async()=>{
  const p=fixture(),url=new URL(await encodeReviewLink(p,base));
  assert.equal(url.search,'?mode=browser');assert.ok(!url.hash.includes('歌詞'));
  const loaded=await decodeReviewFragment(url.hash);
  assert.deepEqual(loaded.lines,p.lines);assert.equal(loaded.assets.media.url,undefined);
  assert.equal(loaded.assets.media.id,undefined);assert.equal(loaded.assets.media.reselect,true);
  assert.equal(p.assets.media.id,'stale');
});
test('ordinary page anchors are ignored',async()=>{assert.equal(await decodeReviewFragment('#editing'),null);});
test('malformed and truncated payloads have readable failures',async()=>{
  for(const hash of ['#review=unknown.abc','#review=gz1.AA','#review=json1.%%%'])
    await assert.rejects(decodeReviewFragment(hash),/確認リンク/);
});
test('schema and duplicate row IDs are rejected before import',async()=>{
  const p=fixture();p.lines[1].id=p.lines[0].id;
  await assert.rejects(encodeReviewLink(p,base),/重複/);
  await assert.rejects(encodeReviewLink({...p,version:2},base),/形式/);
});
test('compressed size expansion and excessively long links are bounded',async()=>{
  const bomb=gzipSync(Buffer.alloc(800*1024,32)).toString('base64url');
  await assert.rejects(decodeReviewFragment('#review=gz1.'+bomb),/大きすぎ/);
  await assert.rejects(decodeReviewFragment('#review=json1.'+'A'.repeat(140000)),/長すぎ/);
});
test('JSON fallback also loads when compression is unavailable',async()=>{
  const original=globalThis.CompressionStream;globalThis.CompressionStream=undefined;
  try{const url=new URL(await encodeReviewLink(fixture(),base));assert.match(url.hash,/#review=json1\./);assert.equal((await decodeReviewFragment(url.hash)).lines.length,3);}
  finally{globalThis.CompressionStream=original;}
});
test('missing decompression gives guidance rather than changing any project',async()=>{
  const url=new URL(await encodeReviewLink(fixture(),base)),original=globalThis.DecompressionStream;
  globalThis.DecompressionStream=undefined;
  try{await assert.rejects(decodeReviewFragment(url.hash),/Safari/);}
  finally{globalThis.DecompressionStream=original;}
});
