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

const STORAGE_KEY = "lyric-srt-studio-v1";
const state = { lines: [], activeIndex: 0, mediaUrl: null, duration: 0, jpDraft: "", enDraft: "" };

const $ = (selector) => document.querySelector(selector);
const rows = $("#rows");
const player = $("#player");
const status = $("#status");
const currentTime = $("#current-time");
const progress = $("#progress");

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

function render() {
  rows.innerHTML = "";
  state.lines.forEach((line, index) => {
    const item = document.createElement("article");
    item.className = `line ${index === state.activeIndex ? "active" : ""}`;
    item.innerHTML = `
      <button class="line-number" type="button" data-action="select" aria-label="${index + 1}行目を選択">${index + 1}</button>
      <div class="inputs">
        <label><span>日本語</span><textarea data-field="jp" placeholder="日本語の歌詞">${escapeHtml(line.jp)}</textarea></label>
        <label><span>English</span><textarea data-field="en" placeholder="English lyric">${escapeHtml(line.en)}</textarea></label>
      </div>
      <div class="timing">
        <output>${line.start === null || line.start === "" ? "--:--.-" : timeLabel(line.start)}</output>
        <button type="button" data-action="capture">ここで記録</button>
        <button class="icon-button" type="button" data-action="delete" aria-label="この行を削除">×</button>
      </div>`;
    item.addEventListener("click", (event) => {
      if (!event.target.closest("textarea") && !event.target.closest("button")) capture(index);
    });
    item.querySelectorAll("textarea").forEach((textarea) => textarea.addEventListener("input", () => {
      state.lines[index][textarea.dataset.field] = textarea.value;
      save();
    }));
    item.querySelector("[data-action=select]").onclick = () => selectLine(index);
    item.querySelector("[data-action=capture]").onclick = () => capture(index);
    item.querySelector("[data-action=delete]").onclick = () => removeLine(index);
    rows.append(item);
  });
  $("#line-count").textContent = `${state.lines.length} 行`;
}

function escapeHtml(value) {
  return String(value || "").replace(/[&<>\"]/g, (char) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[char]);
}

function selectLine(index) {
  state.activeIndex = Math.max(0, Math.min(index, state.lines.length - 1));
  render();
}

function capture(index = state.activeIndex) {
  if (!state.lines.length) return;
  state.lines[index].start = Number(player.currentTime.toFixed(3));
  state.activeIndex = Math.min(index + 1, state.lines.length - 1);
  save(); render();
  status.textContent = `${index + 1} 行目を ${timeLabel(player.currentTime)} に記録しました。`;
}

function removeLine(index) {
  state.lines.splice(index, 1);
  if (!state.lines.length) state.lines.push(newLine());
  state.activeIndex = Math.min(state.activeIndex, state.lines.length - 1);
  save(); render();
}

function addLine() {
  state.lines.splice(state.activeIndex + 1, 0, newLine());
  state.activeIndex += 1;
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
  save(); render();
  status.textContent = `${count} 行の歌詞を表示しました。曲を再生して、歌詞の行を押すだけで記録できます。`;
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
});

player.addEventListener("loadedmetadata", () => { state.duration = player.duration; progress.max = Math.floor(player.duration * 1000); });
player.addEventListener("canplay", () => { status.textContent = "曲を読み込みました。再生しながら歌詞の行を押してください。"; });
player.addEventListener("error", () => {
  const detail = player.error?.code === 4 ? "この形式はiPhoneで再生できません。MP3 / M4A / WAV を試してください。" : "曲を読み込めませんでした。もう一度ファイルを選び直してください。";
  status.textContent = detail;
});
player.addEventListener("timeupdate", () => { currentTime.textContent = timeLabel(player.currentTime); progress.value = Math.floor(player.currentTime * 1000); });
progress.addEventListener("input", () => { player.currentTime = Number(progress.value) / 1000; });

$("#add-line").onclick = addLine;
$("#apply-lyrics").onclick = applyLyrics;
$("#bulk-jp").addEventListener("input", save);
$("#bulk-en").addEventListener("input", save);
$("#capture-active").onclick = () => capture();
$("#clear-times").onclick = () => { state.lines.forEach((line) => { line.start = null; }); save(); render(); status.textContent = "記録した時刻を消去しました。"; };
$("#export-jp").onclick = () => download("jp");
$("#export-en").onclick = () => download("en");
$("#export-bilingual").onclick = () => download("bilingual");

document.addEventListener("keydown", (event) => {
  const isTyping = ["INPUT", "TEXTAREA"].includes(document.activeElement?.tagName);
  if (!isTyping && (event.code === "Space" || event.key === "Enter")) {
    event.preventDefault(); capture();
  }
});

load();
$("#bulk-jp").value = state.jpDraft;
$("#bulk-en").value = state.enDraft;
render();
