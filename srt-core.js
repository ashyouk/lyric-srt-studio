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
  const line = lines[index];
  if (!line || !isTime(line.start)) return null;
  const start = Number(line.start);
  if (isTime(line.end) && Number(line.end) > start) return Number(line.end);
  const next = lines.slice(index + 1).find((candidate) => isTime(candidate.start) && Number(candidate.start) > start);
  if (next) return Math.max(start + MIN_DURATION, Number(next.start) - AUTO_GAP);
  if (Number(duration) > start) return Math.max(start + MIN_DURATION, Number(duration));
  return start + 3;
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

globalThis.LyricSrtCore = { analyzeProject, formatSrtTime, isTime, lineText, makeSrt, resolveEnd, validateLines };
})();
