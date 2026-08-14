/**
 * Automatic keyframe timestamp selection (pure functions): picture-driven only.
 *
 * 设计原则：文稿驱动的选帧**不做关键词猜测**——结合上下文判断「文稿哪里不完整、
 * 必须看画面」是语义分析，属于主 Agent 的两段式工作流（系统提示内置分析提示词，
 * Agent 以 timestamps 定向抓帧）。本模块只提供单次调用的自动兜底：
 *   1. extraCandidates（场景切换峰值，画面信号）
 *   2. 均匀间隔补齐
 * 5 秒去重。
 *
 * @module dsh-bilibili/keyframes
 */

const MIN_GAP_SECONDS = 5;

function normalizeCandidate(candidate, duration) {
  const time = Number(candidate?.time);
  if (!Number.isFinite(time) || time < 0 || time >= Math.max(duration, 1)) return null;
  return { time, reason: candidate?.reason ?? 'candidate', text: candidate?.text ?? '' };
}

function nearAny(list, time) {
  return list.some((item) => Math.abs(item.time - time) <= MIN_GAP_SECONDS);
}

function pushUnique(list, item, duration, cap) {
  const candidate = normalizeCandidate(item, duration);
  if (!candidate || list.length >= cap) return false;
  if (nearAny(list, candidate.time)) return false;
  list.push(candidate);
  return true;
}

/**
 * Automatic capture plan for single-call usage (picture-driven only):
 * extra candidates first, then even-interval backfill.
 *
 * @param {Array<{start:number,end:number,text:string}>} segments - kept for API compatibility;
 *   automatic selection deliberately does not scan transcript text (semantic analysis is the agent's job).
 * @param {number} duration - video duration in seconds
 * @param {number} maxFrames - upper bound on returned timestamps
 * @param {Array<{time:number,reason?:string,text?:string}>} [extraCandidates] - scene-change peaks etc.
 * @returns {Array<{time:number,reason:string,text:string}>} sorted capture plan
 */
export function selectKeyframeTimestamps(segments, duration, maxFrames, extraCandidates = []) {
  void segments;
  const cap = Number.isInteger(maxFrames) && maxFrames > 0 ? maxFrames : 6;
  const validDuration = Number.isFinite(duration) && duration > 0 ? duration : 0;

  const out = [];
  for (const candidate of Array.isArray(extraCandidates) ? extraCandidates : []) {
    pushUnique(out, candidate, validDuration, cap);
  }
  if (validDuration > 0 && out.length < cap) {
    const step = Math.max(Math.floor(validDuration / (cap + 1)), 10);
    for (let i = 1; i <= cap && out.length < cap; i++) {
      const t = step * i;
      if (t >= validDuration) break;
      pushUnique(out, { time: t, reason: 'even interval', text: '' }, validDuration, cap);
    }
  }
  out.sort((a, b) => a.time - b.time);
  return out.slice(0, cap);
}

/** seconds -> 'mm:ss' */
export function formatTime(seconds) {
  const s = Math.max(0, Math.round(Number(seconds) || 0));
  return String(Math.floor(s / 60)) + ':' + String(s % 60).padStart(2, '0');
}
