// dsh-bilibili 单元测试（零依赖，不联网）：纯函数覆盖
// 运行：node --test test/   （或 npm test）
// 网络相关（真实提取/ASR/ffmpeg）不在此套件内，保留为手动验证。

import { test } from "node:test";
import assert from "node:assert/strict";
import { selectKeyframeTimestamps, formatTime } from "../lib/keyframes.js";
import { parseSubtitleBody, nearestSubtitleText, guessStreamExt } from "../lib/extractor.js";
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

