// Generates a private URL locally. Never upload this output as a public asset.
import {readFile,writeFile} from 'node:fs/promises';
import {loadProject} from '../video/core.js';
import {encodeReviewLink} from '../video/review-link.js';
const [source,output,...options]=process.argv.slice(2);
if(!output)throw new Error('Usage: node engine/make-review-link.mjs project.json private-url.txt [--comparison] [--name NAME]');
const project=loadProject(JSON.parse(await readFile(source,'utf8')));
if(options.includes('--comparison')){
  project.style.y=.2;project.style.color='#78e3c7';project.style.fontSize=70;
  // A comparison copy lets the user choose the saved reference movie directly.
  project.assets={media:null,audio:null,background:null};
}
const nameIndex=options.indexOf('--name');if(nameIndex>=0&&options[nameIndex+1])project.name=options[nameIndex+1];
const base=process.env.STUDIO_REVIEW_BASE||'https://ashyouk.github.io/lyric-srt-studio/video/index.html?mode=browser&v=0.4.3';
const link=await encodeReviewLink(project,base);await writeFile(output,link,'utf8');
console.log(JSON.stringify({characters:link.length,rows:project.lines.length,output}));
