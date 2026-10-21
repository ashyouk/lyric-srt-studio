// No fetch, uploads, server IDs, or media bytes in project JSON.
export function isBrowserEditor(href) {
  const url = new URL(href);
  return url.searchParams.get("mode") === "browser" || url.hostname.endsWith(".github.io");
}

export function mediaKind(file) {
  const extension = String(file.name || "").split(".").pop().toLowerCase();
  // iOS file providers sometimes supply a container MIME instead of its contents.
  if (["mp3", "m4a", "wav", "wave", "aac", "ogg", "flac"].includes(extension)) return "audio";
  if (file.type?.startsWith("image/") || ["png", "jpg", "jpeg", "webp"].includes(extension)) return "image";
  if (file.type?.startsWith("video/") || ["mp4", "mov", "m4v", "webm"].includes(extension)) return "video";
  if (file.type?.startsWith("audio/") || ["mp3", "m4a", "wav", "wave", "aac", "ogg", "flac"].includes(extension)) return "audio";
  throw new Error("音源はMP3・M4A・WAV、動画はMP4、背景はPNG・JPEGなどを選んでください。再生できる形式はブラウザによります。");
}

export function playableBlob(file){
  const extension=String(file.name||'').split('.').pop().toLowerCase();
  const mime={mp3:'audio/mpeg',m4a:'audio/mp4',wav:'audio/wav',wave:'audio/wav',aac:'audio/aac',ogg:'audio/ogg',flac:'audio/flac'}[extension];
  return mime&&(!file.type?.startsWith('audio/')||file.type==='audio/x-wav')?new Blob([file],{type:mime}):file;
}

// Bounded header read, not a full audio decode. Metadata playback policy cannot
// block PCM/float RIFF duration discovery. Unknown/compressed WAV falls back.
export async function wavDuration(file){
  if(typeof file.slice!=='function')return null;
  const buffer=await file.slice(0,65536).arrayBuffer(),view=new DataView(buffer);
  const text=(offset,size)=>String.fromCharCode(...new Uint8Array(buffer,offset,size));
  if(buffer.byteLength<12||text(0,4)!=='RIFF'||text(8,4)!=='WAVE')return null;
  let rate=0,dataSize=null;
  for(let pos=12;pos+8<=buffer.byteLength;){
    const tag=text(pos,4),size=view.getUint32(pos+4,true),body=pos+8;
    if(tag==='fmt '&&size>=16&&body+16<=buffer.byteLength){
      let format=view.getUint16(body,true);
      if(format===65534&&size>=40&&body+40<=buffer.byteLength)format=view.getUint16(body+24,true);
      const channels=view.getUint16(body+2,true),sampleRate=view.getUint32(body+4,true),byteRate=view.getUint32(body+8,true),align=view.getUint16(body+12,true);
      if(![1,3].includes(format)||!channels||!sampleRate||!align||byteRate!==sampleRate*align)return null;
      rate=byteRate;
    }
    if(tag==='data'){
      if(size===0xffffffff||size>file.size-body)return null;
      dataSize=size;
    }
    if(rate&&dataSize!==null){const seconds=dataSize/rate;return seconds>0&&Number.isFinite(seconds)?seconds:null;}
    pos=body+size+(size%2);
  }
  return null;
}

export async function decodedAudioDuration(file){
  const Context=globalThis.AudioContext||globalThis.webkitAudioContext;
  if(!Context||typeof file?.arrayBuffer!=='function'||file.size>20*1024*1024)return null;
  // Resample the temporary decoded buffer to keep fallback memory bounded for
  // typical MP3/M4A songs. Never connect a source or play this context.
  const context=new Context({sampleRate:16000});
  try{return (await context.decodeAudioData(await file.arrayBuffer())).duration;}
  finally{await context.close();}
}

export function attachBrowserAsset(project, asset, slot) {
  if (!["media", "audio", "background"].includes(slot)) throw new Error("未対応の素材です。");
  if (slot === "media" && !["audio", "video"].includes(asset.kind) ||
      slot === "audio" && asset.kind !== "audio" || slot === "background" && asset.kind !== "image")
    throw new Error("この欄に対応する種類の素材を選んでください。");
  if (asset.kind !== "image" && (!Number.isFinite(asset.duration) || asset.duration <= 0))
    throw new Error("素材の長さを読み取れません。別形式でお試しください。");
  const next = JSON.parse(JSON.stringify(project));
  next.assets[slot] = {...asset};
  if (slot === "media") {next.duration = asset.duration; next.assets.audio = null;}
  return next;
}

