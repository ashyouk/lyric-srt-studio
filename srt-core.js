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
