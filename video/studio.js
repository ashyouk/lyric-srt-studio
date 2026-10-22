import {newProject,loadProject,saveProject,updateLyrics,applyAlignment,editTiming,confirmLine,
  cues,exportSrt,drawLyrics,History,validTime,activeCue,shiftTiming,timingIssues,candidateSeekTime} from "./core.js";
import {FONTS,normalizeFont} from "./font-catalog.js";
import {ensureFont} from "./fonts.js";
import {drawComposite} from "./preview-render.js";
import {BrowserMedia,attachBrowserAsset,isBrowserEditor} from "./browser-media.js?v=0.4.1";
import {controlMarkup,setControl,installEditorGuides} from "./editor-ui.js?v=0.3.1";
import {decodeReviewFragment} from './review-link.js?v=0.4.3';

const $=selector=>document.querySelector(selector);
const LOCAL=isBrowserEditor(location.href);
const AUTO=LOCAL&&new URL(location.href).searchParams.get('sync')==='local';
let browserSync=null,syncGeneration=0;
const compact=(icon,short,long)=>LOCAL?controlMarkup(icon,short):long;
const localMedia=LOCAL?new BrowserMedia():null;
const localRequests={media:0,audio:0,background:0};
const STORAGE=LOCAL?"lyric-srt-browser-editor-v1":"lyric-video-studio-prototype-v1";
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
const message=(text,error=false,inConsole=false)=>{for(const id of ["#message","#edit-message","#preview-message"]){$(id).textContent=id==="#message"||error?text:"";$(id).classList.toggle("error",error);}const feedback=$('#console-message');if(feedback){feedback.hidden=!error&&!inConsole;feedback.textContent=error||inConsole?text:'';feedback.classList.toggle('error',error);}};
const timeLabel=t=>`${String(Math.floor(Math.max(0,t)/60)).padStart(2,"0")}:${(Math.max(0,t)%60).toFixed(3).padStart(6,"0")}`;
const candidateLabel=t=>validTime(t)?timeLabel(Number(t)):"なし";
const escape=text=>String(text??"").replace(/[&<>"']/g,c=>({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"}[c]));
const clock=()=>project.assets.media?.kind==="video"?video:audio;
const signature=()=>JSON.stringify(project.lines.map(l=>[l.id,l.text,l.alignmentText]));