export class BrowserMedia {
  constructor({url = URL, document: doc = globalThis.document, timeoutMs = 20000,decodeDuration=decodedAudioDuration,fallbackDelayMs=1800} = {}) {
    this.url = url; this.document = doc; this.timeoutMs = timeoutMs; this.urls = new Set(); this.sequence = 0;
    this.decodeDuration=decodeDuration;this.fallbackDelayMs=fallbackDelayMs;
  }
  async open(file, slot) {
    if(file.size===0)throw new Error('ファイルが空です。iCloud等の音源は「ファイル」アプリで端末へダウンロードしてから選び直してください。');
    const kind = mediaKind(file);
    if (slot === "background" && kind !== "image" || slot === "audio" && kind !== "audio" || slot === "media" && kind === "image")
      throw new Error("この欄に対応する種類の素材を選んでください。");
    const url = this.url.createObjectURL(playableBlob(file));
    this.urls.add(url);
    try {
      const fromHeader=kind==='audio'&&/\.(wav|wave)$/i.test(file.name||'')?await wavDuration(file):null;
      const measurement=kind==='image'?{duration:0,source:'image'}:fromHeader?{duration:fromHeader,source:'wav-header'}:await this.duration(url,kind,file);
      const duration=measurement.duration;
      return {id: `browser-${++this.sequence}`, url, name: file.name, kind, duration,
        hasAudio: kind === "audio" ? true : null, size: file.size, lastModified: file.lastModified,
        source: "browser-file",durationSource:measurement.source};
    } catch (error) {this.url.revokeObjectURL(url); this.urls.delete(url); throw error;}
  }
  duration(url, kind, file) {
    return new Promise((resolve, reject) => {
      const element = this.document.createElement(kind === "video" ? "video" : "audio");
      let settled=false,decoding=false,decodeFinished=false,nativeError=false;
      const finish = (error,knownDuration=element.duration,source='media-metadata') => {
        if(settled)return;settled=true;
        clearTimeout(timer);clearTimeout(fallbackTimer); element.onloadedmetadata = element.ondurationchange = element.onloadeddata = element.onerror = null;
        const duration = knownDuration;
        element.pause?.();
        element.removeAttribute("src"); element.load();
        element.remove?.();
        if (error) reject(error);
        else if (!Number.isFinite(duration) || duration <= 0) reject(new Error("素材の長さを読み取れません。MP3・M4A・WAVなど別形式でお試しください。"));
        else resolve({duration,source});
      };
      const decode=async()=>{
        if(settled||decoding||kind!=='audio')return;decoding=true;
        try{const seconds=await this.decodeDuration(file);if(Number.isFinite(seconds)&&seconds>0)finish(null,seconds,'audio-decode');else if(nativeError)finish(new Error('音源を読み込めません。ファイルが端末に保存済みか、MP3・M4A・PCM形式のWAVかを確認してください。'));}
        catch{if(nativeError)finish(new Error('音源を読み込めません。ファイルを端末にダウンロードし直すか、別形式で試してください。'));}
        finally{decodeFinished=true;}
      };
      const timer = setTimeout(() => finish(new Error("素材の読み込みが時間内に終わりませんでした。iCloud等から端末へダウンロード済みか確認し、WAV・MP3などで選び直してください。")), this.timeoutMs);
      const fallbackTimer=kind==='audio'?setTimeout(decode,this.fallbackDelayMs):null;
      element.preload = "metadata"; element.playsInline = true;
      const ready=()=>{if(Number.isFinite(element.duration)&&element.duration>0)finish();};
      element.onloadedmetadata = element.ondurationchange = element.onloadeddata = ready;
      element.onerror = () => {nativeError=true;if(kind==='audio'&&!decodeFinished)decode();else finish(new Error('このブラウザでは素材を読み込めません。端末に保存したMP3・M4A・PCM WAV、H.264のMP4などで試してください。'));};
      element.setAttribute?.('aria-hidden','true');element.setAttribute?.('tabindex','-1');
      if(element.style)element.style.cssText='position:fixed;left:-9999px;width:1px;height:1px;opacity:0;pointer-events:none';
      this.document.body?.append(element);
      element.src = url; element.load();
    });
  }
  // Keep replaced media alive for Undo. Release everything when history is reset.
  release(asset) {if(this.urls.delete(asset.url))this.url.revokeObjectURL(asset.url);}
  dispose() {for (const url of this.urls) this.url.revokeObjectURL(url); this.urls.clear();}
}
