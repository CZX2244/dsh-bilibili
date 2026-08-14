/**
 * dsh-bilibili — DeepSeek Harness tool plugin.
 *
 * Registers the model-facing `bilibili_extract` tool on ctx.tools:
 * extract a Bilibili video's text information first (metadata, transcript,
 * comments, danmaku), then capture keyframes at subtitle-driven timestamps,
 * and hand everything to the model for the final summary. Frame images are
 * saved as files and referenced by absolute path so the model can read_image
 * the ones it needs.
 *
 * Cordis plugin module: exports name / inject / Config / apply.
 *
 * @module dsh-bilibili
 */

import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import z from "@deepseek-ai/schemastery";
import { defineTool } from "@deepseek-ai/dsh-tools";
import { extractAll } from "./extractor.js";
import { formatExtraction } from "./format.js";

/** Cordis plugin name used by loader diagnostics. */
const name = "bilibili";

/** Services required by the tool plugin. */
const inject = ["tools", "systemPrompt"];

const DEFAULT_CONFIG = {
  sessdata: "",
  commentLimit: 20,
  maxFrames: 6,
  extractFrames: true,
  downloadVideo: true,
  keepVideo: false,
  maxVideoMinutes: 30,
  maxDownloadMb: 800,
  quality: 32,
  detectScenes: true,
  sceneThreshold: 0.4,
  sharpFrames: true,
  asrProvider: "bcut",
  whisperBin: "whisper-cli",
  whisperModel: "medium",
  whisperModelDir: "",
  whisperLanguage: "zh",
  whisperThreads: 0,
  sherpaBin: "",
  sherpaModel: "",
  sherpaModelType: "sense-voice",
  sherpaTokens: "",
  sherpaThreads: 0,
  visionProvider: "none",
  visionBaseUrl: "",
  visionModel: "medium",
  visionApiKey: "",
  visionPrompt: "",
  visionPromptByModel: {},
  visionMaxFrames: 6,
  framesDir: "",
  summaryTemplate: "",
  timeoutMs: 300000,
};

/** Deployment-tunable config, filled by the loader from the patch row. */
const Config = z.object({
  sessdata: z.string().default(""),
  commentLimit: z.number().default(20),
  maxFrames: z.number().default(6),
  extractFrames: z.boolean().default(true),
  downloadVideo: z.boolean().default(true),
  keepVideo: z.boolean().default(false),
  maxVideoMinutes: z.number().default(30),
  maxDownloadMb: z.number().default(800),
  quality: z.number().default(32),
  detectScenes: z.boolean().default(true),
  sceneThreshold: z.number().default(0.4),
  sharpFrames: z.boolean().default(true),
  asrProvider: z.string().default("bcut"),
  whisperBin: z.string().default("whisper-cli"),
  whisperModel: z.string().default("medium"),
  whisperModelDir: z.string().default(""),
  whisperLanguage: z.string().default("zh"),
  whisperThreads: z.number().default(0),
  sherpaBin: z.string().default(""),
  sherpaModel: z.string().default(""),
  sherpaModelType: z.string().default("sense-voice"),
  sherpaTokens: z.string().default(""),
  sherpaThreads: z.number().default(0),
  visionProvider: z.string().default("none"),
  visionBaseUrl: z.string().default(""),
  visionModel: z.string().default("medium"),
  visionApiKey: z.string().default(""),
  visionPrompt: z.string().default(""),
  visionPromptByModel: z.dict(z.string()).default({}),
  visionMaxFrames: z.number().default(6),
  framesDir: z.string().default(""),
  summaryTemplate: z.string().default(""),
  timeoutMs: z.number().default(300000),
});

/** Bundled default summary template — the replaceable output-format part. */
const BUNDLED_TEMPLATE_URL = new URL("../templates/summary.md", import.meta.url);

const FALLBACK_TEMPLATE_TEXT = "Summarize the video for the user: one-sentence takeaway, key points with timestamps, and shareable closing lines. Do not fabricate anything without evidence.";

/**
 * Load the summary template: the bundled default, or a user-supplied file.
 * A missing/unreadable custom file falls back to the bundled template so the
 * tool keeps working no matter what the user points at.
 */
function loadSummaryTemplate(pathOrEmpty) {
  if (pathOrEmpty) {
    try {
      return readFileSync(resolve(pathOrEmpty), "utf8");
    } catch {
      // fall through to the bundled template
    }
  }
  try {
    return readFileSync(BUNDLED_TEMPLATE_URL, "utf8");
  } catch {
    return FALLBACK_TEMPLATE_TEXT;
  }
}

function clampInteger(value, fallback, min, max) {
  const n = Number(value);
  if (!Number.isInteger(n)) return fallback;
  return Math.min(Math.max(n, min), max);
}

