const { analyzeProject, buildTimelineBlocks, isTime, makeSrt, resolveEnd, validateLines } = globalThis.LyricSrtCore;

const STORAGE_KEY = "lyric-srt-studio-v2";
const LEGACY_KEY = "lyric-srt-studio-v1";
const PREFERENCES_KEY = "lyric-srt-studio-preferences-v1";
const EDIT_PIXELS_PER_SECOND = 32;
const MAX_TIMELINE_WIDTH = 16000;
const $ = (selector) => document.querySelector(selector);
const player = $("#player");
const waveform = $("#waveform");
const waveformStatus = $("#waveform-status");
const timelineViewport = $("#timeline-viewport");
const timelineContent = $("#timeline-content");
const timelineBlocks = $("#timeline-blocks");
const rows = $("#rows");
const status = $("#status");

function loadPreferences() {
  try {
    return JSON.parse(localStorage.getItem(PREFERENCES_KEY)) || {};
  } catch {
    return {};
  }
}

const preferences = loadPreferences();
const state = {
  projectName: "無題のプロジェクト",
  mediaName: "",
  mediaUrl: null,
  duration: 0,
  lines: [],
  jpDraft: "",
  enDraft: "",
  activeIndex: 0,
  previewMode: "bilingual",
  waveform: null,
  history: [],
  future: [],
  followCapture: preferences.followCapture !== false,
  timelineMode: preferences.timelineMode === "edit" ? "edit" : "full",
};

let waveformFrame = null;
let toastTimer = null;
let saveTimer = null;
let timelineFlashTimer = null;
let recentlyRecordedId = null;

