// dsh-bilibili 单元测试（零依赖，不联网）：纯函数覆盖
// 运行：node --test test/   （或 npm test）
// 网络相关（真实提取/ASR/ffmpeg）不在此套件内，保留为手动验证。

import { test } from "node:test";
import assert from "node:assert/strict";
import { selectKeyframeTimestamps, formatTime } from "../lib/keyframes.js";
import { parseSubtitleBody, nearestSubtitleText, guessStreamExt, parseWhisperTime, parseWhisperJson, resolveWhisperModel, parseSherpaText } from "../lib/extractor.js";
import { formatExtraction } from "../lib/format.js";

const SUBTITLE_SEGS = [
  { start: 0, end: 5, text: "大家好今天聊聊" },
  { start: 30, end: 35, text: "如图所示的界面" },
];

const SCENE_PEAKS = [
  { time: 12, reason: "scene change", text: "" },
  { time: 33, reason: "scene change", text: "" },
  { time: 60, reason: "scene change", text: "" },
];

test("混合选帧：字幕命中保留", () => {
  const plan = selectKeyframeTimestamps(SUBTITLE_SEGS, 120, 5, SCENE_PEAKS);
  assert.ok(plan.some((p) => p.reason.includes("如图")), "subtitle hit kept");
});

test("混合选帧：场景峰合并 + 5 秒去重", () => {
  const plan = selectKeyframeTimestamps(SUBTITLE_SEGS, 120, 5, SCENE_PEAKS);
  assert.ok(plan.some((p) => p.reason === "scene change"), "scene peak merged");
  assert.ok(!plan.some((p) => Math.abs(p.time - 33) < 0.1), "33s peak within 5s of subtitle hit dropped");
  for (let i = 1; i < plan.length; i++) {
    assert.ok(plan[i].time > plan[i - 1].time, "sorted ascending");
  }
});

test("混合选帧：均匀补齐 + 封顶", () => {
  const plan = selectKeyframeTimestamps(SUBTITLE_SEGS, 120, 5, SCENE_PEAKS);
  assert.equal(plan.length, 5, "capped at maxFrames");
  assert.ok(plan.some((p) => p.reason.includes("even")), "backfill present");
});

test("无字幕：场景峰优先 + 均匀补齐", () => {
  const plan = selectKeyframeTimestamps([], 100, 3, SCENE_PEAKS);
  assert.equal(plan.length, 3, "capped");
  assert.ok(plan.some((p) => p.reason === "scene change"), "peaks kept");
});

test("全空输入不崩溃", () => {
  assert.deepEqual(selectKeyframeTimestamps([], 0, 6), []);
  assert.deepEqual(selectKeyframeTimestamps(undefined, 10, 3), []);
});

test("formatTime", () => {
  assert.equal(formatTime(75), "1:15");
  assert.equal(formatTime(0), "0:00");
  assert.equal(formatTime(3661), "61:01");
});

test("parseSubtitleBody：跳空段 + 拼文", () => {
  const parsed = parseSubtitleBody({
    body: [
      { from: 0, to: 4, content: "第一句" },
      { from: 5, to: 9, content: "   " },
      { from: 10, to: 14, content: "第二句" },
    ],
  });
  assert.equal(parsed.segments.length, 2, "blank skipped");
  assert.equal(parsed.text, "第一句\n第二句");
  assert.deepEqual(parsed.segments[1], { start: 10, end: 14, text: "第二句" });
});

test("nearestSubtitleText：±2s 窗口", () => {
  assert.equal(nearestSubtitleText(32, SUBTITLE_SEGS), "如图所示的界面");
  assert.equal(nearestSubtitleText(70, SUBTITLE_SEGS), "", "far away -> empty");
  assert.equal(nearestSubtitleText(32, undefined), "", "no segments -> empty");
});

test("guessStreamExt", () => {
  assert.equal(guessStreamExt("https://x.com/a.m3u8?token=1"), ".m3u8");
  assert.equal(guessStreamExt("https://x.com/a.mp4"), ".mp4");
  assert.equal(guessStreamExt("https://x.com/a.m4s"), ".mp4");
  assert.equal(guessStreamExt("https://x.com/a.flv"), ".flv");
  assert.equal(guessStreamExt("https://x.com/unknown"), ".flv", "default flv");
});

test("formatExtraction：失败分支", () => {
  const text = formatExtraction({ success: false, error: "cannot parse" });
  assert.ok(text.includes("cannot parse"));
});

