import assert from 'node:assert/strict';
import {readFile,writeFile} from 'node:fs/promises';
import {resolve} from 'node:path';
import {launchBrowser} from './browser.mjs';
const browser=await launchBrowser(),page=await browser.newPage({viewport:{width:390,height:844}}),checks=[];
const check=(name,value)=>{assert.ok(value,name);checks.push(name);console.log('PASS '+name);};
try{
  await page.goto('http://127.0.0.1:8765/video/');await page.waitForFunction(()=>window.studio);
  const source=JSON.parse(await readFile('.studio-data/verification/full-request.json','utf8'));
  await page.locator('#lyrics').fill(source.lines.slice(0,4).map(l=>l.text).join('\n'));await page.locator('#apply-lyrics').click();
  await page.locator('#media-file').setInputFiles(resolve('.studio-data/verification/twinkle-short.wav'));
  await page.waitForFunction(()=>window.studio.snapshot().assets.media?.id&&Number.isFinite(document.querySelector('#audio').duration));
  await page.locator('#background-file').setInputFiles(resolve('.studio-data/verification/background.jpg'));
  await page.waitForFunction(()=>document.querySelector('#background').naturalWidth>0);
  check('JPEG background uploads and decodes',await page.evaluate(()=>window.studio.snapshot().assets.background.name==='background.jpg'));
  for(const [width,height] of [[320,740],[375,812],[390,844],[768,1024],[1024,768],[1440,1100]]){
    await page.setViewportSize({width,height});
    check('no horizontal overflow at '+width,await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth));
    check('fixed controls have 44px tap height at '+width,await page.evaluate(()=>[...document.querySelectorAll('.floating button')].every(b=>b.getBoundingClientRect().height>=44)));
  }
  check('touch buttons use manipulation without disabling viewport zoom',await page.evaluate(()=>getComputedStyle(document.querySelector('#record-start')).touchAction==='manipulation'&&!/user-scalable=no|maximum-scale=1/.test(document.querySelector('meta[name=viewport]').content)));
  await page.evaluate(()=>window.studio.seekTo(1.5));await page.locator('#record-start').click();
  check('paused media can record actual playback position',await page.evaluate(()=>window.studio.snapshot().lines[0].start===1.5));
  await page.locator('#fixed-undo').click();
  check('fixed Undo restores unrecorded state',await page.evaluate(()=>window.studio.snapshot().lines[0].start===null));
  await page.locator('#fixed-redo').click();
  check('fixed Redo restores recorded state',await page.evaluate(()=>window.studio.snapshot().lines[0].start===1.5));
  await writeFile('.studio-data/verification/browser/mobile-results.json',JSON.stringify(checks,null,2));
  console.log(`COMPLETE ${checks.length} mobile-layout checks`);
}finally{await browser.close();}
