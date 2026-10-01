import "../srt-core.js";

export const DEFAULT_STYLE = Object.freeze({mode: "subtitle", fontSize: 62, color: "#ffffff",
  shadow: 6, y: .78, width: .82, background: "#101622"});
export const validTime = value => (typeof value === "number" || typeof value === "string" && value.trim() !== "") && Number.isFinite(Number(value));
const clone = value => JSON.parse(JSON.stringify(value));
const clamp = (value, low, high) => Math.min(high, Math.max(low, value));

export function parseLyrics(raw) {
  const source = String(raw).replace(/\r\n?/g, "\n");
  let section = "";
  return source.split("\n").flatMap((text, sourceLine) => {
    if (!text.trim()) return [];
    if (/^\s*\[[^\]\n]+\]\s*$/.test(text)) { section = text.trim(); return []; }
    return [{id: `line-${sourceLine}`, sourceLine, section, text, alignmentText: text,
      start: null, end: null, auto: null, manual: {start: false, end: false},
      review: true, reasons: ["未同期です。"]}];
  });
}

export function newProject(raw = "") {
  return {type: "lyric-video-studio-project", version: 1, name: "歌詞入り動画",
    lyrics: String(raw), lines: parseLyrics(raw), duration: 0, style: {...DEFAULT_STYLE},
    assets: {media: null, audio: null, background: null}, alignment: null};
}

export function normalizeStyle(value = {}) {
  const color = candidate => /^#[0-9a-f]{6}$/i.test(candidate || "");
  return {mode: value.mode === "scroll" ? "scroll" : "subtitle",
    fontSize: clamp(Number(value.fontSize) || 62, 24, 120),
    color: color(value.color) ? value.color : DEFAULT_STYLE.color,
    shadow: clamp(Number(value.shadow) || 0, 0, 12),
    y: clamp(Number(value.y) || .78, .15, .85), width: clamp(Number(value.width) || .82, .3, .95),
    background: color(value.background) ? value.background : DEFAULT_STYLE.background};
}

export function loadProject(data) {
  if (!data || !Array.isArray(data.lines) || data.lines.length > 5000) throw new Error("プロジェクトを読み込めません。");
  if (data.type === "lyric-srt-studio-project" || (!data.type && data.lines.some(l => "jp" in l))) {
    const result = newProject();
    result.name = data.projectName || "旧SRTプロジェクト";
    result.duration = Number(data.duration) || 0;
    result.legacy = clone(data);
    result.lines = data.lines.map((line, i) => ({id: line.id || `legacy-${i}`,
      text: [line.jp, line.en].filter(Boolean).join("\n"), alignmentText: line.jp || line.en || "",
      legacyLanguages: {jp: line.jp || "", en: line.en || ""},
      start: validTime(line.start) ? Number(line.start) : null,
      end: validTime(line.start) ? globalThis.LyricSrtCore.resolveEnd(data.lines, i, result.duration) : null,
      manual: {start: validTime(line.start), end: validTime(line.end)}, auto: null,
      review: !validTime(line.start), reasons: ["旧プロジェクトから取り込みました。"]}));
    result.lyrics = result.lines.map(l => l.text).join("\n");
    result.assets.media = data.mediaName ? {name: data.mediaName, reselect: true} : null;
    return result;
  }
  if (data.type !== "lyric-video-studio-project" || data.version !== 1) throw new Error("未対応のプロジェクト形式です。");
  const result = clone(data);
  result.style = normalizeStyle({...DEFAULT_STYLE, ...data.style});
  result.duration = Math.max(0, Number(data.duration) || 0);
  result.assets = {...newProject().assets, ...result.assets};
  // A project is a reference document, never permission to load remote URLs or
  // resurrect runtime media IDs. Reselect through the local upload boundary.
  Object.values(result.assets).forEach(asset => {
    if (asset) {delete asset.id; delete asset.url; asset.reselect = true;}
  });
  result.lines = result.lines.map((l, i) => ({...l, id: l.id || `line-${i}`, text: String(l.text || ""),
    alignmentText: String(l.alignmentText || l.text || ""),
    start: validTime(l.start) ? Number(l.start) : null, end: validTime(l.end) ? Number(l.end) : null,
    manual: {start: Boolean(l.manual?.start), end: Boolean(l.manual?.end)}, review: l.review !== false,
    reasons: Array.isArray(l.reasons) ? l.reasons.map(String) : []}));
  if (new Set(result.lines.map(l => l.id)).size !== result.lines.length) throw new Error("歌詞行のIDが重複しているプロジェクトです。");
  return result;
}

