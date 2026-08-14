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
import { join } from "node:path";
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
    asrFallback = true,
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

  // 无字幕轨 → 必剪 ASR 兜底（B站播放器「实时AI字幕」同款能力，匿名可用）；文稿 24h 缓存，两段式不重复转写
  if (asrFallback && subtitle.text.length === 0 && subtitle.source === "none") {
    const cachedTranscript = await readTranscriptCache(outDir);
    if (cachedTranscript) {
      subtitle = cachedTranscript;
    } else {
      const asr = await guarded(async () => {
        const audioUrl = await getAudioUrl(session, bvid, info.cid, quality);
        if (!audioUrl) throw new Error("no dash audio stream");
        return await transcribeAudio(session, audioUrl, signal);
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

