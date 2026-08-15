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
import { formatExtraction, renderEnvReport } from "./format.js";
import { getEnvReport } from "./envcheck.js";
import {
  startQrLogin,
  pollQrLogin,
  loadStoredSessdata,
  saveManualSessdata,
  clearCredentials,
  credentialStatus,
} from "./login.js";

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

/** Render the bilibili_login tool result as chat text (QR shown as a markdown image). */
function renderLoginResult(value) {
  const v = value ?? {};
  if (v.status === "waiting_scan") {
    return [
      "B站扫码登录：请用手机 B 站 App 扫下面的二维码，并在 App 内点「确认登录」。",
      "",
      "![" + "扫码登录" + "](" + (v.qr_image_url ?? "") + ")",
      "",
      "备选二维码图（若上图加载失败）： " + (v.qr_image_url_alt ?? ""),
      "本地二维码图片（可直接打开）： " + (v.qr_image_path || "未保存"),
      "登录链接： " + (v.login_url ?? ""),
      "qrcode_key: " + (v.qrcode_key ?? ""),
      "",
      "扫码确认后，让我调用 bilibili_login(action=\"poll\", qrcode_key=\"…\") 等待登录结果。",
    ].join("\n");
  }
  if (v.status === "success") {
    return "登录成功 ✅ B站账号 uid " + (v.dedeuserid || "未知") +
      "。SESSDATA 已保存到本地，后续提取自动生效；重新调用 bilibili_extract 即可拿到需要登录的字幕文稿。";
  }
  if (v.status === "timeout") return "扫码等待超时：限定时间内未完成登录。可重新 action=start 生成新二维码再试。";
  if (v.status === "expired") return "二维码已过期：" + (v.message ?? "") + " 请重新 action=start 生成新二维码。";
  if (v.status === "waiting" || v.status === "scanned") return "登录等待中：" + (v.message ?? v.status);
  if (v.status === "error") return "登录操作失败：" + (v.message ?? "未知错误");
  return JSON.stringify(v, null, 2);
}

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

  // 首用排查：后台预热环境体检缓存（不阻塞插件加载；失败静默，结果 1 小时有效）
  void getEnvReport(resolved).catch(() => {});

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
      "【登录】当字幕需要登录、用户要求登录 B 站账号、或提取需要登录态时，调用 bilibili_login 工具：先 action=start 生成二维码，把二维码以 Markdown 图片形式发给用户（渲染失败就给出链接），用户用手机 B 站 App 扫码确认后，再调 action=poll 等待结果；登录成功后 SESSDATA 自动保存，重新调用 bilibili_extract 即可拿到完整文稿。\n\n" +
      "【环境】每次提取结果附带一次环境体检（本地依赖/配置/云端连通性，首次执行并缓存约 1 小时，失败只降级不阻塞）；体检出现 warn/missing/unreachable/error 项时，把对应的「处理建议」转达给用户；安装/更新依赖或改动配置后需要强制重检时，调用 bilibili_doctor(refresh=true)。\n\n" +
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
      let envReport = null;
      try {
        envReport = await getEnvReport(resolved);
      } catch {
        // 体检失败不阻塞提取：门禁关闭，行为与旧版一致
      }
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
        sessdata: resolved.sessdata || ((await loadStoredSessdata())?.sessdata ?? ""),
        envReport,
        signal: exec.signal,
      });
      if (envReport) value.environment = envReport;
      return value;
    },
    presentCall: (args) => ({ card: "generic", title: args.url, kind: "fetch", rawInput: args.url }),
  }));

  ctx.tools.register(defineTool({
    name: "bilibili_login",
    description:
      "Manage the Bilibili login used by bilibili_extract: start a QR-code login (the user scans it with the Bilibili app on their phone), poll until confirmed, check status, logout, or save a manually provided SESSDATA cookie. " +
      "A successful login stores SESSDATA locally so subsequent bilibili_extract calls can fetch login-required subtitles and comments (videos whose subtitle track returns need_login_subtitle). " +
      "Never return the raw SESSDATA value to the user.",
    parameters: {
      action: {
        type: "string",
        required: true,
        description: "start (generate a new QR code) | poll (wait for the scan result; needs qrcode_key) | status (is a credential stored?) | logout (delete the stored credential) | save (store a manually provided SESSDATA)",
      },
      qrcode_key: {
        type: "string",
        description: "QR session key returned by action=start; required for action=poll",
      },
      sessdata: {
        type: "string",
        description: "Manual SESSDATA cookie value (from the browser); only for action=save",
      },
      wait_seconds: {
        type: "integer",
        description: "Maximum wait for action=poll in seconds (5-180; default 90). The QR stays valid ~3 minutes.",
      },
    },
    output: {
      schema: { type: "json" },
      render: (_args, value) => [{ type: "text", text: renderLoginResult(value) }],
    },
    timeoutMs,
    async execute(args, exec) {
      const action = String(args.action ?? "status");
      if (action === "start") {
        try {
          const qr = await startQrLogin();
          return {
            status: "waiting_scan",
            qrcode_key: qr.qrcode_key,
            login_url: qr.login_url,
            qr_image_url: qr.qr_image_url,
            qr_image_url_alt: qr.qr_image_url_alt,
            qr_image_path: qr.qr_image_path,
            message: "请用手机 B 站 App 扫码并确认登录，然后调用 action=poll 等待结果",
          };
        } catch (error) {
          return { status: "error", message: String(error?.message ?? error) };
        }
      }
      if (action === "poll") {
        if (!args.qrcode_key) return { status: "error", message: "poll 需要 qrcode_key（先调用 action=start）" };
        const waitMs = clampInteger(args.wait_seconds, 90, 5, 180) * 1000;
        const deadline = Date.now() + waitMs;
        for (;;) {
          if (exec.signal?.aborted) return { status: "error", message: "登录等待被取消" };
          let result;
          try {
            result = await pollQrLogin(args.qrcode_key);
          } catch (error) {
            result = { status: "retry", message: String(error?.message ?? error) };
          }
          if (result.status === "success") {
            return {
              ...result,
              message: "登录成功，SESSDATA 已保存到本地；重新调用 bilibili_extract 即可获取需要登录的字幕文稿",
            };
          }
          if (result.status === "expired" || result.status === "error") {
            return { ...result, message: (result.message ?? "") + "（可重新 action=start 生成新二维码）" };
          }
          if (Date.now() >= deadline) {
            return { status: "timeout", message: "等待超时，用户未完成登录；可重新 action=start / action=poll" };
          }
          await new Promise((res) => setTimeout(res, 2000));
        }
      }
      if (action === "status") {
        const st = await credentialStatus();
        return { status: "ok", ...st };
      }
      if (action === "logout") {
        const cleared = await clearCredentials();
        return { status: "ok", cleared, message: cleared ? "本地登录凭证已删除" : "没有可删除的本地凭证" };
      }
      if (action === "save") {
        if (!args.sessdata) return { status: "error", message: "action=save 需要 sessdata 参数" };
        try {
          await saveManualSessdata(args.sessdata);
          return { status: "ok", saved: true, message: "已保存手动提供的 SESSDATA；后续提取自动生效（请确保凭证来源可信）" };
        } catch (error) {
          return { status: "error", message: String(error?.message ?? error) };
        }
      }
      return { status: "error", message: "未知 action：" + action };
    },
  }));

  ctx.tools.register(defineTool({
    name: "bilibili_doctor",
    description:
      "Run the dsh-bilibili environment check (环境体检): verifies local binaries (ffmpeg / whisper.cpp / sherpa-onnx), " +
      "model files, vision service endpoint, output directory writability, config validity, stored SESSDATA, and " +
      "reachability of the Bilibili main API, Bijian ASR and the login service. The first extraction runs it automatically " +
      "and caches the report for about an hour; call this tool to re-check on demand or after installing/updating " +
      "dependencies. The report never exposes raw credentials.",
    parameters: {
      refresh: {
        type: "boolean",
        description: "Force a fresh probe instead of returning the cached report (default false)",
      },
    },
    output: {
      schema: { type: "json" },
      render: (_args, value) => [{ type: "text", text: renderEnvReport(value) }],
    },
    timeoutMs,
    async execute(args) {
      const report = await getEnvReport(resolved, { force: args?.refresh === true });
      return report;
    },
    presentCall: (args) => ({
      card: "generic",
      title: "环境体检",
      kind: "execute",
      rawInput: String(args?.refresh === true ? "强制重检" : "读取缓存报告"),
    }),
  }));
}

export { Config, apply, inject, name };
export { extractAll, normalizeRequestedTimestamps } from "./extractor.js";
export { formatExtraction, formatEnvironment, renderEnvReport } from "./format.js";
export { selectKeyframeTimestamps, formatTime } from "./keyframes.js";
export { getEnvReport, probeEnvironment, summarizeChecks, ASR_PROVIDERS } from "./envcheck.js";