test("formatExtraction：成功摘要关键元素", () => {
  const value = {
    success: true, bvid: "BVTEST", elapsed_seconds: 1.2,
    metadata: { title: "测试视频", uploader: { name: "up" }, duration: 60, category: "科技", pages: 1, description: "-", stats: {} },
    transcript: { source: "subtitle", language: "zh", text: "你好", segments: [], total_segments: 1, note: "" },
    comments: { total: 0, fetched: 0, comments: [], note: "" },
    danmaku: { total: 0, top_messages: [], samples: [], note: "" },
    frames: { enabled: true, strategy: "requested timestamps", mode: "local", note: "cache", frames: [{ time: 12, reason: "requested timestamp", subtitle_text: "如图", has_image: true, path: "C:/t.jpg", error: null }], error: null },
  };
  const text = formatExtraction(value);
  assert.ok(text.includes("测试视频"), "title");
  assert.ok(text.includes("BVTEST"), "bvid");
  assert.ok(text.includes("read_image"), "read_image hint");
  assert.ok(text.includes("capture mode: local"), "mode line");
  assert.ok(text.includes("C:/t.jpg"), "frame path");
});

test("parseWhisperTime：MM:SS,mmm 与 HH:MM:SS,mmm", () => {
  assert.equal(parseWhisperTime("00:01:15,500"), 75.5);
  assert.equal(parseWhisperTime("01:15,500"), 75.5);
  assert.equal(parseWhisperTime("00:00:00,000"), 0);
  assert.equal(parseWhisperTime("bad"), undefined);
});

test("parseWhisperJson：offsets(毫秒) → 秒 + 跳空段", () => {
  const segs = parseWhisperJson({
    transcription: [
      { text: " 第一句 ", offsets: { from: 0, to: 520 } },
      { text: "第二句", offsets: { from: 1000, to: 2500 } },
      { text: "   ", offsets: { from: 2500, to: 2600 } },
    ],
  });
  assert.equal(segs.length, 2, "blank skipped");
  assert.deepEqual(segs[0], { start: 0, end: 0.52, text: "第一句" });
  assert.deepEqual(segs[1], { start: 1, end: 2.5, text: "第二句" });
});

test("parseWhisperJson：无 offsets 时回退解析 timestamps", () => {
  const segs = parseWhisperJson({
    transcription: [{ text: "你好", timestamps: { from: "00:00:03,000", to: "00:00:05,000" } }],
  });
  assert.deepEqual(segs, [{ start: 3, end: 5, text: "你好" }]);
});

test("resolveWhisperModel：低中高三档映射", () => {
  assert.ok(resolveWhisperModel("low", "", "").endsWith("ggml-small.bin"), "low → small");
  assert.ok(resolveWhisperModel("medium", "", "").endsWith("ggml-medium.bin"), "medium → medium");
  assert.ok(resolveWhisperModel("high", "", "").endsWith("ggml-large-v3.bin"), "high → large-v3");
  assert.ok(resolveWhisperModel("large-v3", "", "").endsWith("ggml-large-v3.bin"), "large-v3 literal");
});

test("resolveWhisperModel：目录拼接与字面路径", () => {
  assert.equal(resolveWhisperModel("medium", "D:/models", "").replace(/\\/g, "/"), "D:/models/ggml-medium.bin");
  assert.equal(resolveWhisperModel("C:/x/my.bin", "", ""), "C:/x/my.bin", "literal path kept");
  assert.equal(resolveWhisperModel("small", "", "D:/whisper/whisper-cli.exe").replace(/\\/g, "/"), "D:/whisper/models/ggml-small.bin");
  assert.equal(resolveWhisperModel("", "", ""), undefined, "empty → undefined");
});

test("parseSherpaText：带时间戳行（--> / - / 方括号）", () => {
  const segs = parseSherpaText([
    "00:00:00.000 --> 00:00:02.400: 第一句",
    "00:00:02.400 - 00:00:05.000  第二句",
    "[00:00:05.000 --> 00:00:07.000] 第三句",
  ].join("\n"));
  assert.equal(segs.length, 3);
  assert.deepEqual(segs[0], { start: 0, end: 2.4, text: "第一句" });
  assert.deepEqual(segs[1], { start: 2.4, end: 5, text: "第二句" });
  assert.deepEqual(segs[2], { start: 5, end: 7, text: "第三句" });
});

test("parseSherpaText：无时间戳回退为单段", () => {
  assert.deepEqual(parseSherpaText("你好 世界"), [{ start: 0, end: 0, text: "你好 世界" }]);
  assert.deepEqual(parseSherpaText(""), []);
});

