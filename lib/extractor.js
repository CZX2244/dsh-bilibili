/**
 * Bilibili video extraction: metadata, transcript, comments, danmaku,
 * and subtitle-driven keyframes. One module failure never fails the rest
 * (each channel returns an empty result with a note). HTTP goes through
 * the global fetch with 412 backoff; frames go through the ffmpeg binary.
 *
 * @module dsh-bilibili/extractor
 */

import { spawn } from "node:child_process";
import { mkdir, open, readdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { selectKeyframeTimestamps } from "./keyframes.js";

const API_BASE = "https://api.bilibili.com";
const REFERER = "https://www.bilibili.com/";
const USER_AGENT =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 " +
  "(KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36";
const REQUEST_TIMEOUT_MS = 15000;
const FRAME_TIMEOUT_MS = 20000;
const SCENE_TIMEOUT_MS = 180000;
const SCENE_DETECT_MAX_SECONDS = 1200; // skip the full-decode scene pass beyond 20 minutes
const SCENE_PEAK_MIN_GAP = 5;
const VIDEO_CACHE_TTL_MS = 24 * 3600 * 1000;
const MAX_RETRIES = 2;
const AUDIO_CAP_BYTES = 200 * 1048576; // whisper-local 音频下载上限（DASH 纯音频远小于视频）

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** Combine the caller's abort signal with a per-request timeout. */
function requestSignal(signal, ms) {
  if (signal === undefined || signal === null) return AbortSignal.timeout(ms);
  return AbortSignal.any([signal, AbortSignal.timeout(ms)]);
}

/** Minimal XML entity decode for danmaku text. */
function decodeXml(text) {
  return String(text)
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '\"')
    .replace(/&#39;/g, "'")
    .replace(/&amp;/g, "&")
    .replace(/&#(\d+);/g, (_m, code) => {
      try { return String.fromCodePoint(Number(code)); } catch { return ""; }
    });
}

/** Extract a BV id from a URL or a bare BV id. */
export function parseBvid(url) {
  const text = String(url ?? "").trim();
  const bare = /^(BV[0-9A-Za-z]{10})$/.exec(text);
  if (bare) return bare[1];
  const match = /bilibili\.com\/video\/(BV[0-9A-Za-z]{10})/.exec(text);
  return match ? match[1] : undefined;
}

async function apiGet(session, endpoint, params) {
  const target = new URL(API_BASE + endpoint);
  if (params) {
    for (const [key, value] of Object.entries(params)) {
      if (value !== undefined && value !== null) target.searchParams.set(key, String(value));
    }
  }
  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    let resp;
    try {
      resp = await fetch(target, {
        headers: session.headers,
        signal: requestSignal(session.signal, REQUEST_TIMEOUT_MS),
      });
    } catch (error) {
      if (session.signal?.aborted) throw error; // caller cancelled
      if (attempt < MAX_RETRIES) { await sleep(2 ** (attempt + 1) * 1000); continue; }
      return { code: -1, message: "request failed: " + (error?.message ?? error) };
    }
    if (resp.status === 412 && attempt < MAX_RETRIES) {
      await sleep(2 ** (attempt + 1) * 1000);
      continue;
    }
    if (!resp.ok) return { code: -1, message: "HTTP " + resp.status };
    try { return await resp.json(); } catch {
      return { code: -1, message: "invalid json response" };
    }
  }
  return { code: -1, message: "max retries exceeded" };
}

async function resolveShortLink(session, url) {
  try {
    const resp = await fetch(url, {
      headers: session.headers,
      redirect: "follow",
      signal: requestSignal(session.signal, REQUEST_TIMEOUT_MS),
    });
    const match = /(BV[0-9A-Za-z]{10})/.exec(resp.url);
    return match ? match[1] : undefined;
  } catch {
    return undefined;
  }
}

async function getVideoInfo(session, bvid) {
  const data = await apiGet(session, "/x/web-interface/view", { bvid });
  if (data.code !== 0) throw new Error("video info failed: " + (data.message ?? "unknown"));
  const d = data.data ?? {};
  const stat = d.stat ?? {};
  return {
    title: d.title ?? "",
    description: d.desc ?? "",
    uploader: {
      name: d.owner?.name ?? "",
      mid: d.owner?.mid ?? 0,
      face: d.owner?.face ?? "",
    },
    duration: d.duration ?? 0,
    pubdate: d.pubdate ?? 0,
    cover: d.pic ?? "",
    category: d.tname ?? "",
    pages: Array.isArray(d.pages) ? d.pages.length : 1,
    cid: d.cid ?? 0,
    aid: d.aid ?? 0,
    stats: {
      views: stat.view ?? 0,
      likes: stat.like ?? 0,
      coins: stat.coin ?? 0,
      favorites: stat.favorite ?? 0,
      shares: stat.share ?? 0,
      comments: stat.reply ?? 0,
      danmaku: stat.danmaku ?? 0,
    },
  };
}

const emptySubtitle = (note) => ({ source: "none", text: "", segments: [], total_segments: 0, note });

/** Parse a downloaded Bilibili subtitle JSON body into segments + joined text. */
export function parseSubtitleBody(body) {
  const segments = [];
  const parts = [];
  for (const item of body?.body ?? []) {
    const text = String(item.content ?? "").trim();
    if (!text) continue;
    segments.push({ start: item.from ?? 0, end: item.to ?? 0, text });
    parts.push(text);
  }
  return { segments, text: parts.join("\n") };
}

/** whisper.cpp 三档模型：档位别名 → ggml 模型名（低/中/高 适配不同配置）。 */
const WHISPER_TIERS = {
  low: "small",
  small: "small",
  medium: "medium",
  high: "large-v3",
  large: "large-v3",
  "large-v3": "large-v3",
};

/** Parse whisper.cpp "HH:MM:SS,mmm" / "MM:SS,mmm" into seconds. */
export function parseWhisperTime(text) {
  const s = String(text ?? "").trim();
  const m = /(?:(\d+):)?(\d{1,2}):(\d{1,2})(?:[.,](\d{1,3}))?/.exec(s);
  if (!m) return undefined;
  const hours = m[1] ? Number(m[1]) : 0;
  const total = hours * 3600 + Number(m[2]) * 60 + Number(m[3]) + (m[4] ? Number(m[4]) / 1000 : 0);
  return Number.isFinite(total) ? total : undefined;
}

