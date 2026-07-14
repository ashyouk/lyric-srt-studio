import test from "node:test";
import assert from "node:assert/strict";
import { analyzeProject, formatSrtTime, makeSrt, validateLines } from "./srt-core.js";

const lines = [
  { jp: "朝", en: "Morning", start: 1.2 },
  { jp: "夜", en: "Night", start: 4 },
];

test("formats SRT timestamps", () => assert.equal(formatSrtTime(3661.007), "01:01:01,007"));
test("makes Japanese-only SRT with next line as the end", () => assert.equal(makeSrt(lines, "jp", 8), "1\n00:00:01,200 --> 00:00:03,980\n朝\n\n2\n00:00:04,000 --> 00:00:08,000\n夜\n"));
test("makes bilingual SRT", () => assert.match(makeSrt(lines, "bilingual", 8), /朝\nMorning/));
test("rejects non-increasing timestamps", () => assert.equal(validateLines([{ start: 4 }, { start: 3 }]).length, 1));
test("does not treat an unrecorded line as timestamp zero", () => assert.equal(makeSrt([{ jp: "未記録", start: null }, { jp: "記録済み", start: 2 }], "jp", 5), "1\n00:00:02,000 --> 00:00:05,000\n記録済み\n"));
test("reports unrecorded lines without treating null as zero", () => assert.equal(analyzeProject([{ jp: "未記録", start: null }], 10).issues[0].code, "unrecorded"));
test("reports suspiciously short and long subtitle durations", () => {
  const report = analyzeProject([{ jp: "短い", start: 1 }, { jp: "長い", start: 1.2 }, { jp: "終わり", start: 20 }], 25);
  assert.ok(report.issues.some((issue) => issue.code === "short"));
  assert.ok(report.issues.some((issue) => issue.code === "long"));
});
test("detects reversed timing even across an unrecorded line", () => {
  const report = analyzeProject([{ jp: "先", start: 5 }, { jp: "未記録", start: null }, { jp: "逆転", start: 3 }], 10);
  assert.ok(report.issues.some((issue) => issue.code === "order" && issue.index === 2));
});
