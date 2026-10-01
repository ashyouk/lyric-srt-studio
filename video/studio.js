import {newProject,loadProject,saveProject,parseLyrics,applyAlignment,editTiming,confirmLine,
  cues,exportSrt,drawLyrics,History,validTime} from "./core.js";

const $=selector=>document.querySelector(selector);
const STORAGE="lyric-video-studio-prototype-v1";
let project=newProject(), selected=null, jobId=null, busy=false;
const history=new History();
const video=$("#video"),audio=$("#audio"),canvas=$("#canvas"),ctx=canvas.getContext("2d");
const message=(text,error=false)=>{$("#message").textContent=text;$("#message").classList.toggle("error",error);};
const timeLabel=t=>`${String(Math.floor(Math.max(0,t)/60)).padStart(2,"0")}:${(Math.max(0,t)%60).toFixed(3).padStart(6,"0")}`;
const escape=text=>String(text??"").replace(/[&<>"']/g,c=>({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"}[c]));
const clock=()=>project.assets.media?.kind==="video"?video:audio;
const signature=()=>JSON.stringify(project.lines.map(l=>[l.id,l.text,l.alignmentText]));

async function api(path,options={}) {
  const response=await fetch(path,options);
  const value=await response.json();
  if(!response.ok) throw new Error(typeof value.detail==="string"?value.detail:"処理用PCとの通信に失敗しました。");
  return value;
}
const safely=fn=>async event=>{try{await fn(event);}catch(error){message(error.message,true);}};
function persist(){try{localStorage.setItem(STORAGE,JSON.stringify(saveProject(project)));}catch{message("自動保存できません。プロジェクトファイルを保存してください。",true);}}
function commit(next){project=history.change(project,next);persist();render();}
function refreshHistory(){["#undo","#fixed-undo"].forEach(s=>$(s).disabled=!history.past.length);["#redo","#fixed-redo"].forEach(s=>$(s).disabled=!history.future.length);}
function unload(){video.pause();audio.pause();[video,audio].forEach(el=>{el.removeAttribute("src");el.load();});$("#background").removeAttribute("src");$("#background").hidden=true;}
function attachMedia(){
  video.pause();audio.pause();
  const main=project.assets.media, separate=project.assets.audio;
  video.hidden=main?.kind!=="video";
  if(main?.kind==="video") {video.src=main.url;video.muted=Boolean(separate);if(separate) audio.src=separate.url;else {audio.removeAttribute("src");audio.load();}}
  else if(main?.url) audio.src=main.url;
  const background=project.assets.background;
  $("#background").hidden=!background?.url||main?.kind==="video";
  if(background?.url) $("#background").src=background.url;
  $("#extra-audio-field").hidden=main?.kind!=="video"||main?.hasAudio;
  $("#media-name").textContent=main?`${main.name} · ${timeLabel(project.duration)}${main.reselect?"（再選択してください）":""}`:"素材が未選択です。";
  $("#background-name").textContent=background?.name||"";
}
async function upload(file,kind){
  if(!file) return;
  message(`${file.name}を処理用PCへコピーしています…`);
  const form=new FormData();form.append("file",file);
  const asset=await api("/api/media",{method:"POST",body:form});
  if(kind==="media"&&asset.kind==="image") throw new Error("MVまたは音源を選択してください。画像は背景欄で選べます。");
  if(kind==="audio"&&!asset.hasAudio) throw new Error("音声を含む素材を選択してください。");
  if(kind==="background"&&asset.kind!=="image") throw new Error("背景はPNGまたはJPEGを選択してください。");
  const next=structuredClone(project);next.assets[kind]=asset;
  if(kind==="media") {next.duration=asset.duration;next.assets.audio=null;}
  commit(next);attachMedia();
  message(kind==="media"&&!asset.hasAudio?"動画に音声がありません。追加の音源を選択してください。":"素材を読み込みました。");
}
function applyLyrics(){
  const raw=$("#lyrics").value;
  if(raw===project.lyrics&&project.lines.length) return;
  const parsed=parseLyrics(raw);
  if(!parsed.length) throw new Error("歌詞を1行以上貼り付けてください。");
  const previous=new Map(project.lines.map(l=>[l.id,l]));
  const next=structuredClone(project);next.lyrics=raw;
  next.lines=parsed.map(l=>previous.get(l.id)?.text===l.text?previous.get(l.id):l);
  selected=next.lines[0]?.id;commit(next);message(`${next.lines.length}行を反映しました。`);
}
function selectRow(id,seek=true){selected=id;render();const line=project.lines.find(l=>l.id===id);if(seek&&validTime(line?.start)) seekTo(Math.max(0,line.start-.5));}
function seekTo(time){
  const target=Math.min(project.duration,Math.max(0,time));
  if(clock().getAttribute("src")) clock().currentTime=target;
  if(project.assets.media?.kind==="video"&&project.assets.audio?.url&&Number.isFinite(audio.duration)) audio.currentTime=Math.min(target,audio.duration);
  draw();
}
async function playback(){
  if(!project.assets.media?.id) throw new Error("素材を選択し直してください。");
  const playing=!clock().paused;
  if(playing){video.pause();audio.pause();}
  else {
    if(project.assets.media.kind==="video") {
      const tasks=[video.play()];
      if(project.assets.audio?.url) {audio.currentTime=Math.min(video.currentTime,Number.isFinite(audio.duration)?audio.duration:video.currentTime);tasks.push(audio.play());}
      await Promise.all(tasks);
    } else await audio.play();
  }
  draw();
}
function record(field){
  if(!project.assets.media?.id||!clock().getAttribute("src")) throw new Error("先に素材を選択してください。");
  if(project.assets.media.kind==="video"&&!project.assets.media.hasAudio&&!project.assets.audio?.id) throw new Error("音声がない動画には音源を追加してください。");
  if(!selected) throw new Error("歌詞行を選択してください。");
  commit(editTiming(project,selected,field,clock().currentTime));message(`選択行の${field==="start"?"開始":"終了"}を記録しました。`);
}
function render(){
  if(!project.lines.some(l=>l.id===selected)) selected=project.lines[0]?.id;
  const row=project.lines.find(l=>l.id===selected);
  $("#active-text").textContent=row?`${project.lines.indexOf(row)+1} · ${row.text}`:"歌詞が未入力です";
  $("#review-count").textContent=`${project.lines.length}行 / 要確認 ${project.lines.filter(l=>l.review).length} / 確認済み ${cues(project,true).length}`;
  $("#rows").innerHTML=project.lines.length?project.lines.map((l,i)=>`<article class="lyric-row ${l.id===selected?"selected":""}" data-id="${escape(l.id)}">
    <button class="row-number" data-action="select" aria-label="${i+1}行目を選択して付近へ移動">${i+1}</button>
    <div><div class="row-text">${escape(l.text)}</div><span class="row-state ${!l.review?"confirmed":""}">${l.review?"要確認":"確認済み"}${l.manual.start||l.manual.end?" · 手動修正":""}</span></div>
    <div class="row-tools">${["start","end"].map(field=>`<div><label>${field==="start"?"開始":"終了"}（秒）<input type="number" min="0" max="${project.duration}" step="0.01" data-field="${field}" value="${validTime(l[field])?l[field]:""}"></label><div class="buttons"><button data-action="adjust" data-field="${field}" data-delta="-.1">−0.1</button><button data-action="adjust" data-field="${field}" data-delta=".1">＋0.1</button></div></div>`).join("")}<button data-action="select">付近を再生</button><button data-action="confirm" ${!validTime(l.start)||!validTime(l.end)?"disabled":""}>確認済みにする</button></div>
    <details class="row-details"><summary>照合用テキストと確認理由</summary><input type="text" aria-label="${i+1}行目の照合用テキスト" data-field="alignmentText" value="${escape(l.alignmentText)}"><p>${escape((l.reasons||[]).join(" "))}</p>${l.auto?`<p>自動候補 ${timeLabel(l.auto.candidateStart??l.auto.start??0)} → ${timeLabel(l.auto.candidateEnd??l.auto.end??0)} · 音声認識との照合文字 ${l.auto.evidence?.matchedCharacters??"—"}/${l.auto.evidence?.inputCharacters??"—"}（精度保証の数値ではありません）</p>`:""}</details></article>`).join(""):"<p class='hint'>歌詞を貼り付けて反映してください。</p>";
  refreshHistory();draw();
}
function draw(){
  const current=clock().currentTime||0;
  $("#stage").style.background=project.style.background;
  drawLyrics(ctx,project,current);
  $("#seek").max=String(project.duration||1);$("#seek").value=String(current);
  $("#time").textContent=`${timeLabel(current)} / ${timeLabel(project.duration)}`;
  $("#play").textContent=clock().paused?"▶ 再生":"Ⅱ 停止";
  $("#fixed-play").textContent=clock().paused?"▶":"Ⅱ";
  $("#fixed-play").setAttribute("aria-label",clock().paused?"素材を再生":"素材を一時停止");
  $("#fixed-play").title=clock().paused?"素材を再生":"素材を一時停止";
}
function setStyleInputs(){
  const s=project.style;
  for(const [id,key] of [["style-mode","mode"],["font-size","fontSize"],["font-color","color"],["shadow","shadow"],["position","y"],["lyric-width","width"],["background-color","background"]]) $("#"+id).value=s[key];
}
function blobDownload(content,name,type){const url=URL.createObjectURL(new Blob([content],{type}));const link=document.createElement("a");link.href=url;link.download=name;link.click();setTimeout(()=>URL.revokeObjectURL(url),5000);}
async function runJob(kind){
  if(busy) throw new Error("実行中の処理を完了またはキャンセルしてください。");
  applyLyrics();
  if(!project.assets.media?.id) throw new Error("素材を選択し直してください。");
  const audition=kind==="export"&&$("#export-mode").value==="audition";
  if(kind==="export"&&!cues(project,!audition).length) throw new Error(audition?"先に自動同期または手動で時刻候補を指定してください。":"少なくとも1行を聴いて「確認済み」にしてください。");
  if(kind==="export") message(audition?"要確認の時刻候補を含む試写MP4です。行の確認状態は変更しません。":"要確認の行はMP4へ描き込みません。確認済みの行だけを書き出します。");
  const startedSignature=signature(),startedMedia=project.assets.media.id;
  const body={mediaId:startedMedia,audioId:project.assets.audio?.id,backgroundId:project.assets.background?.id,
    lines:project.lines.map(({id,text,alignmentText})=>({id,text,alignmentText})),project,method:$("#method").value,
    asrModel:$("#asr-model").value,includeUnreviewed:audition};
  busy=true;$("#align").disabled=true;$("#export").disabled=true;$("#job-panel").hidden=false;$("#cancel").hidden=false;$("#download-video").hidden=true;
  try {
    const submitted=await api(`/api/jobs/${kind}`,{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify(body)});
    jobId=submitted.id;
    while(true){
      const job=await api(`/api/jobs/${jobId}`);
      $("#job-status").textContent=job.message||job.stage;
      $("#job-progress").hidden=!job.totalFrames;
      if(job.totalFrames){$("#job-progress").max=job.totalFrames;$("#job-progress").value=job.frame||0;}
      if(job.status==="complete"){
        if(kind==="align"){
          if(signature()!==startedSignature||project.assets.media.id!==startedMedia) throw new Error("処理中に歌詞または素材が変更されました。結果は適用せず、再同期してください。");
          commit(applyAlignment(project,job.result));message(`同期候補を作りました（${job.result.elapsedSeconds}秒）。要確認行を再生してください。`);
        } else {$("#download-video").href=job.result.url;$("#download-video").download=audition?"lyrics-audition.mp4":"lyrics.mp4";$("#download-video").textContent=audition?"試写MP4を保存":"確認済みMP4を保存";$("#download-video").hidden=false;message(`${audition?"要確認の候補を含む試写":"確認済み行の"}MP4を作成しました（${job.elapsedSeconds}秒）。${audition?"歌声と字幕を聴いて確認してください。":"保存できます。"}`);}
        break;
      }
      if(job.status==="failed") throw new Error(job.message);
      if(job.status==="cancelled"){message("処理をキャンセルしました。再試行できます。");break;}
      await new Promise(resolve=>setTimeout(resolve,1000));
    }
  } finally {busy=false;jobId=null;$("#align").disabled=false;$("#export").disabled=false;$("#cancel").hidden=true;}
}