async function api(path,options={}) {
  if(LOCAL) throw new Error("端末内編集ではPCへの接続・自動同期・MP4作成は行いません。PC版で同期したプロジェクトを読み込んでください。");
  const response=await fetch(path,options);
  const value=await response.json();
  if(!response.ok) throw new Error(typeof value.detail==="string"?value.detail:"処理用PCとの通信に失敗しました。");
  return value;
}
const safely=fn=>async event=>{try{await fn(event);}catch(error){message(error.message,true);}};
function persist(){try{localStorage.setItem(STORAGE,JSON.stringify(saveProject(project)));}catch{message("自動保存できません。プロジェクトファイルを保存してください。",true);}}
function commit(next){if(JSON.stringify(next)===JSON.stringify(project))return;project=history.change(project,next);persist();render();}
function refreshHistory(){["#undo","#fixed-undo"].forEach(s=>$(s).disabled=!history.past.length);["#redo","#fixed-redo"].forEach(s=>$(s).disabled=!history.future.length);if(LOCAL){for(const [id,icon,label,count] of [["undo","undo","戻る",history.past.length],["redo","redo","やり直す",history.future.length],["fixed-undo","undo","戻る",history.past.length],["fixed-redo","redo","やり直す",history.future.length]])setControl($("#"+id),icon,id.startsWith("fixed")?label:`${label} ${count}`,`${label}（履歴 ${count}件）`);}else{$("#undo").textContent=`↶ 戻る ${history.past.length}`;$("#redo").textContent=`↷ やり直す ${history.future.length}`;}}
function switchTab(tab,focus=false){
  activeTab=tab==="editing"?"editing":"production";
  for(const name of ["production","editing"]){const active=name===activeTab;$("#"+name+"-panel").hidden=!active;const button=$("#tab-"+name);button.setAttribute("aria-selected",String(active));button.tabIndex=active?0:-1;}
  if(focus)$("#tab-"+activeTab).focus();draw();
}
function visualSource(){return project.assets.media?.kind==="video"?video:project.assets.background?.url?$("#background"):null;}
function previewState(){return {project,time:clock().currentTime||0,paused:clock().paused,selected,playingId:activeCue(project,clock().currentTime||0)?.id||null};}
function syncDetached(){const detached=Boolean(previewWindow&&!previewWindow.closed);$("#stage").hidden=detached;$("#detached-note").hidden=!detached;["#return-preview","#edit-return-preview"].forEach(s=>$(s).hidden=!detached);["#open-preview","#edit-open-preview"].forEach(s=>{if(LOCAL)setControl($(s),"popup","別窓",detached?"開いている別窓を表示":"プレビューを別窓で開く");else $(s).textContent=detached?"別窓を表示":"別窓で開く";});}
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
  if(project.assets.media.kind==="video"&&project.assets.media.hasAudio===false&&!project.assets.audio?.id)throw new Error("音声がない動画には音源を追加してください。");
  selectRow(id,false);seekTo(target);
  message("自動候補の0.5秒手前（曲頭では0秒）へ移動しました。時刻は未確定です。聴いて「開始を記録」「終了を記録」で修正してください。");
}
function unload(){video.pause();audio.pause();[video,audio].forEach(el=>{el.removeAttribute("src");el.load();});$("#background").removeAttribute("src");$("#background").hidden=true;for(const kind of ['media','audio','background']){const status=$(`#${kind}-load-status`);if(status){status.textContent='';status.classList.remove('error');}$(`#${kind}-file`).setAttribute('aria-busy','false');}}
function attachMedia(){
  video.pause();audio.pause();
  const main=project.assets.media, separate=project.assets.audio;
  video.hidden=main?.kind!=="video";
  if(main?.kind==="video") {video.src=main.url;video.muted=Boolean(separate);if(separate) audio.src=separate.url;else {audio.removeAttribute("src");audio.load();}}
  else if(main?.url) audio.src=main.url;
  const background=project.assets.background;
  $("#background").hidden=!background?.url||main?.kind==="video";
  if(background?.url) $("#background").src=background.url;
  $("#extra-audio-field").hidden=main?.kind!=="video"||(!LOCAL&&main?.hasAudio);
  $("#media-name").textContent=main?`${main.name} · ${timeLabel(project.duration)}${main.reselect?"（再選択してください）":""}`:"素材が未選択です。";
  $("#background-name").textContent=background?.name||"";
}
function uploadStatus(kind,text,error=false){
  let status=$(`#${kind}-load-status`);
  if(!status){status=document.createElement('p');status.id=`${kind}-load-status`;status.className='hint local-message';status.setAttribute('role','status');status.setAttribute('aria-live','polite');$(`#${kind}-file`).parentElement.after(status);}
  status.textContent=text;status.classList.toggle('error',error);
}
async function upload(file,kind){
  if(!file) return;
  if(LOCAL){
    const request=++localRequests[kind];
    uploadStatus(kind,`${file.name} · ${file.type||'形式を確認中'} · ${(file.size/1024/1024).toFixed(1)}MB — 読み込み中…`);
    $(`#${kind}-file`).setAttribute('aria-busy','true');
    message(`${file.name}を端末内で開いています。外部へ送信しません。`);
    const previous=project.assets[kind];
    let asset;
    try{asset=await localMedia.open(file,kind);}catch(error){if(request!==localRequests[kind])return;uploadStatus(kind,`${file.name}：${error.message}`,true);throw error;}finally{if(request===localRequests[kind])$(`#${kind}-file`).setAttribute('aria-busy','false');}
    if(request!==localRequests[kind]){localMedia.release(asset);return;}
    commit(attachBrowserAsset(project,asset,kind));attachMedia();
    uploadStatus(kind,`${file.name} を選択しました${asset.kind==='image'?'':`（${timeLabel(asset.duration)}）`}。再生ボタンで確認できます。`);
    const changed=previous&&(previous.name!==asset.name||Math.abs((previous.duration||0)-asset.duration)>.5);
    message(`素材を端末内で開きました。${changed?"以前と異なる素材の可能性があります。時刻は保持しているので、曲が合っているか確認してください。":""}${asset.kind==="video"?"動画が無音の場合は別音源を選択してください。":""}`);
    return;
  }
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
  if($('#lyrics').value!==project.lyrics)throw new Error('歌詞に未反映の変更があります。「準備・保存」で「反映」を押してから記録してください。');
  if(project.assets.media.kind==="video"&&project.assets.media.hasAudio===false&&!project.assets.audio?.id) throw new Error("音声がない動画には音源を追加してください。");
  if(!selected) throw new Error("歌詞を入力して「反映」を押し、記録する行を選択してください。");
  const rowNumber=project.lines.findIndex(l=>l.id===selected)+1,time=clock().currentTime;
  commit(editTiming(project,selected,field,time));message(`${rowNumber}行目の${field==="start"?"開始":"終了"}を ${timeLabel(time)} に記録しました。`,false,true);
}
const canShift=(line,delta)=>validTime(line.start)&&validTime(line.end)&&line.end>line.start&&Number(line.start)+delta>=0&&Number(line.end)+delta<=project.duration;
const canAdjust=(line,field,delta)=>validTime(line[field])&&Number(line[field])+delta>=0&&Number(line[field])+delta<=project.duration;
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
  const summary=$('#alignment-summary');if(summary){const hasResult=Boolean(project.alignment);summary.hidden=!hasResult;const count=project.lines.filter(l=>validTime(l.auto?.start)&&validTime(l.auto?.end)&&l.auto.end>l.auto.start).length;summary.classList.toggle('warning',count<project.lines.length);summary.textContent=!hasResult?'':count===0?'自動同期で有効な時刻を得られませんでした。SRTはまだ自動作成できていません。別の音源・区間で試すか、行を選び、下部の「開始」「終了」で記録できます。':`自動候補 ${count}／${project.lines.length}行。候補は聴いて確認してください。未配置の行は「開始」「終了」で記録できます。`;}
  const issues=timingIssues(project);
  const errorCount=issues.filter(i=>i.severity==="error").length,warningCount=issues.filter(i=>i.severity==="warning").length;
  $("#quality-count").textContent=LOCAL?`品質：エラー ${errorCount} / 注意 ${warningCount}`:`品質チェック：${errorCount}件のエラー / ${warningCount}件の注意（前後の重なりを含む）`;
  ["all","review"].forEach(f=>$("#filter-"+f).setAttribute("aria-pressed",String(rowFilter===f)));
  const visible=project.lines.map((l,i)=>({l,i})).filter(({l})=>rowFilter!=="review"||l.review);
  $("#rows").innerHTML=visible.length?visible.map(({l,i})=>`<article class="lyric-row ${l.id===selected?"selected":""}" data-id="${escape(l.id)}">
    <button class="row-number" data-action="select" aria-label="${i+1}行目を選択して付近へ移動">${i+1}</button>
    <div><div class="row-text">${escape(l.text)}</div><span class="row-state ${placedIds.has(l.id)&&!l.review?"confirmed":""}">${rowState(l)}${l.manual.start||l.manual.end?" · 手動修正":""}</span></div>
    <div class="row-tools"><div class="row-shift"><button data-action="shift" data-delta="-.1" ${canShift(l,-.1)?'':'disabled'} title="開始・終了の記録後、行全体を0.1秒早める" aria-label="${i+1}行目全体を0.1秒早める">${compact("earlier","−0.1秒","0.1秒早める")}</button><button data-action="shift" data-delta=".1" ${canShift(l,.1)?'':'disabled'} title="開始・終了の記録後、行全体を0.1秒遅らせる" aria-label="${i+1}行目全体を0.1秒遅らせる">${compact("later","＋0.1秒","0.1秒遅らせる")}</button></div>${["start","end"].map(field=>`<div><label>${field==="start"?"開始":"終了"}（秒）<input type="number" min="0" max="${project.duration}" step="0.01" data-field="${field}" value="${validTime(l[field])?l[field]:""}"></label><div class="buttons"><button data-action="adjust" data-field="${field}" data-delta="-.1" ${canAdjust(l,field,-.1)?'':'disabled'} aria-label="${field==="start"?"開始":"終了"}だけ0.1秒早める">−0.1</button><button data-action="adjust" data-field="${field}" data-delta=".1" ${canAdjust(l,field,.1)?'':'disabled'} aria-label="${field==="start"?"開始":"終了"}だけ0.1秒遅らせる">＋0.1</button></div></div>`).join("")}<button data-action="listen" ${validTime(l.start)?'':'disabled'} aria-label="${i+1}行目を聴く">${compact("listen","試聴","この行を聴く")}</button>${!placedIds.has(l.id)?`<button data-action="candidate" title="自動候補の少し手前へ移動" aria-label="${i+1}行目の自動候補付近へ移動" ${candidateSeekTime(l,project.duration)===null?"disabled":""}>${compact("next","候補へ","候補付近へ移動")}</button>`:""}<button data-action="confirm" aria-label="${i+1}行目を確認済みにする" ${!placedIds.has(l.id)?"disabled":""}>${compact("check","確認","確認済みにする")}</button></div>
    ${!placedIds.has(l.id)?'<p class="row-details empty-timing-hint">この行を選び、下部の「開始」「終了」で時刻を記録できます。微調整・確認は記録後に使えます。</p>':''}
    ${issues.filter(issue=>issue.index===i).map(issue=>`<p class="row-details quality-warning">${escape(issue.message)}</p>`).join("")}
    <details class="row-details"><summary>${LOCAL?"詳細・確認理由":"照合用テキストと確認理由"}</summary><input type="text" aria-label="${i+1}行目の照合用テキスト" data-field="alignmentText" value="${escape(l.alignmentText)}"><p>${escape((l.reasons||[]).join(" "))}</p>${l.auto?`<p>自動候補 ${candidateLabel(l.auto.candidateStart??l.auto.start)} → ${candidateLabel(l.auto.candidateEnd??l.auto.end)} · 音声認識との照合文字 ${l.auto.evidence?.matchedCharacters??"—"}/${l.auto.evidence?.inputCharacters??"—"}（精度保証の数値ではありません）</p>`:""}</details></article>`).join(""):rowFilter==="review"&&project.lines.length?"<p class='hint'>要確認の行はありません。「すべて」で任意の行を修正できます。</p>":"<p class='hint'>歌詞を貼り付けて反映してください。</p>";
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
  if(LOCAL){for(const id of ["play","edit-play","fixed-play"])setControl($("#"+id),clock().paused?"play":"pause",clock().paused?"再生":"停止",clock().paused?"素材を再生":"素材を一時停止");}
  else{$("#play").textContent=clock().paused?"▶ 再生":"Ⅱ 停止";$("#edit-play").textContent=$("#play").textContent;$("#fixed-play").textContent=clock().paused?"▶":"Ⅱ";}
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
  if(LOCAL) throw new Error("この画面は端末内の修正・SRT出力専用です。自動同期とMP4作成はPC版を使用してください。");
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

