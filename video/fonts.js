import {fontFamily, normalizeFont} from "./font-catalog.js";
const loading = new Map();
export function ensureFont(id) {
  id=normalizeFont(id);
  if(!loading.has(id)) loading.set(id,Promise.all([500,700].map(async weight=>{
    const faces=await document.fonts.load(`${weight} 62px "${fontFamily(id)}"`,"歌詞 Hello");
    if(!faces.length || faces.some(face=>face.status!=="loaded")) throw new Error("フォントを読み込めません。接続を確認して再度選択してください。");
  })).catch(error=>{loading.delete(id);throw error;}));
  return loading.get(id);
}
