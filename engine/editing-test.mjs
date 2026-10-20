import assert from "node:assert/strict";
import {readFile,writeFile,mkdir} from "node:fs/promises";
import {resolve} from "node:path";
import {launchBrowser} from "./browser.mjs";
import {FONTS} from "../video/font-catalog.js";
const base=process.env.STUDIO_BASE_URL||"http://127.0.0.1:8765", folder=resolve(".studio-data/verification/editing");
await mkdir(folder,{recursive:true});
// Existing real acoustic estimates. No ASR mocks or fabricated synchronization.
const projectPath=resolve(process.env.STUDIO_EDIT_PROJECT||".studio-data/verification/browser/scroll-project.json"),audioPath=resolve(process.env.STUDIO_EDIT_AUDIO||".studio-data/verification/japanese-speech.wav");
const project=JSON.parse(await readFile(projectPath,"utf8"));
const browser=await launchBrowser(),context=await browser.newContext({viewport:{width:1440,height:1050}}),page=await context.newPage(),checks=[],errors=[];
const check=(name,value)=>{assert.ok(value,name);checks.push(name);console.log("PASS "+name);};
context.on("page",p=>p.on("pageerror",e=>errors.push(e.message)));page.on("pageerror",e=>errors.push(e.message));
let jobs=0;page.on("request",r=>{if(r.method()==="POST"&&r.url().includes("/api/jobs/"))jobs++;});
const state=()=>page.evaluate(()=>window.studio.snapshot());
const png=target=>target.evaluate(()=>document.querySelector("canvas").toDataURL());
async function popup(){const next=page.waitForEvent("popup");await page.locator("#edit-open-preview").click();const p=await next;await p.waitForFunction(()=>document.querySelector("#popup-status").textContent.includes("リアルタイム"));return p;}
try{
  await page.goto(base+"/video/");await page.waitForFunction(()=>window.studio);
  await page.locator("#project-file").setInputFiles(projectPath);
  await page.waitForFunction(n=>window.studio.snapshot().lines.length===n,project.lines.length);
  await page.locator("#media-file").setInputFiles(audioPath);
  await page.waitForFunction(()=>window.studio.snapshot().assets.media?.id&&Number.isFinite(document.querySelector("#audio").duration));
  await page.locator("#lyrics").fill(project.lyrics+"\n");
  await page.locator("#tab-editing").click();await page.evaluate(()=>window.studio.selectRow(window.studio.snapshot().lines[0].id));
  const initial=await state(),before=initial.lines[0],row=page.locator(".lyric-row").first();
  await row.locator('[data-action="shift"][data-delta=".1"]').click();
  const shifted=(await state()).lines[0];
  check("whole-row +0.1 seconds preserves actual acoustic interval duration",Math.abs(shifted.start-before.start-.1)<1e-9&&Math.abs(shifted.end-before.end-.1)<1e-9);
  const saved=JSON.stringify(await state()),history=await page.evaluate(()=>window.studio.inspection());const time=await page.evaluate(()=>window.studio.currentTime());
  await page.locator("#tab-production").click();check("draft lyrics survive tabs",(await page.locator("#lyrics").inputValue())===project.lyrics+"\n");await page.locator("#tab-editing").click();
  check("tabs retain project, media position and Undo history",JSON.stringify(await state())===saved&&await page.evaluate(()=>window.studio.inspection().past)===history.past&&Math.abs(await page.evaluate(()=>window.studio.currentTime())-time)<.01);
  let child=await popup();
  check("popup has no audio/video elements and exactly one audible parent source",await child.locator("audio,video").count()===0&&await page.evaluate(()=>document.querySelector("#audio").getAttribute("src")&&!document.querySelector("#video").getAttribute("src")));
  const cueTime=before.start+.5;await page.evaluate(t=>window.studio.seekTo(t),cueTime);await child.waitForFunction(t=>Math.abs(Number(document.querySelector("#popup-seek").value)-t)<.02,cueTime);
  check("popup initial state/parent seeks share the authoritative clock",Math.abs(Number(await child.locator("#popup-seek").inputValue())-cueTime)<.02);
  const firstImage=await png(child);
  await row.locator('input[data-field="end"]').fill(String(cueTime-.1));await row.locator('input[data-field="end"]').dispatchEvent("change");
  await child.waitForFunction(()=>document.querySelector("#popup-line").textContent.includes("なし"));
  check("paused timing edit changes child without reload",await png(child)!==firstImage);
  await page.locator("#undo").click();await child.waitForFunction(()=>!document.querySelector("#popup-line").textContent.includes("なし"));
  check("Undo restores exact popup pixels while paused",await png(child)===firstImage);
  await page.locator("#redo").click();await child.waitForFunction(()=>document.querySelector("#popup-line").textContent.includes("なし"));await page.locator("#undo").click();
  check("Redo and multi-step Undo sync both preview views",await page.evaluate(()=>window.studio.inspection().future===1));
  await page.locator("#tab-production").click();const originalLyrics=(await state()).lyrics;
  await page.locator("#lyrics").fill(originalLyrics.replace(before.text,before.text+" · 表示確認"));await page.locator("#apply-lyrics").click();
  await page.evaluate(t=>window.studio.seekTo(t),shifted.start);await page.locator("#record-start").click();await page.evaluate(t=>window.studio.seekTo(t),shifted.end);await page.locator("#record-end").click();await page.evaluate(t=>window.studio.seekTo(t),cueTime);
  await child.waitForFunction(()=>document.querySelector("#popup-line").textContent.includes("表示確認"));check("canonical lyric edits update popup without reloading or analysis",(await child.locator("#popup-line").textContent()).includes("表示確認"));
  await page.locator("#fixed-undo").click();await page.locator("#fixed-undo").click();await page.locator("#fixed-undo").click();await page.locator("#tab-editing").click();
  await child.waitForFunction(()=>!document.querySelector("#popup-line").textContent.includes("表示確認"));
  await child.locator("#popup-play").click();await page.waitForFunction(()=>!document.querySelector("#audio").paused);await child.waitForTimeout(350);
  check("popup Play controls the single parent media clock",await page.evaluate(()=>window.studio.currentTime())>cueTime+.2);
  await page.locator("#edit-play").click();await child.waitForFunction(()=>document.querySelector("#popup-play").textContent.includes("再生"));
  await child.locator("#popup-seek").evaluate(el=>{el.value="10";el.dispatchEvent(new Event("input",{bubbles:true}));});
  check("popup seek changes parent position",Math.abs(await page.evaluate(()=>window.studio.currentTime())-10)<.02);
  await page.locator("#edit-play").click();const running=await page.evaluate(()=>window.studio.currentTime());await row.locator('[data-action="shift"][data-delta="-.1"]').click();
  check("nudge while playing never resets playback position",await page.evaluate(()=>window.studio.currentTime())>=running-.02);await page.locator("#edit-play").click();
  const pages=context.pages().length;await page.locator("#edit-open-preview").click();check("repeated detach focuses existing window",context.pages().length===pages);
  await child.close();await page.waitForFunction(()=>!window.studio.inspection().detached);await page.locator("#tab-production").click();check("closing popup safely restores embedded preview",await page.locator("#stage").isVisible());
  await page.locator("#tab-editing").click();child=await popup();await child.locator("#popup-return").click();await page.waitForFunction(()=>!window.studio.inspection().detached);check("reopen then return closes popup and restores embedded state",child.isClosed());
  // Simulate a browser-blocked window, not a media/analysis mock.
  await page.evaluate(()=>{window.savedOpen=window.open;window.open=()=>null;});await page.locator("#edit-open-preview").click();
  check("blocked popup reports error without removing embedded editing preview",(await page.locator("#message").textContent()).includes("ブロック")&&await page.locator("#edit-canvas").isVisible());await page.evaluate(()=>{window.open=window.savedOpen;delete window.savedOpen;});
  await page.locator("#tab-production").click();await page.locator("#lyrics").fill(project.lyrics);
  const hashes=[];
  for(const f of FONTS){await page.locator("#font-choice").selectOption(f.id);await page.waitForFunction(id=>window.studio.snapshot().style.fontId===id,f.id);await page.evaluate(t=>window.studio.seekTo(t),cueTime);hashes.push(await png(page));await page.locator("#tab-editing").click();child=await popup();
    check(f.id+" font renders same glyphs in compact and popup previews",await child.evaluate(()=>document.querySelector("canvas").toDataURL())===await page.locator("#edit-canvas").evaluate(c=>c.toDataURL()));
    if(f.id==="noto-sans"){await page.locator("#tab-production").click();const previous=await png(child);await page.locator("#font-choice").selectOption("noto-serif");await page.waitForFunction(()=>window.studio.snapshot().style.fontId==="noto-serif");await child.waitForFunction(previous=>document.querySelector("canvas").toDataURL()!==previous,previous);check("changing font updates an already-open paused popup without reload",await png(child)!==previous);}
    await child.close();await page.waitForFunction(()=>!window.studio.inspection().detached);await page.locator("#tab-production").click();}
  check("all three bundled fonts produce distinct visible glyphs",new Set(hashes).size===3);
  const download=page.waitForEvent("download");await page.locator("#save-project").click();const file=await download;await file.saveAs(resolve(folder,"saved.json"));const savedProject=JSON.parse(await readFile(resolve(folder,"saved.json"),"utf8"));
  await page.locator("#project-file").setInputFiles(resolve(folder,"saved.json"));await page.waitForFunction(()=>!window.studio.snapshot().assets.media?.id);
  check("font and manual corrections round-trip without rerunning alignment",(await state()).style.fontId==="zen-maru"&&(await state()).lines[0].start===savedProject.lines[0].start&&jobs===0);
  await page.locator("#tab-editing").click();await page.locator("#filter-review").click();check("review filter uses existing actual review flags",await page.locator(".lyric-row").count()===(await state()).lines.filter(l=>l.review).length);
  await page.locator("#filter-all").click();for(const row of await page.locator(".lyric-row").all()){if(await row.locator('[data-action="confirm"]').isEnabled())await row.locator('[data-action="confirm"]').click();}
  await page.locator("#filter-review").click();check("no-review state explicitly offers all rows",(await page.locator("#rows").textContent()).includes("要確認の行はありません"));await page.locator("#filter-all").click();
  for(const [width,height] of [[320,740],[390,844],[768,1024],[1024,768],[1440,1050]]){await page.setViewportSize({width,height});check("editing has no horizontal overflow at "+width,await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth));await page.screenshot({path:resolve(folder,`editing-${width}.png`),fullPage:true});}
  await page.locator("#tab-production").click();await page.locator("#media-file").setInputFiles(resolve(".studio-data/verification/test-mv.mp4"));await page.waitForFunction(()=>window.studio.snapshot().assets.media?.kind==="video"&&document.querySelector("#video").readyState>=2);
  await page.locator("#tab-editing").click();child=await popup();await page.evaluate(()=>window.studio.seekTo(2));await page.waitForFunction(()=>!document.querySelector("#video").seeking);await child.waitForTimeout(100);const mvImage=await png(child);
  check("MV pixels match compact and detached preview with parent stage hidden",mvImage===await page.locator("#edit-canvas").evaluate(c=>c.toDataURL()));
  await child.locator("#popup-play").click();await page.waitForTimeout(450);await child.locator("#popup-play").click();await child.waitForTimeout(100);check("hidden parent MV continues decoding real moving frames for popup",await png(child)!==mvImage&&await page.evaluate(()=>window.studio.currentTime())>2.3);await child.close();
  await page.locator(".edit-monitor").scrollIntoViewIfNeeded();await page.screenshot({path:resolve(folder,"editing-desktop-viewport.png")});await page.setViewportSize({width:390,height:844});await page.locator(".edit-monitor").scrollIntoViewIfNeeded();await page.screenshot({path:resolve(folder,"editing-mobile-viewport.png")});
  await page.locator('.lyric-row input[data-field="start"]').first().focus();check("mobile field focus releases sticky monitor and hides compact canvas for keyboard",await page.evaluate(()=>getComputedStyle(document.querySelector(".edit-monitor")).position==="static"&&getComputedStyle(document.querySelector(".compact-stage")).display==="none"));await page.locator("#filter-all").focus();check("leaving field restores compact preview",await page.locator("#edit-canvas").isVisible());
  check("no uncaught parent or popup errors",errors.length===0);
  const keyboardBefore=JSON.stringify(await state());await page.locator("#tab-editing").focus();await page.keyboard.press("ArrowLeft");await page.keyboard.press("Space");check("accessible tab keyboard controls do not record timestamps",(await page.evaluate(()=>window.studio.inspection().activeTab))==="production"&&JSON.stringify(await state())===keyboardBefore);
  const lanPage=await context.newPage();await lanPage.addInitScript(()=>Object.defineProperty(crypto,"randomUUID",{value:undefined}));await lanPage.goto(base+"/video/");await lanPage.waitForFunction(()=>window.studio);check("initialization works without secure-context-only randomUUID (LAN compatibility)",await lanPage.locator("#tab-editing").isVisible());await lanPage.close();
  await writeFile(resolve(folder,"results.json"),JSON.stringify({checks,errors},null,2));console.log(`COMPLETE ${checks.length} editing checks`);
}finally{await browser.close();}
