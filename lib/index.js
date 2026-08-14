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
  asrFallback: true,
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
  asrFallback: z.boolean().default(true),
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
    text: "Use the bilibili_extract tool to analyze Bilibili videos. For detailed analysis prefer a two-pass workflow: first call with extract_frames: false to read the transcript cheaply and decide which moments need visual confirmation, then call again with explicit timestamps to capture exactly those frames, inspect them with the read_image tool, and summarize. " +
      "Format the final summary per the template below (user-replaceable via the summaryTemplate config):\n\n" + template +
      "\n\nFor deeper output formats (learning notes, timelines, Q&A cards, etc.), load the bilibili-video-analyzer skill instead.",
  });

  ctx.tools.register(defineTool({
    name: "bilibili_extract",
    description:
      "Extract content from a Bilibili video: metadata, full transcript, hot comments, danmaku, " +
      "and keyframes. Frame moments are picked by a hybrid strategy — scene-change detection on the " +
      "picture, transcript visual-hint words, and even-interval backfill — and the video is downloaded " +
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
        asrFallback: resolved.asrFallback,
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

