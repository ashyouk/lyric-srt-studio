import {ensureFont} from "./fonts.js";
const $=s=>document.querySelector(s),ctx=$("#popup-canvas").getContext("2d"),overlay=document.createElement("canvas");
overlay.width=1920;overlay.height=1080;const overlayCtx=overlay.getContext("2d");
let bridge,frame,closed=false,readyFont=null,loadingFont=null;
const label=t=>`${String(Math.floor(t/60)).padStart(2,"0")}:${(t%60).toFixed(3).padStart(6,"0")}`;
try{bridge=window.opener?.studioPreview;}catch{}
function disconnected(){closed=true;cancelAnimationFrame(frame);$("#popup-status").textContent="親画面との接続がありません。制作画面の「別窓で開く」から開き直してください。";document.querySelectorAll("button,input").forEach(el=>el.disabled=true);}
function tick(){
  if(closed)return;
  try{
    if(!bridge||!window.opener||window.opener.closed){disconnected();return;}
    const state=bridge.getState(),font=state.project.style.fontId;
    if(readyFont!==font&&loadingFont!==font){loadingFont=font;$("#popup-status").textContent="フォントを読み込んでいます…";ensureFont(font).then(()=>{if(!closed&&loadingFont===font){readyFont=font;loadingFont=null;$("#popup-status").textContent="親画面の修正をリアルタイムに表示しています。";}}).catch(error=>{$("#popup-status").textContent=error.message;});}
    if(readyFont===font)bridge.paint(ctx,overlayCtx,state);
    $("#popup-seek").max=String(state.project.duration||1);$("#popup-seek").value=String(state.time);
    $("#popup-time").textContent=`${label(state.time)} / ${label(state.project.duration)}`;
    $("#popup-play").textContent=state.paused?"▶ 再生":"Ⅱ 停止";
    const index=state.project.lines.findIndex(l=>l.id===state.playingId);$("#popup-line").textContent=index<0?"再生中の歌詞行：なし":`再生中の歌詞行 ${index+1}：${state.project.lines[index].text}`;
  }catch{disconnected();return;}
  frame=requestAnimationFrame(tick);
}
$("#popup-play").onclick=async()=>{try{await bridge?.toggle();}catch(error){$("#popup-status").textContent=error.message;}};$("#popup-back").onclick=()=>bridge?.seek(Math.max(0,bridge.getState().time-3));$("#popup-seek").oninput=e=>bridge?.seek(Number(e.target.value));$("#popup-return").onclick=()=>bridge?.return();
window.addEventListener("pagehide",()=>{closed=true;cancelAnimationFrame(frame);bridge?.closed(window);bridge=null;});
tick();
