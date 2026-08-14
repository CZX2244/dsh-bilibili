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
    out.push(capText(transcript.text, TRANSCRIPT_CAP));
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
    const samples = (danmaku.samples ?? []).slice(0, DANMAKU_SAMPLE_CAP);
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
        if (frame.description) line += "\n    vision: " + capText(frame.description, 300);
        else if (frame.vision_error) line += "\n    vision error: " + frame.vision_error;
        out.push(line);
      }
      out.push("Use the read_image tool with a frame path above to inspect that frame if your model supports image input; otherwise rely on the vision descriptions.");
    }
  }

  out.push("");
  out.push("Extraction took " + (value.elapsed_seconds ?? 0) + "s. Summarize the video from the transcript above; consult frames for visual details.");
  return out.join("\n");
}