async function runBrowserSync(){
  if(!AUTO)return;
  if(busy)throw new Error('処理中です。完了または中止をお待ちください。');
  if(!$('#model-consent').checked)throw new Error('初回のモデル取得と、実験版の注意事項をご確認ください。');
  applyLyrics();
  if($('#lyrics').value!==project.lyrics)throw new Error('歌詞の変更を反映してから再試行してください。');
  const asset=project.assets.audio||project.assets.media;
  if(!asset?.url?.startsWith('blob:'))throw new Error('この端末から音源を選択してください。');
  if(asset.kind!=='audio')throw new Error('この実験版の自動同期は音源のみです。WAV・MP3・M4Aで試してください。');
  if(project.lines.some(l=>l.start!==null&&!l.manual.start&&!l.manual.end)&&!window.confirm('自動候補を作り直します。手動修正した行は保護しますが、それ以外の自動時刻は置き換わります。冒頭30秒の解析では範囲外の行が未配置になる場合があります。先に作業保存しておくことをおすすめします。実行しますか？'))return;
  const sourceKey=()=>`${project.assets.media?.id}/${project.assets.audio?.id}`;
  const initialKey=sourceKey(),initialSignature=signature(),generation=++syncGeneration;
  busy=true;$('#align').disabled=true;$('#job-panel').hidden=false;$('#cancel').hidden=false;$('#job-progress').hidden=true;
  const stage=text=>{$('#job-status').textContent=text;message(text);};
  try{
    stage('音源をこの端末の中で解析用に変換しています…');
    const {decodeForAlignment,BrowserSync}=await import('./browser-sync.js');
    const response=await fetch(asset.url);const samples=await decodeForAlignment(await response.blob(),Number($('#sync-range').value));
    if(generation!==syncGeneration)return;
    browserSync??=new BrowserSync();
    const result=await browserSync.run(samples,project.lines,$('#sync-language').value,stage);
    if(generation!==syncGeneration)return;
    if(signature()!==initialSignature||sourceKey()!==initialKey)throw new Error('処理中に歌詞または音源が変わったため、結果は反映していません。再試行してください。');
    const aligned=applyAlignment(project,result);aligned.alignment={...aligned.alignment,modelRevision:result.diagnostics.revision,runtime:result.diagnostics.runtime,analyzedSeconds:Number($('#sync-range').value)===30?Math.min(30,asset.duration):asset.duration};
    commit(aligned);
    const placed=result.lines.filter(l=>validTime(l.start)&&validTime(l.end)).length;
    const resultMessage=placed?`端末内解析：${result.lines.length}行中${placed}行に候補（${result.elapsedSeconds}秒）。未配置行を含め、必ず聴いて確認してください。`:`自動同期で有効な時刻を得られませんでした（0／${result.lines.length}行）。SRTはまだ作成できていません。別の音源・区間を試すか、「修正」で手動記録できます。`;
    stage(resultMessage);if(placed)switchTab('editing');else message(resultMessage,true,true);
  }catch(error){if(error.name==='AbortError')stage('解析を中止しました。既存の時刻は変更していません。');else{stage(error.message);message(error.message,true);}}
  finally{busy=false;$('#align').disabled=false;$('#cancel').hidden=true;}
}

