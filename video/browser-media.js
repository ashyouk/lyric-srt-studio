// No fetch, uploads, server IDs, or media bytes in project JSON.
export function isBrowserEditor(href) {
  const url = new URL(href);
  return url.searchParams.get("mode") === "browser" || url.hostname.endsWith(".github.io");
}

export function mediaKind(file) {
  const extension = String(file.name || "").split(".").pop().toLowerCase();
  if (file.type?.startsWith("image/") || ["png", "jpg", "jpeg", "webp"].includes(extension)) return "image";
  if (file.type?.startsWith("video/") || ["mp4", "mov", "m4v", "webm"].includes(extension)) return "video";
  if (file.type?.startsWith("audio/") || ["mp3", "m4a", "wav", "wave", "aac", "ogg", "flac"].includes(extension)) return "audio";
  throw new Error("音源はMP3・M4A・WAV、動画はMP4、背景はPNG・JPEGなどを選んでください。再生できる形式はブラウザによります。");
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
  constructor({url = URL, document: doc = globalThis.document, timeoutMs = 20000} = {}) {
    this.url = url; this.document = doc; this.timeoutMs = timeoutMs; this.urls = new Set(); this.sequence = 0;
  }
  async open(file, slot) {
    const kind = mediaKind(file);
    if (slot === "background" && kind !== "image" || slot === "audio" && kind !== "audio" || slot === "media" && kind === "image")
      throw new Error("この欄に対応する種類の素材を選んでください。");
    const url = this.url.createObjectURL(file);
    this.urls.add(url);
    try {
      const duration = kind === "image" ? 0 : await this.duration(url, kind);
      return {id: `browser-${++this.sequence}`, url, name: file.name, kind, duration,
        hasAudio: kind === "audio" ? true : null, size: file.size, lastModified: file.lastModified,
        source: "browser-file"};
    } catch (error) {this.url.revokeObjectURL(url); this.urls.delete(url); throw error;}
  }
  duration(url, kind) {
    return new Promise((resolve, reject) => {
      const element = this.document.createElement(kind === "video" ? "video" : "audio");
      const finish = (error) => {
        clearTimeout(timer); element.onloadedmetadata = element.onerror = null;
        const duration = element.duration;
        element.removeAttribute("src"); element.load();
        if (error) reject(error);
        else if (!Number.isFinite(duration) || duration <= 0) reject(new Error("素材の長さを読み取れません。MP3・M4A・WAVなど別形式でお試しください。"));
        else resolve(duration);
      };
      const timer = setTimeout(() => finish(new Error("素材の読み込みが時間内に終わりませんでした。ファイルが端末へダウンロード済みか確認してください。")), this.timeoutMs);
      element.preload = "metadata"; element.playsInline = true;
      element.onloadedmetadata = () => finish();
      element.onerror = () => finish(new Error("このブラウザでは素材を再生できません。MP3・M4A・WAV、H.264のMP4など別形式でお試しください。"));
      element.src = url; element.load();
    });
  }
  // Keep replaced media alive for Undo. Release everything when history is reset.
  release(asset) {if(this.urls.delete(asset.url))this.url.revokeObjectURL(asset.url);}
  dispose() {for (const url of this.urls) this.url.revokeObjectURL(url); this.urls.clear();}
}
