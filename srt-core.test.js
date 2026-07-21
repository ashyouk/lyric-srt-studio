import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import vm from "node:vm";
import "./srt-core.js";

const { analyzeProject, formatSrtTime, makeSrt, resolveEnd, validateLines } = globalThis.LyricSrtCore;

const lines = [{ jp: "朝", en: "Morning", start: 1.2, end: null }, { jp: "夜", en: "Night", start: 4, end: null }];
test("loads as classic scripts without global declaration collisions", () => {
  const context = vm.createContext({});
  vm.runInContext(readFileSync(new URL("./srt-core.js", import.meta.url), "utf8"), context);
  vm.runInContext('const { analyzeProject, isTime } = globalThis.LyricSrtCore; if (!analyzeProject || !isTime) throw new Error("Core unavailable");', context);
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
