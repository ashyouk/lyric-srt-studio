import assert from "node:assert/strict";
import {launchBrowser} from "./browser.mjs";
import {captureFrame} from "./frame.mjs";
import {newProject} from "../video/core.js";

// Start engine/server.py first. Synthetic text only; no song/model download needed.
const project = newProject("星の向こうへ Hello world\n長い歌詞も表示領域で折り返して位置を確かめる\n夜が明ける Goodbye");
project.duration = 6;
project.style.y = .5;
project.style.width = .4;
project.lines.forEach((line, i) => {line.start = i * 2 + .5; line.end = i * 2 + 1.5;});
const browser = await launchBrowser();
let checks = 0;
try {
  const page = await browser.newPage({viewport: {width: 1920, height: 1080}, deviceScaleFactor: 1});
  await page.goto((process.env.STUDIO_BASE_URL || "http://127.0.0.1:8765") + "/video/render.html");
  await page.waitForFunction(() => window.renderReady);
  for (const mode of ["subtitle", "scroll"]) {
    project.style.mode = mode;
    for (const time of [0, 1, 2.65, 4.8]) {
      const direct = await captureFrame(page, project, time);
      const screenshot = await page.locator("canvas").screenshot({type: "png", omitBackground: true});
      const mismatch = await page.evaluate(async ({a, b}) => {
        async function pixels(base64) {
          const image = new Image(); image.src = "data:image/png;base64," + base64;
          await image.decode();
          const canvas = document.createElement("canvas"); canvas.width = 1920; canvas.height = 1080;
          const ctx = canvas.getContext("2d"); ctx.drawImage(image, 0, 0);
          return ctx.getImageData(0, 0, 1920, 1080).data;
        }
        const x = await pixels(a), y = await pixels(b);
        let different = 0;
        for (let i = 0; i < x.length; i++) if (x[i] !== y[i]) different++;
        return different;
      }, {a: direct.toString("base64"), b: screenshot.toString("base64")});
      assert.equal(mismatch, 0, `${mode} @ ${time}: exported canvas equals visible renderer RGBA`);
      // A backwards seek must regenerate the identical frame, not retain animation state.
      await captureFrame(page, project, time + .1);
      assert.deepEqual(await captureFrame(page, project, time), direct);
      console.log(`PASS ${mode} @ ${time}s: exact PNG pixels and deterministic seek`);
      checks += 2;
    }
  }
  console.log(`COMPLETE ${checks} frame checks`);
} finally {await browser.close();}
