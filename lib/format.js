/**
 * Model-facing formatting of one extraction value. Bounded: the model gets
 * a readable digest (transcript capped, top comments/danmaku only) plus
 * absolute paths for every captured frame so it can read_image on demand.
 *
 * @module dsh-bilibili/format
 */

import { formatTime } from "./keyframes.js";

const TRANSCRIPT_CAP = 8000;
const COMMENT_CAP = 10;
const DANMAKU_MESSAGE_CAP = 10;
const DANMAKU_SAMPLE_CAP = 30;

function capText(text, cap) {
  if (text.length <= cap) return text;
  return text.slice(0, cap) + "\n[... truncated " + (text.length - cap) + " chars]";
}

/**
 * 文稿截断保骨架：超出上限时保留前部完整正文 + 全文时间索引
 * （每 chunkSeconds 取该桶首句），让模型对长视频仍有全局认知，
 * 能指出「19:00 附近需要看画面」这类后部时刻。
 */
export function capTranscriptSmart(segments, text, cap = TRANSCRIPT_CAP, chunkSeconds = 300) {
  const body = String(text ?? "");
  if (body.length <= cap) return body;
  const segs = Array.isArray(segments) ? segments : [];
  const headLen = Math.floor(cap * 0.4);
  const head = body.slice(0, headLen);
  const lines = [];
  let bucket = -1;
  for (const seg of segs) {
    const b = Math.floor((Number(seg.start) || 0) / chunkSeconds);
    if (b <= bucket) continue;
    bucket = b;
    const snippet = String(seg.text ?? "").trim().slice(0, 60);
    if (snippet) lines.push("[" + formatTime(seg.start) + "] " + snippet);
    if (lines.length >= 60) break;
  }
  return head +
    "\n\n[... truncated " + (body.length - cap) + " chars]" +
    "\n[全文时间索引（每" + (chunkSeconds / 60) + "分钟首句，用于定位后部时刻）]\n" +
    lines.join("\n");
}

/**
 * 弹幕密度峰采样：按时间窗口统计密度，取最密集的 topWindows 个窗口
 * 内的弹幕（片头「来了/第一」不再霸榜），上限 cap 条，保持时间顺序。
 */
export function pickDanmakuPeaks(samples, windowSec = 60, topWindows = 4, cap = 30) {
  const list = Array.isArray(samples) ? samples : [];
  if (list.length === 0) return [];
  const windows = new Map();
  let maxIdx = 0;
  for (const s of list) {
    const idx = Math.floor((Number(s.time) || 0) / windowSec);
    if (idx > maxIdx) maxIdx = idx;
    const arr = windows.get(idx) ?? [];
    arr.push(s);
    windows.set(idx, arr);
  }
  const top = new Set(
    [...windows.entries()]
      .sort((a, b) => b[1].length - a[1].length)
      .slice(0, topWindows)
      .map(([idx]) => idx),
  );
  const perWindow = Math.max(1, Math.floor(cap / topWindows));
  const out = [];
  // 第一遍：每个峰值窗口保底 perWindow 条（保证峰值窗口都有代表，片头不霸榜）
  for (let i = 0; i <= maxIdx; i++) {
    if (!top.has(i)) continue;
    const arr = windows.get(i) ?? [];
    for (let k = 0; k < arr.length && k < perWindow && out.length < cap; k++) out.push(arr[k]);
  }
  // 第二遍：按时间顺序用最密集窗口补满剩余额度
  for (let i = 0; i <= maxIdx && out.length < cap; i++) {
    if (!top.has(i)) continue;
    const arr = windows.get(i) ?? [];
    for (let k = perWindow; k < arr.length && out.length < cap; k++) out.push(arr[k]);
  }
  return out;
}

