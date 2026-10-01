import {readFile} from "node:fs/promises";
import {spawn} from "node:child_process";
import {once} from "node:events";
import {launchBrowser} from "./browser.mjs";
import {captureFrame} from "./frame.mjs";
import {loadProject,videoExportProject} from "../video/core.js";

const request=JSON.parse(await readFile(process.argv[2],"utf8"));
const project=videoExportProject(loadProject(request.project),request.includeUnreviewed===true);
if(!project.lines.length) throw new Error(request.includeUnreviewed===true?"有効な時刻候補がありません。":"確認済みの字幕がありません。");
const FPS=30, duration=Number(request.duration), totalFrames=Math.ceil(duration*FPS);
if(!(duration>0&&duration<=300)) throw new Error("動画は5分以内にしてください。");
const event=(stage,fields={})=>process.stdout.write(JSON.stringify({stage,...fields})+"\n");
let browser, encoder;
const args=["-hide_banner","-loglevel","error","-y"];
const video=Boolean(request.sourceInfo.hasVideo);
if(video) args.push("-i",request.source);
else if(request.background) args.push("-loop","1","-i",request.background);
else args.push("-f","lavfi","-i",`color=c=${project.style.background}:s=1920x1080:r=${FPS}`);
args.push("-f","image2pipe","-framerate",String(FPS),"-vcodec","png","-i","pipe:0");
if(!video||request.audioSeparate) args.push("-i",request.audio);
const audioIndex=video&&!request.audioSeparate?0:2;
// Input timestamps are normalized by FFmpeg from each input's start_time. Do not use
// -copyts, -ss, speed filters or duplicate audio maps. Resample fills real leading gaps.
const filter=`[0:v]scale=1920:1080:force_original_aspect_ratio=decrease,pad=1920:1080:(ow-iw)/2:(oh-ih)/2:color=${project.style.background},setsar=1,fps=${FPS}[base];`+
  "[base][1:v]overlay=0:0:shortest=1:format=auto,format=yuv420p[v];"+
  `[${audioIndex}:a:0]aresample=async=1:first_pts=0,apad[a]`;
args.push("-filter_complex",filter,"-map","[v]","-map","[a]","-t",String(duration),
  "-c:v","libx264","-preset","fast","-crf","18","-pix_fmt","yuv420p",
  "-c:a","aac","-b:a","256k","-movflags","+faststart",request.output);
try {
  event("prepare-video",{message:"日本語フォントと共通描画を準備中"});
  browser=await launchBrowser();
  const page=await browser.newPage({viewport:{width:1920,height:1080},deviceScaleFactor:1,
    extraHTTPHeaders:process.env.STUDIO_TOKEN?{"x-studio-token":process.env.STUDIO_TOKEN}:{}});
  await page.goto(request.baseUrl+"/video/render.html");
  await page.waitForFunction(()=>window.renderReady);
  encoder=spawn("ffmpeg",args,{windowsHide:true,stdio:["pipe","ignore","pipe"]});
  let failure="";
  encoder.stderr.on("data",data=>{failure=(failure+data).slice(-8000);});
  const completed=new Promise((resolve,reject)=>{
    encoder.on("error",reject);
    encoder.on("close",code=>code===0?resolve():reject(new Error(failure||`FFmpeg exited ${code}`)));
  });
  // Attach immediately so early encoder failures are handled while frames are produced.
  completed.catch(()=>{});
  encoder.stdin.on("error",()=>{});
  for(let frame=0;frame<totalFrames;frame++) {
    const image=await captureFrame(page,project,frame/FPS);
    if(encoder.exitCode!==null) throw new Error(failure||"Encoder stopped");
    if(!encoder.stdin.write(image)) await Promise.race([once(encoder.stdin,"drain"),completed]);
    if(frame%30===0) event("render",{message:"歌詞を描き込み、MP4をエンコード中",frame:frame+1,totalFrames});
  }
  encoder.stdin.end();
  await completed;
  event("complete",{message:"音声付きMP4が完成しました。",frame:totalFrames,totalFrames});
} finally {
  if(encoder&&encoder.exitCode===null) encoder.kill();
  if(browser) await browser.close();
}