function apply(ctx, config) {
  const resolved = { ...DEFAULT_CONFIG, ...(config ?? {}) };
  const { timeoutMs } = resolved;

  const template = loadSummaryTemplate(resolved.summaryTemplate);
  ctx.systemPrompt.section({
    name: "tool:bilibili_extract",
    order: 160,
    text: "Use the bilibili_extract tool to analyze Bilibili videos. 主路径是**提示词驱动的两段式分析**：不是靠自动抓帧，而是由你读完文稿后自己判断哪些位置必须看画面。\n\n" +
      "【第一段：读文稿 + 内容完整性检查】先调用 bilibili_extract(url, extract_frames: false) 只拿文字（秒级、零下载）。然后逐段检查文稿哪些位置「离开画面就不完整」，重点找五类信息缺失：\n" +
      "① 指代悬空——出现「这个/这样/如图/看这里/就是它/这个效果」等指代，但文稿没有说出它指的具体内容；\n" +
      "② 结论先行——只给了评价（差距很明显/效果好/一目了然），没念出具体数据或依据；\n" +
      "③ 操作无口述——「点这里/选这个/改成这样」但没说界面上的具体选项；\n" +
      "④ 无声演示——相邻语句时间间隔数秒，画面可能承载了全部信息；\n" +
      "⑤ 视觉对比——「对比一下这两款」但差异细节没展开。\n" +
      "对每一处信息缺失，确定需要看画面的时间点（取该句附近的时间戳）；纯口播内容不需要抓帧。\n\n" +
      "【第二段：定向抓帧】在回复末尾用固定格式列出所有需要画面的时刻：[建议抓帧] mm:ss 理由（例：[建议抓帧] 03:20 此处说「如图所示」但文稿无图）。然后直接发起第二轮 bilibili_extract(url, timestamps: [...]) 定向抓帧。\n\n" +
      "抓帧后判断报告里引用哪些图：若帧带 description 与 citation_hint（用户启用视觉功能时），只引用「配图建议=适合」且画面清晰的帧，每段至多 1-2 张；没有需要看的画面就不配图。若你的模型有图像输入能力，也可用 read_image 直接查看帧图。 " +
      "Format the final summary per the template below (user-replaceable via the summaryTemplate config):\n\n" + template +
      "\n\nFor deeper output formats (learning notes, timelines, Q&A cards, etc.), load the bilibili-video-analyzer skill instead.",
  });

  ctx.tools.register(defineTool({
    name: "bilibili_extract",
    description:
      "Extract content from a Bilibili video: metadata, full transcript, hot comments, danmaku, " +
      "and keyframes. Automatic frame moments are picture-driven only — scene-change detection plus " +
      "even-interval backfill; transcript-driven moments are chosen by you via the two-pass workflow with explicit timestamps. The video is downloaded " +
      "locally first for fast, repeatable capture. Use it when the user asks about a Bilibili video " +
      "(bilibili.com/video/BV... URL, b23.tv short link, or a bare BV id). Returns a structured text " +
      "digest plus absolute file paths for captured frame images; inspect a frame with the read_image tool, " +
      "or call again with explicit `timestamps` to zoom into specific moments, and then summarize the " +
      "video for the user. For deep analysis prefer two passes: extract_frames: false first to read the " +
      "transcript and decide which moments need visual confirmation, then a targeted call with timestamps " +
      "for exactly those moments (each requested frame is captioned with its nearby subtitle line).",
    parameters: {
      url: {
        type: "string",
        required: true,
        description: "Bilibili video URL (bilibili.com/video/BV..., b23.tv) or a bare BV id",
      },
      comment_limit: {
        type: "integer",
        description: "Maximum comments to fetch (1-50; defaults to the configured 20)",
      },
      max_frames: {
        type: "integer",
        description: "Maximum keyframes to capture (1-20; defaults to the configured 6)",
      },
      extract_frames: {
        type: "boolean",
        description: "Whether to capture keyframes (default true; set false for text-only extraction)",
      },
      timestamps: {
        type: "array",
        items: { type: "number" },
        description: "Optional explicit capture timestamps in seconds — skips auto-selection; use it to zoom into specific moments after a first pass",
      },
    },
    output: {
      schema: { type: "json" },
      render: (_args, value) => [{ type: "text", text: formatExtraction(value) }],
    },
    timeoutMs,
    async execute(args, exec) {
      const value = await extractAll({
        url: args.url,
        commentLimit: clampInteger(args.comment_limit, resolved.commentLimit, 1, 50),
        maxFrames: clampInteger(args.max_frames, resolved.maxFrames, 1, 20),
        extractFrames: args.extract_frames ?? resolved.extractFrames,
        downloadVideo: resolved.downloadVideo,
        keepVideo: resolved.keepVideo,
        maxVideoMinutes: resolved.maxVideoMinutes,
        maxDownloadMb: resolved.maxDownloadMb,
        quality: resolved.quality,
        timestamps: args.timestamps,
        detectScenes: resolved.detectScenes,
        sceneThreshold: resolved.sceneThreshold,
        sharpFrames: resolved.sharpFrames,
        asrProvider: resolved.asrProvider,
        whisperBin: resolved.whisperBin,
        whisperModel: resolved.whisperModel,
        whisperModelDir: resolved.whisperModelDir,
        whisperLanguage: resolved.whisperLanguage,
        whisperThreads: resolved.whisperThreads,
        sherpaBin: resolved.sherpaBin,
        sherpaModel: resolved.sherpaModel,
        sherpaModelType: resolved.sherpaModelType,
        sherpaTokens: resolved.sherpaTokens,
        sherpaThreads: resolved.sherpaThreads,
        visionProvider: resolved.visionProvider,
        visionBaseUrl: resolved.visionBaseUrl,
        visionModel: resolved.visionModel,
        visionApiKey: resolved.visionApiKey,
        visionPrompt: resolved.visionPrompt,
        visionPromptByModel: resolved.visionPromptByModel,
        visionMaxFrames: resolved.visionMaxFrames,
        framesDir: resolved.framesDir,
        sessdata: resolved.sessdata,
        signal: exec.signal,
      });
      return value;
    },
    presentCall: (args) => ({ card: "generic", title: args.url, kind: "fetch", rawInput: args.url }),
  }));
}

export { Config, apply, inject, name };
export { extractAll } from "./extractor.js";
export { formatExtraction } from "./format.js";
export { selectKeyframeTimestamps, formatTime } from "./keyframes.js";

