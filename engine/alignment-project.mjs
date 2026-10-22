// Convert a private acoustic experiment into a reviewable version-1 project.
// Reference video times are deliberately not copied into the project.
import {readFile,writeFile} from 'node:fs/promises';
import {basename} from 'node:path';
import {newProject,applyAlignment,saveProject,validTime} from '../video/core.js';

const [requestPath,resultPath,outputPath]=process.argv.slice(2);
if(!outputPath)throw new Error('Usage: node engine/alignment-project.mjs request.json acoustic-result.json output.lyricvideo.json');
const request=JSON.parse(await readFile(requestPath,'utf8'));
const result=JSON.parse(await readFile(resultPath,'utf8'));
const canonical=request.reference||request.lines;
if(!Array.isArray(canonical)||!canonical.length||!Number.isFinite(result.duration)||result.duration<=0)
  throw new Error('Canonical lines and a valid acoustic duration are required.');
const ids=new Set(canonical.map(l=>l.id));
if(ids.size!==canonical.length)throw new Error('Canonical row IDs must be unique.');
const estimates=new Map(result.lines.map(l=>[l.id,l]));
if(canonical.some(l=>!estimates.has(l.id)))throw new Error('Acoustic result does not cover the canonical row IDs.');
let project=newProject(canonical.map(l=>l.text).join('\n'));
if(project.lines.length!==canonical.length)throw new Error('Canonical lines must contain nonempty subtitle text, not section tags.');
project.duration=result.duration;
project.name='自動同期・実曲検証（全行要確認）';
project.assets.media={name:basename(request.audio),kind:'audio',duration:result.duration,reselect:true};
const lines=canonical.map((line,i)=>({...estimates.get(line.id),id:project.lines[i].id}));
project=applyAlignment(project,{...result,lines});
project.alignment.asrModel=result.diagnostics?.asrModel||result.engine;
for(const line of project.lines){
  if(validTime(line.start)&&(!validTime(line.end)||line.start<0||line.end<=line.start||line.end>project.duration+.15))
    throw new Error('Invalid acoustic interval; fix the experiment before importing.');
}
project.alignment.chunkSeconds=result.chunkSeconds||0;
project.alignment.notes=request.provenance||'Acoustic candidates, not human-confirmed timing.';
await writeFile(outputPath,JSON.stringify(saveProject(project),null,2),'utf8');
console.log(JSON.stringify({rows:project.lines.length,placed:project.lines.filter(l=>validTime(l.start)).length,
  allReviewRequired:project.lines.every(l=>l.review&&!l.manual.start&&!l.manual.end),output:outputPath}));