/** Parse whisper.cpp -oj JSON into {start,end,text} segments (seconds). */
export function parseWhisperJson(json) {
  const transcription = json?.transcription ?? (Array.isArray(json) ? json : []);
  const segments = [];
  for (const item of transcription) {
    const text = String(item?.text ?? item?.timestamps?.text ?? "").trim();
    if (!text) continue;
    let start;
    let end;
    const offFrom = Number(item?.offsets?.from);
    const offTo = Number(item?.offsets?.to);
    if (Number.isFinite(offFrom) && Number.isFinite(offTo)) {
      start = offFrom / 1000;
      end = offTo / 1000;
    } else {
      start = parseWhisperTime(item?.timestamps?.from);
      end = parseWhisperTime(item?.timestamps?.to);
    }
    if (!Number.isFinite(start) || !Number.isFinite(end)) continue;
    segments.push({ start, end, text });
  }
  return segments;
}

/**
 * Resolve the whisper.cpp GGML model path. A tier keyword (small/medium/large-v3,
 * or the low/medium/high aliases) resolves to ggml-<tier>.bin in the model dir;
 * a path (contains a separator) or a *.bin filename is used verbatim.
 */
export function resolveWhisperModel(whisperModel, whisperModelDir, whisperBin) {
  const model = String(whisperModel ?? "").trim();
  if (!model) return undefined;
  if (model.includes("/") || model.includes("\\") || /\.bin$/i.test(model)) return model;
  const tier = WHISPER_TIERS[model.toLowerCase()] ?? model.toLowerCase();
  let dir = String(whisperModelDir ?? "").trim();
  if (!dir) {
    if (whisperBin && (String(whisperBin).includes("/") || String(whisperBin).includes("\\"))) {
      dir = join(dirname(String(whisperBin)), "models");
    } else {
      dir = "models";
    }
  }
  return join(dir, "ggml-" + tier + ".bin");
}

const SHERPA_TS_RE = /^(?:\[)?(\d{1,2}:\d{2}:\d{2}(?:[.,]\d{1,3})?)\s*(?:-->|->|→|-)\s*(\d{1,2}:\d{2}:\d{2}(?:[.,]\d{1,3})?)(?:\])?\s*:?\s*(.*)$/;

/** Parse sherpa-onnx-offline stdout into {start,end,text} segments (seconds). */
export function parseSherpaText(text) {
  const lines = String(text ?? "").split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  const segments = [];
  for (const line of lines) {
    const m = SHERPA_TS_RE.exec(line);
    if (!m) continue;
    const start = parseWhisperTime(m[1]);
    const end = parseWhisperTime(m[2]);
    const segText = (m[3] ?? "").trim();
    if (!Number.isFinite(start) || !Number.isFinite(end) || !segText) continue;
    segments.push({ start, end, text: segText });
  }
  if (segments.length === 0) {
    const joined = lines.join(" ").trim();
    if (joined) segments.push({ start: 0, end: 0, text: joined });
  }
  return segments;
}

/** 视觉模型三档：档位关键词 → Ollama 模型 tag（低/中/高 适配不同配置）。 */
const VISION_TIERS = {
  low: "qwen3-vl:2b",
  small: "qwen3-vl:2b",
  medium: "qwen3-vl:8b",
  high: "qwen3-vl:32b",
  large: "qwen3-vl:32b",
};

/** Resolve the vision model name: tier keyword → recommended Ollama tag; explicit names pass through. */
export function resolveVisionModel(visionModel) {
  const model = String(visionModel ?? "").trim();
  if (!model) return undefined;
  return VISION_TIERS[model.toLowerCase()] ?? model;
}

/** Bundled default prompt teaching the VLM how to describe a frame for gap-filling. */
export const DEFAULT_VISION_PROMPT =
  "你是视频画面分析助手。用中文客观描述这张视频截图，重点提供语音文稿中缺失的视觉信息：" +
  "① 画面主体（人物/场景/产品/界面）；② 可见的文字、数据、图表、代码；" +
  "③ 正在进行的操作、演示或对比；④ 与视频主题相关的关键细节。" +
  "要求 2-3 句话，只描述事实，不评价、不推测画面之外的内容。" +
  "若画面只是主持人口播、无信息量，回复「纯口播画面，无补充信息」。";

/** Build an OpenAI-compatible chat/completions vision request (image as base64 data URL). */
export function buildVisionRequest(imageBytes, opts) {
  const prompt = String(opts?.prompt ?? "").trim() || DEFAULT_VISION_PROMPT;
  const model = resolveVisionModel(opts?.model) ?? "qwen3-vl:8b";
  const headers = { "Content-Type": "application/json" };
  if (opts?.apiKey) headers.Authorization = "Bearer " + opts.apiKey;
  const body = {
    model,
    messages: [
      {
        role: "user",
        content: [
          { type: "text", text: prompt },
          {
            type: "image_url",
            image_url: { url: "data:image/jpeg;base64," + Buffer.from(imageBytes).toString("base64") },
          },
        ],
      },
    ],
    max_tokens: 300,
  };
  return { headers, body };
}

/** Parse an OpenAI-compatible chat/completions response into plain text. */
export function parseChatCompletion(json) {
  const content = json?.choices?.[0]?.message?.content;
  return typeof content === "string" ? content.trim() : "";
}

async function getSubtitle(session, bvid, cid) {
  const data = await apiGet(session, "/x/player/v2", { bvid, cid });
  if (data.code !== 0) return emptySubtitle("subtitle list failed: " + (data.message ?? ""));
  const subtitles = data.data?.subtitle?.subtitles ?? [];
  if (!Array.isArray(subtitles) || subtitles.length === 0) {
    const note = data.data?.need_login_subtitle === true
      ? "video has subtitles but they require login — set SESSDATA in the plugin config"
      : "video has no subtitle track (transcript unavailable)";
    return emptySubtitle(note);
  }
  // prefer Chinese, fall back to the first track
  let chosen = subtitles.find((s) => (s.lan ?? "").includes("zh") && s.subtitle_url);
  if (!chosen) chosen = subtitles.find((s) => s.subtitle_url);
  if (!chosen) return emptySubtitle("subtitle list present but url empty");
  let subUrl = chosen.subtitle_url;
  if (subUrl.startsWith("//")) subUrl = "https:" + subUrl;
  let body;
  try {
    const resp = await fetch(subUrl, {
      headers: session.headers,
      signal: requestSignal(session.signal, REQUEST_TIMEOUT_MS),
    });
    if (!resp.ok) return emptySubtitle("subtitle download HTTP " + resp.status);
    body = await resp.json();
  } catch (error) {
    if (session.signal?.aborted) throw error;
    return emptySubtitle("subtitle download failed: " + (error?.message ?? error));
  }
  const parsed = parseSubtitleBody(body);
  return {
    source: "subtitle",
    language: chosen.lan_name ?? chosen.lan ?? "unknown",
    text: parsed.text,
    segments: parsed.segments,
    total_segments: parsed.segments.length,
    note: "",
  };
}

