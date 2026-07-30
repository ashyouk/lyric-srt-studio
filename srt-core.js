(() => {
const MIN_DURATION = 0.25;
const AUTO_GAP = 0.02;

function isTime(value) {
  return value !== null && value !== "" && Number.isFinite(Number(value));
}

function formatSrtTime(seconds) {
  const totalMs = Math.max(0, Math.round(Number(seconds || 0) * 1000));
  const hours = Math.floor(totalMs / 3_600_000);
  const minutes = Math.floor((totalMs % 3_600_000) / 60_000);
  const secs = Math.floor((totalMs % 60_000) / 1000);
  const ms = totalMs % 1000;
  return [hours, minutes, secs].map((part) => String(part).padStart(2, "0")).join(":") + "," + String(ms).padStart(3, "0");
}

function resolveEnd(lines, index, duration = 0) {
  return resolveEndDetails(lines, index, duration)?.end ?? null;
}

function resolveEndDetails(lines, index, duration = 0) {
  const line = lines[index];
  if (!line || !isTime(line.start)) return null;
  const start = Number(line.start);
  if (isTime(line.end) && Number(line.end) > start) {
    return { end: Number(line.end), source: "manual", invalidManual: false };
  }
  const invalidManual = isTime(line.end);
  const next = lines.slice(index + 1).find((candidate) => isTime(candidate.start) && Number(candidate.start) > start);
  if (next) {
    return {
      end: Math.max(start + MIN_DURATION, Number(next.start) - AUTO_GAP),
      source: "next",
      invalidManual,
    };
  }
  if (Number(duration) > start) {
    return { end: Math.max(start + MIN_DURATION, Number(duration)), source: "duration", invalidManual };
  }
  return { end: start + 3, source: "fallback", invalidManual };
}

function buildTimelineBlocks(lines, duration = 0) {
  return lines.flatMap((line, index) => {
    if (!isTime(line.start)) return [];
    const timing = resolveEndDetails(lines, index, duration);
    return [{
      index,
      start: Number(line.start),
      end: timing.end,
      source: timing.source,
      manual: timing.source === "manual",
      invalidManual: timing.invalidManual,
    }];
  });
}

function lyricDraftLines(value) {
  const lines = String(value || "").replace(/\r\n?/g, "\n").split("\n").map((line) => line.trim());
  while (lines[0] === "") lines.shift();
  while (lines.at(-1) === "") lines.pop();
  return lines;
}

function lyricDraftInfo(jpRaw, enRaw) {
  const jpLines = lyricDraftLines(jpRaw);
  const enLines = lyricDraftLines(enRaw);
  const hasJapanese = jpLines.some(Boolean);
  const hasEnglish = enLines.some(Boolean);
  let rows = [];

  if (hasJapanese && hasEnglish) {
    const count = Math.max(jpLines.length, enLines.length);
    rows = Array.from({ length: count }, (_, index) => ({
      jp: jpLines[index] || "",
      en: enLines[index] || "",
    })).filter((line) => line.jp || line.en);
  } else if (hasJapanese) {
    rows = jpLines.filter(Boolean).map((jp) => ({ jp, en: "" }));
  } else if (hasEnglish) {
    rows = enLines.filter(Boolean).map((en) => ({ jp: "", en }));
  }

  return {
    rows,
    hasJapanese,
    hasEnglish,
    jpLineCount: hasJapanese ? jpLines.length : 0,
    enLineCount: hasEnglish ? enLines.length : 0,
    lengthsDiffer: hasJapanese && hasEnglish && jpLines.length !== enLines.length,
  };
}

function parseLyricDrafts(jpRaw, enRaw) {
  return lyricDraftInfo(jpRaw, enRaw).rows;
}

function findNextUnrecordedIndex(lines, startIndex = 0) {
  if (!Array.isArray(lines) || !lines.length) return -1;
  const firstIndex = ((Number(startIndex) || 0) % lines.length + lines.length) % lines.length;
  for (let offset = 0; offset < lines.length; offset += 1) {
    const index = (firstIndex + offset) % lines.length;
    if (!isTime(lines[index]?.start)) return index;
  }
  return -1;
}

function timelineFollowScrollTarget({
  enabled,
  mode,
  currentTime,
  duration,
  contentWidth,
  viewportWidth,
  scrollLeft,
  force = false,
}) {
  if (!enabled || mode !== "edit") return null;
  const timelineDuration = Number(duration);
  const timelineWidth = Number(contentWidth);
  const visibleWidth = Number(viewportWidth);
  if (!(timelineDuration > 0) || !(timelineWidth > 0) || !(visibleWidth > 0)) return null;
  const current = Math.max(0, Math.min(timelineDuration, Number(currentTime) || 0));
  const left = Math.max(0, Number(scrollLeft) || 0);
  const playheadX = current / timelineDuration * timelineWidth;
  const leadingEdge = left + visibleWidth * .22;
  const trailingEdge = left + visibleWidth * .78;
  if (!force && playheadX >= leadingEdge && playheadX <= trailingEdge) return null;
  const maximumLeft = Math.max(0, timelineWidth - visibleWidth);
  return Math.max(0, Math.min(maximumLeft, playheadX - visibleWidth * .38));
}

function lineText(line, language) {
  if (language === "bilingual") return [line.jp, line.en].map((text) => String(text || "").trim()).filter(Boolean).join("\n");
  return String(line[language] || "").trim();
}

function validateLines(lines, duration = 0) {
  const errors = [];
  let previousStart = null;
  lines.forEach((line, index) => {
    if (!isTime(line.start)) return;
    const start = Number(line.start);
    if (previousStart !== null && start <= previousStart) errors.push(`${index + 1}行目の開始時刻が前の行以前になっています。`);
    if (isTime(line.end) && Number(line.end) <= start) errors.push(`${index + 1}行目の終了時刻は開始時刻より後にしてください。`);
    if (duration > 0 && (start > duration || (isTime(line.end) && Number(line.end) > duration))) errors.push(`${index + 1}行目の時刻が曲の長さを超えています。`);
    previousStart = start;
  });
  return errors;
}

function makeSrt(lines, language, duration = 0) {
  if (validateLines(lines, duration).length) return "";
  const selected = lines.map((line, index) => ({ line, index, text: lineText(line, language) })).filter(({ line, text }) => text && isTime(line.start));
  if (!selected.length) return "";
  return selected.map(({ line, index, text }, outputIndex) => `${outputIndex + 1}\n${formatSrtTime(line.start)} --> ${formatSrtTime(resolveEnd(lines, index, duration))}\n${text}`).join("\n\n") + "\n";
}

function analyzeProject(lines, duration = 0) {
  const issues = [];
  const hasJapanese = lines.some((line) => String(line.jp || "").trim());
  const hasEnglish = lines.some((line) => String(line.en || "").trim());
  let previousStart = null;
  lines.forEach((line, index) => {
    const jp = String(line.jp || "").trim();
    const en = String(line.en || "").trim();
    if (!jp && !en) issues.push({ index, severity: "error", code: "empty", message: "歌詞が空欄です。" });
    if (!isTime(line.start)) issues.push({ index, severity: "error", code: "unrecorded", message: "開始時刻が未記録です。" });
    if (hasJapanese && hasEnglish && (!jp || !en)) issues.push({ index, severity: "warning", code: "language", message: `${!jp ? "日本語" : "English"} が空欄です。` });
    if (jp.length > 42 || en.length > 58) issues.push({ index, severity: "warning", code: "long-text", message: "1字幕の文字数が多めです。読みやすさを確認してください。" });
    if (!isTime(line.start)) return;
    const start = Number(line.start);
    if (start < 0 || (duration > 0 && start > duration)) issues.push({ index, severity: "error", code: "range", message: "開始時刻が曲の範囲外です。" });
    if (previousStart !== null && start <= previousStart) issues.push({ index, severity: "error", code: "order", message: "前の記録済み行より後の時刻にしてください。" });
    previousStart = start;
    if (isTime(line.end)) {
      const end = Number(line.end);
      if (end <= start) issues.push({ index, severity: "error", code: "end-order", message: "終了時刻は開始時刻より後にしてください。" });
      if (duration > 0 && end > duration) issues.push({ index, severity: "error", code: "end-range", message: "終了時刻が曲の範囲外です。" });
      const next = lines.slice(index + 1).find((candidate) => isTime(candidate.start));
      if (next && end > Number(next.start)) issues.push({ index, severity: "warning", code: "overlap", message: "次の字幕と表示時間が重なっています。" });
    }
    const span = resolveEnd(lines, index, duration) - start;
    if (span < .5) issues.push({ index, severity: "warning", code: "short", message: `表示時間が短めです（${span.toFixed(2)}秒）。` });
    if (span > 15) issues.push({ index, severity: "warning", code: "long", message: `表示時間が長めです（${span.toFixed(1)}秒）。終了時刻の指定をおすすめします。` });
  });
  const errorLines = new Set(issues.filter((issue) => issue.severity === "error").map((issue) => issue.index));
  const readyCount = lines.filter((line, index) => !errorLines.has(index) && (line.jp || line.en) && isTime(line.start)).length;
  return { issues, readyCount, total: lines.length, errors: issues.filter((issue) => issue.severity === "error").length, warnings: issues.filter((issue) => issue.severity === "warning").length };
}

globalThis.LyricSrtCore = {
  analyzeProject,
  buildTimelineBlocks,
  findNextUnrecordedIndex,
  formatSrtTime,
  isTime,
  lineText,
  lyricDraftInfo,
  makeSrt,
  parseLyricDrafts,
  resolveEnd,
  resolveEndDetails,
  timelineFollowScrollTarget,
  validateLines,
};
})();
