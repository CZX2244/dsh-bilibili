// dsh-bilibili 单元测试（零依赖，不联网）：纯函数覆盖
// 运行：node --test test/   （或 npm test）
// 网络相关（真实提取/ASR/ffmpeg）不在此套件内，保留为手动验证。

import { test } from "node:test";
import assert from "node:assert/strict";
import { selectKeyframeTimestamps, formatTime } from "../lib/keyframes.js";
import { parseSubtitleBody, nearestSubtitleText, guessStreamExt, parseWhisperTime, parseWhisperJson, resolveWhisperModel, parseSherpaText, resolveVisionModel, buildVisionRequest, parseChatCompletion, DEFAULT_VISION_PROMPT, resolveVisionBaseUrl, resolveVisionPrompt, parseCitationHint, VISION_PROMPT_SHORT } from "../lib/extractor.js";
import { formatExtraction, capTranscriptSmart, pickDanmakuPeaks } from "../lib/format.js";

const SUBTITLE_SEGS = [
  { start: 0, end: 5, text: "大家好今天聊聊" },
  { start: 30, end: 35, text: "如图所示的界面" },
];

const SCENE_PEAKS = [
  { time: 12, reason: "scene change", text: "" },
  { time: 33, reason: "scene change", text: "" },
  { time: 60, reason: "scene change", text: "" },
];

test("自动选帧：场景峰保留 + 排序 + 封顶", () => {
  const plan = selectKeyframeTimestamps(SUBTITLE_SEGS, 120, 5, SCENE_PEAKS);
  assert.equal(plan.length, 5, "capped at maxFrames");
  assert.ok(plan.some((p) => p.reason === "scene change"), "scene peaks kept");
  for (let i = 1; i < plan.length; i++) {
    assert.ok(plan[i].time > plan[i - 1].time, "sorted ascending");
  }
});

test("自动选帧：均匀补齐", () => {
  const plan = selectKeyframeTimestamps(SUBTITLE_SEGS, 120, 5, SCENE_PEAKS);
  assert.ok(plan.some((p) => p.reason.includes("even")), "backfill present");
});

