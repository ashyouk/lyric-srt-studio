import test from "node:test";
import assert from "node:assert/strict";
import { formatSrtTime, makeSrt, validateLines } from "./srt-core.js";

const lines = [
  { jp: "朝", en: "Morning", start: 1.2 },
  { jp: "夜", en: "Night", start: 4 },
];

test("formats SRT timestamps", () => assert.equal(formatSrtTime(3661.007), "01:01:01,007"));
test("makes Japanese-only SRT with next line as the end", () => assert.equal(makeSrt(lines, "jp", 8), "1\n00:00:01,200 --> 00:00:03,980\n朝\n\n2\n00:00:04,000 --> 00:00:08,000\n夜\n"));
test("makes bilingual SRT", () => assert.match(makeSrt(lines, "bilingual", 8), /朝\nMorning/));
test("rejects non-increasing timestamps", () => assert.equal(validateLines([{ start: 4 }, { start: 3 }]).length, 1));
test("does not treat an unrecorded line as timestamp zero", () => assert.equal(makeSrt([{ jp: "未記録", start: null }, { jp: "記録済み", start: 2 }], "jp", 5), "1\n00:00:02,000 --> 00:00:05,000\n記録済み\n"));
