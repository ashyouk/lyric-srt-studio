import {pipeline,env} from './vendor/transformers-3.8.1/transformers.min.js';
import {BROWSER_MODELS,matchAcousticWords} from './browser-alignment.js';
env.allowLocalModels=false;
env.useBrowserCache=true;
env.backends.onnx.wasm.wasmPaths=new URL('./vendor/transformers-3.8.1/',import.meta.url).href;
env.backends.onnx.wasm.numThreads=1;
env.backends.onnx.wasm.proxy=false;
// Fail closed if a future runtime change tries to contact an inference service.
const nativeFetch=globalThis.fetch.bind(globalThis);
globalThis.fetch=(input,options={})=>{
  const request=input instanceof Request?input:null,url=new URL(request?.url||String(input),self.location.href);
  const method=(options.method||request?.method||'GET').toUpperCase();
  const local=url.origin===self.location.origin;
  const model=url.origin==='https://huggingface.co'&&Object.values(BROWSER_MODELS).some(m=>url.pathname.startsWith(`/${m.id}/resolve/${m.revision}/`));
  if(!['GET','HEAD'].includes(method)||(!local&&!model))throw new Error('許可されていない解析通信を遮断しました。');
  return nativeFetch(input,options);
};
let transcriber;const reported=new Map();
self.onmessage=async({data})=>{
  const started=performance.now();
  try{
    const model=BROWSER_MODELS[data.model||'tiny'];if(!model)throw new Error('未対応のモデルです。');
    self.postMessage({type:'stage',message:`モデルを読込中：${model.id}（初回は取得が必要です）`});
    transcriber??=await pipeline('automatic-speech-recognition',model.id,{revision:model.revision,device:'wasm',dtype:'q8',progress_callback:p=>{
      if(p.status==='progress'){const step=Math.floor((p.progress||0)/10)*10;if(reported.get(p.file)!==step){reported.set(p.file,step);self.postMessage({type:'stage',message:`モデル取得中：${p.file} ${step}%`});}}
    }});
    self.postMessage({type:'stage',message:'この端末で音声を認識中です。画面を閉じずにお待ちください。'});
    // This pinned runtime has no language auto-detection; mixed defaults to JA.
    const language=data.language==='en'?'en':'ja';
    const output=await transcriber(data.samples,{return_timestamps:'word',chunk_length_s:30,stride_length_s:5,task:'transcribe',language});
    self.postMessage({type:'stage',message:'入力した歌詞と音響時刻を照合中…'});
    const lines=matchAcousticWords(data.lines,output.chunks,data.samples.length/16000);
    self.postMessage({type:'complete',result:{engine:`browser-whisper-${data.model||'tiny'}-q8-word-blocks`,elapsedSeconds:Math.round((performance.now()-started)/10)/100,lines,
      diagnostics:{asrModel:model.id,revision:model.revision,language,recognizedForMatchingOnly:output.text,wordTimings:output.chunks,runtime:'wasm-single-thread'}}});
  }catch(error){self.postMessage({type:'error',message:`端末内解析に失敗しました：${error.message}。短いWAVで再試行してください。`});}
};