const BCUT_API_BASE = "https://member.bilibili.com/x/bcut/rubick-interface";
const BCUT_POLL_MS = 5000;
const BCUT_MAX_POLLS = 24;

/** DASH 纯音频流地址（供 ASR 使用），来自 playurl 接口。 */
async function getAudioUrl(session, bvid, cid, quality = 32) {
  const data = await apiGet(session, "/x/player/playurl", {
    bvid, cid, qn: quality, fnval: 16,
  });
  if (data.code !== 0) return undefined;
  const dashAudio = data.data?.dash?.audio;
  if (Array.isArray(dashAudio) && dashAudio.length > 0) {
    return dashAudio[0].baseUrl ?? dashAudio[0].base_url;
  }
  return undefined;
}

async function abortableSleep(ms, signal) {
  await sleep(ms);
  if (signal?.aborted) throw new Error("aborted");
}

/**
 * B站播放器「实时 AI 字幕」同款能力：必剪（Bcut）ASR，URL 直传、匿名可用。
 * 无字幕轨的视频借此获得带时间戳的文稿。best-effort：失败时由调用方降级。
 */
async function transcribeAudio(session, audioUrl, signal) {
  const createResp = await fetch(BCUT_API_BASE + "/task", {
    method: "POST",
    headers: {
      "User-Agent": USER_AGENT,
      "Content-Type": "application/json",
      "Cache-Control": "no-cache",
    },
    body: JSON.stringify({ resource: audioUrl, model_id: "8" }),
    signal: requestSignal(signal, 30000),
  });
  if (!createResp.ok) throw new Error("bcut task create HTTP " + createResp.status);
  const create = await createResp.json();
  if (create.code !== 0) throw new Error("bcut task create failed: " + (create.message ?? create.code));
  const taskId = create.data?.task_id;
  if (!taskId) throw new Error("bcut task create returned no task id");
  for (let attempt = 0; attempt < BCUT_MAX_POLLS; attempt++) {
    if (attempt > 0) await abortableSleep(BCUT_POLL_MS, signal);
    const resResp = await fetch(
      BCUT_API_BASE + "/task/result?model_id=8&task_id=" + taskId,
      { headers: { "User-Agent": USER_AGENT, "Cache-Control": "no-cache" }, signal: requestSignal(signal, 30000) },
    );
    if (!resResp.ok) continue;
    const res = await resResp.json();
    const state = res.data?.state;
    if (state === 3) throw new Error("bcut asr error: " + (res.data?.remark ?? ""));
    if (state === 4) {
      const parsed = JSON.parse(res.data?.result ?? "{}");
      const segments = (parsed.utterances ?? [])
        .map((u) => ({
          start: Math.round(u.start_time) / 1000,
          end: Math.round(u.end_time) / 1000,
          text: String(u.transcript ?? "").trim(),
        }))
        .filter((s) => s.text.length > 0);
      return {
        source: "bcut-asr",
        language: "zh",
        text: segments.map((s) => s.text).join("\n"),
        segments,
        total_segments: segments.length,
        note: "transcribed on demand via Bilibili Bijian ASR (video has no subtitle track; text may contain recognition errors)",
      };
    }
  }
  throw new Error("bcut asr timed out");
}

const emptyComments = (note) => ({ total: 0, fetched: 0, comments: [], note });

async function getComments(session, aid, pageSize) {
  const data = await apiGet(session, "/x/v2/reply", {
    type: 1, oid: aid, pn: 1, ps: pageSize, sort: 1,
  });
  if (data.code !== 0) return emptyComments("comments failed: " + (data.message ?? ""));
  const page = data.data?.page ?? {};
  const replies = data.data?.replies ?? [];
  const comments = [];
  for (const reply of replies) {
    const subReplies = (reply.replies ?? []).map((sub) => ({
      user: sub.member?.uname ?? "",
      content: sub.content?.message ?? "",
      likes: sub.like ?? 0,
    }));
    comments.push({
      user: reply.member?.uname ?? "",
      content: reply.content?.message ?? "",
      likes: reply.like ?? 0,
      ctime: reply.ctime ?? 0,
      replies: subReplies.slice(0, 5),
    });
  }
  return { total: page.count ?? 0, fetched: comments.length, comments, note: "" };
}

const emptyDanmaku = (note) => ({ total: 0, top_messages: [], samples: [], note });

async function getDanmaku(session, cid) {
  let xml;
  try {
    const resp = await fetch("https://comment.bilibili.com/" + cid + ".xml", {
      headers: session.headers,
      signal: requestSignal(session.signal, REQUEST_TIMEOUT_MS),
    });
    if (!resp.ok) return emptyDanmaku("danmaku HTTP " + resp.status);
    xml = await resp.text();
  } catch (error) {
    if (session.signal?.aborted) throw error;
    return emptyDanmaku("danmaku failed: " + (error?.message ?? error));
  }
  const entries = [];
  const pattern = /<d p="([^"]*)">([\s\S]*?)<\/d>/g;
  let match;
  while ((match = pattern.exec(xml)) !== null) {
    const parts = match[1].split(",");
    const time = Number.parseFloat(parts[0]);
    if (!Number.isFinite(time)) continue;
    const text = decodeXml(match[2]).trim();
    if (!text) continue;
    entries.push({ time: Math.round(time * 10) / 10, text });
  }
  entries.sort((a, b) => a.time - b.time);
  const counter = new Map();
  for (const entry of entries) counter.set(entry.text, (counter.get(entry.text) ?? 0) + 1);
  const topMessages = [...counter.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, 30)
    .map(([text, count]) => ({ text, count }));
  return {
    total: entries.length,
    top_messages: topMessages,
    samples: entries.slice(0, 200),
    note: "",
  };
}

