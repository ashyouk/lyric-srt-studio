import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import vm from "node:vm";
import "./srt-core.js";

const {
  analyzeProject,
  buildTimelineBlocks,
  findNextUnrecordedIndex,
  formatSrtTime,
  lyricDraftInfo,
  makeSrt,
  parseLyricDrafts,
  resolveEnd,
  timelineFollowScrollTarget,
  validateLines,
} = globalThis.LyricSrtCore;

const lines = [{ jp: "朝", en: "Morning", start: 1.2, end: null }, { jp: "夜", en: "Night", start: 4, end: null }];
test("loads as classic scripts without global declaration collisions", () => {
  const context = vm.createContext({});
  vm.runInContext(readFileSync(new URL("./srt-core.js", import.meta.url), "utf8"), context);
  vm.runInContext('const { analyzeProject, isTime } = globalThis.LyricSrtCore; if (!analyzeProject || !isTime) throw new Error("Core unavailable");', context);
});
test("mobile editing controls expose labeled navigation and multi-step history", () => {
  const html = readFileSync(new URL("./index.html", import.meta.url), "utf8");
  const app = readFileSync(new URL("./app.js", import.meta.url), "utf8");
  const css = readFileSync(new URL("./styles.css", import.meta.url), "utf8");
  ["上へ", "選択行", "未記録", "下へ"].forEach((label) => assert.match(html, new RegExp(`<span>${label}</span>`)));
  assert.match(app, /state\.history\[state\.history\.length - 1\]/);
  assert.match(app, /state\.future\[state\.future\.length - 1\]/);
  assert.match(app, /戻る \$\{state\.history\.length\}/);
  assert.match(app, /やり直す \$\{state\.future\.length\}/);
  assert.match(css, /\.dock-actions \{ display: grid; grid-column: 1; grid-row: 2;/);
});
test("fixed editing consoles expose playback and lyric-line following", () => {
  const html = readFileSync(new URL("./index.html", import.meta.url), "utf8");
  const app = readFileSync(new URL("./app.js", import.meta.url), "utf8");
  const css = readFileSync(new URL("./styles.css", import.meta.url), "utf8");
  ["dock-play-toggle", "capture-follow", "floating-console", "floating-play-toggle", "floating-follow"].forEach((id) => {
    assert.match(html, new RegExp(`id="${id}"`));
  });
  assert.match(app, /render\(false\);\s+if \(field === "start" && state\.followTimeline\) \{[\s\S]*?followActiveLyricLine\(\{ behavior: "auto" \}\);[\s\S]*?followTimelineToPlayhead\(\{ force: true, behavior: "auto" \}\);/);
  assert.match(app, /followTimeline: state\.followTimeline,\s+timelineMode: state\.timelineMode,/);
  assert.match(app, /\$\("#dock-play-toggle"\)\.onclick = togglePlayback;/);
  assert.match(app, /\$\("#floating-play-toggle"\)\.onclick = togglePlayback;/);
  assert.match(css, /\.dock-mini-player \{/);
  assert.match(css, /\.floating-console \{/);
});
test("touch controls suppress double-tap zoom without disabling accessible page zoom", () => {
  const html = readFileSync(new URL("./index.html", import.meta.url), "utf8");
  const app = readFileSync(new URL("./app.js", import.meta.url), "utf8");
  const css = readFileSync(new URL("./styles.css", import.meta.url), "utf8");
  const viewport = html.match(/<meta name="viewport"[^>]*>/)?.[0] || "";
  assert.doesNotMatch(viewport, /user-scalable\s*=\s*no/i);
  assert.doesNotMatch(viewport, /maximum-scale\s*=\s*1/i);
  assert.match(css, /button, label\[for\], summary, a\[href\] \{[\s\S]*?touch-action: manipulation;/);
  assert.match(css, /-webkit-user-select: none;[\s\S]*?user-select: none;/);
  assert.match(css, /-webkit-tap-highlight-color:/);
  assert.match(css, /\.timeline-viewport \{[^}]*touch-action: pan-x pan-y pinch-zoom;/);
  assert.match(css, /@media \(pointer: coarse\) \{[\s\S]*?min-height: 44px;/);
  assert.doesNotMatch(app, /addEventListener\(["']touch(?:start|move|end|cancel)["']/);
});
test("lyric-line progression finds the next unrecorded row in sequence", () => {
  const draft = [{ start: 1 }, { start: null }, { start: 3 }, { start: null }];
  assert.equal(findNextUnrecordedIndex(draft, 2), 3);
  assert.equal(findNextUnrecordedIndex(draft, 4), 1);
  assert.equal(findNextUnrecordedIndex(draft, -1), 3);
  assert.equal(findNextUnrecordedIndex([{ start: 1 }, { start: 2 }], 1), -1);
  assert.equal(findNextUnrecordedIndex([], 0), -1);
});
test("timeline follow computes an internal scroll target only while enabled in edit mode", () => {
  const options = {
    enabled: true,
    mode: "edit",
    currentTime: 50,
    duration: 100,
    contentWidth: 3200,
    viewportWidth: 400,
    scrollLeft: 0,
    force: true,
  };
  assert.equal(timelineFollowScrollTarget(options), 1448);
  assert.equal(timelineFollowScrollTarget({ ...options, enabled: false }), null);
  assert.equal(timelineFollowScrollTarget({ ...options, mode: "full" }), null);
  assert.equal(timelineFollowScrollTarget({ ...options, force: false, scrollLeft: 1400 }), null);
});
test("lyric-line follow UI syncs controls without forcing a timeline mode", () => {
  const html = readFileSync(new URL("./index.html", import.meta.url), "utf8");
  const app = readFileSync(new URL("./app.js", import.meta.url), "utf8");
  assert.match(html, /歌詞行追従/);
  assert.match(html, /aria-label="歌詞行追従：ON。記録後に次の歌詞行を画面へ表示する"/);
  assert.match(html, /title="歌詞行追従：ON。記録後に次の歌詞行を画面へ表示する"/);
  const toggleSource = app.match(/function toggleLyricFollow\(\) \{[\s\S]*?\n\}/)?.[0] || "";
  assert.match(toggleSource, /state\.followTimeline = !state\.followTimeline/);
  assert.match(toggleSource, /followActiveLyricLine\(\{ behavior: "smooth" \}\)/);
  assert.match(toggleSource, /followTimelineToPlayhead\(\{ force: true, behavior: "smooth" \}\)/);
  assert.match(toggleSource, /歌詞行追従をONにしました。記録後に次の歌詞行を表示します。/);
  assert.match(toggleSource, /歌詞行追従をOFFにしました。画面位置を固定します。/);
  assert.doesNotMatch(toggleSource, /timelineMode|setTimelineMode|renderTimeline/);
  const modeSource = app.match(/function setTimelineMode\(mode\) \{[\s\S]*?\n\}/)?.[0] || "";
  assert.doesNotMatch(modeSource, /state\.followTimeline\s*=/);
  const controlsSource = app.match(/function updateLyricFollowControls\(\) \{[\s\S]*?\n\}/)?.[0] || "";
  assert.match(controlsSource, /\[\$\("#capture-follow"\), \$\("#floating-follow"\)\]/);
  assert.match(controlsSource, /ariaPressed = String\(state\.followTimeline\)/);
  assert.match(controlsSource, /button\.ariaLabel = description/);
  assert.match(controlsSource, /button\.title = description/);
  assert.match(controlsSource, /記録後に次の歌詞行を画面へ表示する/);
  assert.match(app, /followTimeline: preferences\.followTimeline \?\? \(preferences\.followCapture !== false\)/);
  assert.match(app, /followTimeline: state\.followTimeline,\s+timelineMode: state\.timelineMode,/);
  const followSource = app.match(/function followTimelineToPlayhead\([\s\S]*?\n\}/)?.[0] || "";
  assert.match(followSource, /timelineFollowScrollTarget\(/);
  assert.match(followSource, /timelineViewport\.scrollTo\(\{ left: target, behavior \}\)/);
  assert.doesNotMatch(followSource, /scrollIntoView/);
  assert.match(app, /function updatePlayhead\(\{ follow = true \} = \{\}\) \{[\s\S]*?if \(follow\) followTimelineToPlayhead\(\);/);
  assert.match(app, /function selectTimelineBlock\([\s\S]*?updatePlayhead\(\{ follow: false \}\);[\s\S]*?followTimelineToPlayhead\(\{ force: true, behavior: "smooth" \}\)/);
});
test("lyric-line follow scrolls only after a followed start capture", () => {
  const app = readFileSync(new URL("./app.js", import.meta.url), "utf8");
  const captureSource = app.match(/function capture\(index = state\.activeIndex, field = "start"\) \{[\s\S]*?\n\}/)?.[0] || "";
  const nextIndexPosition = captureSource.indexOf("findNextUnrecordedIndex(state.lines, index + 1)");
  const renderPosition = captureSource.indexOf("render(false)");
  const followPosition = captureSource.indexOf('followActiveLyricLine({ behavior: "auto" })');
  assert.ok(nextIndexPosition >= 0 && renderPosition > nextIndexPosition && followPosition > renderPosition);
  assert.match(captureSource, /if \(field === "start"\) \{[\s\S]*?state\.activeIndex = nextIndex >= 0 \? nextIndex : index;[\s\S]*?\} else \{\s+state\.activeIndex = index;/);
  assert.match(captureSource, /if \(field === "start" && state\.followTimeline\) \{[\s\S]*?followActiveLyricLine/);
  assert.equal((captureSource.match(/followActiveLyricLine/g) || []).length, 1);
  const scrollSource = app.match(/function followActiveLyricLine\([\s\S]*?\n\}/)?.[0] || "";
  assert.match(scrollSource, /cancelAnimationFrame\(lyricFollowFrame\)/);
  assert.match(scrollSource, /requestAnimationFrame/);
  assert.match(scrollSource, /prefers-reduced-motion: reduce/);
  assert.match(scrollSource, /scrollIntoView\(\{[\s\S]*?block: "center"/);
});
test("Undo, Redo, end capture, and fine adjustment never trigger lyric-line follow", () => {
  const app = readFileSync(new URL("./app.js", import.meta.url), "utf8");
  const undoSource = app.match(/function undo\(\) \{[\s\S]*?\n\}/)?.[0] || "";
  const redoSource = app.match(/function redo\(\) \{[\s\S]*?\n\}/)?.[0] || "";
  const adjustSource = app.match(/function adjustTime\([\s\S]*?\n\}/)?.[0] || "";
  [undoSource, redoSource, adjustSource].forEach((source) => {
    assert.doesNotMatch(source, /followActiveLyricLine|scrollIntoView/);
  });
  const captureSource = app.match(/function capture\(index = state\.activeIndex, field = "start"\) \{[\s\S]*?\n\}/)?.[0] || "";
  assert.match(captureSource, /\} else \{\s+state\.activeIndex = index;\s+\}\s+render\(false\);/);
  assert.match(captureSource, /if \(field === "start" && state\.followTimeline\)/);
});
test("fixed consoles expose unique synchronized Undo and Redo controls", () => {
  const html = readFileSync(new URL("./index.html", import.meta.url), "utf8");
  const app = readFileSync(new URL("./app.js", import.meta.url), "utf8");
  const ids = [...html.matchAll(/\sid="([^"]+)"/g)].map((match) => match[1]);
  assert.equal(new Set(ids).size, ids.length);
  ["undo-capture", "redo-capture", "floating-undo", "floating-redo"].forEach((id) => {
    assert.match(html, new RegExp(`id="${id}"`));
  });
  assert.match(app, /\$\("#undo-capture"\)\.onclick = undo;/);
  assert.match(app, /\$\("#floating-undo"\)\.onclick = undo;/);
  assert.match(app, /\$\("#redo-capture"\)\.onclick = redo;/);
  assert.match(app, /\$\("#floating-redo"\)\.onclick = redo;/);
  const controlsSource = app.match(/function updateHistoryControls\(\) \{[\s\S]*?\n\}/)?.[0] || "";
  assert.match(controlsSource, /\[\$\("#undo-capture"\), \$\("#floating-undo"\)\]/);
  assert.match(controlsSource, /\[\$\("#redo-capture"\), \$\("#floating-redo"\)\]/);
  assert.match(controlsSource, /button\.disabled = !undoChange/);
  assert.match(controlsSource, /button\.disabled = !redoChange/);
  assert.match(controlsSource, /state\.history\.length/);
  assert.match(controlsSource, /state\.future\.length/);
  assert.match(app, /function undo\(\) \{[\s\S]*?state\.history\.pop\(\)[\s\S]*?state\.future\.push\(change\)/);
  assert.match(app, /function redo\(\) \{[\s\S]*?state\.future\.pop\(\)[\s\S]*?state\.history\.push\(change\)/);
});
test("media picker defers format validation until after file selection", () => {
  const html = readFileSync(new URL("./index.html", import.meta.url), "utf8");
  const app = readFileSync(new URL("./app.js", import.meta.url), "utf8");
  const mediaInput = html.match(/<input id="media-file"[^>]*>/)?.[0];
  assert.ok(mediaInput);
  assert.doesNotMatch(mediaInput, /\saccept=/);
  assert.match(app, /\$\("#media-file"\)\.addEventListener\("change", \(event\) => \{[\s\S]*?event\.target\.value = "";[\s\S]*?loadMedia\(file\);[\s\S]*?\}\);/);
});
test("bilingual lyric drafts preserve a blank line in one language", () => {
  assert.deepEqual(parseLyricDrafts(
    "一行目\n二行目\n三行目",
    "First line\n\nThird line",
  ), [
    { jp: "一行目", en: "First line" },
    { jp: "二行目", en: "" },
    { jp: "三行目", en: "Third line" },
  ]);
});
test("bilingual lyric drafts remove rows blank in both languages after alignment", () => {
  assert.deepEqual(parseLyricDrafts(
    "一行目\n\n二行目",
    "First line\n\nSecond line",
  ), [
    { jp: "一行目", en: "First line" },
    { jp: "二行目", en: "Second line" },
  ]);
});
test("Japanese-only lyric drafts discard internal blank rows", () => {
  assert.deepEqual(parseLyricDrafts("一行目\n\n二行目", ""), [
    { jp: "一行目", en: "" },
    { jp: "二行目", en: "" },
  ]);
});
test("English-only lyric drafts discard internal blank rows", () => {
  assert.deepEqual(parseLyricDrafts("", "First line\n\nSecond line"), [
    { jp: "", en: "First line" },
    { jp: "", en: "Second line" },
  ]);
});
test("lyric drafts trim outer blank lines without shifting bilingual content", () => {
  assert.deepEqual(parseLyricDrafts(
    "\n\n 一行目 \n二行目\n\n",
    "\n First line\nSecond line \n\n\n",
  ), [
    { jp: "一行目", en: "First line" },
    { jp: "二行目", en: "Second line" },
  ]);
});
test("shorter bilingual draft is padded and reported for review", () => {
  const draft = lyricDraftInfo(
    "一行目\n二行目\n三行目",
    "First line\nSecond line",
  );
  assert.deepEqual(draft.rows, [
    { jp: "一行目", en: "First line" },
    { jp: "二行目", en: "Second line" },
    { jp: "三行目", en: "" },
  ]);
  assert.equal(draft.lengthsDiffer, true);
});
test("aligned bilingual blanks remain visible to quality checks and SRT export", () => {
  const timed = parseLyricDrafts(
    "一行目\n二行目\n三行目",
    "First line\n\nThird line",
  ).map((line, index) => ({ ...line, start: index * 2 + 1 }));
  const report = analyzeProject(timed, 8);
  const english = makeSrt(timed, "en", 8);
  const bilingual = makeSrt(timed, "bilingual", 8);
  assert.ok(report.issues.some((issue) => issue.code === "language" && issue.index === 1));
  assert.doesNotMatch(english, /00:00:03,000/);
  assert.match(english, /00:00:05,000 --> 00:00:08,000\nThird line/);
  assert.match(bilingual, /00:00:03,000 --> 00:00:04,980\n二行目/);
  assert.match(bilingual, /三行目\nThird line/);
});
test("draft count and lyric import share the aligned parser result", () => {
  const app = readFileSync(new URL("./app.js", import.meta.url), "utf8");
  assert.match(app, /function updateDraftCount\(\) \{[\s\S]*?lyricDraftInfo\([\s\S]*?draft\.rows\.length/);
  assert.match(app, /function applyLyrics\(\) \{[\s\S]*?lyricDraftInfo\([\s\S]*?state\.lines = draft\.rows\.map/);
  assert.match(app, /draft\.lengthsDiffer[\s\S]*?日本語とEnglishの行数が異なります。空欄になった行を確認してください。/);
});
test("capture rejects every recording route until a media object URL is loaded", () => {
  const app = readFileSync(new URL("./app.js", import.meta.url), "utf8");
  const captureSource = app.match(/function capture\(index = state\.activeIndex, field = "start"\) \{[\s\S]*?\n\}/)?.[0] || "";
  const guardIndex = captureSource.indexOf("if (!hasLoadedMedia())");
  const firstMutationIndex = captureSource.indexOf("pushChange(");
  assert.ok(guardIndex >= 0 && firstMutationIndex > guardIndex);
  assert.match(captureSource.slice(guardIndex, firstMutationIndex), /先に曲を選んでください。/);
  assert.match(captureSource.slice(guardIndex, firstMutationIndex), /曲が選択されていません/);
  assert.doesNotMatch(captureSource, /player\.paused/);
  assert.match(app, /function hasLoadedMedia\(\) \{[\s\S]*?state\.mediaUrl[\s\S]*?player\.getAttribute\("src"\)/);
  assert.match(app, /function loadMedia\(sourceFile\) \{[\s\S]*?state\.mediaUrl = URL\.createObjectURL\(file\);[\s\S]*?player\.src = state\.mediaUrl;/);
  assert.match(app, /\$\("#capture-active"\)\.onclick = \(\) => capture\(\);/);
  assert.match(app, /\$\("#capture-floating"\)\.onclick = \(\) => capture\(\);/);
  assert.match(app, /data-action=capture-start[\s\S]*?capture\(index, "start"\)/);
  assert.match(app, /data-action=capture-end[\s\S]*?capture\(index, "end"\)/);
  assert.match(app, /event\.code === "Space"[\s\S]*?capture\(\)/);
  assert.match(app, /event\.code === "KeyE"[\s\S]*?capture\(state\.activeIndex, "end"\)/);
});
test("opening a project unloads any previous media before capture can resume", () => {
  const app = readFileSync(new URL("./app.js", import.meta.url), "utf8");
  assert.match(app, /function applyProject\([\s\S]*?unloadMedia\(\);[\s\S]*?mediaUrl: null/);
  assert.match(app, /function unloadMedia\(\) \{[\s\S]*?URL\.revokeObjectURL[\s\S]*?player\.removeAttribute\("src"\)/);
});
test("timeline creates blocks only for recorded lines", () => {
  const blocks = buildTimelineBlocks([{ start: null }, { start: 2 }, { start: "" }, { start: 5 }], 8);
  assert.deepEqual(blocks.map(({ index, start, end }) => ({ index, start, end })), [
    { index: 1, start: 2, end: 4.98 },
    { index: 3, start: 5, end: 8 },
  ]);
});
test("recording the next line updates the previous timeline range", () => {
  const source = [{ start: 1 }, { start: null }];
  assert.equal(buildTimelineBlocks(source, 10)[0].end, 10);
  source[1].start = 4;
  assert.equal(buildTimelineBlocks(source, 10)[0].end, 3.98);
});
test("timeline manual end takes priority", () => {
  const [block] = buildTimelineBlocks([{ start: 1, end: 2.5 }, { start: 4 }], 8);
  assert.equal(block.end, 2.5);
  assert.equal(block.source, "manual");
  assert.equal(block.manual, true);
});
test("timeline final line reaches media duration", () => {
  const [block] = buildTimelineBlocks([{ start: 6 }], 9.5);
  assert.equal(block.end, 9.5);
  assert.equal(block.source, "duration");
});
test("invalid manual end is flagged and safely uses automatic timing", () => {
  const [block] = buildTimelineBlocks([{ start: 2, end: 1 }, { start: 5 }], 8);
  assert.equal(block.end, 4.98);
  assert.equal(block.invalidManual, true);
  assert.equal(block.manual, false);
});
test("timeline UI restores, rerenders, seeks, and never captures from an empty tap", () => {
  const html = readFileSync(new URL("./index.html", import.meta.url), "utf8");
  const app = readFileSync(new URL("./app.js", import.meta.url), "utf8");
  ["timeline-viewport", "timeline-content", "subtitle-timeline", "timeline-blocks", "timeline-empty"].forEach((id) => {
    assert.match(html, new RegExp(`id="${id}"`));
  });
  assert.match(app, /function render\(scroll = false\) \{[\s\S]*?renderTimeline\(\);/);
  assert.match(app, /function applyProject\([\s\S]*?render\(\);/);
  assert.match(app, /function undo\(\) \{[\s\S]*?render\(\);/);
  assert.match(app, /function redo\(\) \{[\s\S]*?render\(\);/);
  assert.match(app, /function selectTimelineBlock\(index, start\) \{[\s\S]*?state\.activeIndex[\s\S]*?player\.currentTime[\s\S]*?updatePlayhead\(\{ follow: false \}\);/);
  const emptyTap = app.match(/timelineContent\.addEventListener\("click", \(event\) => \{[\s\S]*?\n\}\);/)?.[0] || "";
  assert.match(emptyTap, /player\.currentTime =/);
  assert.doesNotMatch(emptyTap, /\bcapture\(/);
});
test("editing timeline follow remains supplemental to lyric-line follow", () => {
  const app = readFileSync(new URL("./app.js", import.meta.url), "utf8");
  const captureSource = app.match(/function capture\(index = state\.activeIndex, field = "start"\) \{[\s\S]*?\n\}/)?.[0] || "";
  assert.match(captureSource, /render\(false\);/);
  assert.match(captureSource, /followTimelineToPlayhead\(\{ force: true, behavior: "auto" \}\)/);
  assert.match(app, /timelineFollowScrollTarget\(\{[\s\S]*?enabled: state\.followTimeline,[\s\S]*?mode: state\.timelineMode,/);
});
test("timeline exposes full and edit modes plus beta candidate branding", () => {
  const html = readFileSync(new URL("./index.html", import.meta.url), "utf8");
  const css = readFileSync(new URL("./styles.css", import.meta.url), "utf8");
  assert.match(html, /data-timeline-mode="full"/);
  assert.match(html, /data-timeline-mode="edit"/);
  assert.match(html, /音に、<br><em>言葉の居場所をつくる。<\/em>/);
  assert.match(html, /BETA CANDIDATE \/ 2\.3\.3/);
  assert.match(html, /Lyric SRT Studio v2\.3\.3 β候補版/);
  assert.match(html, /styles\.css\?v=2\.3\.3/);
  assert.match(html, /srt-core\.js\?v=2\.3\.3/);
  assert.match(html, /app\.js\?v=2\.3\.3/);
  assert.match(css, /\.timeline-block\.just-recorded/);
  assert.match(css, /@media \(prefers-reduced-motion: reduce\)/);
});
test("formats SRT timestamps", () => assert.equal(formatSrtTime(3661.007), "01:01:01,007"));
test("auto end uses next start minus a gap", () => assert.equal(resolveEnd(lines, 0, 8), 3.98));
test("manual end overrides automatic timing", () => assert.equal(resolveEnd([{ jp: "A", start: 1, end: 2.5 }], 0, 10), 2.5));
test("makes Japanese-only SRT", () => assert.equal(makeSrt(lines, "jp", 8), "1\n00:00:01,200 --> 00:00:03,980\n朝\n\n2\n00:00:04,000 --> 00:00:08,000\n夜\n"));
test("makes bilingual SRT", () => assert.match(makeSrt(lines, "bilingual", 8), /朝\nMorning/));
test("keeps original timing when selected language is blank", () => {
  const source = [{ jp: "一", en: "One", start: 1 }, { jp: "二", en: "", start: 3 }, { jp: "三", en: "Three", start: 5 }];
  assert.match(makeSrt(source, "en", 8), /00:00:01,000 --> 00:00:02,980/);
});
test("rejects non-increasing timestamps", () => assert.equal(validateLines([{ start: 4 }, { start: 3 }]).length, 1));
test("rejects an end before its start", () => assert.equal(validateLines([{ start: 4, end: 3 }]).length, 1));
test("does not treat an unrecorded line as zero", () => assert.match(makeSrt([{ jp: "未記録", start: null }, { jp: "記録済み", start: 2 }], "jp", 5), /^1\n00:00:02,000/));
test("reports suspicious durations and overlaps", () => {
  const report = analyzeProject([{ jp: "短い", start: 1 }, { jp: "重なる", start: 1.2, end: 22 }, { jp: "終わり", start: 20 }], 25);
  assert.ok(report.issues.some((issue) => issue.code === "short"));
  assert.ok(report.issues.some((issue) => issue.code === "overlap"));
});
test("detects reversed timing across an unrecorded line", () => {
  const report = analyzeProject([{ jp: "先", start: 5 }, { jp: "未記録", start: null }, { jp: "逆転", start: 3 }], 10);
  assert.ok(report.issues.some((issue) => issue.code === "order" && issue.index === 2));
});
