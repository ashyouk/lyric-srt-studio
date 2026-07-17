function formatSrtTime(seconds) {
  const totalMs = Math.max(0, Math.round(Number(seconds || 0) * 1000));
  const hours = Math.floor(totalMs / 3_600_000);
  const minutes = Math.floor((totalMs % 3_600_000) / 60_000);
  const secs = Math.floor((totalMs % 60_000) / 1000);
  const ms = totalMs % 1000;
  return [hours, minutes, secs].map((part) => String(part).padStart(2, "0")).join(":") + "," + String(ms).padStart(3, "0");
}

function preparedLines(lines, language) {
  return lines
    .map((line) => ({ ...line, text: language === "bilingual" ? [line.jp, line.en].filter(Boolean).join("\n") : line[language] }))
    .filter((line) => line.text && line.start !== null && line.start !== "" && Number.isFinite(Number(line.start)));
}

function validateLines(lines) {
  const timed = lines.filter((line) => line.start !== null && line.start !== "" && Number.isFinite(Number(line.start)));
  for (let index = 1; index < timed.length; index += 1) {
    if (Number(timed[index].start) <= Number(timed[index - 1].start)) return ["開始時刻は上から順に、前の行より後にしてください。"];
  }
  return [];
}

function makeSrt(lines, language, duration = 0) {
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

function analyzeProject(lines, duration = 0) {
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

const STORAGE_KEY = "lyric-srt-studio-v1";
const state = { lines: [], activeIndex: 0, mediaUrl: null, duration: 0, jpDraft: "", enDraft: "", history: [], future: [], waveform: null, previewMode: "bilingual" };

const $ = (selector) => document.querySelector(selector);
const rows = $("#rows");
const player = $("#player");
const status = $("#status");
const currentTime = $("#current-time");
const progress = $("#progress");
const waveform = $("#waveform");
const waveformStatus = $("#waveform-status");
const timelineViewport = $("#timeline-viewport");
const timelineTrack = $("#timeline-track");
const timelineBlocks = $("#timeline-blocks");
const timelineRuler = $("#timeline-ruler");
const timelinePlayhead = $("#timeline-playhead");
let waveformFrame = null;
let undoToastTimer = null;

function newId() { return globalThis.crypto?.randomUUID?.() || `${Date.now()}-${Math.random().toString(36).slice(2)}`; }
function newLine() { return { id: newId(), jp: "", en: "", start: null }; }

function seedLines() {
  state.lines = ["第一行の日本語", "第二行の日本語", "第三行の日本語"].map((jp, index) => ({
    id: newId(), jp, en: ["First line in English", "Second line in English", "Third line in English"][index], start: null,
  }));
}

function save() {
  localStorage.setItem(STORAGE_KEY, JSON.stringify({ lines: state.lines, jpDraft: $("#bulk-jp")?.value ?? state.jpDraft, enDraft: $("#bulk-en")?.value ?? state.enDraft }));
}

function load() {
  try {
    const stored = JSON.parse(localStorage.getItem(STORAGE_KEY));
    if (Array.isArray(stored?.lines) && stored.lines.length) state.lines = stored.lines.map((line) => ({ ...newLine(), ...line }));
    state.jpDraft = stored?.jpDraft || "";
    state.enDraft = stored?.enDraft || "";
  } catch { /* A corrupt saved draft should never block the app. */ }
  if (!state.lines.length) seedLines();
}

function timeLabel(seconds) {
  const s = Math.max(0, Number(seconds || 0));
  const minutes = Math.floor(s / 60);
  return `${String(minutes).padStart(2, "0")}:${String(Math.floor(s % 60)).padStart(2, "0")}.${String(Math.floor((s % 1) * 10))}`;
}

function mediaTypeFromName(name) {
  const extension = String(name || "").split(".").pop().toLowerCase();
  return {
    mp3: "audio/mpeg", m4a: "audio/mp4", aac: "audio/aac", wav: "audio/wav",
    mp4: "video/mp4", mov: "video/quicktime", ogg: "audio/ogg", webm: "audio/webm",
  }[extension] || "";
}

function fileWithKnownMediaType(file) {
  const type = mediaTypeFromName(file.name);
  if (!type || file.type === type) return file;
  return new File([file], file.name, { type, lastModified: file.lastModified });
}

function render(scrollActive = false) {
  rows.innerHTML = "";
  const report = analyzeProject(state.lines, state.duration);
  const issuesByLine = new Map();
  report.issues.forEach((issue) => {
    const current = issuesByLine.get(issue.index);
    if (!current || (issue.severity === "error" && current.severity !== "error")) issuesByLine.set(issue.index, issue);
  });
  state.lines.forEach((line, index) => {
    const lineIssue = issuesByLine.get(index);
    const item = document.createElement("article");
    item.className = `line ${index === state.activeIndex ? "active" : ""} ${lineIssue ? `has-${lineIssue.severity}` : ""}`;
    item.innerHTML = `
      <button class="line-number" type="button" data-action="select" aria-label="${index + 1}行目を選択">${index + 1}</button>
      <div class="inputs">
        <label><span>日本語</span><textarea data-field="jp" placeholder="日本語の歌詞">${escapeHtml(line.jp)}</textarea></label>
        <label><span>English</span><textarea data-field="en" placeholder="English lyric">${escapeHtml(line.en)}</textarea></label>
      </div>
      <div class="timing">
        <output>${line.start === null || line.start === "" ? "--:--.-" : timeLabel(line.start)}</output>
        <button type="button" data-action="capture">ここで記録</button>
        ${lineIssue ? `<span class="line-alert">${lineIssue.severity === "error" ? "●" : "▲"} ${escapeHtml(lineIssue.message)}</span>` : ""}
        <div class="fine-adjust" aria-label="時刻を微調整">
          <button type="button" data-adjust="-0.5">−.5</button><button type="button" data-adjust="-0.1">−.1</button>
          <button type="button" data-adjust="0.1">＋.1</button><button type="button" data-adjust="0.5">＋.5</button>
        </div>
        <button class="icon-button" type="button" data-action="delete" aria-label="この行を削除">×</button>
      </div>`;
    item.addEventListener("click", (event) => {
      if (!event.target.closest("textarea") && !event.target.closest("button")) capture(index);
    });
    item.querySelectorAll("textarea").forEach((textarea) => textarea.addEventListener("input", () => {
      state.lines[index][textarea.dataset.field] = textarea.value;
      save();
      renderTimeline();
      renderQuality();
      updateSubtitlePreview();
    }));
    item.querySelector("[data-action=select]").onclick = () => selectLine(index);
    item.querySelector("[data-action=capture]").onclick = () => capture(index);
    item.querySelector("[data-action=delete]").onclick = () => removeLine(index);
    item.querySelectorAll("[data-adjust]").forEach((button) => { button.onclick = () => adjustTime(index, Number(button.dataset.adjust)); });
    rows.append(item);
  });
  $("#line-count").textContent = `${state.lines.length} 行`;
  updateFocus();
  updateUndoControl();
  drawWaveform();
  renderTimeline();
  renderQuality(report);
  updateSubtitlePreview();
  if (scrollActive) requestAnimationFrame(() => rows.children[state.activeIndex]?.scrollIntoView({ behavior: "smooth", block: "center" }));
}

function escapeHtml(value) {
  return String(value || "").replace(/[&<>\"]/g, (char) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[char]);
}

function selectLine(index) {
  state.activeIndex = Math.max(0, Math.min(index, state.lines.length - 1));
  render(true);
}

function capture(index = state.activeIndex) {
  if (!state.lines.length) return;
  const next = Number(player.currentTime.toFixed(3));
  state.history.push({ index, previous: state.lines[index].start, next, action: "時刻の記録" });
  state.future = [];
  state.lines[index].start = next;
  state.activeIndex = Math.min(index + 1, state.lines.length - 1);
  save(); render();
  status.textContent = `${index + 1} 行目を ${timeLabel(player.currentTime)} に記録しました。`;
  showUndoToast(`${index + 1} 行目を ${timeLabel(player.currentTime)} に記録しました`);
}

function updateFocus() {
  const line = state.lines[state.activeIndex];
  $("#focus-number").textContent = line ? `${state.activeIndex + 1} / ${state.lines.length}` : "";
  $("#focus-jp").textContent = line?.jp || line?.en || "歌詞を入力してください";
  $("#focus-en").textContent = line?.jp ? (line.en || "") : "";
}

function adjustTime(index, delta) {
  const line = state.lines[index];
  if (line.start === null || line.start === "") { status.textContent = "先にこの行の時刻を記録してください。"; return; }
  const next = Number(Math.max(0, Math.min(state.duration || Infinity, Number(line.start) + delta)).toFixed(3));
  state.history.push({ index, previous: line.start, next, action: `${delta > 0 ? "+" : ""}${delta.toFixed(1)}秒の調整` });
  state.future = [];
  line.start = next;
  state.activeIndex = index;
  save(); render();
  status.textContent = `${index + 1} 行目を ${delta > 0 ? "+" : ""}${delta.toFixed(1)} 秒調整しました。`;
  showUndoToast(`${index + 1} 行目を ${delta > 0 ? "+" : ""}${delta.toFixed(1)} 秒調整しました`);
}

function undoCapture() {
  const change = state.history.pop();
  if (!change) { status.textContent = "取り消せる操作はありません。"; return; }
  state.lines[change.index].start = change.previous;
  state.future.push(change);
  state.activeIndex = change.index;
  save(); render();
  status.textContent = `${change.index + 1} 行目の「${change.action || "時刻操作"}」を元に戻しました。`;
  showUndoToast(`${change.index + 1} 行目を元に戻しました（さらに戻せます）`);
}

function redoCapture() {
  const change = state.future.pop();
  if (!change) { status.textContent = "やり直せる操作はありません。"; return; }
  state.lines[change.index].start = change.next;
  state.history.push(change);
  state.activeIndex = change.index;
  save(); render();
  status.textContent = `${change.index + 1} 行目の「${change.action || "時刻操作"}」をやり直しました。`;
  showUndoToast(`${change.index + 1} 行目をやり直しました`);
}

function updateUndoControl() {
  const undoButton = $("#undo-capture");
  const redoButton = $("#redo-capture");
  const undoChange = state.history.at(-1);
  const redoChange = state.future.at(-1);
  undoButton.disabled = !undoChange;
  redoButton.disabled = !redoChange;
  undoButton.textContent = undoChange ? `↶ 元に戻す（残り ${state.history.length}）` : "↶ 元に戻す";
  redoButton.textContent = redoChange ? `↷ やり直す（残り ${state.future.length}）` : "↷ やり直す";
}

function showUndoToast(message) {
  clearTimeout(undoToastTimer);
  $("#undo-toast-message").textContent = message;
  $("#undo-toast").hidden = false;
  undoToastTimer = setTimeout(hideUndoToast, 6500);
}

function hideUndoToast() {
  clearTimeout(undoToastTimer);
  $("#undo-toast").hidden = true;
}

function removeLine(index) {
  state.lines.splice(index, 1);
  if (!state.lines.length) state.lines.push(newLine());
  state.activeIndex = Math.min(state.activeIndex, state.lines.length - 1);
  state.history = [];
  state.future = [];
  hideUndoToast();
  save(); render();
}

function rewind(seconds = 3) {
  player.currentTime = Math.max(0, player.currentTime - seconds);
  status.textContent = `${seconds} 秒戻しました。`;
  drawWaveform();
}

function addLine() {
  state.lines.splice(state.activeIndex + 1, 0, newLine());
  state.activeIndex += 1;
  state.history = [];
  state.future = [];
  hideUndoToast();
  save(); render();
  rows.querySelectorAll("textarea")[state.activeIndex * 2]?.focus();
}

function lyricLines(value) {
  return String(value || "").replace(/\r/g, "").split("\n").map((line) => line.trim()).filter(Boolean);
}

function applyLyrics() {
  const jp = lyricLines($("#bulk-jp").value);
  const en = lyricLines($("#bulk-en").value);
  const count = Math.max(jp.length, en.length);
  if (!count) { status.textContent = "日本語または English の歌詞を、1行ずつ貼り付けてください。"; return; }
  state.lines = Array.from({ length: count }, (_, index) => ({ id: newId(), jp: jp[index] || "", en: en[index] || "", start: null }));
  state.activeIndex = 0;
  state.history = [];
  state.future = [];
  save(); render();
  status.textContent = `${count} 行の歌詞を表示しました。曲を再生して、歌詞の行を押すだけで記録できます。`;
}

async function loadWaveform(file) {
  state.waveform = null;
  waveformStatus.hidden = false;
  waveformStatus.textContent = "波形を端末内で解析しています…";
  drawWaveform();
  try {
    const AudioContextClass = globalThis.AudioContext || globalThis.webkitAudioContext;
    if (!AudioContextClass) throw new Error("AudioContext unavailable");
    const context = new AudioContextClass();
    const buffer = await context.decodeAudioData(await file.arrayBuffer());
    const bins = 900;
    const peaks = new Float32Array(bins);
    const step = Math.max(1, Math.floor(buffer.length / bins));
    for (let bin = 0; bin < bins; bin += 1) {
      const start = bin * step;
      const end = Math.min(buffer.length, start + step);
      let peak = 0;
      for (let channel = 0; channel < buffer.numberOfChannels; channel += 1) {
        const data = buffer.getChannelData(channel);
        for (let sample = start; sample < end; sample += Math.max(1, Math.floor(step / 80))) peak = Math.max(peak, Math.abs(data[sample] || 0));
      }
      peaks[bin] = peak;
    }
    state.waveform = { peaks, duration: buffer.duration };
    waveformStatus.hidden = true;
    await context.close();
    drawWaveform();
  } catch {
    waveformStatus.hidden = false;
    waveformStatus.textContent = "この曲の波形は表示できませんが、再生と記録はそのまま使えます。";
  }
}

function drawWaveform() {
  const rect = waveform.getBoundingClientRect();
  const ratio = Math.max(1, globalThis.devicePixelRatio || 1);
  const width = Math.max(1, Math.round(rect.width * ratio));
  const height = Math.max(1, Math.round(rect.height * ratio));
  if (waveform.width !== width || waveform.height !== height) { waveform.width = width; waveform.height = height; }
  const context = waveform.getContext("2d");
  context.clearRect(0, 0, width, height);
  if (!state.waveform) return;
  const { peaks, duration } = state.waveform;
  const played = duration ? Math.min(1, player.currentTime / duration) : 0;
  const center = height / 2;
  for (let x = 0; x < width; x += Math.max(1, Math.round(ratio))) {
    const peak = peaks[Math.min(peaks.length - 1, Math.floor(x / width * peaks.length))];
    context.fillStyle = x / width <= played ? "#f1bad2" : "#755468";
    const bar = Math.max(ratio, peak * height * .86);
    context.fillRect(x, center - bar / 2, Math.max(1, ratio), bar);
  }
  state.lines.forEach((line, index) => {
    if (line.start === null || line.start === "") return;
    const x = Number(line.start) / duration * width;
    context.fillStyle = index === state.activeIndex ? "#fff4a8" : "rgba(255,255,255,.55)";
    context.fillRect(x, 0, Math.max(1, ratio), height);
  });
}

function scheduleWaveformDraw() {
  if (waveformFrame) return;
  waveformFrame = requestAnimationFrame(() => { waveformFrame = null; drawWaveform(); });
}

function recordedLines() {
  return state.lines
    .map((line, index) => ({ ...line, index, rawStart: line.start, start: Number(line.start) }))
    .filter((line) => line.rawStart !== null && line.rawStart !== "" && Number.isFinite(line.start));
}

function renderTimeline() {
  const duration = Number(state.duration || state.waveform?.duration || 0);
  const recorded = recordedLines();
  const report = analyzeProject(state.lines, duration);
  const severityByLine = new Map();
  report.issues.forEach((issue) => {
    const current = severityByLine.get(issue.index);
    if (!current || issue.severity === "error") severityByLine.set(issue.index, issue.severity);
  });
  $("#timeline-count").textContent = `${recorded.length} / ${state.lines.length} 行を記録`;
  $("#timeline-empty").hidden = recorded.length > 0;
  timelineBlocks.innerHTML = "";
  timelineRuler.innerHTML = "";

  const viewportWidth = timelineViewport.clientWidth || 320;
  const trackWidth = duration ? Math.max(viewportWidth, Math.min(2600, duration * 5)) : viewportWidth;
  timelineTrack.style.width = `${Math.round(trackWidth)}px`;

  if (duration) {
    const tickStep = duration <= 90 ? 10 : duration <= 240 ? 30 : 60;
    for (let seconds = 0; seconds <= duration; seconds += tickStep) {
      const tick = document.createElement("span");
      tick.className = "timeline-tick";
      tick.style.left = `${seconds / duration * 100}%`;
      tick.innerHTML = `<span>${timeLabel(seconds).slice(0, 5)}</span>`;
      timelineRuler.append(tick);
    }
  }

  recorded.forEach((line, recordedIndex) => {
    if (!duration) return;
    const next = recorded.slice(recordedIndex + 1).find((candidate) => candidate.start > line.start);
    const end = next?.start || duration;
    const left = Math.max(0, Math.min(100, line.start / duration * 100));
    const width = Math.max(.35, Math.min(100 - left, (Math.max(line.start + .25, end) - line.start) / duration * 100));
    const button = document.createElement("button");
    button.type = "button";
    button.className = `timeline-block ${line.index === state.activeIndex ? "active" : ""} ${severityByLine.has(line.index) ? `has-${severityByLine.get(line.index)}` : ""}`;
    button.style.left = `${left}%`;
    button.style.width = `${width}%`;
    button.title = `${line.index + 1}. ${line.jp || line.en || "歌詞なし"} — ${timeLabel(line.start)}`;
    button.innerHTML = `<b>${line.index + 1}. ${escapeHtml(line.jp || line.en || "歌詞なし")}</b><small class="block-time">${timeLabel(line.start)}</small>`;
    button.onclick = () => selectTimelineLine(line.index, line.start);
    timelineBlocks.append(button);
  });
  updateTimelinePlayhead(false);
}

function currentPreviewLine(seconds = player.currentTime) {
  const recorded = recordedLines().sort((a, b) => a.start - b.start);
  let current = null;
  for (const line of recorded) {
    if (line.start <= seconds) current = line;
    else break;
  }
  return current;
}

function updateSubtitlePreview() {
  const line = currentPreviewLine();
  const placeholder = $("#preview-placeholder");
  const subtitle = $("#preview-subtitle");
  const jp = state.previewMode === "en" ? "" : String(line?.jp || "").trim();
  const en = state.previewMode === "jp" ? "" : String(line?.en || "").trim();
  const hasText = Boolean(line && (jp || en));
  placeholder.hidden = hasText;
  subtitle.hidden = !hasText;
  $("#preview-jp").textContent = jp;
  $("#preview-jp").hidden = !jp;
  $("#preview-en").textContent = en;
  $("#preview-en").hidden = !en;
}

function renderQuality(report = analyzeProject(state.lines, state.duration)) {
  $("#quality-score").textContent = `${report.readyCount} / ${report.total} 行`;
  const summary = $("#quality-summary");
  const issues = $("#quality-issues");
  summary.classList.toggle("ready", report.issues.length === 0);
  summary.textContent = report.issues.length === 0
    ? "✓ すべての行を確認しました。SRTを書き出せる状態です。"
    : `未解決：エラー ${report.errors} 件・確認推奨 ${report.warnings} 件`;
  issues.innerHTML = "";
  report.issues.slice(0, 10).forEach((issue) => {
    const button = document.createElement("button");
    button.type = "button";
    button.className = `quality-issue ${issue.severity}`;
    button.innerHTML = `<b class="issue-icon">${issue.severity === "error" ? "●" : "▲"}</b><span>${issue.index + 1} 行目：${escapeHtml(issue.message)}</span><small>行へ移動</small>`;
    button.onclick = () => selectLine(issue.index);
    issues.append(button);
  });
  if (report.issues.length > 10) {
    const more = document.createElement("p");
    more.className = "quality-more";
    more.textContent = `ほか ${report.issues.length - 10} 件。各歌詞行にも印を表示しています。`;
    issues.append(more);
  }
}

function selectTimelineLine(index, start) {
  state.activeIndex = index;
  player.currentTime = start;
  render();
  status.textContent = `${index + 1} 行目の ${timeLabel(start)} に移動しました。`;
}

function updateTimelinePlayhead(follow = true) {
  const duration = Number(state.duration || state.waveform?.duration || 0);
  if (!duration) { timelinePlayhead.style.transform = "translateX(0)"; return; }
  const trackWidth = timelineTrack.clientWidth || 1;
  const x = Math.max(0, Math.min(trackWidth, player.currentTime / duration * trackWidth));
  timelinePlayhead.style.transform = `translateX(${x}px)`;
  if (!follow || player.paused) return;
  const left = timelineViewport.scrollLeft;
  const width = timelineViewport.clientWidth;
  if (x < left + width * .15 || x > left + width * .85) timelineViewport.scrollTo({ left: Math.max(0, x - width * .3), behavior: "smooth" });
}

function download(language) {
  const errors = validateLines(state.lines);
  if (errors.length) { status.textContent = errors[0]; return; }
  const srt = makeSrt(state.lines, language, state.duration);
  if (!srt) { status.textContent = "書き出す歌詞と記録時刻を1行以上入れてください。"; return; }
  const blob = new Blob(["\uFEFF", srt], { type: "application/x-subrip;charset=utf-8" });
  const link = document.createElement("a");
  link.href = URL.createObjectURL(blob);
  link.download = `lyrics-${language}.srt`;
  link.click();
  URL.revokeObjectURL(link.href);
  status.textContent = `${language === "jp" ? "日本語" : language === "en" ? "English" : "日英併記"}SRTを書き出しました。`;
}

$("#media-file").addEventListener("change", (event) => {
  const file = event.target.files[0];
  if (!file) return;
  if (state.mediaUrl) URL.revokeObjectURL(state.mediaUrl);
  const mediaFile = fileWithKnownMediaType(file);
  state.mediaUrl = URL.createObjectURL(mediaFile);
  player.src = state.mediaUrl;
  player.load();
  $("#media-name").textContent = file.name;
  status.textContent = "曲を読み込んでいます…";
  loadWaveform(file);
});

player.addEventListener("loadedmetadata", () => { state.duration = player.duration; progress.max = Math.floor(player.duration * 1000); renderTimeline(); });
player.addEventListener("canplay", () => { status.textContent = "曲を読み込みました。再生しながら歌詞の行を押してください。"; });
player.addEventListener("error", () => {
  const detail = player.error?.code === 4 ? "この形式はiPhoneで再生できません。MP3 / M4A / WAV を試してください。" : "曲を読み込めませんでした。もう一度ファイルを選び直してください。";
  status.textContent = detail;
});
player.addEventListener("timeupdate", () => { currentTime.textContent = timeLabel(player.currentTime); progress.value = Math.floor(player.currentTime * 1000); scheduleWaveformDraw(); updateTimelinePlayhead(); updateSubtitlePreview(); });
progress.addEventListener("input", () => { player.currentTime = Number(progress.value) / 1000; drawWaveform(); updateTimelinePlayhead(false); updateSubtitlePreview(); });
waveform.addEventListener("click", (event) => {
  const rect = waveform.getBoundingClientRect();
  const duration = state.duration || state.waveform?.duration;
  if (duration) player.currentTime = Math.max(0, Math.min(duration, (event.clientX - rect.left) / rect.width * duration));
});
globalThis.addEventListener("resize", () => { scheduleWaveformDraw(); renderTimeline(); });

$("#add-line").onclick = addLine;
$("#apply-lyrics").onclick = applyLyrics;
$("#bulk-jp").addEventListener("input", save);
$("#bulk-en").addEventListener("input", save);
$("#capture-active").onclick = () => capture();
$("#capture-console").onclick = () => capture();
$("#rewind-3").onclick = () => rewind();
$("#undo-capture").onclick = undoCapture;
$("#redo-capture").onclick = redoCapture;
$("#locate-active").onclick = () => rows.children[state.activeIndex]?.scrollIntoView({ behavior: "smooth", block: "center" });
$("#undo-toast-button").onclick = undoCapture;
document.querySelectorAll("[data-preview-mode]").forEach((button) => { button.onclick = () => {
  state.previewMode = button.dataset.previewMode;
  document.querySelectorAll("[data-preview-mode]").forEach((candidate) => candidate.classList.toggle("selected", candidate === button));
  updateSubtitlePreview();
}; });
document.querySelectorAll("[data-rate]").forEach((button) => { button.onclick = () => {
  player.playbackRate = Number(button.dataset.rate);
  document.querySelectorAll("[data-rate]").forEach((candidate) => candidate.classList.toggle("selected", candidate === button));
  status.textContent = `再生速度を ${Number(button.dataset.rate)} 倍にしました。`;
}; });
$("#clear-times").onclick = () => { state.lines.forEach((line) => { line.start = null; }); state.history = []; state.future = []; hideUndoToast(); save(); render(); status.textContent = "記録した時刻を消去しました。"; };
$("#export-jp").onclick = () => download("jp");
$("#export-en").onclick = () => download("en");
$("#export-bilingual").onclick = () => download("bilingual");

document.addEventListener("keydown", (event) => {
  const isInteractive = ["INPUT", "TEXTAREA", "BUTTON", "AUDIO"].includes(document.activeElement?.tagName);
  if (!isInteractive && (event.code === "Space" || event.key === "Enter")) {
    event.preventDefault(); capture();
  }
});

load();
$("#bulk-jp").value = state.jpDraft;
$("#bulk-en").value = state.enDraft;
render();