test("自动选帧：不做关键词猜测（语义判断交给主 Agent）", () => {
  const plan = selectKeyframeTimestamps(
    [{ start: 0, end: 5, text: "如图所示的界面展示对比数据，看这里，就是它" }],
    60, 3, [],
  );
  assert.ok(!plan.some((p) => p.reason.includes("subtitle")), "no keyword-based picks");
  assert.ok(plan.every((p) => p.reason === "even interval"), "only even backfill without scene signal");
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

test("resolveVisionModel：低中高三档映射与显式名透传", () => {
  assert.equal(resolveVisionModel("low"), "qwen3-vl:2b");
  assert.equal(resolveVisionModel("medium"), "qwen3-vl:4b");
  assert.equal(resolveVisionModel("high"), "qwen3-vl:8b");
  assert.equal(resolveVisionModel("large"), "qwen3-vl:8b", "large alias -> 8b");
  assert.equal(resolveVisionModel("qwen3-vl:4b"), "qwen3-vl:4b", "explicit 4b tag kept");
  assert.equal(resolveVisionModel("minicpm-v"), "minicpm-v", "explicit name kept");
  assert.equal(resolveVisionModel("gpt-4o-mini"), "gpt-4o-mini", "cloud id kept");
  assert.equal(resolveVisionModel(""), undefined, "empty -> undefined");
});

test("buildVisionRequest：base64 data URL + model/prompt + apiKey header", () => {
  const bytes = Buffer.from("fakejpeg");
  const req = buildVisionRequest(bytes, { model: "medium", prompt: "", apiKey: "" });
  assert.equal(req.body.model, "qwen3-vl:4b", "tier resolved (medium -> 4b)");
  assert.ok(req.body.messages[0].content[1].image_url.url.startsWith("data:image/jpeg;base64,"), "data url");
  assert.equal(req.body.messages[0].content[1].image_url.url, "data:image/jpeg;base64," + bytes.toString("base64"), "base64 correct");
  assert.equal(req.body.messages[0].content[0].text, DEFAULT_VISION_PROMPT, "default prompt used");
  assert.equal(req.headers.Authorization, undefined, "no key -> no auth header");

  const withKey = buildVisionRequest(bytes, { model: "gpt-4o-mini", prompt: "看图", apiKey: "sk-test" });
  assert.equal(withKey.body.model, "gpt-4o-mini", "explicit model kept");
  assert.equal(withKey.body.messages[0].content[0].text, "看图", "custom prompt used");
  assert.equal(withKey.headers.Authorization, "Bearer sk-test", "auth header present");
});

test("parseChatCompletion：OpenAI 格式解析与容错", () => {
  assert.equal(parseChatCompletion({ choices: [{ message: { content: " 画面描述 " } }] }), "画面描述");
  assert.equal(parseChatCompletion({ choices: [] }), "", "no choices -> empty");
  assert.equal(parseChatCompletion({}), "", "empty json -> empty");
  assert.equal(parseChatCompletion(null), "", "null -> empty");
});

test("resolveVisionBaseUrl：provider 默认地址与显式地址", () => {
  assert.equal(resolveVisionBaseUrl("ollama", ""), "http://localhost:11434/v1", "ollama default");
  assert.equal(resolveVisionBaseUrl("llama-cpp", ""), "http://localhost:8080/v1", "llama-cpp default");
  assert.equal(resolveVisionBaseUrl("openai-compatible", ""), "", "cloud needs explicit url");
  assert.equal(resolveVisionBaseUrl("ollama", "http://10.0.0.5:9999/v1/"), "http://10.0.0.5:9999/v1", "explicit url kept, trailing slash trimmed");
});

test("capTranscriptSmart：长文稿保骨架（前部完整 + 时间索引）", () => {
  const segs = [];
  let text = "";
  for (let i = 0; i < 100; i++) {
    segs.push({ start: i * 60, end: i * 60 + 10, text: "第" + i + "段内容" });
    text += ("第" + i + "段内容").repeat(20);
  }
  const out = capTranscriptSmart(segs, text, 8000);
  assert.ok(out.length < text.length, "compressed");
  assert.ok(out.includes("全文时间索引"), "has time index");
  assert.ok(/\[0:00\]/.test(out), "index entries with timestamps");
  assert.ok(out.includes("[95:00]"), "late-section bucket head discoverable in index");
});

test("pickDanmakuPeaks：密度峰采样（片头弹幕不霸榜）", () => {
  const samples = [];
  for (let i = 0; i < 40; i++) samples.push({ time: i, text: "来了" + i });
  for (let i = 0; i < 10; i++) samples.push({ time: 300 + i, text: "高能" + i });
  const picked = pickDanmakuPeaks(samples, 60, 4, 30);
  assert.ok(picked.length <= 30, "capped");
  assert.ok(picked.some((s) => s.text.startsWith("高能")), "peak window included");
});

test("resolveVisionPrompt：优先级链与分模型选择", () => {
  assert.equal(resolveVisionPrompt("qwen3-vl:8b", "", {}), DEFAULT_VISION_PROMPT, "default family");
  assert.equal(resolveVisionPrompt("low", "", {}), VISION_PROMPT_SHORT, "low tier -> short");
  assert.equal(resolveVisionPrompt("qwen3-vl:2b", "", {}), VISION_PROMPT_SHORT, "2b model -> short");
  const mp = resolveVisionPrompt("minicpm-v:8b-2.6-q6_K", "", {});
  assert.ok(mp.includes("结论"), "minicpm family prompt used");
  const en = resolveVisionPrompt("moondream2", "", {});
  assert.ok(/citation: suitable/i.test(en), "moondream2 gets english prompt");
  // 用户覆盖优先级：显式模型名 > 档位 > 全局
  assert.equal(resolveVisionPrompt("qwen3-vl:4b", "全局覆盖", {}), "全局覆盖");
  assert.equal(resolveVisionPrompt("qwen3-vl:4b", "全局覆盖", { medium: "档位覆盖" }), "档位覆盖");
  assert.equal(resolveVisionPrompt("qwen3-vl:8b", "全局覆盖", { "qwen3-vl:8b": "精确覆盖" }), "精确覆盖");
  // 数字边界回归：32b 不得被 "2b" 子串误判为低档（不应拿到短提示词）
  assert.equal(resolveVisionPrompt("qwen3-vl:32b", "", {}), DEFAULT_VISION_PROMPT, "32b -> detailed prompt, not short");
  assert.equal(resolveVisionPrompt("medium", "", {}), DEFAULT_VISION_PROMPT, "4b medium -> detailed prompt");
});

test("resolveVisionPrompt：内容理解而非逐字转录（无 OCR 指令）", () => {
  const p8 = resolveVisionPrompt("qwen3-vl:8b", "", {});
  assert.ok(p8.includes("不要逐字转录"), "default prompt forbids transcription");
  const mp = resolveVisionPrompt("minicpm-v:8b-2.6-q6_K", "", {});
  assert.ok(mp.includes("不要逐字转录"), "minicpm prompt forbids transcription");
  const sh = resolveVisionPrompt("low", "", {});
  assert.ok(!/转录|转写/.test(sh), "short prompt has no transcription demand at all");
  const en = resolveVisionPrompt("moondream2", "", {});
  assert.ok(/do not transcribe/i.test(en), "english prompt forbids transcription");
});

test("parseCitationHint：中英标记解析与容错", () => {
  assert.equal(parseCitationHint("描述内容...\n配图建议：适合"), "suitable");
  assert.equal(parseCitationHint("描述...\n配图建议: 不适合"), "unsuitable");
  assert.equal(parseCitationHint("desc...\ncitation: suitable"), "suitable");
  assert.equal(parseCitationHint("desc...\ncitation: UNSUITABLE"), "unsuitable");
  assert.equal(parseCitationHint("没有标记"), "");
  assert.equal(parseCitationHint(""), "");
});

test("buildVisionRequest：分模型提示词进入请求体", () => {
  const bytes = Buffer.from("fakejpeg");
  const req = buildVisionRequest(bytes, { model: "moondream2", prompt: resolveVisionPrompt("moondream2", "", {}) });
  assert.ok(/citation: suitable/i.test(req.body.messages[0].content[0].text), "resolved prompt in body");
});

