/**
 * First-run environment probe for dsh-bilibili ("环境体检").
 *
 * 三层检查，在真正开始提取之前回答三个问题：
 *   1. 本地依赖装了没有（ffmpeg / whisper.cpp / sherpa-onnx / 模型文件 / 视觉服务 / 输出目录）；
 *   2. 配置能不能正常使用（provider 合法性、必填项齐全、路径可解析）；
 *   3. 云端服务可达不可达（B站主 API / 必剪 ASR / 登录服务 / 凭证有效性）。
 *
 * 设计原则：先本地后云端、先便宜后昂贵；探针只做存在性/可达性检查，
 * 绝不提交真实转写任务、不下载任何媒体；结果带 1 小时缓存（config_key
 * 不一致自动失效），排查本身不做无谓的重复工作。检查失败只降级不阻塞。
 *
 * @module dsh-bilibili/envcheck
 */

import { spawn } from "node:child_process";
import { mkdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { resolveVisionBaseUrl, resolveWhisperModel } from "./extractor.js";
import { loadStoredSessdata } from "./login.js";

const PLUGIN_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const CACHE_FILE = join(PLUGIN_ROOT, ".envcheck.json");
const CACHE_TTL_MS = 3600 * 1000; // 体检报告缓存 1 小时
const PROBE_TIMEOUT_MS = 6000;
const API_BASE = "https://api.bilibili.com";
const BCUT_API_BASE = "https://member.bilibili.com/x/bcut/rubick-interface";
const PASSPORT_BASE = "https://passport.bilibili.com";
const USER_AGENT =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 " +
  "(KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36";

/** asrProvider 合法取值（与 README / extractor 保持一致）。 */
export const ASR_PROVIDERS = ["bcut", "sherpa-onnx", "whisper-local", "auto", "none"];

/** Spawn 一个 CLI（stdio 忽略、无管道）：ok=能启动；missing=ENOENT；error=其他启动错误。 */
function spawnCheck(bin, args = ["--help"]) {
  return new Promise((resolve) => {
    let child;
    try {
      child = spawn(bin, args, { stdio: "ignore", windowsHide: true });
    } catch (error) {
      resolve(error?.code === "ENOENT" ? "missing" : "error");
      return;
    }
    child.on("error", (error) => resolve(error?.code === "ENOENT" ? "missing" : "error"));
    child.on("close", () => resolve("ok"));
  });
}

/** 文件存在性检查：ok=存在且是文件；missing=不存在或不是文件。 */
async function fileCheck(path) {
  if (!path) return "missing";
  try {
    const info = await stat(path);
    return info.isFile() ? "ok" : "missing";
  } catch {
    return "missing";
  }
}

/** HTTP 可达性探针：收到任何 HTTP 响应即算可达；网络层失败为不可达。 */
async function httpReach(url, { method = "GET", headers = {}, timeoutMs = PROBE_TIMEOUT_MS } = {}) {
  try {
    const resp = await fetch(url, {
      method,
      headers: { "User-Agent": USER_AGENT, ...headers },
      signal: AbortSignal.timeout(timeoutMs),
    });
    return { ok: true, status: resp.status };
  } catch (error) {
    return { ok: false, error: String(error?.message ?? error).slice(-160) };
  }
}

/** 把检查列表汇总成各状态计数（纯函数，供测试）。 */
export function summarizeChecks(checks) {
  const summary = { ok: 0, info: 0, warn: 0, missing: 0, unreachable: 0, error: 0 };
  for (const check of Array.isArray(checks) ? checks : []) {
    const status = check?.status;
    if (status && Object.prototype.hasOwnProperty.call(summary, status)) summary[status] += 1;
  }
  return summary;
}

/** 体检结果与配置的绑定键：任一相关配置变化即视为缓存失效。 */
function configKey(config = {}) {
  return [
    config.asrProvider ?? "bcut",
    config.visionProvider ?? "none",
    config.whisperBin ?? "",
    config.whisperModel ?? "",
    config.whisperModelDir ?? "",
    config.sherpaBin ?? "",
    config.sherpaModel ?? "",
    config.sherpaModelType ?? "",
    config.sherpaTokens ?? "",
    config.visionBaseUrl ?? "",
    config.framesDir ?? "",
  ].join("|");
}

/**
 * 执行一次完整环境体检（全量、并行、每项独立降级）。
 * @param {object} config 插件已解析配置（与 extractAll 使用的字段一致）
 * @returns {Promise<object>} { checked_at, config_key, summary, checks[] }
 */
export async function probeEnvironment(config = {}) {
  const checks = [];
  const add = (order, id, label, status, detail, hint = "") =>
    checks.push({ order, id, label, status, detail, hint });

  const provider = String(config.asrProvider ?? "bcut");
  const visionOn = String(config.visionProvider ?? "none") !== "none";
  const providerValid = ASR_PROVIDERS.includes(provider);
  const usesWhisper = provider === "whisper-local" || provider === "auto";
  const usesSherpa = provider === "sherpa-onnx" || provider === "auto";
  const unusedDetail = "当前 asrProvider 不使用该引擎，无影响";
  // 本地引擎部件缺失时的状态：固定引擎=missing（硬缺）；auto 模式=warn（该跳会失败但链路仍可走）；不涉及=info
  const engineStatus = (raw, used) => (!used ? "info" : raw === "ok" ? "ok" : provider === "auto" ? "warn" : "missing");

  const whisperBin = String(config.whisperBin ?? "whisper-cli").trim() || "whisper-cli";
  const whisperModelPath = resolveWhisperModel(config.whisperModel, config.whisperModelDir, config.whisperBin);
  const sherpaBin = String(config.sherpaBin ?? "").trim();
  const sherpaModel = String(config.sherpaModel ?? "").trim();
  const sherpaTokens = String(config.sherpaTokens ?? "").trim();

  const tasks = [];

  // —— 第 1 层：本地依赖 ——
  tasks.push(
    spawnCheck("ffmpeg", ["-version"]).then((status) =>
      add(1, "ffmpeg", "FFmpeg（抓帧/转码）", status,
        status === "ok" ? "已安装且可运行" : status === "missing" ? "未找到 ffmpeg 命令（spawn ENOENT）" : "ffmpeg 无法启动",
        status === "ok" ? "" : "安装 FFmpeg 并加入 PATH：https://ffmpeg.org/download.html（Windows 可 winget install Gyan.FFmpeg）；缺失时插件会跳过视频下载与抓帧，避免无谓流量"),
    ),
  );

  const whisperBinIsPath = whisperBin.includes("/") || whisperBin.includes("\\");
  tasks.push(
    (whisperBinIsPath ? fileCheck(whisperBin) : spawnCheck(whisperBin, ["--help"])).then((status) =>
      add(2, "whisper-bin", "whisper-cli 二进制", engineStatus(status, usesWhisper),
        usesWhisper ? (status === "ok" ? "已安装" : "未找到（" + whisperBin + "）") : unusedDetail,
        !usesWhisper || status === "ok" ? "" : "从 https://github.com/ggml-org/whisper.cpp 编译 whisper-cli，或把 whisperBin 配成绝对路径"),
    ),
  );
  tasks.push(
    fileCheck(whisperModelPath).then((status) =>
      add(3, "whisper-model", "whisper 模型文件", engineStatus(status, usesWhisper),
        usesWhisper ? (status === "ok" ? whisperModelPath : "未找到 " + (whisperModelPath ?? "（whisperModel 未配置）")) : unusedDetail,
        !usesWhisper || status === "ok" ? "" : "下载 ggml 模型（如 ggml-medium.bin）到模型目录：https://huggingface.co/ggerganov/whisper.cpp，或配置 whisperModelDir"),
    ),
  );

  const sherpaBinIsPath = sherpaBin.includes("/") || sherpaBin.includes("\\");
  tasks.push(
    (sherpaBin ? (sherpaBinIsPath ? fileCheck(sherpaBin) : spawnCheck(sherpaBin, ["--help"])) : Promise.resolve("missing")).then((status) =>
      add(4, "sherpa-bin", "sherpa-onnx 二进制", engineStatus(status, usesSherpa),
        usesSherpa ? (status === "ok" ? "已安装" : sherpaBin ? "未找到（" + sherpaBin + "）" : "未配置（sherpaBin 为空）") : unusedDetail,
        !usesSherpa || status === "ok" ? "" : "下载 sherpa-onnx-offline（k2-fsa/sherpa-onnx releases），或把 sherpaBin 配成绝对路径"),
    ),
  );
  tasks.push(
    fileCheck(sherpaModel).then((status) =>
      add(5, "sherpa-model", "sherpa-onnx 模型", engineStatus(status, usesSherpa),
        usesSherpa ? (status === "ok" ? sherpaModel : "未找到（" + (sherpaModel || "sherpaModel 未配置") + "）") : unusedDetail,
        !usesSherpa || status === "ok" ? "" : "从 k2-fsa/sherpa-onnx 下载 SenseVoice 模型（sherpa-onnx-sense-voice-zh-en-ja-ko-yue-2024-07-17）"),
    ),
  );
  tasks.push(
    fileCheck(sherpaTokens).then((status) =>
      add(6, "sherpa-tokens", "sherpa-onnx tokens", engineStatus(status, usesSherpa),
        usesSherpa ? (status === "ok" ? sherpaTokens : "未找到（" + (sherpaTokens || "sherpaTokens 未配置") + "）") : unusedDetail,
        !usesSherpa || status === "ok" ? "" : "tokens 文件与模型同包分发（tokens.txt）"),
    ),
  );

  if (!visionOn) {
    add(7, "vision", "视觉模型服务", "info", "未启用（visionProvider=none）");
  } else {
    const baseUrl = resolveVisionBaseUrl(config.visionProvider, config.visionBaseUrl);
    if (!baseUrl) {
      add(7, "vision", "视觉模型服务", "error", "visionBaseUrl 未配置且 provider 无默认地址",
        "配置 visionBaseUrl（如 http://localhost:11434/v1），或改用 ollama / llama-cpp");
    } else {
      tasks.push(
        httpReach(baseUrl + "/models").then((r) =>
          add(7, "vision", "视觉模型服务（" + baseUrl + "）", r.ok ? "ok" : "unreachable",
            r.ok ? "端点可达（HTTP " + r.status + "）" : r.error,
            r.ok ? "" : "启动视觉服务（ollama serve / llama-server）并确认已拉取模型；检查 visionBaseUrl 端口")),
      );
    }
  }

  tasks.push((async () => {
    const baseDir = String(config.framesDir ?? "").trim() || join(tmpdir(), "dsh-bilibili");
    try {
      await mkdir(baseDir, { recursive: true });
      const probePath = join(baseDir, ".envcheck-probe");
      await writeFile(probePath, "ok", "utf8");
      await rm(probePath, { force: true });
      add(8, "outdir", "输出目录可写（" + baseDir + "）", "ok", "读写测试通过");
    } catch (error) {
      add(8, "outdir", "输出目录可写", "error", String(error?.message ?? error).slice(-120),
        "检查 framesDir 配置或临时目录权限；抓帧与缓存需要写权限");
    }
  })());

  // —— 第 2 层：配置可用性（静态） ——
  add(9, "asr-provider", "asrProvider 配置", providerValid ? "ok" : "error",
    providerValid ? provider : "非法取值：" + provider,
    providerValid ? "" : "可选：bcut | sherpa-onnx | whisper-local | auto | none");

  if (usesWhisper) {
    add(10, "whisper-config", "whisper 配置完整性", whisperModelPath ? "ok" : provider === "auto" ? "warn" : "error",
      whisperModelPath ? "模型解析为 " + whisperModelPath : "whisperModel 未配置",
      whisperModelPath ? "" : "设置 whisperModel（档位 low/medium/high 或模型文件路径）");
  } else {
    add(10, "whisper-config", "whisper 配置完整性", "info", unusedDetail);
  }

  if (usesSherpa) {
    const missing = [];
    if (!sherpaBin) missing.push("sherpaBin");
    if (!sherpaModel) missing.push("sherpaModel");
    if (!sherpaTokens) missing.push("sherpaTokens");
    add(11, "sherpa-config", "sherpa 配置完整性", missing.length === 0 ? "ok" : provider === "auto" ? "warn" : "error",
      missing.length === 0 ? "bin/model/tokens 均已配置" : "缺少：" + missing.join(", "),
      missing.length === 0 ? "" : "在插件配置中补齐 sherpaBin / sherpaModel / sherpaTokens");
  } else {
    add(11, "sherpa-config", "sherpa 配置完整性", "info", unusedDetail);
  }

  const visionBase = visionOn ? resolveVisionBaseUrl(config.visionProvider, config.visionBaseUrl) : "";
  if (visionOn && !visionBase) {
    add(12, "vision-config", "视觉服务配置", "error", "visionProvider 已启用但地址不可解析", "配置 visionBaseUrl");
  } else {
    add(12, "vision-config", "视觉服务配置", visionOn ? "ok" : "info",
      visionOn ? "visionBaseUrl 已解析" : "未启用（visionProvider=none）");
  }

  // —— 第 3 层：云端连通性 + 凭证 ——
  const cred = await loadStoredSessdata();
  if (!cred) {
    add(13, "credentials", "登录凭证（SESSDATA）", "info", "未登录",
      "部分字幕需要登录才能获取；需要时调用 bilibili_login 扫码登录");
  } else {
    add(13, "credentials", "登录凭证（SESSDATA）", "ok",
      "存在本地凭证（保存于 " + (cred.saved_at || "未知时间") + "）");
  }

  tasks.push(
    httpReach(API_BASE + "/x/web-interface/nav").then((r) =>
      add(14, "bili-api", "B站主 API 连通性", r.ok ? "ok" : "unreachable",
        r.ok ? "可达（HTTP " + r.status + "）" : r.error,
        r.ok ? "" : "B站 API 不可达时插件整体不可用（本地 ASR 引擎所需的音频流同样来自该站 playurl 接口）；检查网络/代理后重试"),
    ),
  );

  tasks.push(
    httpReach(BCUT_API_BASE, { method: "HEAD" }).then((r) =>
      add(15, "bcut", "必剪 ASR 连通性", r.ok ? "ok" : "unreachable",
        r.ok ? "端点可达（HTTP " + r.status + "，仅探针，未提交任务）" : r.error,
        r.ok ? "" : "无字幕轨视频将无法转写；建议 asrProvider: auto 并安装本地引擎，或稍后重试"),
    ),
  );

  tasks.push(
    httpReach(PASSPORT_BASE + "/").then((r) =>
      add(16, "passport", "登录服务连通性", r.ok ? "ok" : "info",
        r.ok ? "可达" : "不可达：" + r.error,
        r.ok ? "" : "需要扫码登录时会失败；不影响未登录的提取"),
    ),
  );

  if (cred) {
    tasks.push((async () => {
      try {
        const resp = await fetch(API_BASE + "/x/web-interface/nav", {
          headers: {
            "User-Agent": USER_AGENT,
            Referer: "https://www.bilibili.com/",
            Cookie: "SESSDATA=" + cred.sessdata,
          },
          signal: AbortSignal.timeout(PROBE_TIMEOUT_MS),
        });
        const json = await resp.json().catch(() => null);
        if (json?.data?.isLogin === true) {
          add(17, "credential-validity", "登录凭证有效性", "ok", "凭证有效（uid " + (json.data.mid ?? "未知") + "）");
        } else {
          add(17, "credential-validity", "登录凭证有效性", "warn", "凭证无效或已过期（isLogin=false）",
            "重新调用 bilibili_login 扫码登录，或更新配置中的 SESSDATA");
        }
      } catch (error) {
        add(17, "credential-validity", "登录凭证有效性", "unreachable",
          "无法验证（" + String(error?.message ?? error).slice(-120) + "）",
          "B站 API 不可达时无法验证；网络恢复后调用 bilibili_doctor 复查");
      }
    })());
  }

  await Promise.allSettled(tasks);
  checks.sort((a, b) => (a.order ?? 99) - (b.order ?? 99));
  return {
    checked_at: new Date().toISOString(),
    config_key: configKey(config),
    summary: summarizeChecks(checks),
    checks,
  };
}

async function readCache() {
  try {
    const data = JSON.parse(await readFile(CACHE_FILE, "utf8"));
    if (!Array.isArray(data?.checks)) return null;
    return data;
  } catch {
    return null;
  }
}

async function writeCache(report) {
  try {
    await writeFile(CACHE_FILE, JSON.stringify(report), "utf8");
  } catch {
    // 缓存写入 best-effort：失败只意味着下次重新体检
  }
}

/**
 * 取环境体检报告：1 小时内且配置未变化时直接复用缓存，否则全量体检。
 * 首用排查的入口——首次提取、插件加载预热、bilibili_doctor 工具都走这里。
 * @param {object} config 插件已解析配置
 * @param {{force?:boolean}} [opts] force=true 强制重检（忽略缓存）
 */
export async function getEnvReport(config = {}, { force = false } = {}) {
  const cached = await readCache();
  if (
    !force &&
    cached &&
    cached.config_key === configKey(config) &&
    Date.now() - Date.parse(cached.checked_at ?? "") < CACHE_TTL_MS
  ) {
    return cached;
  }
  const report = await probeEnvironment(config);
  await writeCache(report);
  return report;
}