async function getStreamUrl(session, bvid, cid, quality = 32) {
  const data = await apiGet(session, "/x/player/playurl", {
    bvid, cid, qn: quality, fnval: 16,
  });
  if (data.code !== 0) return undefined;
  const durl = data.data?.durl;
  if (Array.isArray(durl) && durl.length > 0 && durl[0].url) return durl[0].url;
  const dashVideo = data.data?.dash?.video;
  if (Array.isArray(dashVideo) && dashVideo.length > 0) {
    return dashVideo[0].baseUrl ?? dashVideo[0].base_url;
  }
  return undefined;
}

/** Run ffmpeg with no stdio pipes: exit code and output-file presence are the only signals.
 *  (Pipe-free spawn also works inside confined sandboxes that forbid capturing child output.) */
async function runFfmpeg(args, signal) {
  return new Promise((resolve, reject) => {
    const child = spawn("ffmpeg", args, { stdio: "ignore", windowsHide: true, signal });
    child.on("error", reject);
    child.on("close", (code) => {
      if (code === 0) resolve();
      else reject(new Error(signal?.aborted ? "aborted" : "ffmpeg exited with code " + code));
    });
  });
}

async function fileExists(path) {
  try { await stat(path); return true; } catch { return false; }
}

/** Guess a file extension for a playurl direct link (progressive flv/mp4, hls, fmp4). */
export function guessStreamExt(streamUrl) {
  const text = String(streamUrl);
  if (/\.m3u8(\?|$)/.test(text)) return ".m3u8";
  if (/\.mp4(\?|$)/.test(text)) return ".mp4";
  if (/\.m4s(\?|$)/.test(text)) return ".mp4"; // fmp4: init + media concatenated
  return ".flv";
}

/**
 * Download the direct video stream to a local file with plain HTTP (GET).
 * Bounds: content-length pre-check plus an in-flight byte cap; a caller
 * abort cancels the read and removes the partial file.
 */
async function downloadStream(session, streamUrl, destPath, maxBytes) {
  let resp;
  try {
    resp = await fetch(streamUrl, {
      headers: session.headers,
      signal: requestSignal(session.signal, 600000),
    });
  } catch (error) {
    if (session.signal?.aborted) throw error;
    throw new Error("download request failed: " + (error?.message ?? error));
  }
  if (!resp.ok || !resp.body) throw new Error("download HTTP " + resp.status);
  const declared = Number(resp.headers.get("content-length"));
  if (Number.isFinite(declared) && declared > maxBytes) {
    throw new Error(
      "video too large (" + Math.round(declared / 1048576) + " MB > " +
      Math.round(maxBytes / 1048576) + " MB cap)",
    );
  }
  const handle = await open(destPath, "w");
  let total = 0;
  try {
    const reader = resp.body.getReader();
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > maxBytes) throw new Error("video exceeded " + Math.round(maxBytes / 1048576) + " MB cap");
      await handle.write(Buffer.from(value));
    }
  } catch (error) {
    await handle.close().catch(() => {});
    await rm(destPath, { force: true }).catch(() => {});
    if (session.signal?.aborted) throw error;
    throw new Error("download interrupted: " + (error?.message ?? error));
  }
  await handle.close();
  return total;
}

/** Run ffmpeg with stderr redirected to a FILE (no pipes): parse-friendly everywhere. */
async function runFfmpegStderrToFile(args, stderrFd, signal) {
  return new Promise((resolve, reject) => {
    const child = spawn("ffmpeg", args, {
      stdio: ["ignore", "ignore", stderrFd],
      windowsHide: true,
      signal,
    });
    child.on("error", reject);
    child.on("close", (code) => {
      if (code === 0) resolve();
      else reject(new Error(signal?.aborted ? "aborted" : "ffmpeg exited with code " + code));
    });
  });
}

/** Run a CLI (whisper-cli / sherpa-onnx-offline) with stdout/stderr redirected to files (no pipes): sandbox-friendly. */
async function runCliToFile(bin, label, args, stdoutFd, stderrFd, signal) {
  return new Promise((resolve, reject) => {
    let child;
    try {
      child = spawn(bin, args, {
        stdio: ["ignore", stdoutFd, stderrFd],
        windowsHide: true,
        signal,
      });
    } catch (error) {
      reject(error);
      return;
    }
    child.on("error", (error) => {
      if (error?.code === "ENOENT") reject(new Error(label + " binary not found: " + bin));
      else reject(error);
    });
    child.on("close", (code) => {
      if (code === 0) resolve();
      else reject(new Error(signal?.aborted ? "aborted" : label + " exited with code " + code));
    });
  });
}

/**
 * Local ASR via whisper.cpp: download the DASH audio, convert to 16kHz mono WAV
 * with ffmpeg, run whisper-cli (-oj), and parse the JSON into timestamped
 * segments. The model file must be downloaded by the user — this only wires the
 * interface. Best-effort: failures are caught by the caller and degrade cleanly.
 */
