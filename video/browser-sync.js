// No upload or API: decode a locally selected Blob, transfer PCM only to our worker.
export async function decodeForAlignment(blob,limitSeconds=300){
  if(!blob||blob.size>100*1024*1024)throw new Error('解析用音源は100MB以内で選んでください。');
  const AudioContext=globalThis.AudioContext||globalThis.webkitAudioContext;
  if(!AudioContext||!globalThis.OfflineAudioContext)throw new Error('このブラウザは音声の端末内変換に未対応です。');
  const context=new AudioContext();
  try{
    const decoded=await context.decodeAudioData(await blob.arrayBuffer());
    if(decoded.duration>300)throw new Error('この実験版は5分以内の音源が対象です。');
    const duration=Math.min(decoded.duration,limitSeconds),offline=new OfflineAudioContext(1,Math.ceil(duration*16000),16000);
    const source=offline.createBufferSource();source.buffer=decoded;source.connect(offline.destination);source.start();
    return (await offline.startRendering()).getChannelData(0).slice();
  }catch(error){throw new Error(`音源を解析用に読めません：${error.message}。WAV・MP3・M4Aで試してください。`);}
  finally{await context.close();}
}
export class BrowserSync {
  constructor(){this.worker=null;this.reject=null;}
  run(samples,lines,language,onStage=()=>{},model='tiny'){
    if(this.worker)throw new Error('実行中です。完了または中止をお待ちください。');
    return new Promise((resolve,reject)=>{
      this.reject=reject;this.worker=new Worker(new URL('./browser-sync-worker.js',import.meta.url),{type:'module'});
      const finish=(fn,value)=>{this.worker?.terminate();this.worker=null;this.reject=null;fn(value);};
      this.worker.onmessage=({data})=>{if(data.type==='stage')onStage(data.message);else if(data.type==='complete')finish(resolve,data.result);else if(data.type==='error')finish(reject,new Error(data.message));};
      this.worker.onerror=()=>finish(reject,new Error('解析ワーカーが停止しました。端末の空きメモリ・通信・ブラウザの対応を確認してください。'));
      this.worker.postMessage({samples,lines:lines.map(({id,text,alignmentText})=>({id,text,alignmentText})),language,model},[samples.buffer]);
    });
  }
  cancel(){this.worker?.terminate();this.worker=null;const reject=this.reject;this.reject=null;reject?.(new DOMException('解析を中止しました。','AbortError'));}
}
