export function formatSrtTime(seconds) {
  const totalMs = Math.max(0, Math.round(Number(seconds || 0) * 1000));
  const hours = Math.floor(totalMs / 3_600_000);
  const minutes = Math.floor((totalMs % 3_600_000) / 60_000);
  const secs = Math.floor((totalMs % 60_000) / 1000);
  const ms = totalMs % 1000;
  return [hours, minutes, secs].map((part) => String(part).padStart(2, "0")).join(":") + "," + String(ms).padStart(3, "0");
}

export function preparedLines(lines, language) {
  return lines
    .map((line) => ({ ...line, text: language === "bilingual" ? [line.jp, line.en].filter(Boolean).join("\n") : line[language] }))
    .filter((line) => line.text && line.start !== null && line.start !== "" && Number.isFinite(Number(line.start)));
}

export function validateLines(lines) {
  const timed = lines.filter((line) => line.start !== null && line.start !== "" && Number.isFinite(Number(line.start)));
  const errors = [];
  for (let index = 1; index < timed.length; index += 1) {
    if (Number(timed[index].start) <= Number(timed[index - 1].start)) {
      errors.push("開始時刻は上から順に、前の行より後にしてください。");
      break;
    }
  }
  return errors;
}

export function makeSrt(lines, language, duration = 0) {
  const selected = preparedLines(lines, language);
  if (!selected.length) return "";

  return selected.map((line, index) => {
    const start = Number(line.start);
    const hasNextLine = index < selected.length - 1;
    const nextStart = hasNextLine ? Number(selected[index + 1].start) : Number(duration || 0);
    const end = Math.max(start + 0.25, nextStart > start ? (hasNextLine ? nextStart - 0.02 : nextStart) : start + 3);
    return `${index + 1}\n${formatSrtTime(start)} --> ${formatSrtTime(end)}\n${line.text}`;
  }).join("\n\n") + "\n";
}

export function analyzeProject(lines, duration = 0) {
  const issues = [];
  const hasJapanese = lines.some((line) => String(line.jp || "").trim());
  const hasEnglish = lines.some((line) => String(line.en || "").trim());
  const starts = lines.map((line) => line.start === null || line.start === "" ? null : Number(line.start));

  let previousTimed = null;
  lines.forEach((line, index) => {
    const jp = String(line.jp || "").trim();
    const en = String(line.en || "").trim();
    const start = starts[index];
    if (!jp && !en) issues.push({ index, severity: "error", code: "empty", message: "歌詞が空欄です。" });
    if (start === null || !Number.isFinite(start)) issues.push({ index, severity: "error", code: "unrecorded", message: "開始時刻が未記録です。" });
    if (start !== null && Number.isFinite(start) && (start < 0 || (duration > 0 && start > duration))) issues.push({ index, severity: "error", code: "range", message: "開始時刻が曲の範囲外です。" });
    if (hasJapanese && hasEnglish && (!jp || !en)) issues.push({ index, severity: "warning", code: "language", message: `${!jp ? "日本語" : "English"} が空欄です。` });
    if (start !== null && Number.isFinite(start)) {
      if (previousTimed !== null && start <= previousTimed) issues.push({ index, severity: "error", code: "order", message: "前の記録済み行より後の時刻にしてください。" });
      previousTimed = start;
    }
  });

  lines.forEach((line, index) => {
    const start = starts[index];
    if (start === null || !Number.isFinite(start)) return;
    const next = index < lines.length - 1 ? starts[index + 1] : (duration > start ? duration : null);
    if (next === null || !Number.isFinite(next) || next <= start) return;
    const span = next - start;
    if (span < .5) issues.push({ index, severity: "warning", code: "short", message: `表示時間が短すぎます（${span.toFixed(2)}秒）。` });
    if (span > 15) issues.push({ index, severity: "warning", code: "long", message: `表示時間が長めです（${span.toFixed(1)}秒）。` });
  });

  const errorLines = new Set(issues.filter((issue) => issue.severity === "error").map((issue) => issue.index));
  const readyCount = lines.filter((line, index) => !errorLines.has(index) && (line.jp || line.en) && starts[index] !== null).length;
  return { issues, readyCount, total: lines.length, errors: issues.filter((issue) => issue.severity === "error").length, warnings: issues.filter((issue) => issue.severity === "warning").length };
}
