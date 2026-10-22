// Project data travels in a URL fragment. No fetch, media bytes, or server store.
import {loadProject,saveProject} from './core.js';
const MAX_BYTES=768*1024,MAX_LINK=128*1024;

function checkedProject(value){
  if(!value||value.type!=='lyric-video-studio-project'||value.version!==1||
    !Array.isArray(value.lines)||!value.lines.length||value.lines.length>1000||
    !Number.isFinite(Number(value.duration))||Number(value.duration)<=0)
    throw new Error('確認リンクのプロジェクト形式を読み取れません。');
  return loadProject(value);
}
function base64url(bytes){
  let binary='';for(let i=0;i<bytes.length;i+=8192)binary+=String.fromCharCode(...bytes.subarray(i,i+8192));
  return btoa(binary).replace(/\+/g,'-').replace(/\//g,'_').replace(/=+$/,'');
}
async function boundedBytes(stream){
  const reader=stream.getReader(),parts=[];let total=0;
  try{while(true){const {value,done}=await reader.read();if(done)break;total+=value.length;
    if(total>MAX_BYTES){await reader.cancel();throw new Error('確認リンクのデータが大きすぎます。');}parts.push(value);}}
  finally{reader.releaseLock();}
  const bytes=new Uint8Array(total);let offset=0;for(const part of parts){bytes.set(part,offset);offset+=part.length;}return bytes;
}
export async function encodeReviewLink(project,base){
  const url=new URL(base);if(!['http:','https:'].includes(url.protocol))throw new Error('HTTP(S)の編集画面URLを指定してください。');
  const bytes=new TextEncoder().encode(JSON.stringify(saveProject(checkedProject(project))));
  if(bytes.length>MAX_BYTES)throw new Error('確認リンクのデータが大きすぎます。');
  const zipped=typeof CompressionStream==='function';
  const encoded=zipped?await boundedBytes(new Blob([bytes]).stream().pipeThrough(new CompressionStream('gzip'))):bytes;
  url.hash=`review=${zipped?'gz1':'json1'}.${base64url(encoded)}`;
  if(url.href.length>MAX_LINK)throw new Error('確認リンクが長すぎます。プロジェクトファイルを使用してください。');
  return url.href;
}
export async function decodeReviewFragment(hash){
  if(!hash.startsWith('#review='))return null;
  if(hash.length>MAX_LINK)throw new Error('確認リンクが長すぎます。');
  const match=/^#review=(gz1|json1)\.([A-Za-z0-9_-]+)$/.exec(hash);
  if(!match)throw new Error('確認リンクが途中で切れているか、形式が異なります。');
  let bytes;try{bytes=Uint8Array.from(atob(match[2].replace(/-/g,'+').replace(/_/g,'/')),c=>c.charCodeAt(0));}
  catch{throw new Error('確認リンクの文字を読み取れません。');}
  if(match[1]==='gz1'){
    if(typeof DecompressionStream!=='function')throw new Error('このブラウザでは確認リンクを開けません。Safariを更新して開き直してください。');
    try{bytes=await boundedBytes(new Blob([bytes]).stream().pipeThrough(new DecompressionStream('gzip')));}
    catch(error){if(error.message.includes('大きすぎ'))throw error;throw new Error('確認リンクの展開に失敗しました。元のリンクを開き直してください。');}
  }
  if(bytes.length>MAX_BYTES)throw new Error('確認リンクのデータが大きすぎます。');
  let value;try{value=JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(bytes));}
  catch{throw new Error('確認リンクの内容を読み取れません。元のリンクを開き直してください。');}
  return checkedProject(value);
}