async function transcribeWhisperLocal(session, bvid, cid, quality, outDir, opts, signal) {
  const whisperBin = opts.whisperBin || "whisper-cli";
  const whisperModel = opts.whisperModel || "medium";
  const whisperLanguage = opts.whisperLanguage || "zh";
  const whisperThreads = Number(opts.whisperThreads) || 0;
  const modelPath = resolveWhisperModel(whisperModel, opts.whisperModelDir, whisperBin);
  if (!modelPath) throw new Error("whisper model not configured");

  const audioUrl = await getAudioUrl(session, bvid, cid, quality);
  if (!audioUrl) throw new Error("no dash audio stream");
  await mkdir(outDir, { recursive: true });

  const audioPath = join(outDir, "audio.m4s");
  const wavPath = join(outDir, "audio.wav");
  const jsonPath = join(outDir, "whisper.json");
  const errPath = join(outDir, "whisper.err.log");
  try {
    await downloadStream(session, audioUrl, audioPath, AUDIO_CAP_BYTES);
    await runFfmpeg(
      ["-y", "-i", audioPath, "-ac", "1", "-ar", "16000", "-c:a", "pcm_s16le", wavPath],
      requestSignal(signal, FRAME_TIMEOUT_MS),
    );
    const stdoutFd = await open(jsonPath, "w");
    const stderrFd = await open(errPath, "w");
    const args = ["-m", modelPath, "-l", whisperLanguage, "-oj", "-f", wavPath];
    if (whisperThreads > 0) args.push("-t", String(whisperThreads));
    try {
      await runCliToFile(whisperBin, "whisper-cli", args, stdoutFd, stderrFd, signal);
    } finally {
      await stdoutFd.close().catch(() => {});
      await stderrFd.close().catch(() => {});
    }
    let jsonText = "";
    try { jsonText = await readFile(jsonPath, "utf8"); } catch { /* handled below */ }
    let parsed;
    try {
      parsed = JSON.parse(jsonText);
    } catch {
      let tail = "";
      try { tail = (await readFile(errPath, "utf8")).trim().split("\n").slice(-4).join(" | "); } catch { /* ignore */ }
      throw new Error("whisper-cli produced no valid JSON" + (tail ? ": " + tail : ""));
    }
    const segments = parseWhisperJson(parsed);
    if (segments.length === 0) throw new Error("whisper-cli returned no transcription segments");
    return {
      source: "whisper-local",
      language: whisperLanguage,
      text: segments.map((s) => s.text).join("\n"),
      segments,
      total_segments: segments.length,
      note: "transcribed locally via whisper.cpp (" + whisperModel + "); the model file must be downloaded by the user",
    };
  } finally {
    await rm(audioPath, { force: true }).catch(() => {});
    await rm(wavPath, { force: true }).catch(() => {});
    await rm(jsonPath, { force: true }).catch(() => {});
    await rm(errPath, { force: true }).catch(() => {});
  }
}

/**
 * Local ASR via sherpa-onnx (SenseVoice/Paraformer, Chinese-optimized): download
 * the DASH audio, convert to 16kHz mono WAV, run sherpa-onnx-offline, and parse
 * the stdout transcript. Model + tokens must be downloaded by the user — this
 * only wires the interface. Best-effort; failures degrade cleanly.
 */
async function transcribeSherpaOnnx(session, bvid, cid, quality, outDir, opts, signal) {
  const sherpaBin = String(opts.sherpaBin ?? "").trim();
  const sherpaModel = String(opts.sherpaModel ?? "").trim();
  const sherpaTokens = String(opts.sherpaTokens ?? "").trim();
  const sherpaModelType = String(opts.sherpaModelType ?? "sense-voice").trim();
  const sherpaThreads = Number(opts.sherpaThreads) || 0;
  if (!sherpaBin) throw new Error("sherpa-onnx binary not configured (sherpaBin)");
  if (!sherpaModel) throw new Error("sherpa-onnx model not configured (sherpaModel)");
  if (!sherpaTokens) throw new Error("sherpa-onnx tokens not configured (sherpaTokens)");

  const audioUrl = await getAudioUrl(session, bvid, cid, quality);
  if (!audioUrl) throw new Error("no dash audio stream");
  await mkdir(outDir, { recursive: true });

  const audioPath = join(outDir, "audio.m4s");
  const wavPath = join(outDir, "audio.wav");
  const outPath = join(outDir, "sherpa.out.txt");
  const errPath = join(outDir, "sherpa.err.log");
  try {
    await downloadStream(session, audioUrl, audioPath, AUDIO_CAP_BYTES);
    await runFfmpeg(
      ["-y", "-i", audioPath, "-ac", "1", "-ar", "16000", "-c:a", "pcm_s16le", wavPath],
      requestSignal(signal, FRAME_TIMEOUT_MS),
    );
    const stdoutFd = await open(outPath, "w");
    const stderrFd = await open(errPath, "w");
    const args = [
      "--" + sherpaModelType + "=" + sherpaModel,
      "--tokens=" + sherpaTokens,
      "--wav-filename=" + wavPath,
    ];
    if (sherpaThreads > 0) args.push("--num-threads=" + sherpaThreads);
    try {
      await runCliToFile(sherpaBin, "sherpa-onnx", args, stdoutFd, stderrFd, signal);
    } finally {
      await stdoutFd.close().catch(() => {});
      await stderrFd.close().catch(() => {});
    }
    let outText = "";
    try { outText = await readFile(outPath, "utf8"); } catch { /* handled below */ }
    const segments = parseSherpaText(outText);
    if (segments.length === 0) {
      let tail = "";
      try { tail = (await readFile(errPath, "utf8")).trim().split("\n").slice(-4).join(" | "); } catch { /* ignore */ }
      throw new Error("sherpa-onnx produced no transcript" + (tail ? ": " + tail : ""));
    }
    const hasTimestamps = segments.some((s) => s.end > 0);
    return {
      source: "sherpa-onnx",
      language: "zh",
      text: segments.map((s) => s.text).join("\n"),
      segments,
      total_segments: segments.length,
      note: "transcribed locally via sherpa-onnx (" + sherpaModelType + "); model + tokens must be downloaded by the user" + (hasTimestamps ? "" : " — no per-segment timestamps in output"),
    };
  } finally {
    await rm(audioPath, { force: true }).catch(() => {});
    await rm(wavPath, { force: true }).catch(() => {});
    await rm(outPath, { force: true }).catch(() => {});
    await rm(errPath, { force: true }).catch(() => {});
  }
}

const VISION_TIMEOUT_MS = 60000;

/** Resolve the vision endpoint URL for the given provider. */
export function resolveVisionBaseUrl(provider, baseUrl) {
  const url = String(baseUrl ?? "").trim().replace(/\/+$/, "");
  if (url) return url;
  if (provider === "ollama") return "http://localhost:11434/v1";
  if (provider === "llama-cpp") return "http://localhost:8080/v1";
  return "";
}

/**
 * Describe captured frames with a configured vision model (local Ollama or any
 * OpenAI-compatible endpoint). One request per frame, sequential, bounded by
 * visionMaxFrames; a per-frame failure is recorded and the loop continues.
 * Best-effort: the caller degrades gracefully when this throws.
 */
