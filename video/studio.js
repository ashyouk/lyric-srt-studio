import {newProject,loadProject,saveProject,updateLyrics,applyAlignment,editTiming,confirmLine,
  cues,exportSrt,drawLyrics,History,validTime,activeCue,shiftTiming,timingIssues,candidateSeekTime} from "./core.js";
import {FONTS,normalizeFont} from "./font-catalog.js";
import {ensureFont} from "./fonts.js";
import {drawComposite} from "./preview-render.js";

const $=selector=>document.querySelector(selector);
const STORAGE="lyric-video-studio-prototype-v1";
let project=newProject(), selected=null, jobId=null, busy=false;
let activeTab="production", rowFilter="all", previewWindow=null, previewPoll=null, fontRequest=0;
// LAN HTTP is not a secure context: randomUUID may not exist there.
const previewName=`lyric-preview-${globalThis.crypto?.randomUUID?.()||`${Date.now()}-${Math.random().toString(36).slice(2)}`}`;
const loadedFonts=new Set();
const history=new History();
const video=$("#video"),audio=$("#audio"),canvas=$("#canvas"),ctx=canvas.getContext("2d");
const editCtx=$("#edit-canvas").getContext("2d"), editOverlay=document.createElement("canvas");
editOverlay.width=1920;editOverlay.height=1080;
const editOverlayCtx=editOverlay.getContext("2d");
const message=(text,error=false)=>{for(const id of ["#message","#edit-message","#preview-message"]){$(id).textContent=id==="#message"||error?text:"";$(id).classList.toggle("error",error);}};
const timeLabel=t=>`${String(Math.floor(Math.max(0,t)/60)).padStart(2,"0")}:${(Math.max(0,t)%60).toFixed(3).padStart(6,"0")}`;
const candidateLabel=t=>validTime(t)?timeLabel(Number(t)):"なし";
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
function commit(next){if(JSON.stringify(next)===JSON.stringify(project))return;project=history.change(project,next);persist();render();}
function refreshHistory(){["#undo","#fixed-undo"].forEach(s=>$(s).disabled=!history.past.length);["#redo","#fixed-redo"].forEach(s=>$(s).disabled=!history.future.length);$("#undo").textContent=`↶ 戻る ${history.past.length}`;$("#redo").textContent=`↷ やり直す ${history.future.length}`;}
function switchTab(tab,focus=false){
  activeTab=tab==="editing"?"editing":"production";
  for(const name of ["production","editing"]){const active=name===activeTab;$("#"+name+"-panel").hidden=!active;const button=$("#tab-"+name);button.setAttribute("aria-selected",String(active));button.tabIndex=active?0:-1;}
  if(focus)$("#tab-"+activeTab).focus();draw();
}
function visualSource(){return project.assets.media?.kind==="video"?video:project.assets.background?.url?$("#background"):null;}
function previewState(){return {project,time:clock().currentTime||0,paused:clock().paused,selected,playingId:activeCue(project,clock().currentTime||0)?.id||null};}
function syncDetached(){const detached=Boolean(previewWindow&&!previewWindow.closed);$("#stage").hidden=detached;$("#detached-note").hidden=!detached;["#return-preview","#edit-return-preview"].forEach(s=>$(s).hidden=!detached);["#open-preview","#edit-open-preview"].forEach(s=>$(s).textContent=detached?"別窓を表示":"別窓で開く");}
function previewClosed(child){
  if(child&&child!==previewWindow)return;
  previewWindow=null;if(previewPoll){clearInterval(previewPoll);previewPoll=null;}syncDetached();draw();
}
function returnPreview(){const child=previewWindow;previewClosed();if(child&&!child.closed)child.close();}
function openPreview(){
  if(previewWindow&&!previewWindow.closed){previewWindow.focus();return;}
  previewWindow=window.open("./preview.html",previewName,"popup,width=1000,height=720,resizable=yes,scrollbars=yes");
  if(!previewWindow){syncDetached();message("別窓がブロックされました。このサイトのポップアップを許可するか、画面内プレビューをご利用ください。",true);return;}
  syncDetached();previewPoll=setInterval(()=>{if(previewWindow?.closed)previewClosed();},300);
  message("別窓を開きました。再生と音声は親画面に一本化しています。");
}
async function chooseFont(id){
  id=normalizeFont(id);const request=++fontRequest;$("#font-choice").value=id;
  message("歌詞フォントを読み込んでいます…");try{await ensureFont(id);}catch(error){if(request===fontRequest)setStyleInputs();throw error;}loadedFonts.add(id);
  if(request!==fontRequest)return;
  project={...project,style:{...project.style,fontId:id}};persist();setStyleInputs();draw();message("フォントを変更しました。改行と行の高さを更新しました（再同期は不要です）。");
}
async function prepareProjectFont(){
  const id=project.style.fontId;await ensureFont(id);loadedFonts.add(id);draw();
}
async function listenRow(id=selected){
  const line=project.lines.find(l=>l.id===id);
  if(!validTime(line?.start))throw new Error("先にこの行の開始時刻を指定してください。");
  selectRow(id);if(clock().paused)await playback();
}
function seekCandidate(id){
  const line=project.lines.find(l=>l.id===id),target=candidateSeekTime(line,project.duration);
  if(target===null)throw new Error("素材の範囲内に有効な自動候補がありません。再生位置を選んで開始・終了を記録してください。");
  if(!project.assets.media?.id||!clock().getAttribute("src")||clock().readyState<1)throw new Error("先に素材を選択して、読み込みが終わるまでお待ちください。");
  if(project.assets.media.kind==="video"&&!project.assets.media.hasAudio&&!project.assets.audio?.id)throw new Error("音声がない動画には音源を追加してください。");
  selectRow(id,false);seekTo(target);
  message("自動候補の0.5秒手前（曲頭では0秒）へ移動しました。時刻は未確定です。聴いて「開始を記録」「終了を記録」で修正してください。");
}
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
function applyLyrics({confirmReset=false}={}){
  const raw=$("#lyrics").value;
  if(raw===project.lyrics&&project.lines.length) return;
  const next=updateLyrics(project,raw,{resetTiming:confirmReset});
  const reset=project.lines.length>0&&(next.lines.length!==project.lines.length||next.lines.some((l,i)=>l.text!==project.lines[i].text));
  if(reset&&!window.confirm("本文・順序・行数が変わっています。変更を反映すると、全行の時刻・確認状態・照合用テキストをリセットし、再同期が必要になります。歌詞を反映して再同期の準備をしますか？\nキャンセルすると既存の時刻と自動保存を保持します。"))return;
  selected=next.lines[0]?.id;commit(next);message(reset?`${next.lines.length}行を反映しました。本文または順序が変わったため、時刻は未同期に戻しました。「戻る」で復元できます。`:`${next.lines.length}行を反映しました。`);
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
function selectionLabels(){
  const row=project.lines.find(l=>l.id===selected);
  $("#active-text").textContent=row?`${project.lines.indexOf(row)+1} · ${row.text}`:"歌詞が未入力です";
  $("#edit-selected").textContent=row?`選択行 ${project.lines.indexOf(row)+1}：${row.text}`:"選択行：未選択";
  document.querySelectorAll(".lyric-row").forEach(el=>el.classList.toggle("selected",el.dataset.id===selected));
}
function render(){
  if(!project.lines.some(l=>l.id===selected)) selected=project.lines[0]?.id;
  selectionLabels();
  const placedIds=new Set(cues(project).map(l=>l.id));
  const rowState=l=>placedIds.has(l.id)?l.review?"要確認":"確認済み":!validTime(l.start)&&!validTime(l.end)?"未配置":!validTime(l.start)?"開始未記録":!validTime(l.end)?"終了未記録":"時刻要修正";
  $("#review-count").textContent=`${project.lines.length}行 / 未配置 ${project.lines.length-placedIds.size} / 要確認 ${project.lines.filter(l=>l.review).length} / 確認済み ${cues(project,true).length}`;
  const issues=timingIssues(project);
  $("#quality-count").textContent=`品質チェック：${issues.filter(i=>i.severity==="error").length}件のエラー / ${issues.filter(i=>i.severity==="warning").length}件の注意（前後の重なりを含む）`;
  ["all","review"].forEach(f=>$("#filter-"+f).setAttribute("aria-pressed",String(rowFilter===f)));
  const visible=project.lines.map((l,i)=>({l,i})).filter(({l})=>rowFilter!=="review"||l.review);
  $("#rows").innerHTML=visible.length?visible.map(({l,i})=>`<article class="lyric-row ${l.id===selected?"selected":""}" data-id="${escape(l.id)}">
    <button class="row-number" data-action="select" aria-label="${i+1}行目を選択して付近へ移動">${i+1}</button>
    <div><div class="row-text">${escape(l.text)}</div><span class="row-state ${placedIds.has(l.id)&&!l.review?"confirmed":""}">${rowState(l)}${l.manual.start||l.manual.end?" · 手動修正":""}</span></div>
    <div class="row-tools"><div class="row-shift"><button data-action="shift" data-delta="-.1" title="行全体の開始・終了を0.1秒早める">0.1秒早める</button><button data-action="shift" data-delta=".1" title="行全体の開始・終了を0.1秒遅らせる">0.1秒遅らせる</button></div>${["start","end"].map(field=>`<div><label>${field==="start"?"開始":"終了"}（秒）<input type="number" min="0" max="${project.duration}" step="0.01" data-field="${field}" value="${validTime(l[field])?l[field]:""}"></label><div class="buttons"><button data-action="adjust" data-field="${field}" data-delta="-.1" aria-label="${field==="start"?"開始":"終了"}だけ0.1秒早める">−0.1</button><button data-action="adjust" data-field="${field}" data-delta=".1" aria-label="${field==="start"?"開始":"終了"}だけ0.1秒遅らせる">＋0.1</button></div></div>`).join("")}<button data-action="listen">この行を聴く</button>${!placedIds.has(l.id)?`<button data-action="candidate" ${candidateSeekTime(l,project.duration)===null?"disabled":""}>候補付近へ移動</button>`:""}<button data-action="confirm" ${!placedIds.has(l.id)?"disabled":""}>確認済みにする</button></div>
    ${issues.filter(issue=>issue.index===i).map(issue=>`<p class="row-details quality-warning">${escape(issue.message)}</p>`).join("")}
    <details class="row-details"><summary>照合用テキストと確認理由</summary><input type="text" aria-label="${i+1}行目の照合用テキスト" data-field="alignmentText" value="${escape(l.alignmentText)}"><p>${escape((l.reasons||[]).join(" "))}</p>${l.auto?`<p>自動候補 ${candidateLabel(l.auto.candidateStart??l.auto.start)} → ${candidateLabel(l.auto.candidateEnd??l.auto.end)} · 音声認識との照合文字 ${l.auto.evidence?.matchedCharacters??"—"}/${l.auto.evidence?.inputCharacters??"—"}（精度保証の数値ではありません）</p>`:""}</details></article>`).join(""):rowFilter==="review"&&project.lines.length?"<p class='hint'>要確認の行はありません。「すべて」で任意の行を修正できます。</p>":"<p class='hint'>歌詞を貼り付けて反映してください。</p>";
  refreshHistory();draw();
  document.body.classList.toggle("row-input-focus",Boolean(document.activeElement?.closest("#rows input")));
}
function draw(){
  const current=clock().currentTime||0;
  $("#stage").style.background=project.style.background;
  if(loadedFonts.has(project.style.fontId)){if(activeTab==="production"&&!$("#stage").hidden)drawLyrics(ctx,project,current);if(activeTab==="editing")drawComposite(editCtx,editOverlayCtx,project,current,visualSource());}
  const active=activeCue(project,current),playing=active?`再生中の歌詞行 ${project.lines.indexOf(active)+1}：${active.text}`:"再生中の歌詞行：なし（前奏・間奏・後奏）";
  $("#edit-playing").textContent=playing;$("#playing-line").textContent=active?`/ 再生中：${project.lines.indexOf(active)+1}行目`:"/ 再生中：なし";
  $("#seek").max=String(project.duration||1);$("#seek").value=String(current);
  $("#time").textContent=`${timeLabel(current)} / ${timeLabel(project.duration)}`;
  $("#edit-seek").max=String(project.duration||1);$("#edit-seek").value=String(current);$("#edit-time").textContent=$("#time").textContent;
  $("#play").textContent=clock().paused?"▶ 再生":"Ⅱ 停止";
  $("#edit-play").textContent=$("#play").textContent;
  $("#fixed-play").textContent=clock().paused?"▶":"Ⅱ";
  $("#fixed-play").setAttribute("aria-label",clock().paused?"素材を再生":"素材を一時停止");
  $("#fixed-play").title=clock().paused?"素材を再生":"素材を一時停止";
}
function setStyleInputs(){
  const s=project.style;
  for(const [id,key] of [["style-mode","mode"],["font-size","fontSize"],["font-color","color"],["shadow","shadow"],["position","y"],["lyric-width","width"],["background-color","background"]]) $("#"+id).value=s[key];
  $("#font-choice").value=normalizeFont(s.fontId);document.querySelectorAll("[data-font]").forEach(b=>b.setAttribute("aria-pressed",String(b.dataset.font===s.fontId)));
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
$("#apply-lyrics").onclick=safely(()=>applyLyrics({confirmReset:true}));
$("#align").onclick=safely(()=>runJob("align"));$("#export").onclick=safely(()=>runJob("export"));
$("#cancel").onclick=safely(async()=>{if(jobId) await api(`/api/jobs/${jobId}/cancel`,{method:"POST"});});
$("#play").onclick=$("#fixed-play").onclick=$("#edit-play").onclick=safely(playback);
$("#edit-listen").onclick=safely(()=>listenRow());$("#edit-seek").oninput=e=>seekTo(Number(e.target.value));
$("#open-preview").onclick=$("#edit-open-preview").onclick=openPreview;
$("#return-preview").onclick=$("#edit-return-preview").onclick=returnPreview;
for(const tab of ["production","editing"])$("#tab-"+tab).onclick=()=>switchTab(tab);
$(".app-tabs").onkeydown=e=>{if(["ArrowLeft","ArrowRight","Home","End"].includes(e.key)){e.preventDefault();switchTab(e.key==="Home"?"production":e.key==="End"?"editing":activeTab==="production"?"editing":"production",true);}};
document.querySelectorAll("[data-tab-target]").forEach(a=>a.onclick=()=>switchTab(a.dataset.tabTarget));
for(const filter of ["all","review"])$("#filter-"+filter).onclick=()=>{rowFilter=filter;render();};
$("#font-choice").onchange=safely(e=>chooseFont(e.target.value));
$("#font-samples").innerHTML=FONTS.map(f=>`<button data-font="${f.id}" style='font-family:"${f.family}"' aria-pressed="false" disabled><small>${escape(f.label)}</small><span>歌詞を、音に。<br>Hello, music.</span></button>`).join("");
$("#font-samples").onclick=safely(e=>{const button=e.target.closest("[data-font]");if(button)return chooseFont(button.dataset.font);});
FONTS.forEach(async f=>{try{await ensureFont(f.id);loadedFonts.add(f.id);const b=document.querySelector(`[data-font="${f.id}"]`);b.disabled=false;setStyleInputs();draw();}catch(error){message(error.message,true);}});
$("#back").onclick=()=>seekTo(clock().currentTime-3);$("#forward").onclick=()=>seekTo(clock().currentTime+3);$("#seek").oninput=e=>seekTo(Number(e.target.value));
$("#record-start").onclick=safely(()=>record("start"));$("#record-end").onclick=safely(()=>record("end"));
function restoreHistory(next){
  const mediaChanged=JSON.stringify(project.assets)!==JSON.stringify(next.assets);
  project=next;$("#lyrics").value=project.lyrics;
  if(mediaChanged){unload();attachMedia();}
  persist();render();setStyleInputs();
  prepareProjectFont().catch(error=>message(error.message,true));
}
function undo(){restoreHistory(history.undo(project));}
function redo(){restoreHistory(history.redo(project));}
$("#undo").onclick=$("#fixed-undo").onclick=undo;$("#redo").onclick=$("#fixed-redo").onclick=redo;
$("#next-review").onclick=()=>{const index=project.lines.findIndex(l=>l.id===selected);const ordered=[...project.lines.slice(index+1),...project.lines.slice(0,index+1)];const line=ordered.find(l=>l.review);if(line){selectRow(line.id);document.querySelector(`[data-id="${CSS.escape(line.id)}"]`)?.scrollIntoView({block:"center",behavior:"auto"});}else message("要確認の行はありません。");};
$("#rows").onclick=safely(async e=>{
  const button=e.target.closest("button[data-action]");if(!button)return;
  const id=button.closest("[data-id]").dataset.id,row=project.lines.find(l=>l.id===id);
  if(button.dataset.action==="select"){selectRow(id);return;}
  if(button.dataset.action==="listen"){await listenRow(id);return;}
  if(button.dataset.action==="candidate"){seekCandidate(id);return;}
  selected=id;selectionLabels();
  if(button.dataset.action==="confirm") commit(confirmLine(project,id));
  if(button.dataset.action==="shift")commit(shiftTiming(project,id,Number(button.dataset.delta)));
  if(button.dataset.action==="adjust") {const field=button.dataset.field;if(!validTime(row[field])) throw new Error("先に時刻を指定してください。");commit(editTiming(project,id,field,row[field]+Number(button.dataset.delta)));}
});
$("#rows").onchange=safely(e=>{
  const field=e.target.dataset.field,id=e.target.closest("[data-id]")?.dataset.id;if(!field||!id)return;
  selected=id;selectionLabels();
  if(field==="alignmentText"){const next=structuredClone(project);next.lines.find(l=>l.id===id).alignmentText=e.target.value;commit(next);}
  else commit(editTiming(project,id,field,e.target.value));
});
// On touch layouts, give the keyboard and timing fields the space they need.
for(const event of ["focusin","focusout"])document.addEventListener(event,e=>{
  if(event==="focusin"&&e.target.closest("#rows input")){selected=e.target.closest("[data-id]").dataset.id;selectionLabels();}
  queueMicrotask(()=>document.body.classList.toggle("row-input-focus",Boolean(document.activeElement?.closest("#rows input"))));
});
for(const [id,key] of [["style-mode","mode"],["font-size","fontSize"],["font-color","color"],["shadow","shadow"],["position","y"],["lyric-width","width"],["background-color","background"]]) {
  $("#"+id).oninput=e=>{const next=structuredClone(project);next.style[key]=["mode","color","background"].includes(key)?e.target.value:Number(e.target.value);project=next;persist();draw();};
}
$("#save-project").onclick=safely(()=>{if(project.lines.length||$("#lyrics").value.trim())applyLyrics();blobDownload(JSON.stringify(saveProject(project),null,2),"lyrics.lyricvideo.json","application/json");});
$("#project-file").onchange=safely(async e=>{const file=e.target.files[0];if(!file)return;const next=loadProject(JSON.parse(await file.text()));await ensureFont(next.style.fontId);loadedFonts.add(next.style.fontId);++fontRequest;unload();history.past=[];history.future=[];project=next;selected=next.lines[0]?.id;$("#lyrics").value=next.lyrics;attachMedia();setStyleInputs();persist();render();message("プロジェクトを開きました。素材を選び直してください。");e.target.value="";});
$("#srt").onclick=safely(()=>{const content=exportSrt(project,$("#srt-language").value);if(!content)throw new Error("確認済みの時刻を確認してください。");blobDownload(content,"lyrics.srt","application/x-subrip;charset=utf-8");});
document.addEventListener("keydown",safely(e=>{if(e.target.closest("input,textarea,select,[contenteditable]")||e.code==="Space"&&e.target.closest("[role=tab],#font-samples button"))return;if(e.code==="Space"){e.preventDefault();record("start");}else if(e.key.toLowerCase()==="e")record("end");else if(e.key.toLowerCase()==="k")return playback();else if((e.ctrlKey||e.metaKey)&&e.key.toLowerCase()==="z"){e.preventDefault();e.shiftKey?redo():undo();}}));
video.addEventListener("seeking",()=>{if(project.assets.audio?.url&&Number.isFinite(audio.duration))audio.currentTime=Math.min(video.currentTime,audio.duration);});
video.addEventListener("pause",()=>{if(project.assets.audio?.url)audio.pause();});
video.addEventListener("timeupdate",()=>{if(project.assets.audio?.url&&!video.paused&&Number.isFinite(audio.duration)&&Math.abs(audio.currentTime-video.currentTime)>.1&&video.currentTime<audio.duration)audio.currentTime=video.currentTime;});
video.addEventListener("error",()=>{if(video.getAttribute("src"))message("このブラウザでは動画をプレビューできません。H.264のMP4で確認してください。",true);});
audio.addEventListener("error",()=>{if(audio.getAttribute("src"))message("音源を再生できません。WAVなど別形式を確認してください。",true);});
try{const saved=JSON.parse(localStorage.getItem(STORAGE));if(saved)project=loadProject(saved);}catch{}
$("#lyrics").value=project.lyrics;attachMedia();setStyleInputs();
// Available before the initial font wait, including a popup opened immediately.
window.studioPreview={getState:previewState,paint:(target,overlay,state=previewState())=>drawComposite(target,overlay,state.project,state.time,visualSource()),
  toggle:async()=>{try{await playback();}catch(error){message(error.message,true);throw error;}},seek:seekTo,return:returnPreview,closed:previewClosed};
window.addEventListener("pagehide",returnPreview);
await prepareProjectFont();render();
function tick(){if(!clock().paused)draw();requestAnimationFrame(tick);}requestAnimationFrame(tick);
api("/api/health").then(()=>$("#engine-state").textContent="接続済み：このPCで同期・MP4書き出しを実行します。").catch(()=>{$("#engine-state").textContent="処理用PCが未接続です。READMEの起動手順を確認してください。";$("#align").disabled=true;$("#export").disabled=true;});
// Read-only browser test/inspection interface; no generated timestamps or mock results.
window.studio={snapshot:()=>structuredClone(project),currentTime:()=>clock().currentTime,selectRow,seekTo,
  inspection:()=>({activeTab,rowFilter,selected,past:history.past.length,future:history.future.length,paused:clock().paused,detached:Boolean(previewWindow&&!previewWindow.closed)})};
[video,audio].forEach(el=>["timeupdate","seeked","play","pause","loadeddata"].forEach(event=>el.addEventListener(event,draw)));
$("#background").addEventListener("load",draw);