for(const kind of ["media","audio","background"]) $("#"+kind+"-file").onchange=safely(async e=>{try{await upload(e.target.files[0],kind);}finally{e.target.value="";}});
$("#apply-lyrics").onclick=safely(()=>applyLyrics({confirmReset:true}));
$("#align").onclick=safely(()=>runJob("align"));$("#export").onclick=safely(()=>runJob("export"));
$("#cancel").onclick=safely(async()=>{if(AUTO){syncGeneration++;browserSync?.cancel();$('#job-status').textContent='解析を中止しました。';message('解析を中止しました。既存の時刻は変更していません。');}else if(jobId) await api(`/api/jobs/${jobId}/cancel`,{method:"POST"});});
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
const saveWork=safely(()=>{if(project.lines.length||$("#lyrics").value.trim())applyLyrics();blobDownload(JSON.stringify(saveProject(project),null,2),"lyrics.lyricvideo.json","application/json");});
$("#save-project").onclick=saveWork;$("#edit-save-project").onclick=saveWork;
function openProject(data){
  const next=loadProject(data);
  if((project.lines.length||$("#lyrics").value.trim())&&!window.confirm("現在の作業を読み込みファイルへ置き換えます。未保存の作業がある場合はキャンセルして先に保存してください。開きますか？"))return false;
  ++fontRequest;for(const key of Object.keys(localRequests))localRequests[key]++;
  unload();localMedia?.dispose();history.past=[];history.future=[];project=next;selected=next.lines[0]?.id;
  $("#lyrics").value=next.lyrics;attachMedia();setStyleInputs();persist();render();
  message("プロジェクトを開きました。時刻・要確認状態・書体を引き継ぎました。同じ素材を端末から選び直してください。");
  prepareProjectFont().catch(error=>message(error.message,true));return true;
}
const openWork=safely(async e=>{const file=e.target.files[0];if(!file)return;try{openProject(JSON.parse(await file.text()));}finally{e.target.value="";}});
$("#project-file").onchange=$("#browser-project-file").onchange=openWork;
const saveSrt=safely(()=>{if($("#lyrics").value!==project.lyrics)throw new Error("歌詞の入力欄に未反映の変更があります。先に「歌詞を反映」で確認してください。");const content=exportSrt(project,$("#srt-language").value);if(!content)throw new Error("確認済みの時刻を確認してください。");blobDownload(content,"lyrics.srt","application/x-subrip;charset=utf-8");message(`SRTを保存しました（確認済み ${cues(project,true).length}行）。要確認・未配置の行は含まれません。`);});
$("#srt").onclick=saveSrt;$("#edit-srt").onclick=saveSrt;
document.addEventListener("keydown",safely(e=>{if(e.defaultPrevented||document.querySelector("#editor-help")?.open||e.target.closest("#incoming-review,input,textarea,select,[contenteditable]")||e.code==="Space"&&e.target.closest("[role=tab],#font-samples button"))return;if(e.code==="Space"){e.preventDefault();record("start");}else if(e.key.toLowerCase()==="e")record("end");else if(e.key.toLowerCase()==="k")return playback();else if((e.ctrlKey||e.metaKey)&&e.key.toLowerCase()==="z"){e.preventDefault();e.shiftKey?redo():undo();}}));
video.addEventListener("seeking",()=>{if(project.assets.audio?.url&&Number.isFinite(audio.duration))audio.currentTime=Math.min(video.currentTime,audio.duration);});
video.addEventListener("pause",()=>{if(project.assets.audio?.url)audio.pause();});
video.addEventListener("timeupdate",()=>{if(project.assets.audio?.url&&!video.paused&&Number.isFinite(audio.duration)&&Math.abs(audio.currentTime-video.currentTime)>.1&&video.currentTime<audio.duration)audio.currentTime=video.currentTime;});
video.addEventListener("error",()=>{if(video.getAttribute("src")){const text="このブラウザでは動画をプレビューできません。H.264のMP4で確認してください。";message(text,true);if(LOCAL)uploadStatus('media',text,true);}});
audio.addEventListener("error",()=>{if(audio.getAttribute("src")){const text="音源を再生できません。ファイルが端末に保存済みか確認し、MP3・M4A・PCM形式のWAVなどで試してください。";message(text,true);if(LOCAL)uploadStatus(project.assets.media?.kind==='video'?'audio':'media',text,true);}});
try{const saved=JSON.parse(localStorage.getItem(STORAGE));if(saved)project=loadProject(saved);}catch{}
$("#lyrics").value=project.lyrics;attachMedia();setStyleInputs();
// Available before the initial font wait, including a popup opened immediately.
window.studioPreview={getState:previewState,paint:(target,overlay,state=previewState())=>drawComposite(target,overlay,state.project,state.time,visualSource()),
  toggle:async()=>{try{await playback();}catch(error){message(error.message,true);throw error;}},seek:seekTo,return:returnPreview,closed:previewClosed};