async function describeFramesWithVision(frames, opts, signal) {
  const baseUrl = resolveVisionBaseUrl(opts.provider, opts.baseUrl);
  if (!baseUrl) throw new Error("vision endpoint not configured (visionBaseUrl)");
  const cap = Math.min(Math.max(Number(opts.maxFrames) || 4, 1), 20);
  const target = (frames ?? []).filter((f) => f.has_image && f.path).slice(0, cap);
  const results = [];
  for (const frame of target) {
    let imageBytes;
    try {
      imageBytes = await readFile(frame.path);
    } catch (error) {
      results.push({ time: frame.time, description: "", vision_error: "frame file unreadable: " + String(error?.message ?? error) });
      continue;
    }
    const { headers, body } = buildVisionRequest(imageBytes, opts);
    try {
      const resp = await fetch(baseUrl + "/chat/completions", {
        method: "POST",
        headers,
        body: JSON.stringify(body),
        signal: requestSignal(signal, VISION_TIMEOUT_MS),
      });
      if (!resp.ok) throw new Error("vision HTTP " + resp.status);
      const json = await resp.json();
      const description = parseChatCompletion(json);
      results.push({
        time: frame.time,
        description,
        vision_error: description ? null : "empty vision response",
      });
    } catch (error) {
      if (signal?.aborted) throw error; // caller cancelled
      results.push({ time: frame.time, description: "", vision_error: String(error?.message ?? error).slice(-160) });
    }
  }
  return results;
}

/**
 * Picture-driven candidate timestamps: decode the local video once with
 * ffmpeg's scene-change filter and collect frame times via showinfo.
 * Best-effort — failures yield no peaks (the caller falls back gracefully).
 */
async function detectScenePeaks(videoPath, outDir, threshold, signal) {
  const logPath = join(outDir, "scene-detect.log");
  const logFd = await open(logPath, "w");
  try {
    await runFfmpegStderrToFile([
      "-hide_banner",
      "-i", videoPath,
      "-vf", "select='gt(scene," + threshold + ")',showinfo",
      "-an",
      "-f", "null", "-",
    ], logFd, requestSignal(signal, SCENE_TIMEOUT_MS));
  } finally {
    await logFd.close().catch(() => {});
  }
  let log = "";
  try { log = await readFile(logPath, "utf8"); } catch { /* keep empty */ }
  await rm(logPath, { force: true }).catch(() => {});
  const peaks = [];
  for (const line of log.split("\n")) {
    const match = /pts_time:([\d.]+)/.exec(line);
    if (!match) continue;
    const time = Number.parseFloat(match[1]);
    if (!Number.isFinite(time)) continue;
    if (peaks.length === 0 || time - peaks[peaks.length - 1].time > SCENE_PEAK_MIN_GAP) {
      peaks.push({ time, reason: "scene change", text: "" });
    }
  }
  return peaks;
}

/** Nearest subtitle line around a time (within +-2s window), for captioning requested frames. */
export function nearestSubtitleText(time, segments) {
  if (!Array.isArray(segments)) return "";
  for (const seg of segments) {
    if (time >= seg.start - 2 && time <= seg.end + 2 && seg.text) return seg.text;
  }
  return "";
}

/** Normalize the tool's optional explicit `timestamps` argument, or null.
 *  Each requested moment is captioned with its nearest subtitle line. */
function normalizeRequestedTimestamps(timestamps, duration, maxFrames, segments) {
  if (!Array.isArray(timestamps) || timestamps.length === 0) return null;
  const list = timestamps
    .map((t) => Number(t))
    .filter((t) => Number.isFinite(t) && t >= 0 && t < Math.max(duration, 1))
    .slice(0, Math.max(1, Math.min(maxFrames, 20)));
  if (list.length === 0) return null;
  return list.map((t) => ({ time: t, reason: "requested timestamp", text: nearestSubtitleText(t, segments) }));
}

/** Transcript cache: avoid re-running ASR across the two-pass workflow (24h TTL). */
async function readTranscriptCache(outDir) {
  try {
    const info = await stat(join(outDir, "transcript.json"));
    if (Date.now() - info.mtimeMs >= VIDEO_CACHE_TTL_MS) return null;
    const parsed = JSON.parse(await readFile(join(outDir, "transcript.json"), "utf8"));
    return parsed && typeof parsed.text === "string" && Array.isArray(parsed.segments) ? parsed : null;
  } catch {
    return null;
  }
}

async function writeTranscriptCache(outDir, transcript) {
  try {
    await mkdir(outDir, { recursive: true });
    await writeFile(join(outDir, "transcript.json"), JSON.stringify(transcript), "utf8");
  } catch { /* best-effort */ }
}

/** Reuse a fresh cached copy of the downloaded video (same BV, same outDir). */
async function findCachedVideo(outDir) {
  let entries = [];
  try { entries = await readdir(outDir); } catch { return null; }
  for (const name of entries) {
    if (!name.startsWith("video")) continue;
    const path = join(outDir, name);
    try {
      const info = await stat(path);
      if (Date.now() - info.mtimeMs < VIDEO_CACHE_TTL_MS) return path;
      await rm(path, { force: true }); // stale cleanup
    } catch { /* ignore */ }
  }
  return null;
}

/** Download the video into outDir unless a fresh cached copy already exists. */
async function ensureVideo(session, streamUrl, outDir, maxBytes) {
  const cached = await findCachedVideo(outDir);
  if (cached) return { path: cached, bytes: 0, reused: true };
  const videoPath = join(outDir, "video" + guessStreamExt(streamUrl));
  const bytes = await downloadStream(session, streamUrl, videoPath, maxBytes);
  return { path: videoPath, bytes, reused: false };
}

/** Extract frames from a LOCAL video file: fast, accurate, repeatable. */
async function extractFramesFromFile(videoPath, timestamps, outDir, signal) {
  const results = [];
  for (let i = 0; i < timestamps.length; i++) {
    const ts = timestamps[i];
    const outPath = join(outDir, "frame_" + String(i + 1).padStart(3, "0") + ".jpg");
    const args = [
      "-y",
      "-ss", String(ts.time),
      "-i", videoPath,
      "-frames:v", "1",
      "-q:v", "2",
      "-an",
      outPath,
    ];
    try {
      await runFfmpeg(args, requestSignal(signal, FRAME_TIMEOUT_MS));
      const ok = await fileExists(outPath);
      results.push({ ...ts, path: ok ? outPath : null, error: ok ? null : "output file missing" });
    } catch (error) {
      if (signal?.aborted) throw error; // caller cancelled
      results.push({ ...ts, path: null, error: "ffmpeg: " + String(error?.message ?? error).slice(-200) });
    }
  }
  return results;
}