export function formatExtraction(value) {
  if (!value || value.success !== true) {
    return "[bilibili_extract] extraction failed: " + String(value?.error ?? "unknown error");
  }

  const out = [];
  const meta = value.metadata ?? {};
  const stats = meta.stats ?? {};

  out.push("=== Bilibili video content extraction ===");
  out.push("Title: " + meta.title);
  out.push("Uploader: " + (meta.uploader?.name ?? "unknown"));
  out.push("Duration: " + formatTime(meta.duration) + " | Category: " + (meta.category || "unknown"));
  out.push("BV: " + value.bvid + " | Pages: " + (meta.pages ?? 1));
  out.push("Stats: views " + (stats.views ?? 0) + " | likes " + (stats.likes ?? 0) +
    " | coins " + (stats.coins ?? 0) + " | favorites " + (stats.favorites ?? 0) +
    " | comments " + (stats.comments ?? 0) + " | danmaku " + (stats.danmaku ?? 0));
  if (meta.description && meta.description !== "-") out.push("Description: " + capText(meta.description, 500));

  const transcript = value.transcript ?? {};
  out.push("");
  out.push("--- Transcript ---");
  if (transcript.text) {
    out.push("source: " + transcript.source + " | language: " + (transcript.language ?? "unknown") +
      " | segments: " + (transcript.total_segments ?? 0));
    out.push("");
    out.push(capTranscriptSmart(transcript.segments, transcript.text, TRANSCRIPT_CAP));
  } else {
    out.push("No transcript available. " + (transcript.note ?? ""));
  }

  const danmaku = value.danmaku ?? {};
  if ((danmaku.total ?? 0) > 0) {
    out.push("");
    out.push("--- Danmaku (total " + danmaku.total + ") ---");
    const top = (danmaku.top_messages ?? []).slice(0, DANMAKU_MESSAGE_CAP);
    if (top.length > 0) {
      out.push("Top repeated messages:");
      for (const item of top) out.push("  [" + item.text + "] x" + item.count);
    }
    const samples = pickDanmakuPeaks(danmaku.samples ?? [], 60, 4, DANMAKU_SAMPLE_CAP);
    if (samples.length > 0) {
      out.push("Timeline samples:");
      for (const sample of samples) out.push("  " + formatTime(sample.time) + " " + sample.text);
    }
  }

  const comments = value.comments ?? {};
  if ((comments.fetched ?? 0) > 0) {
    out.push("");
    out.push("--- Hot comments (total " + (comments.total ?? 0) + ", showing " + comments.fetched + ") ---");
    for (const comment of (comments.comments ?? []).slice(0, COMMENT_CAP)) {
      out.push("  [" + comment.user + "] " + comment.content + " (likes " + comment.likes + ")");
      for (const reply of (comment.replies ?? []).slice(0, 2)) {
        out.push("    - [" + reply.user + "] " + reply.content + " (likes " + reply.likes + ")");
      }
    }
  }

  const frames = value.frames ?? {};
  if (frames.enabled) {
    out.push("");
    out.push("--- Keyframes (" + (frames.strategy ?? "") + ") ---");
    if (frames.mode) out.push("capture mode: " + frames.mode + (frames.note ? " — " + frames.note : ""));
    const list = frames.frames ?? [];
    if (list.length === 0) {
      out.push("No frames captured." + (frames.error ? " Error: " + frames.error : ""));
    } else {
      for (const frame of list) {
        let line = "  frame " + formatTime(frame.time) + " | reason: " + frame.reason;
        if (frame.subtitle_text) line += " | subtitle: " + capText(frame.subtitle_text, 60);
        if (frame.has_image) line += " | image: " + frame.path;
        else line += " | no image" + (frame.error ? " (" + frame.error + ")" : "");
        if (frame.requested_time !== null && frame.requested_time !== undefined &&
          Math.abs(frame.time - frame.requested_time) >= 0.5) {
          line += " | 原始请求 " + formatTime(frame.requested_time);
        }
        if (frame.description) line += "\n    vision: " + capText(frame.description, 300);
        else if (frame.vision_error) line += "\n    vision error: " + frame.vision_error;
        if (frame.citation_hint) line += " | 配图建议: " + (frame.citation_hint === "suitable" ? "适合" : "不适合");
        out.push(line);
      }
      out.push("In your report, cite only frames marked 配图建议=适合 (clear and informative); skip pure talking-head or blurry frames, at most 1-2 images per section. Use the read_image tool with a frame path if your model supports image input; otherwise rely on the vision descriptions.");
    }
  }

  out.push("");
  out.push("Extraction took " + (value.elapsed_seconds ?? 0) + "s. Summarize the video from the transcript above; consult frames for visual details.");
  return out.join("\n");
}