for(const kind of ["media","audio","background"]) $("#"+kind+"-file").onchange=safely(async e=>{await upload(e.target.files[0],kind);e.target.value="";});
$("#apply-lyrics").onclick=safely(applyLyrics);
$("#align").onclick=safely(()=>runJob("align"));$("#export").onclick=safely(()=>runJob("export"));
$("#cancel").onclick=safely(async()=>{if(jobId) await api(`/api/jobs/${jobId}/cancel`,{method:"POST"});});
$("#play").onclick=$("#fixed-play").onclick=safely(playback);
$("#back").onclick=()=>seekTo(clock().currentTime-3);$("#forward").onclick=()=>seekTo(clock().currentTime+3);$("#seek").oninput=e=>seekTo(Number(e.target.value));
$("#record-start").onclick=safely(()=>record("start"));$("#record-end").onclick=safely(()=>record("end"));
function restoreHistory(next){
  const mediaChanged=JSON.stringify(project.assets)!==JSON.stringify(next.assets);
  project=next;$("#lyrics").value=project.lyrics;
  if(mediaChanged){unload();attachMedia();}
  persist();render();setStyleInputs();
}
function undo(){restoreHistory(history.undo(project));}
function redo(){restoreHistory(history.redo(project));}
$("#undo").onclick=$("#fixed-undo").onclick=undo;$("#redo").onclick=$("#fixed-redo").onclick=redo;
$("#next-review").onclick=()=>{const index=project.lines.findIndex(l=>l.id===selected);const ordered=[...project.lines.slice(index+1),...project.lines.slice(0,index+1)];const line=ordered.find(l=>l.review);if(line){selectRow(line.id);document.querySelector(`[data-id="${CSS.escape(line.id)}"]`)?.scrollIntoView({block:"center",behavior:"auto"});}else message("要確認の行はありません。");};
$("#rows").onclick=safely(e=>{
  const button=e.target.closest("button[data-action]");if(!button)return;
  const id=button.closest("[data-id]").dataset.id,row=project.lines.find(l=>l.id===id);
  if(button.dataset.action==="select"){selectRow(id);return;}
  selected=id;
  if(button.dataset.action==="confirm") commit(confirmLine(project,id));
  if(button.dataset.action==="adjust") {const field=button.dataset.field;if(!validTime(row[field])) throw new Error("先に時刻を指定してください。");commit(editTiming(project,id,field,row[field]+Number(button.dataset.delta)));}
});
$("#rows").onchange=safely(e=>{
  const field=e.target.dataset.field,id=e.target.closest("[data-id]")?.dataset.id;if(!field||!id)return;
  if(field==="alignmentText"){const next=structuredClone(project);next.lines.find(l=>l.id===id).alignmentText=e.target.value;commit(next);}
  else commit(editTiming(project,id,field,e.target.value));
});
for(const [id,key] of [["style-mode","mode"],["font-size","fontSize"],["font-color","color"],["shadow","shadow"],["position","y"],["lyric-width","width"],["background-color","background"]]) {
  $("#"+id).oninput=e=>{const next=structuredClone(project);next.style[key]=["mode","color","background"].includes(key)?e.target.value:Number(e.target.value);project=next;persist();draw();};
}
$("#save-project").onclick=safely(()=>{if($("#lyrics").value.trim())applyLyrics();blobDownload(JSON.stringify(saveProject(project),null,2),"lyrics.lyricvideo.json","application/json");});
$("#project-file").onchange=safely(async e=>{const file=e.target.files[0];if(!file)return;const next=loadProject(JSON.parse(await file.text()));unload();history.past=[];history.future=[];project=next;selected=next.lines[0]?.id;$("#lyrics").value=next.lyrics;attachMedia();setStyleInputs();persist();render();message("プロジェクトを開きました。素材を選び直してください。");e.target.value="";});
$("#srt").onclick=safely(()=>{const content=exportSrt(project,$("#srt-language").value);if(!content)throw new Error("確認済みの時刻を確認してください。");blobDownload(content,"lyrics.srt","application/x-subrip;charset=utf-8");});
document.addEventListener("keydown",safely(e=>{if(e.target.closest("input,textarea,select,[contenteditable]"))return;if(e.code==="Space"){e.preventDefault();record("start");}else if(e.key.toLowerCase()==="e")record("end");else if(e.key.toLowerCase()==="k")return playback();else if((e.ctrlKey||e.metaKey)&&e.key.toLowerCase()==="z"){e.preventDefault();e.shiftKey?redo():undo();}}));
video.addEventListener("seeking",()=>{if(project.assets.audio?.url&&Number.isFinite(audio.duration))audio.currentTime=Math.min(video.currentTime,audio.duration);});
video.addEventListener("pause",()=>{if(project.assets.audio?.url)audio.pause();});
video.addEventListener("timeupdate",()=>{if(project.assets.audio?.url&&!video.paused&&Number.isFinite(audio.duration)&&Math.abs(audio.currentTime-video.currentTime)>.1&&video.currentTime<audio.duration)audio.currentTime=video.currentTime;});
video.addEventListener("error",()=>{if(video.getAttribute("src"))message("このブラウザでは動画をプレビューできません。H.264のMP4で確認してください。",true);});
audio.addEventListener("error",()=>{if(audio.getAttribute("src"))message("音源を再生できません。WAVなど別形式を確認してください。",true);});
try{const saved=JSON.parse(localStorage.getItem(STORAGE));if(saved)project=loadProject(saved);}catch{}
$("#lyrics").value=project.lyrics;attachMedia();setStyleInputs();
await document.fonts.load('700 62px "Studio Noto"');render();
function tick(){if(!clock().paused)draw();requestAnimationFrame(tick);}requestAnimationFrame(tick);
api("/api/health").then(()=>$("#engine-state").textContent="接続済み：このPCで同期・MP4書き出しを実行します。").catch(()=>{$("#engine-state").textContent="処理用PCが未接続です。READMEの起動手順を確認してください。";$("#align").disabled=true;$("#export").disabled=true;});
// Read-only browser test/inspection interface; no generated timestamps or mock results.
window.studio={snapshot:()=>structuredClone(project),currentTime:()=>clock().currentTime,selectRow,seekTo};