async function captureFrames(streamUrl, timestamps, outDir, signal) {
  if (!streamUrl || timestamps.length === 0) {
    return timestamps.map((ts) => ({ ...ts, path: null, error: "no stream url" }));
  }
  const results = [];
  const ffmpegHeaders =
    "Referer: " + REFERER + "\r\n" + "User-Agent: " + USER_AGENT + "\r\n";
  for (let i = 0; i < timestamps.length; i++) {
    const ts = timestamps[i];
    const outPath = join(outDir, "frame_" + String(i + 1).padStart(3, "0") + ".jpg");
    const args = [
      "-y",
      "-headers", ffmpegHeaders,
      "-ss", String(ts.time),
      "-i", streamUrl,
      "-frames:v", "1",
      "-q:v", "2",
      "-an",
      outPath,
    ];
    try {
      await runFfmpeg(args, requestSignal(signal, FRAME_TIMEOUT_MS));
      const ok = await fileExists(outPath);
      results.push({ ...ts, path: ok ? outPath : null, error: ok ? null : "output file missing" });
    } catch (error) {
      if (signal?.aborted) throw error; // caller cancelled
      results.push({ ...ts, path: null, error: "ffmpeg: " + String(error?.message ?? error).slice(-200) });
    }
  }
  return results;
}

async function guarded(task, fallback) {
  try { return await task(); } catch (error) {
    return fallback(String(error?.message ?? error));
  }
}

/**
 * Extract everything for one Bilibili video. Each channel is isolated:
 * a failing channel yields an empty result with a note instead of failing
 * the whole extraction. Returns a lossless-JSON-friendly plain object.
 *
 * @param {{url:string, commentLimit?:number, extractFrames?:boolean,
 *          maxFrames?:number, framesDir?:string, sessdata?:string,
 *          downloadVideo?:boolean, keepVideo?:boolean,
 *          maxVideoMinutes?:number, maxDownloadMb?:number,
 *          quality?:number, timestamps?:number[],
 *          detectScenes?:boolean, sceneThreshold?:number,
 *          asrProvider?:string, whisperBin?:string, whisperModel?:string,
 *          whisperModelDir?:string, whisperLanguage?:string, whisperThreads?:number,
 *          sherpaBin?:string, sherpaModel?:string, sherpaModelType?:string,
 *          sherpaTokens?:string, sherpaThreads?:number,
 *          visionProvider?:string, visionBaseUrl?:string, visionModel?:string,
 *          visionApiKey?:string, visionPrompt?:string, visionMaxFrames?:number,
 *          signal?:AbortSignal}} options
 */