window.addEventListener("pagehide",e=>{returnPreview();if(AUTO){syncGeneration++;browserSync?.cancel();}if(!e.persisted)localMedia?.dispose();});
if(LOCAL){
  document.body.classList.add("browser-editor");
  document.title="Lyric SRT — 端末内編集 β";
  $("header .tag").textContent="端末内編集 β 0.3.1";
  $(".brand span").textContent="SRT EDITOR";
  $(".intro h1").textContent="聴いて、SRTへ。";
  $(".intro>div>p:last-child").textContent="PCで同期したプロジェクトを引き継ぎ、スマホ・タブレット・PCのブラウザで仕上げます。";
  $(".privacy strong").textContent="音源と歌詞は、この端末の中で扱います。";
  $(".privacy p").textContent="素材は外部へ送信しません。PCへの接続も不要です。自動同期・MP4作成はこの画面にはありません。SRTは文字と時刻のファイルで、フォントなどの見た目は含みません。";
  $("#engine-state").textContent="端末内編集：プロジェクトを開き、同じ音源を選び直してください。";
  $("#prepare .panel-title span").textContent="素材は送信しません";
  $("#media-file").parentElement.querySelector("small").textContent="音源のMP3・M4A・WAV、動画のH.264 MP4を想定しています。再生可否はブラウザによります。iOS実機は確認をお願いします。";
  $("#preview-note").textContent="要確認の候補もプレビューします。聴いて修正し、各行を確認済みにしてください。SRTには確認済みの行だけを書き出します。";
  $("#font-note").replaceChildren(document.createTextNode("日本語・英語対応の同梱フォントでプレビューします。書体はプロジェクトへ保存されますが、SRTファイルには含まれません。 "),Object.assign(document.createElement("a"),{href:"fonts/README.md",textContent:"フォントとライセンス"}));
  $("#output .panel-title span").textContent="確認済みの行だけSRTへ";
  $("#output>p:last-child").textContent="プロジェクトJSONに素材本体は含まれません。別端末・再読み込み後は同じ素材を選び直してください。ブラウザの自動保存だけに頼らず、JSONも保存してください。";
  $("footer").textContent="端末内編集 β 0.3.1。自動同期はPC版で実行してください。音源の再生形式、保存先や別窓の挙動は端末・ブラウザによって異なります。";
  document.querySelectorAll("[data-server-only]").forEach(el=>{el.hidden=true;el.querySelectorAll("button,select,input").forEach(control=>control.disabled=true);});
  document.querySelectorAll("[data-browser-only]").forEach(el=>el.hidden=false);
  $("#align").hidden=$("#export").hidden=true;$("#align").disabled=$("#export").disabled=true;
  for(const [id,icon,label,description] of [["apply-lyrics","check","反映","入力した歌詞を一覧へ反映"],["record-start","start","開始","現在の再生位置を選択行の開始に記録"],["record-end","end","終了","現在の再生位置を選択行の終了に記録"],["edit-listen","listen","試聴","選択行を少し手前から聴く"],["srt","file","SRT保存","確認済み行のSRTを保存"],["edit-srt","file","SRT保存","確認済み行のSRTを保存"],["save-project","save","作業保存","続きを編集するプロジェクトJSONを保存"],["edit-save-project","save","作業保存","続きを編集するプロジェクトJSONを保存"],["filter-all","file","すべて","すべての歌詞行を表示"],["filter-review","edit","要確認","要確認の歌詞行だけ表示"],["next-review","next","次へ","次の要確認行へ移動"],["open-preview","popup","別窓","別窓プレビューを開く"],["edit-open-preview","popup","別窓","別窓プレビューを開く"],["return-preview","close","戻す","プレビューを画面内へ戻す"],["edit-return-preview","close","戻す","プレビューを画面内へ戻す"],["back","earlier","3秒","再生位置を3秒戻す"],["forward","later","3秒","再生位置を3秒進める"],["tab-production","folder","準備・保存","素材の準備と書き出し"],["tab-editing","edit","修正","歌詞のタイミング修正"]])setControl($("#"+id),icon,label,description);
  const stepNames=[["folder","01 素材"],["listen","02 試聴"],["edit","03 修正"],["save","04 保存"]];
  document.querySelectorAll(".steps a").forEach((link,i)=>{link.innerHTML=controlMarkup(...stepNames[i]);});
  $("#prepare h2").textContent="01 素材と歌詞";$("#editing h2").textContent="03 修正";
  installEditorGuides();
  message("音源または作業ファイルを選んでください。");
}
if(AUTO){
  $('header .tag').textContent='端末内自動同期 実験 0.4.3';
  $('.intro h1').textContent='音源と歌詞から、SRTへ。';
  $('.intro>div>p:last-child').textContent='PC接続なし・月額サービスなしの端末内解析を検証中です。候補を聴いて確認してからSRTへ保存します。';
  $('.privacy p').textContent='音源・歌詞はこの端末内で処理します。実行時にHugging Faceからモデルを取得しますが、音源や歌詞は送信しません。初回は通信量と空き容量が必要です。';
  $('#engine-state').textContent='実験版：スマホ実機での速度・安定性・歌唱精度は未検証です。';
  const guide=$('.browser-guide');guide.querySelector('strong').textContent='音源と歌詞から始める';
  guide.querySelector('ol').innerHTML='<li>音源を選び、正しい歌詞を貼り付けます。</li><li>下の注意事項を確認し「自動同期」で候補を作ります。</li><li>聴いて修正・確認後、JSONとSRTを保存します。</li>';
  guide.querySelector('.hint').textContent='以前の作業JSONを読み込んで続きを編集することもできます。';
  const settings=document.createElement('div');settings.className='local-sync-settings';
  settings.innerHTML='<strong>端末内自動同期 · 実験版</strong><p class="hint">音源のみ・5分／100MB以内。初回は約45MBのモデル＋約23MBの処理プログラムを取得します。Wi-Fi推奨。軽量モデルのため認識漏れがあり、完成精度は保証できません。</p><label>歌唱言語<select id="sync-language"><option value="ja">日本語中心</option><option value="en">English中心</option><option value="mixed">日英混在（日本語中心で照合）</option></select></label><label>解析する範囲<select id="sync-range"><option value="30">まず冒頭30秒で試す</option><option value="300">曲全体（5分以内）</option></select></label><label class="model-consent"><input id="model-consent" type="checkbox"> モデル取得と実験版の注意事項を確認しました</label><p class="hint">解析中はこの画面を開いたままにしてください。中止・失敗では既存の時刻を変更しません。手動修正済みの行は再解析でも保護します。<a href="vendor/transformers-3.8.1/NOTICE.md" target="_blank" rel="noopener">モデル・ライセンス</a></p>';
  $('#apply-lyrics').parentElement.before(settings);
  const limitation=document.createElement('p');limitation.className='quality-warning';limitation.textContent='精度の注意：検証した日本語の伴奏付き実曲では、軽量モデルが十分な時刻候補を作れませんでした。日本語曲の完成用としてはまだ不十分です。';settings.prepend(limitation);
  $('#align').hidden=false;$('#align').disabled=false;$('#align').onclick=safely(runBrowserSync);setControl($('#align'),'listen','自動同期','音源と入力歌詞をこの端末内で自動照合する');
  const help=$('#editor-help');help.querySelector('.help-steps li:first-child p').textContent='音源を選び、正しい歌詞を貼り付けます。初回モデル取得に同意し「自動同期」を押してください。保存したJSONから続けることもできます。';
  help.querySelector('details:last-child p').textContent='この実験画面では端末内で自動同期・時刻修正・SRT保存を行います。認識結果は本文を置き換えません。自動候補はすべて要確認です。MP4作成は行いません。モデル取得時は通信しますが、音源・歌詞は外部送信しません。';
  $('footer').textContent='端末内自動同期 実験0.4.3。スマホ実機は未検証です。自動候補を聴いて確認し、作業JSONも保存してください。';
  message('音源と歌詞を選び、まず30秒で試してください。自動候補は必ず確認が必要です。');
}
render();
async function showIncomingReview(){
  if(!LOCAL||!location.hash.startsWith('#review='))return;
  $('#incoming-review')?.remove();
  const fragment=location.hash;
  // Remove project data from the address bar before any subsequent navigation.
  window.history.replaceState(null,'',location.pathname+location.search);
  const card=document.createElement('section');card.id='incoming-review';card.className='panel';
  const title=document.createElement('h2');title.textContent='確認用の候補を開く';title.style.overflowWrap='anywhere';
  const status=document.createElement('p');status.className='hint local-message';status.setAttribute('role','status');status.textContent='確認リンクを読み込んでいます…';
  const buttons=document.createElement('div');buttons.className='buttons';
  const cancel=document.createElement('button');cancel.textContent='閉じる';cancel.onclick=()=>card.remove();buttons.append(cancel);
  card.append(title,status,buttons);$('main').prepend(card);
  try{
    const incoming=await decodeReviewFragment(fragment);if(!card.isConnected)return;
    title.textContent=String(incoming.name||'確認用の候補').slice(0,160);
    status.textContent=`${incoming.lines.length}行・時刻候補${cues(incoming).length}行。ファイルの保存は不要です。「候補を開く」のあと、同じ曲の音源または保存済み動画を選んでください。`;
    const open=document.createElement('button');open.className='primary';open.id='open-incoming-review';open.textContent='候補を開く';
    open.onclick=safely(()=>{if(openProject(incoming)){card.remove();switchTab('production');
      uploadStatus('media','同じ曲のMP3・WAV、またはスマホに保存済みのMOV・MP4を選んでください。');
      message('候補を開きました。同じ曲の音源・保存済み動画を選んでください。',false,true);
      $('#media-file').scrollIntoView({block:'center',behavior:'auto'});}});
    const save=document.createElement('button');save.id='save-incoming-review';save.textContent='JSONも保存';save.onclick=()=>blobDownload(JSON.stringify(saveProject(incoming),null,2),'review.lyricvideo.json','application/json');
    buttons.prepend(open,save);
  }catch(error){status.textContent=error.message;status.classList.add('error');message(error.message,true,true);}
}
showIncomingReview();
window.addEventListener('hashchange',showIncomingReview);
prepareProjectFont().catch(error=>message(error.message,true));
function tick(){if(!clock().paused)draw();requestAnimationFrame(tick);}requestAnimationFrame(tick);
if(!LOCAL)api("/api/health").then(()=>$("#engine-state").textContent="接続済み：このPCで同期・MP4書き出しを実行します。").catch(()=>{$("#engine-state").textContent="処理用PCが未接続です。READMEの起動手順を確認してください。";$("#align").disabled=true;$("#export").disabled=true;});
// Read-only browser test/inspection interface; no generated timestamps or mock results.
window.studio={snapshot:()=>structuredClone(project),currentTime:()=>clock().currentTime,selectRow,seekTo,
  inspection:()=>({runtime:LOCAL?"browser":"pc",activeTab,rowFilter,selected,past:history.past.length,future:history.future.length,paused:clock().paused,detached:Boolean(previewWindow&&!previewWindow.closed)})};
[video,audio].forEach(el=>["timeupdate","seeked","play","pause","loadeddata"].forEach(event=>el.addEventListener(event,draw)));
$("#background").addEventListener("load",draw);