export function saveProject(project) {
  const result = clone(project);
  Object.values(result.assets).forEach(asset => {if (asset) {delete asset.id; delete asset.url; asset.reselect = true;}});
  return result;
}

export function applyAlignment(project, result) {
  const next = clone(project);
  const byId = new Map(result.lines.map(l => [l.id, l]));
  next.lines = next.lines.map(line => {
    const estimate = byId.get(line.id);
    if (!estimate) return line;
    const protectedTiming = line.manual.start || line.manual.end;
    return {...line, auto: {...estimate, engine: result.engine},
      start: protectedTiming ? line.start : estimate.start,
      end: protectedTiming ? line.end : estimate.end,
      review: protectedTiming ? line.review : true,
      reasons: protectedTiming ? line.reasons : estimate.reasons};
  });
  next.alignment = {engine: result.engine, elapsedSeconds: result.elapsedSeconds,
    asrModel: result.diagnostics?.asrModel || null};
  return next;
}

export function editTiming(project, id, field, value) {
  if (!["start", "end"].includes(field)) throw new Error("未対応の時刻項目です。");
  if (!validTime(value) || Number(value) < 0 || Number(value) > project.duration) throw new Error("素材の範囲内で時刻を指定してください。");
  const next = clone(project);
  const row = next.lines.find(l => l.id === id);
  if (!row) throw new Error("対象行がありません。");
  row[field] = Math.round(Number(value) * 1000) / 1000;
  row.manual[field] = true;
  row.review = true;
  row.reasons = ["手動修正した区間を確認してください。"];
  return next;
}

export function confirmLine(project, id) {
  const next = clone(project);
  const row = next.lines.find(l => l.id === id);
  if (!row || !validTime(row.start) || !validTime(row.end) || row.start < 0 || row.end <= row.start || row.end > project.duration + .15) {
    throw new Error("開始・終了時刻を正しい範囲で指定してください。");
  }
  row.review = false;
  return next;
}

export function cues(project, confirmedOnly = false) {
  return project.lines.filter(l => validTime(l.start) && validTime(l.end) && l.end > l.start &&
    l.start >= 0 && l.end <= project.duration + .15 && (!confirmedOnly || !l.review));
}

// An audition includes valid candidates without silently approving the saved rows.
// Final output keeps the same confirmed-only intervals as SRT.
export function videoExportProject(project, includeUnreviewed = false) {
  const next = clone(project);
  next.lines = cues(next, !includeUnreviewed);
  return next;
}

export function activeCue(project, time) {
  return cues(project).find(l => time >= l.start && time < l.end) || null;
}

export function exportSrt(project, language = "original") {
  const lines = cues(project, true).map(l => ({start: l.start, end: l.end,
    jp: language === "original" ? l.text : l.legacyLanguages?.jp || l.text,
    en: l.legacyLanguages?.en || ""}));
  return globalThis.LyricSrtCore.makeSrt(lines, language === "original" ? "jp" : language, project.duration);
}

export class History {
  constructor(limit = 100) {this.limit = limit; this.past = []; this.future = [];}
  change(current, next) {this.past.push(clone(current)); if (this.past.length > this.limit) this.past.shift(); this.future = []; return next;}
  undo(current) {if (!this.past.length) return current; this.future.push(clone(current)); return this.past.pop();}
  redo(current) {if (!this.future.length) return current; this.past.push(clone(current)); return this.future.pop();}
}