export async function extractAll(options) {
  const started = Date.now();
  const {
    url,
    commentLimit = 20,
    extractFrames = true,
    maxFrames = 6,
    framesDir = "",
    sessdata = "",
    downloadVideo = true,
    keepVideo = false,
    maxVideoMinutes = 30,
    maxDownloadMb = 800,
    quality = 32,
    timestamps,
    detectScenes = true,
    sceneThreshold = 0.4,
    asrProvider,
    asrFallback = true, // 旧字段别名：false 等价于 asrProvider: "none"
    whisperBin = "whisper-cli",
    whisperModel = "medium",
    whisperModelDir = "",
    whisperLanguage = "zh",
    whisperThreads = 0,
    sherpaBin = "",
    sherpaModel = "",
    sherpaModelType = "sense-voice",
    sherpaTokens = "",
    sherpaThreads = 0,
    visionProvider = "none",
    visionBaseUrl = "",
    visionModel = "medium",
    visionApiKey = "",
    visionPrompt = "",
    visionMaxFrames = 4,
    signal,
  } = options ?? {};

  const headers = {
    "User-Agent": USER_AGENT,
    Referer: REFERER,
    Accept: "application/json, text/plain, */*",
  };
  if (sessdata) headers.Cookie = "SESSDATA=" + sessdata;
  const session = { headers, signal };

  let bvid = parseBvid(url);
  if (!bvid && /b23\.tv/.test(String(url))) bvid = await resolveShortLink(session, url);
  if (!bvid) return { success: false, error: "cannot parse a Bilibili video id from the url" };

  let info;
  try {
    info = await getVideoInfo(session, bvid);
  } catch (error) {
    if (session.signal?.aborted) throw error;
    return { success: false, error: String(error?.message ?? error), bvid };
  }

  const baseDir = framesDir || join(tmpdir(), "dsh-bilibili");
  const outDir = join(baseDir, bvid);

  let subtitle;
  let comments;
  let danmaku;
  [subtitle, comments, danmaku] = await Promise.all([
    guarded(() => getSubtitle(session, bvid, info.cid), emptySubtitle),
    guarded(() => getComments(session, info.aid, commentLimit), emptyComments),
    guarded(() => getDanmaku(session, info.cid), emptyDanmaku),
  ]);

  // 无字幕轨 → ASR 兜底：默认必剪（bcut），可切 sherpa-onnx（中文推荐）/whisper-local；auto 依次降级 必剪→sherpa→whisper；文稿 24h 缓存
  const provider = asrProvider ?? (asrFallback === false ? "none" : "bcut");
  if (provider !== "none" && subtitle.text.length === 0 && subtitle.source === "none") {
    const cachedTranscript = await readTranscriptCache(outDir);
    if (cachedTranscript) {
      subtitle = cachedTranscript;
    } else {
      const whisperOpts = { whisperBin, whisperModel, whisperModelDir, whisperLanguage, whisperThreads };
      const sherpaOpts = { sherpaBin, sherpaModel, sherpaModelType, sherpaTokens, sherpaThreads };
      const asr = await guarded(async () => {
        if (provider === "whisper-local") {
          return await transcribeWhisperLocal(session, bvid, info.cid, quality, outDir, whisperOpts, signal);
        }
        if (provider === "sherpa-onnx") {
          return await transcribeSherpaOnnx(session, bvid, info.cid, quality, outDir, sherpaOpts, signal);
        }
        try {
          const audioUrl = await getAudioUrl(session, bvid, info.cid, quality);
          if (!audioUrl) throw new Error("no dash audio stream");
          return await transcribeAudio(session, audioUrl, signal);
        } catch (error) {
          if (provider === "auto") {
            // 中文内容优先 sherpa-onnx，其次 whisper-local；逐级降级并累积失败原因
            const reasons = ["bcut: " + (error?.message ?? error)];
            try {
              return await transcribeSherpaOnnx(session, bvid, info.cid, quality, outDir, sherpaOpts, signal);
            } catch (e2) {
              reasons.push("sherpa-onnx: " + (e2?.message ?? e2));
              try {
                return await transcribeWhisperLocal(session, bvid, info.cid, quality, outDir, whisperOpts, signal);
              } catch (e3) {
                reasons.push("whisper-local: " + (e3?.message ?? e3));
                throw new Error("auto ASR fallback failed → " + reasons.join(" → "));
              }
            }
          }
          throw error;
        }
      }, emptySubtitle);
      if (asr.text) {
        subtitle = asr;
        await writeTranscriptCache(outDir, asr);
      } else if (subtitle.note) {
        subtitle = { ...subtitle, note: subtitle.note + " | ASR fallback failed: " + (asr.note ?? "") };
      }
    }
  }

  const frames = { enabled: false, strategy: "", mode: "none", frames: [], error: null, note: "" };
  if (extractFrames) {
    try {
      const requestedPlan = normalizeRequestedTimestamps(timestamps, info.duration, maxFrames, subtitle.segments);
      const streamUrl = await getStreamUrl(session, bvid, info.cid, quality);
      await mkdir(outDir, { recursive: true });
      const withinDurationCap = info.duration <= maxVideoMinutes * 60;
      let plan;
      let scenePeaks = [];
      let captured;
      if (downloadVideo && withinDurationCap && streamUrl) {
        // 先下载整段视频到本地（缓存复用），再从本地文件抓帧：快、准、可重复
        const { path: videoPath, bytes, reused } = await ensureVideo(session, streamUrl, outDir, maxDownloadMb * 1048576);
        // 字幕命中已够数就跳过场景检测（省一次全片解码）
        const hintPlan = requestedPlan ?? selectKeyframeTimestamps(subtitle.segments, info.duration, maxFrames, []);
        const needScenePass = requestedPlan === null && detectScenes &&
          info.duration <= SCENE_DETECT_MAX_SECONDS && hintPlan.length < maxFrames;
        if (needScenePass) {
          try { scenePeaks = await detectScenePeaks(videoPath, outDir, sceneThreshold, signal); } catch { /* best-effort */ }
        }
        plan = requestedPlan ?? (scenePeaks.length > 0
          ? selectKeyframeTimestamps(subtitle.segments, info.duration, maxFrames, scenePeaks)
          : hintPlan);
        captured = await extractFramesFromFile(videoPath, plan, outDir, signal);
        frames.mode = "local";
        frames.note = reused
          ? "reused cached video, frames extracted from the local file"
          : "downloaded " + Math.round(bytes / 1048576) + " MB video, frames extracted from the local file";
        // 定向抓帧说明模型在迭代分析，保留缓存供后续调用复用（keepVideo=true 则永久保留）
        if (!keepVideo && requestedPlan === null) await rm(videoPath, { force: true });
      } else {
        plan = requestedPlan ?? selectKeyframeTimestamps(subtitle.segments, info.duration, maxFrames, []);
        captured = await captureFrames(streamUrl, plan, outDir, signal);
        frames.mode = "remote";
        if (!streamUrl) frames.note = "no playable stream url";
        else if (!withinDurationCap) frames.note = "video longer than maxVideoMinutes (" + maxVideoMinutes +
          " min) — per-frame remote extraction";
        else frames.note = "video download disabled by config";
      }
      if (plan.length > 0) {
        frames.enabled = true;
        frames.strategy = requestedPlan !== null
          ? "requested timestamps"
          : scenePeaks.length > 0
            ? "hybrid: scene-change peaks + transcript hints + even backfill"
            : "transcript hints + even backfill";
        frames.frames = captured.map((f) => ({
          time: f.time,
          reason: f.reason,
          subtitle_text: f.text,
          has_image: Boolean(f.path),
          path: f.path ?? null,
          error: f.error ?? null,
          description: "",
          vision_error: null,
        }));
      } else {
        frames.enabled = true;
        frames.mode = "none";
        frames.strategy = "no timestamps selected";
      }
    } catch (error) {
      frames.enabled = false;
      frames.error = String(error?.message ?? error);
    }
  }

  // 可选视觉描述：把帧图交给视觉模型（本地 Ollama / OpenAI 兼容云端），画面内容转文字，供无视觉能力的主模型使用
  if (visionProvider !== "none" && frames.enabled && frames.frames.length > 0) {
    const visionOpts = {
      provider: visionProvider,
      baseUrl: visionBaseUrl,
      model: visionModel,
      apiKey: visionApiKey,
      prompt: visionPrompt,
      maxFrames: visionMaxFrames,
    };
    try {
      const described = await describeFramesWithVision(frames.frames, visionOpts, signal);
      let index = 0;
      let okCount = 0;
      for (const frame of frames.frames) {
        if (frame.has_image && frame.path && index < described.length) {
          const d = described[index++];
          frame.description = d.description;
          frame.vision_error = d.vision_error;
          if (d.description) okCount++;
        }
      }
      frames.note = (frames.note ? frames.note + " | " : "") +
        "vision: described " + okCount + "/" + described.length + " frames via " +
        visionProvider + "/" + (resolveVisionModel(visionModel) ?? visionModel);
    } catch (error) {
      if (signal?.aborted) throw error;
      frames.note = (frames.note ? frames.note + " | " : "") +
        "vision: failed — " + String(error?.message ?? error).slice(-140);
    }
  }

  const elapsed = Math.round((Date.now() - started) / 10) / 100;
  return {
    success: true,
    bvid,
    elapsed_seconds: elapsed,
    metadata: {
      title: info.title,
      description: info.description,
      uploader: info.uploader,
      duration: info.duration,
      pubdate: info.pubdate,
      cover: info.cover,
      category: info.category,
      pages: info.pages,
      stats: info.stats,
    },
    transcript: subtitle,
    comments,
    danmaku,
    frames,
  };
}

