// Public CC0 singing only. Downloads no user media and calls no inference service.
import {mkdir,readFile,writeFile} from 'node:fs/promises';
import {existsSync} from 'node:fs';
import {resolve} from 'node:path';
import {execFileSync} from 'node:child_process';
const folder=resolve('.studio-data/verification');await mkdir(folder,{recursive:true});
const ogg=resolve(folder,'twinkle-full.ogg');
if(!existsSync(ogg)){
  const r=await fetch('https://upload.wikimedia.org/wikipedia/commons/4/4f/Twinkle_Twinkle_Little_Star_-_sung_with_full_lyrics.ogg');
  if(!r.ok)throw new Error('CC0 fixture download failed: '+r.status);
  await writeFile(ogg,Buffer.from(await r.arrayBuffer()));
}
const ff=(args,name)=>execFileSync('ffmpeg',['-hide_banner','-loglevel','error','-y',...args,resolve(folder,name)]);
ff(['-i',ogg,'-ac','1','-ar','16000'],'twinkle-full.wav');
ff(['-i',ogg,'-t','27','-ac','1','-ar','16000'],'twinkle-short.wav');
const short=resolve(folder,'twinkle-short.wav');
ff(['-f','lavfi','-i','testsrc2=size=640x480:rate=30','-itsoffset','0.5','-i',short,'-t','12','-c:v','libx264','-crf','18','-c:a','aac','-b:a','128k'],'test-mv.mp4');
ff(['-i',resolve(folder,'test-mv.mp4'),'-an','-c:v','copy'],'silent-mv.mp4');
ff(['-i',short,'-t','12','-c:a','libmp3lame'],'test.mp3');
ff(['-i',short,'-t','12','-c:a','aac'],'test.m4a');
ff(['-f','lavfi','-i','color=c=0x243d55:s=1280x720','-frames:v','1'],'background.png');
console.log('CC0 singing and FFmpeg test fixtures prepared in '+folder);