// Stable time-derived geometry. Preview and export use this exact layout and draw function.
export function wrapText(text, maxWidth, measure) {
  const output = [];
  for (const paragraph of String(text).split("\n")) {
    const tokens = paragraph.match(/[A-Za-z0-9'’-]+\s*|[^A-Za-z0-9]/gu) || [""];
    let line = "";
    for (const token of tokens) {
      if (line && measure(line + token) > maxWidth) {output.push(line.trimEnd()); line = "";}
      if (measure(token) > maxWidth) {
        for (const char of token) {if (line && measure(line + char) > maxWidth) {output.push(line); line = "";} line += char;}
      } else line += token;
    }
    output.push(line.trimEnd());
  }
  return output;
}

export function layoutScene(project, time, measure) {
  const style = normalizeStyle(project.style), font = style.fontSize, lineHeight = font * 1.45;
  const items = cues(project).map(l => ({...l, wrapped: wrapText(l.text, 1920 * style.width, measure)}));
  const active = items.find(l => time >= l.start && time < l.end);
  if (style.mode === "subtitle") {
    if (!active) return [];
    return [{...active, active: true, opacity: 1, y: 1080 * style.y - (active.wrapped.length - 1) * lineHeight / 2}];
  }
  if (!items.length) return [];
  let anchor = active || items.filter(l => l.start <= time).at(-1) || items[0];
  const index = items.indexOf(anchor);
  const centers = [], heights = items.map(l => l.wrapped.length * lineHeight + font * .65);
  let top = 0;
  items.forEach((l, i) => {centers.push(top + heights[i] / 2); top += heights[i];});
  // Animation phase is a function of media time, not accumulated RAF/delta state.
  const previous = Math.max(0, index - 1);
  const progress = clamp((time - anchor.start) / .3, 0, 1);
  const eased = progress * progress * (3 - 2 * progress);
  const offset = centers[previous] + (centers[index] - centers[previous]) * eased;
  return items.map((l, i) => ({...l, active: l.id === active?.id, opacity: l.id === active?.id ? 1 : .35,
    y: 1080 * style.y + centers[i] - offset - (l.wrapped.length - 1) * lineHeight / 2}));
}

export function drawLyrics(ctx, project, time) {
  const style = normalizeStyle(project.style), font = style.fontSize;
  ctx.clearRect(0, 0, 1920, 1080);
  ctx.font = `600 ${font}px "Studio Noto"`;
  const layout = layoutScene(project, time, text => ctx.measureText(text).width);
  ctx.textAlign = "center"; ctx.textBaseline = "middle";
  ctx.lineJoin = "round";
  const top = 1080 * style.y - 290, bottom = 1080 * style.y + 290;
  ctx.save();
  if (style.mode === "scroll") {ctx.beginPath(); ctx.rect(0, Math.max(0, top), 1920, Math.min(1080, bottom) - Math.max(0, top)); ctx.clip();}
  for (const row of layout) {
    ctx.font = `${row.active ? 700 : 500} ${font}px "Studio Noto"`;
    row.wrapped.forEach((text, i) => {
      const y = row.y + i * font * 1.45;
      const edge = style.mode === "scroll" ? clamp(Math.min(y - top, bottom - y) / 100, 0, 1) : 1;
      ctx.globalAlpha = row.opacity * edge;
      ctx.strokeStyle = "#000000"; ctx.lineWidth = style.shadow;
      ctx.shadowColor = "#000000bb"; ctx.shadowBlur = style.shadow * 2;
      if (style.shadow) ctx.strokeText(text, 960, y);
      ctx.fillStyle = style.color; ctx.fillText(text, 960, y);
    });
  }
  ctx.restore();
  ctx.globalAlpha = 1;
  return layout;
}