function newId() {
  return globalThis.crypto?.randomUUID?.() || `${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

function newLine(source = {}) {
  return {
    id: source.id || newId(),
    jp: String(source.jp || ""),
    en: String(source.en || ""),
    start: isTime(source.start) ? Number(source.start) : null,
    end: isTime(source.end) ? Number(source.end) : null,
  };
}

function escapeHtml(value) {
  return String(value || "").replace(/[&<>\"]/g, (char) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[char]);
}

function timeLabel(seconds) {
  if (!isTime(seconds)) return "--:--.---";
  const value = Math.max(0, Number(seconds));
  const hours = Math.floor(value / 3600);
  const minutes = Math.floor((value % 3600) / 60);
  const secs = Math.floor(value % 60);
  const ms = Math.floor((value % 1) * 1000);
  const prefix = hours ? `${String(hours).padStart(2, "0")}:` : "";
  return `${prefix}${String(minutes).padStart(2, "0")}:${String(secs).padStart(2, "0")}.${String(ms).padStart(3, "0")}`;
}

function slug(value) {
  return String(value || "lyrics").trim().replace(/[\\/:*?"<>|]/g, "-").replace(/\s+/g, "-").slice(0, 70) || "lyrics";
}

function projectPayload() {
  return {
    type: "lyric-srt-studio-project",
    version: 2,
    projectName: state.projectName,
    mediaName: state.mediaName,
    duration: state.duration,
    lines: state.lines,
    jpDraft: $("#bulk-jp").value,
    enDraft: $("#bulk-en").value,
    updatedAt: new Date().toISOString(),
  };
}

function saveLocal() {
  clearTimeout(saveTimer);
  $("#save-state").textContent = "保存中…";
  $("#save-state").classList.remove("saved");
  saveTimer = setTimeout(() => {
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(projectPayload()));
      $("#save-state").textContent = "✓ この端末に自動保存しました";
      $("#save-state").classList.add("saved");
    } catch {
      $("#save-state").textContent = "自動保存できませんでした。ファイル保存をご利用ください";
    }
  }, 250);
}

function sanitizeProject(data) {
  if (!data || !Array.isArray(data.lines) || data.lines.length > 5000) throw new Error("このプロジェクトファイルは読み込めません。");
  return {
    projectName: String(data.projectName || "無題のプロジェクト").slice(0, 80),
    mediaName: String(data.mediaName || "").slice(0, 255),
    duration: Number.isFinite(Number(data.duration)) ? Math.max(0, Number(data.duration)) : 0,
    lines: data.lines.map(newLine),
    jpDraft: String(data.jpDraft || ""),
    enDraft: String(data.enDraft || ""),
  };
}

function applyProject(project, message = "プロジェクトを開きました。曲を選び直してください。") {
  Object.assign(state, project, { activeIndex: 0, history: [], future: [], waveform: null });
  state.lines = project.lines.length ? project.lines : [];
  $("#project-title").value = state.projectName;
  $("#bulk-jp").value = state.jpDraft;
  $("#bulk-en").value = state.enDraft;
  $("#media-name").textContent = state.mediaName ? `${state.mediaName}（再選択してください）` : "曲を選択してください";
  $("#now-file").textContent = state.mediaName || "曲が未選択です";
  $("#audio-drop").classList.remove("has-file", "is-dragging");
  updateDraftCount();
  render();
  saveLocal();
  setStatus(message);
}

function loadLocal() {
  try {
    const saved = JSON.parse(localStorage.getItem(STORAGE_KEY));
    if (saved?.lines) return sanitizeProject(saved);
    const legacy = JSON.parse(localStorage.getItem(LEGACY_KEY));
    if (legacy?.lines) return sanitizeProject({ ...legacy, projectName: "復元したプロジェクト" });
  } catch { /* An invalid draft must not block startup. */ }
  return { projectName: "無題のプロジェクト", mediaName: "", duration: 0, lines: [], jpDraft: "", enDraft: "" };
}

function downloadBlob(content, filename, type) {
  const url = URL.createObjectURL(new Blob([content], { type }));
  const link = document.createElement("a");
  link.href = url;
  link.download = filename;
  link.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

function saveProjectFile() {
  downloadBlob(JSON.stringify(projectPayload(), null, 2), `${slug(state.projectName)}.lyricsrt.json`, "application/json;charset=utf-8");
  showToast("プロジェクトファイルを保存しました");
}

async function openProjectFile(file) {
  try {
    const project = sanitizeProject(JSON.parse(await file.text()));
    applyProject(project);
  } catch (error) {
    setStatus(error.message || "プロジェクトファイルを読み込めませんでした。");
    showToast("ファイルを読み込めませんでした");
  }
}

function newProject() {
  const hasWork = state.lines.some((line) => line.jp || line.en || isTime(line.start));
  if (hasWork && !confirm("現在の作業を閉じて、新しいプロジェクトを作りますか？\n必要なら先にプロジェクトを保存してください。")) return;
  if (state.mediaUrl) URL.revokeObjectURL(state.mediaUrl);
  player.removeAttribute("src");
  player.load();
  Object.assign(state, { projectName: "無題のプロジェクト", mediaName: "", mediaUrl: null, duration: 0, lines: [], jpDraft: "", enDraft: "", activeIndex: 0, waveform: null, history: [], future: [] });
  $("#project-title").value = state.projectName;
  $("#bulk-jp").value = "";
  $("#bulk-en").value = "";
  $("#media-name").textContent = "曲を選択してください";
  $("#now-file").textContent = "曲が未選択です";
  $("#audio-drop").classList.remove("has-file", "is-dragging");
  updateDraftCount();
  render();
  saveLocal();
  setStatus("新しいプロジェクトを作成しました。");
}

function setStatus(message) {
  status.textContent = message;
}

function savePreferences() {
  try {
    localStorage.setItem(PREFERENCES_KEY, JSON.stringify({
      followCapture: state.followCapture,
      timelineMode: state.timelineMode,
    }));
  } catch { /* Preferences remain available for this session. */ }
}

function updateCaptureFollowControls() {
  [$("#capture-follow"), $("#floating-follow")].forEach((button) => {
    button.classList.toggle("enabled", state.followCapture);
    button.ariaPressed = String(state.followCapture);
  });
  $("#capture-follow-state").textContent = state.followCapture ? "ON" : "OFF";
  $("#floating-follow-state").textContent = state.followCapture ? "ON" : "OFF";
}

function toggleCaptureFollow() {
  state.followCapture = !state.followCapture;
  savePreferences();
  updateCaptureFollowControls();
  const label = state.followCapture ? "ON" : "OFF";
  if (state.followCapture) followTimelineToPlayhead(true);
  setStatus(`タイムラインの画面追従を${label}にしました。`);
  showToast(`画面追従：${label}`);
}

function updateTimelineModeControls() {
  timelineViewport.dataset.mode = state.timelineMode;
  document.querySelectorAll("[data-timeline-mode]").forEach((button) => {
    const selected = button.dataset.timelineMode === state.timelineMode;
    button.classList.toggle("selected", selected);
    button.ariaPressed = String(selected);
  });
}

function setTimelineMode(mode) {
  if (!["full", "edit"].includes(mode) || state.timelineMode === mode) return;
  state.timelineMode = mode;
  savePreferences();
  updateTimelineModeControls();
  renderTimeline();
  drawWaveform();
  if (mode === "edit") followTimelineToPlayhead(true);
  else timelineViewport.scrollLeft = 0;
  setStatus(mode === "edit" ? "編集表示に切り替えました。横へ動かして細部を確認できます。" : "曲全体を表示しました。");
}

function showToast(message, action = null) {
  clearTimeout(toastTimer);
  $("#toast-message").textContent = message;
  $("#toast").hidden = false;
  $("#toast-action").hidden = !action;
  $("#toast-action").onclick = action || null;
  toastTimer = setTimeout(() => { $("#toast").hidden = true; }, 5500);
}

function lyricLines(value) {
  return String(value || "").replace(/\r/g, "").split("\n").map((line) => line.trim()).filter(Boolean);
}

function updateDraftCount() {
  const count = Math.max(lyricLines($("#bulk-jp").value).length, lyricLines($("#bulk-en").value).length);
  $("#draft-line-count").textContent = `${count} 行を検出`;
}

function applyLyrics() {
  const jp = lyricLines($("#bulk-jp").value);
  const en = lyricLines($("#bulk-en").value);
  const count = Math.max(jp.length, en.length);
  if (!count) return setStatus("日本語またはEnglishの歌詞を1行ずつ貼り付けてください。");
  if (state.lines.some((line) => isTime(line.start)) && !confirm("現在のタイミング記録を置き換えて、歌詞一覧を作り直しますか？")) return;
  state.lines = Array.from({ length: count }, (_, index) => newLine({ jp: jp[index], en: en[index] }));
  state.activeIndex = 0;
  state.history = [];
  state.future = [];
  render();
  saveLocal();
  setStatus(`${count}行の歌詞を反映しました。曲を再生して開始を記録してください。`);
  $(".lyrics-import").open = false;
  $("#studio").scrollIntoView({ behavior: "smooth", block: "start" });
}

function pushChange(index, field, next, label) {
  const line = state.lines[index];
  if (!line) return;
  const previous = line[field];
  state.history.push({ index, field, previous, next, label });
  if (state.history.length > 100) state.history.shift();
  state.future = [];
  line[field] = next;
}

function capture(index = state.activeIndex, field = "start") {
  if (!state.lines.length) return setStatus("先に歌詞を反映してください。");
  const time = Number(player.currentTime.toFixed(3));
  pushChange(index, field, time, field === "start" ? "開始時刻の記録" : "終了時刻の記録");
  if (field === "start") recentlyRecordedId = state.lines[index]?.id || null;
  if (field === "start") state.activeIndex = Math.min(index + 1, state.lines.length - 1);
  else state.activeIndex = index;
  render(false);
  if (field === "start" && state.followCapture) followTimelineToPlayhead(true);
  saveLocal();
  const kind = field === "start" ? "開始" : "終了";
  setStatus(`${index + 1}行目の${kind}を${timeLabel(time)}に記録しました。`);
  showToast(`${index + 1}行目の${kind}を記録しました`, undo);
}

function adjustTime(index, field, delta) {
  const line = state.lines[index];
  if (!line || !isTime(line[field])) return setStatus(`先に${field === "start" ? "開始" : "終了"}時刻を記録してください。`);
  const next = Number(Math.max(0, Math.min(state.duration || Infinity, Number(line[field]) + delta)).toFixed(3));
  pushChange(index, field, next, `${delta > 0 ? "+" : ""}${delta}秒の調整`);
  state.activeIndex = index;
  render();
  saveLocal();
  setStatus(`${index + 1}行目を${delta > 0 ? "+" : ""}${delta.toFixed(1)}秒調整しました。`);
}

function clearEnd(index) {
  if (!isTime(state.lines[index]?.end)) return;
  pushChange(index, "end", null, "終了時刻を自動に戻す");
  state.activeIndex = index;
  render();
  saveLocal();
  setStatus(`${index + 1}行目の終了時刻を自動に戻しました。`);
}

function undo() {
  const change = state.history.pop();
  if (!change || !state.lines[change.index]) return setStatus("元に戻せる操作はありません。");
  state.lines[change.index][change.field] = change.previous;
  state.future.push(change);
  state.activeIndex = change.index;
  render();
  saveLocal();
  setStatus(`${change.index + 1}行目の「${change.label}」を元に戻しました。`);
}

function redo() {
  const change = state.future.pop();
  if (!change || !state.lines[change.index]) return setStatus("やり直せる操作はありません。");
  state.lines[change.index][change.field] = change.next;
  state.history.push(change);
  state.activeIndex = change.index;
  render();
  saveLocal();
  setStatus(`${change.index + 1}行目の「${change.label}」をやり直しました。`);
}

function addLine() {
  state.lines.splice(Math.min(state.activeIndex + 1, state.lines.length), 0, newLine());
  state.activeIndex = state.lines.length === 1 ? 0 : Math.min(state.activeIndex + 1, state.lines.length - 1);
  state.history = [];
  state.future = [];
  render(true);
  saveLocal();
}

function removeLine(index) {
  const line = state.lines[index];
  if ((line.jp || line.en || isTime(line.start)) && !confirm(`${index + 1}行目を削除しますか？`)) return;
  state.lines.splice(index, 1);
  state.activeIndex = Math.max(0, Math.min(state.activeIndex, state.lines.length - 1));
  state.history = [];
  state.future = [];
  render();
  saveLocal();
  setStatus(`${index + 1}行目を削除しました。`);
}

function clearAllTimes() {
  const previous = state.lines.map(({ start, end }) => ({ start, end }));
  if (!previous.some(({ start, end }) => isTime(start) || isTime(end))) return setStatus("消去する時刻はありません。");
  if (!confirm("すべての開始・終了時刻を消去しますか？\n歌詞は残ります。")) return;
  state.lines.forEach((line) => { line.start = null; line.end = null; });
  state.activeIndex = 0;
  state.history = [];
  state.future = [];
  render();
  saveLocal();
  setStatus("すべての時刻を消去しました。歌詞はそのまま残っています。");
  showToast("すべての時刻を消去しました", () => {
    state.lines.forEach((line, index) => Object.assign(line, previous[index] || { start: null, end: null }));
    render();
    saveLocal();
    setStatus("消去前の時刻を復元しました。");
  });
}

function selectLine(index, scroll = false) {
  state.activeIndex = Math.max(0, Math.min(index, state.lines.length - 1));
  render();
  if (scroll) requestAnimationFrame(() => rows.children[state.activeIndex]?.scrollIntoView({ behavior: "smooth", block: "center" }));
}

function nextUnrecordedIndex() {
  if (!state.lines.length) return -1;
  for (let offset = 0; offset < state.lines.length; offset += 1) {
    const index = (state.activeIndex + offset) % state.lines.length;
    if (!isTime(state.lines[index].start)) return index;
  }
  return state.lines.length - 1;
}

function goToNextUnrecorded() {
  const index = nextUnrecordedIndex();
  if (index < 0) return setStatus("先に歌詞を反映してください。");
  const allRecorded = state.lines.every((line) => isTime(line.start));
  selectLine(index, true);
  setStatus(allRecorded ? "すべて記録済みです。最後の行へ移動しました。" : `${index + 1}行目の未記録行へ移動しました。`);
}

function scrollToActiveLine() {
  if (!state.lines.length) return setStatus("先に歌詞を反映してください。");
  rows.children[state.activeIndex]?.scrollIntoView({ behavior: "smooth", block: "center" });
}

function updateQuickNav() {
  const timingSection = $("#lyrics-timing");
  const mobileLayout = globalThis.innerWidth <= 980;
  $("#quick-nav").hidden = !state.lines.length || (!mobileLayout && globalThis.scrollY < timingSection.offsetTop - 180);
  const studio = $("#studio");
  $("#floating-console").hidden = !state.lines.length
    || globalThis.innerWidth <= 980
    || globalThis.scrollY < studio.offsetTop + studio.offsetHeight - 120;
  const showMobileDock = state.lines.length > 0
    && globalThis.innerWidth <= 980
    && globalThis.scrollY >= $("#studio").offsetTop - 70
    && globalThis.scrollY < $("#export").offsetTop - 100;
  document.body.classList.toggle("show-mobile-dock", showMobileDock);
}

function updateWorkflowProgress() {
  let currentStep = 1;
  if (state.lines.length) {
    if (state.lines.some((line) => !isTime(line.start))) currentStep = 2;
    else currentStep = analyzeProject(state.lines, state.duration).errors ? 3 : 4;
  }
  document.querySelectorAll("[data-workflow-step]").forEach((link) => {
    const step = Number(link.dataset.workflowStep);
    const current = step === currentStep;
    link.classList.toggle("current", current);
    link.classList.toggle("complete", step < currentStep);
    if (current) link.setAttribute("aria-current", "step");
    else link.removeAttribute("aria-current");
  });
}

function timelineDuration(blocks = buildTimelineBlocks(state.lines, state.duration)) {
  const knownDuration = state.duration || state.waveform?.duration || 0;
  if (knownDuration > 0) return knownDuration;
  return blocks.reduce((maximum, block) => Math.max(maximum, block.end), 0);
}

function timelineWidth(duration) {
  const viewportWidth = Math.max(1, timelineViewport.clientWidth);
  if (state.timelineMode === "full" || !duration) return viewportWidth;
  return Math.min(MAX_TIMELINE_WIDTH, Math.max(viewportWidth, duration * EDIT_PIXELS_PER_SECOND));
}

function renderTimeline() {
  const blocks = buildTimelineBlocks(state.lines, state.duration);
  const duration = timelineDuration(blocks);
  const issueSeverity = new Map();
  analyzeProject(state.lines, state.duration).issues.forEach((issue) => {
    if (issue.severity === "error" || !issueSeverity.has(issue.index)) issueSeverity.set(issue.index, issue.severity);
  });
  const oldWidth = Math.max(1, timelineContent.getBoundingClientRect().width);
  const scrollRatio = timelineViewport.scrollLeft / oldWidth;
  timelineContent.style.width = `${timelineWidth(duration)}px`;
  updateTimelineModeControls();
  timelineBlocks.innerHTML = "";
  $("#timeline-empty").hidden = blocks.length > 0;

  blocks.forEach((block) => {
    const line = state.lines[block.index];
    const startRatio = duration ? Math.max(0, Math.min(1, block.start / duration)) : 0;
    const endRatio = duration ? Math.max(startRatio, Math.min(1, block.end / duration)) : startRatio;
    const severity = issueSeverity.get(block.index);
    const button = document.createElement("button");
    button.type = "button";
    button.className = `timeline-block${block.index === state.activeIndex ? " selected" : ""}${block.manual ? " manual-end" : ""}${block.invalidManual ? " invalid-end" : ""}${severity ? ` has-${severity}` : ""}${line.id === recentlyRecordedId ? " just-recorded" : ""}`;
    button.style.left = `${startRatio * 100}%`;
    button.style.width = `${Math.max(0, endRatio - startRatio) * 100}%`;
    button.dataset.lineIndex = String(block.index);
    button.dataset.endSource = block.source;
    button.title = `${block.index + 1}行目 ${timeLabel(block.start)} → ${timeLabel(block.end)}\n${line.jp || line.en || "歌詞なし"}`;
    button.setAttribute("aria-label", `${block.index + 1}行目を選択して${timeLabel(block.start)}へ移動`);

    const content = document.createElement("span");
    content.className = "timeline-block-content";
    const number = document.createElement("b");
    number.textContent = String(block.index + 1).padStart(2, "0");
    const lyric = document.createElement("strong");
    lyric.textContent = line.jp || line.en || "歌詞なし";
    const time = document.createElement("time");
    time.textContent = timeLabel(block.start);
    content.append(number, lyric, time);
    if (isTime(line.end)) {
      const marker = document.createElement("i");
      marker.textContent = "◆";
      marker.title = block.invalidManual ? "手動終了時刻にエラーがあります" : "手動終了";
      content.append(marker);
    }
    button.append(content);
    button.addEventListener("click", (event) => {
      event.stopPropagation();
      selectTimelineBlock(block.index, block.start);
    });
    timelineBlocks.append(button);
  });

  if (state.timelineMode === "edit") timelineViewport.scrollLeft = scrollRatio * timelineContent.getBoundingClientRect().width;
  else timelineViewport.scrollLeft = 0;

  if (recentlyRecordedId) {
    clearTimeout(timelineFlashTimer);
    timelineFlashTimer = setTimeout(() => {
      recentlyRecordedId = null;
      timelineBlocks.querySelector(".just-recorded")?.classList.remove("just-recorded");
    }, 760);
  }
}

function selectTimelineBlock(index, start) {
  state.activeIndex = Math.max(0, Math.min(index, state.lines.length - 1));
  if (player.src) player.currentTime = Math.max(0, Math.min(state.duration || Infinity, Number(start)));
  render(false);
  updatePlayhead();
  if (state.followCapture) followTimelineToPlayhead(true);
  setStatus(player.src
    ? `${index + 1}行目を選択し、${timeLabel(start)}へ移動しました。`
    : `${index + 1}行目を選択しました。再生位置を確認するには曲を選び直してください。`);
}

function followTimelineToPlayhead(force = false) {
  if (!state.followCapture || state.timelineMode !== "edit") return;
  const duration = timelineDuration();
  if (!duration) return;
  const contentWidth = timelineContent.getBoundingClientRect().width;
  const playheadX = Math.max(0, Math.min(contentWidth, player.currentTime / duration * contentWidth));
  const viewportWidth = timelineViewport.clientWidth;
  const left = timelineViewport.scrollLeft;
  const leadingEdge = left + viewportWidth * .22;
  const trailingEdge = left + viewportWidth * .78;
  if (!force && playheadX >= leadingEdge && playheadX <= trailingEdge) return;
  timelineViewport.scrollTo({
    left: Math.max(0, playheadX - viewportWidth * .38),
    behavior: force ? "smooth" : "auto",
  });
}

function renderRows(scroll = false) {
  const report = analyzeProject(state.lines, state.duration);
  const issueByLine = new Map();
  report.issues.forEach((issue) => {
    const current = issueByLine.get(issue.index);
    if (!current || issue.severity === "error") issueByLine.set(issue.index, issue);
  });
  rows.innerHTML = "";
  if (!state.lines.length) {
    rows.innerHTML = '<div class="lyric-empty">上の「歌詞をまとめて貼り付け」から歌詞一覧を作成してください。</div>';
    return report;
  }
  state.lines.forEach((line, index) => {
    const issue = issueByLine.get(index);
    const end = isTime(line.start) ? resolveEnd(state.lines, index, state.duration) : null;
    const article = document.createElement("article");
    article.className = `lyric-row${index === state.activeIndex ? " active" : ""}${issue?.severity === "error" ? " has-error" : ""}`;
    article.innerHTML = `
      <div class="line-index"><button type="button" data-action="select" aria-label="${index + 1}行目を選択">${String(index + 1).padStart(2, "0")}</button></div>
      <div class="line-texts">
        <label><span>JAPANESE</span><textarea data-field="jp" aria-label="${index + 1}行目の日本語">${escapeHtml(line.jp)}</textarea></label>
        <label><span>ENGLISH</span><textarea data-field="en" aria-label="${index + 1}行目の英語">${escapeHtml(line.en)}</textarea></label>
      </div>
      <div class="line-timing">
        <div class="time-pair"><div class="time-box"><span>開始</span><output>${timeLabel(line.start)}</output></div><span class="time-arrow">→</span><div class="time-box"><span>終了</span><output class="${isTime(line.end) ? "" : "auto"}">${timeLabel(end)}</output></div></div>
        <div class="timing-buttons"><button type="button" data-action="capture-start">開始を記録</button><button type="button" data-action="capture-end">終了を記録</button></div>
        <div class="fine-adjust"><button type="button" data-adjust="-0.5">−.5</button><button type="button" data-adjust="-0.1">−.1</button><button type="button" data-adjust="0.1">＋.1</button><button type="button" data-adjust="0.5">＋.5</button></div>
        <div class="line-footer"><span class="line-alert">${issue ? `${issue.severity === "error" ? "●" : "▲"} ${escapeHtml(issue.message)}` : ""}</span><span>${isTime(line.end) ? '<button class="row-menu" type="button" data-action="auto-end">終了を自動に戻す</button>' : ""}<button class="row-menu" type="button" data-action="delete">行を削除</button></span></div>
      </div>`;
    article.addEventListener("click", (event) => { if (!event.target.closest("textarea,button")) selectLine(index); });
    article.querySelector("[data-action=select]").onclick = () => selectLine(index);
    article.querySelector("[data-action=capture-start]").onclick = () => capture(index, "start");
    article.querySelector("[data-action=capture-end]").onclick = () => capture(index, "end");
    article.querySelectorAll("[data-adjust]").forEach((button) => { button.onclick = () => adjustTime(index, "start", Number(button.dataset.adjust)); });
    article.querySelector("[data-action=auto-end]")?.addEventListener("click", () => clearEnd(index));
    article.querySelector("[data-action=delete]").onclick = () => removeLine(index);
    article.querySelectorAll("textarea").forEach((textarea) => textarea.addEventListener("input", () => {
      state.lines[index][textarea.dataset.field] = textarea.value;
      saveLocal();
      renderQuality();
      renderTimeline();
      updatePreview();
    }));
    rows.append(article);
  });
  if (scroll) requestAnimationFrame(() => rows.children[state.activeIndex]?.scrollIntoView({ behavior: "smooth", block: "center" }));
  return report;
}

function updateFocus() {
  const line = state.lines[state.activeIndex];
  $("#focus-number").textContent = line ? `${state.activeIndex + 1} / ${state.lines.length}` : "";
  $("#focus-jp").textContent = line?.jp || line?.en || "歌詞を入力してください";
  $("#focus-en").textContent = line?.jp ? line.en : "";
  const recorded = state.lines.filter((item) => isTime(item.start)).length;
  $("#recorded-count").textContent = `${recorded} / ${state.lines.length}`;
  $("#recorded-bar").style.width = `${state.lines.length ? recorded / state.lines.length * 100 : 0}%`;
  $("#capture-floating-number").textContent = line ? `${state.activeIndex + 1} 行目` : "—";
  $("#capture-active-context").textContent = line ? `${state.activeIndex + 1}行目を、この位置で` : "この位置で";
  $("#session-lines").textContent = `${state.lines.length} LINES`;
  $("#session-duration").textContent = state.duration > 0 ? timeLabel(state.duration) : "--:--.---";
  $("#duration-time").textContent = state.duration > 0 ? timeLabel(state.duration) : "--:--.---";
  const undoButton = $("#undo-capture");
  const redoButton = $("#redo-capture");
  const undoChange = state.history[state.history.length - 1];
  const redoChange = state.future[state.future.length - 1];
  undoButton.disabled = !undoChange;
  redoButton.disabled = !redoChange;
  undoButton.textContent = undoChange ? `↶ 戻す ${state.history.length}` : "↶ 戻す";
  redoButton.textContent = redoChange ? `↷ やり直す ${state.future.length}` : "↷ やり直す";
  undoButton.title = undoChange ? `${undoChange.label}を元に戻す（残り${state.history.length}件）` : "元に戻せる操作はありません";
  redoButton.title = redoChange ? `${redoChange.label}をやり直す（残り${state.future.length}件）` : "やり直せる操作はありません";
  updateDockPlayback();
  updateCaptureFollowControls();
}

function renderQuality(report = analyzeProject(state.lines, state.duration)) {
  $("#quality-score").textContent = `${report.readyCount} / ${report.total}`;
  const summary = $("#quality-summary");
  summary.classList.toggle("ready", report.issues.length === 0 && report.total > 0);
  if (!report.total) summary.textContent = "歌詞を反映するとチェック結果が表示されます。";
  else if (!report.issues.length) summary.textContent = "✓ すべての行を確認しました。書き出し準備完了です。";
  else summary.textContent = `修正が必要 ${report.errors}件・確認推奨 ${report.warnings}件`;
  const list = $("#quality-issues");
  list.innerHTML = "";
  if (!report.issues.length) {
    list.innerHTML = '<p class="quality-empty">問題は見つかりませんでした。</p>';
    return;
  }
  report.issues.slice(0, 12).forEach((issue) => {
    const button = document.createElement("button");
    button.type = "button";
    button.className = `quality-issue ${issue.severity}`;
    button.innerHTML = `<b>${issue.severity === "error" ? "●" : "▲"}</b><span>${issue.index + 1}行目：${escapeHtml(issue.message)}</span><small>移動</small>`;
    button.onclick = () => selectLine(issue.index, true);
    list.append(button);
  });
}

function render(scroll = false) {
  const report = renderRows(scroll);
  updateFocus();
  renderQuality(report);
  updateWorkflowProgress();
  renderTimeline();
  drawWaveform();
  updatePreview();
  updateQuickNav();
}

function currentPreviewLine(seconds = player.currentTime) {
  for (let index = state.lines.length - 1; index >= 0; index -= 1) {
    const line = state.lines[index];
    if (!isTime(line.start)) continue;
    const end = resolveEnd(state.lines, index, state.duration);
    if (Number(line.start) <= seconds && seconds <= end) return line;
  }
  return null;
}

function updatePreview() {
  const line = currentPreviewLine();
  const jp = state.previewMode === "en" ? "" : String(line?.jp || "").trim();
  const en = state.previewMode === "jp" ? "" : String(line?.en || "").trim();
  const hasText = Boolean(jp || en);
  $("#preview-placeholder").hidden = hasText;
  $("#preview-subtitle").hidden = !hasText;
  $("#preview-jp").textContent = jp;
  $("#preview-jp").hidden = !jp;
  $("#preview-en").textContent = en;
  $("#preview-en").hidden = !en;
}

function updatePlayhead() {
  const duration = timelineDuration();
  const ratio = duration ? Math.min(1, player.currentTime / duration) : 0;
  $("#waveform-playhead").style.left = `${ratio * 100}%`;
  $("#progress").value = Math.floor(player.currentTime * 1000);
  $("#current-time").textContent = timeLabel(player.currentTime);
  updateDockPlayback();
  updatePreview();
  followTimelineToPlayhead();
}

function updateDockPlayback() {
  const mediaName = state.mediaName || "曲が未選択です";
  const currentTime = timeLabel(player.currentTime);
  const duration = state.duration > 0 ? timeLabel(state.duration) : "--:--.---";
  $("#dock-media-name").textContent = mediaName;
  $("#dock-media-name").title = mediaName;
  $("#dock-current-time").textContent = currentTime;
  $("#dock-duration").textContent = duration;
  $("#floating-media-name").textContent = mediaName;
  $("#floating-media-name").title = mediaName;
  $("#floating-current-time").textContent = currentTime;
}

function updatePlaybackControls(isPlaying) {
  const icon = isPlaying ? "❚❚" : "▶";
  const label = isPlaying ? "一時停止" : "再生";
  $("#play-icon").textContent = icon;
  $("#dock-play-icon").textContent = icon;
  $("#floating-play-icon").textContent = icon;
  $("#dock-play-label").textContent = label;
  [$("#play-toggle"), $("#dock-play-toggle"), $("#floating-play-toggle")].forEach((button) => {
    button.ariaLabel = label;
    button.ariaPressed = String(isPlaying);
  });
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
    const bins = 1000;
    const peaks = new Float32Array(bins);
    const step = Math.max(1, Math.floor(buffer.length / bins));
    for (let bin = 0; bin < bins; bin += 1) {
      let peak = 0;
      const start = bin * step;
      const end = Math.min(buffer.length, start + step);
      const sampleStep = Math.max(1, Math.floor(step / 70));
      for (let channel = 0; channel < buffer.numberOfChannels; channel += 1) {
        const data = buffer.getChannelData(channel);
        for (let sample = start; sample < end; sample += sampleStep) peak = Math.max(peak, Math.abs(data[sample] || 0));
      }
      peaks[bin] = peak;
    }
    state.waveform = { peaks, duration: buffer.duration };
    waveformStatus.hidden = true;
    await context.close();
    drawWaveform();
  } catch {
    waveformStatus.textContent = "波形は表示できませんが、再生と記録は利用できます";
  }
}

function drawWaveform() {
  const rect = waveform.getBoundingClientRect();
  const dpr = Math.max(1, globalThis.devicePixelRatio || 1);
  const renderScale = Math.min(dpr, 16384 / Math.max(1, rect.width));
  const width = Math.max(1, Math.round(rect.width * renderScale));
  const height = Math.max(1, Math.round(rect.height * dpr));
  if (waveform.width !== width || waveform.height !== height) { waveform.width = width; waveform.height = height; }
  const context = waveform.getContext("2d");
  context.clearRect(0, 0, width, height);
  if (!state.waveform) return;
  const { peaks, duration } = state.waveform;
  const axisDuration = state.duration || duration;
  const played = axisDuration ? player.currentTime / axisDuration : 0;
  const barWidth = Math.max(1, Math.round(2 * renderScale));
  const gap = Math.max(1, Math.round(2 * renderScale));
  for (let x = 0; x < width; x += barWidth + gap) {
    const peak = peaks[Math.min(peaks.length - 1, Math.floor(x / width * peaks.length))];
    const bar = Math.max(2 * dpr, peak * height * .72);
    context.fillStyle = x / width <= played ? "#59e0bd" : "#35404c";
    context.fillRect(x, (height - bar) / 2, barWidth, bar);
  }
  state.lines.forEach((line, index) => {
    if (!isTime(line.start)) return;
    const x = Number(line.start) / axisDuration * width;
    context.fillStyle = index === state.activeIndex ? "#ff6047" : "rgba(197,210,224,.28)";
    context.fillRect(x, 0, Math.max(1, dpr), height);
  });
}

function scheduleWaveformDraw() {
  if (waveformFrame) return;
  waveformFrame = requestAnimationFrame(() => { waveformFrame = null; drawWaveform(); });
}

function mediaTypeFromName(name) {
  const extension = String(name || "").split(".").pop().toLowerCase();
  return {
    mp3: "audio/mpeg", m4a: "audio/mp4", aac: "audio/aac", wav: "audio/wav",
    ogg: "audio/ogg", flac: "audio/flac", mp4: "video/mp4", mov: "video/quicktime", webm: "audio/webm",
  }[extension] || "";
}

function fileWithKnownMediaType(file) {
  const inferredType = mediaTypeFromName(file.name);
  if (!inferredType || file.type === inferredType) return file;
  return new File([file], file.name, { type: inferredType, lastModified: file.lastModified });
}

function loadMedia(sourceFile) {
  if (!sourceFile) return;
  const inferredType = mediaTypeFromName(sourceFile.name);
  if (!sourceFile.type?.startsWith("audio/") && !sourceFile.type?.startsWith("video/") && !inferredType) {
    setStatus("音声・動画ファイルを選択してください。");
    showToast("このファイル形式は音源として読み込めません");
    return;
  }
  const file = fileWithKnownMediaType(sourceFile);
  if (state.mediaUrl) URL.revokeObjectURL(state.mediaUrl);
  state.duration = 0;
  state.mediaUrl = URL.createObjectURL(file);
  state.mediaName = file.name;
  player.src = state.mediaUrl;
  player.load();
  $("#media-name").textContent = file.name;
  $("#now-file").textContent = file.name;
  $("#audio-drop").classList.add("has-file");
  setStatus("曲を読み込んでいます…");
  updateDockPlayback();
  loadWaveform(file);
  saveLocal();
}

function togglePlayback() {
  if (!player.src) return setStatus("先に曲を選んでください。");
  if (player.paused) player.play().catch(() => setStatus("再生できませんでした。別の音源形式をお試しください。"));
  else player.pause();
}

function seek(delta) {
  player.currentTime = Math.max(0, Math.min(state.duration || Infinity, player.currentTime + delta));
  updatePlayhead();
  drawWaveform();
}

function downloadSrt(language) {
  const timingErrors = validateLines(state.lines, state.duration);
  if (timingErrors.length) {
    setStatus(timingErrors[0]);
    $("#check").scrollIntoView({ behavior: "smooth" });
    return;
  }
  const srt = makeSrt(state.lines, language, state.duration);
  if (!srt) return setStatus("この言語で書き出せる、歌詞と開始時刻の入った行がありません。");
  const label = language === "jp" ? "ja" : language === "en" ? "en" : "ja-en";
  const content = $("#include-bom").checked ? `\uFEFF${srt}` : srt;
  downloadBlob(content, `${slug(state.projectName)}-${label}.srt`, "application/x-subrip;charset=utf-8");
  setStatus(`${language === "jp" ? "日本語" : language === "en" ? "English" : "日英併記"}SRTを書き出しました。`);
  showToast("SRTを書き出しました");
}

$("#media-file").addEventListener("change", (event) => {
  const file = event.target.files[0];
  event.target.value = "";
  loadMedia(file);
});
const audioDrop = $("#audio-drop");
["dragenter", "dragover"].forEach((eventName) => audioDrop.addEventListener(eventName, (event) => {
  event.preventDefault();
  if (event.dataTransfer) event.dataTransfer.dropEffect = "copy";
  audioDrop.classList.add("is-dragging");
}));
audioDrop.addEventListener("dragleave", (event) => {
  if (!audioDrop.contains(event.relatedTarget)) audioDrop.classList.remove("is-dragging");
});
audioDrop.addEventListener("drop", (event) => {
  event.preventDefault();
  audioDrop.classList.remove("is-dragging");
  loadMedia(event.dataTransfer?.files?.[0]);
});
$("#project-title").addEventListener("input", (event) => { state.projectName = event.target.value || "無題のプロジェクト"; saveLocal(); });
$("#bulk-jp").addEventListener("input", () => { state.jpDraft = $("#bulk-jp").value; updateDraftCount(); saveLocal(); });
$("#bulk-en").addEventListener("input", () => { state.enDraft = $("#bulk-en").value; updateDraftCount(); saveLocal(); });
$("#apply-lyrics").onclick = applyLyrics;
$("#new-project").onclick = newProject;
$("#save-project").onclick = saveProjectFile;
$("#open-project").onclick = () => $("#project-file").click();
$("#project-file").addEventListener("change", (event) => { if (event.target.files[0]) openProjectFile(event.target.files[0]); event.target.value = ""; });
$("#add-line").onclick = addLine;
$("#go-next-unrecorded").onclick = goToNextUnrecorded;
$("#clear-all-times").onclick = clearAllTimes;
$("#capture-active").onclick = () => capture();
$("#capture-floating").onclick = () => capture();
$("#capture-follow").onclick = toggleCaptureFollow;
$("#floating-follow").onclick = toggleCaptureFollow;
$("#undo-capture").onclick = undo;
$("#redo-capture").onclick = redo;
$("#rewind-3").onclick = () => seek(-3);
$("#forward-3").onclick = () => seek(3);
$("#play-toggle").onclick = togglePlayback;
$("#dock-play-toggle").onclick = togglePlayback;
$("#floating-play-toggle").onclick = togglePlayback;
$("#export-jp").onclick = () => downloadSrt("jp");
$("#export-en").onclick = () => downloadSrt("en");
$("#export-bilingual").onclick = () => downloadSrt("bilingual");
$("#jump-studio").onclick = () => $("#top").scrollIntoView({ behavior: "smooth", block: "start" });
$("#jump-active").onclick = scrollToActiveLine;
$("#jump-next").onclick = goToNextUnrecorded;
$("#jump-bottom").onclick = () => $("#export").scrollIntoView({ behavior: "smooth", block: "start" });

document.querySelectorAll("[data-rate]").forEach((button) => { button.onclick = () => {
  player.playbackRate = Number(button.dataset.rate);
  document.querySelectorAll("[data-rate]").forEach((candidate) => candidate.classList.toggle("selected", candidate === button));
  setStatus(`再生速度を${Number(button.dataset.rate)}倍にしました。`);
}; });

document.querySelectorAll("[data-preview-mode]").forEach((button) => { button.onclick = () => {
  state.previewMode = button.dataset.previewMode;
  document.querySelectorAll("[data-preview-mode]").forEach((candidate) => candidate.classList.toggle("selected", candidate === button));
  updatePreview();
}; });

document.querySelectorAll("[data-timeline-mode]").forEach((button) => {
  button.onclick = () => setTimelineMode(button.dataset.timelineMode);
});

player.addEventListener("loadedmetadata", () => {
  state.duration = Number(player.duration || 0);
  $("#progress").max = Math.floor(state.duration * 1000);
  render();
  updateDockPlayback();
  saveLocal();
});
player.addEventListener("canplay", () => setStatus("準備完了。再生して、歌い始めに「開始を記録」を押してください。"));
player.addEventListener("play", () => updatePlaybackControls(true));
player.addEventListener("pause", () => updatePlaybackControls(false));
player.addEventListener("timeupdate", () => { updatePlayhead(); scheduleWaveformDraw(); });
player.addEventListener("ended", () => { updatePlayhead(); updatePlaybackControls(false); });
player.addEventListener("error", () => setStatus("曲を再生できませんでした。MP3、M4A、WAVをお試しください。"));
$("#progress").addEventListener("input", () => { player.currentTime = Number($("#progress").value) / 1000; updatePlayhead(); drawWaveform(); });
timelineContent.addEventListener("click", (event) => {
  if (event.target.closest(".timeline-block")) return;
  const duration = timelineDuration();
  if (!duration) return;
  if (!player.src) return setStatus("再生位置を移動するには曲を選び直してください。");
  const rect = timelineContent.getBoundingClientRect();
  player.currentTime = Math.max(0, Math.min(duration, (event.clientX - rect.left) / rect.width * duration));
  updatePlayhead();
  drawWaveform();
});

globalThis.addEventListener("resize", () => {
  renderTimeline();
  scheduleWaveformDraw();
  updateQuickNav();
});
globalThis.addEventListener("scroll", updateQuickNav, { passive: true });
document.addEventListener("keydown", (event) => {
  const interactive = document.activeElement?.matches?.("input, textarea, button, summary, [contenteditable=true]");
  if (!interactive && !event.ctrlKey && !event.metaKey && !event.altKey) {
    if (event.code === "Space") { event.preventDefault(); capture(); }
    if (event.code === "KeyJ") { event.preventDefault(); seek(-3); }
    if (event.code === "KeyK") { event.preventDefault(); togglePlayback(); }
    if (event.code === "KeyL") { event.preventDefault(); seek(3); }
    if (event.code === "KeyE") { event.preventDefault(); capture(state.activeIndex, "end"); }
  }
  if ((event.ctrlKey || event.metaKey) && !event.shiftKey && event.key.toLowerCase() === "z") { event.preventDefault(); undo(); }
  if ((event.ctrlKey || event.metaKey) && (event.key.toLowerCase() === "y" || (event.shiftKey && event.key.toLowerCase() === "z"))) { event.preventDefault(); redo(); }
});

document.addEventListener("visibilitychange", () => { if (document.visibilityState === "hidden") localStorage.setItem(STORAGE_KEY, JSON.stringify(projectPayload())); });

applyProject(loadLocal(), "前回の作業をこの端末から復元しました。");
