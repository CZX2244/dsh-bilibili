/**
 * Subtitle-driven keyframe timestamp selection (pure functions, the core idea):
 * scan transcript segments for visual-hint keywords, take the segment
 * midpoint as the capture time, dedupe near hits, and backfill with an
 * even interval when hits are sparse.
 *
 * @module dsh-bilibili/keyframes
 */

/** Keywords whose presence in a subtitle line suggests visually valuable footage. */
export const VISUAL_HINT_KEYWORDS = [
  '看', '看到', '看一下', '注意看', '仔细看', '大家看', '你们看',
  '如图', '如图所示', '这张图', '这个图', '这张表', '这个表',
  '这里', '这里边', '这边', '这地方', '这个地方',
  '展示', '显示', '演示', '表示', '放大', '画面',
  '接下来', '然后', '现在', '我们来看', '来看一下',
  '切换到', '跳到', '进入', '打开',
  '对比', '区别', '不同', '变化', '区别在于',
  '重点', '关键', '核心', '值得注意的是',
  '点击', '选择', '输入', '设置', '配置', '安装',
  '代码', '终端', '命令行', '运行',
  'show', 'look', 'see', 'here', 'this', 'as you can see',
  'demonstrate', 'display', 'compare', 'result',
];

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
 * Pick capture timestamps from a transcript, plus optional extra candidates
 * (scene-change peaks, explicit timestamps). Priority order:
 *   1. subtitle visual-hint hits   (content-driven)
 *   2. extraCandidates             (picture-driven: scene changes)
 *   3. even-interval backfill      (fallback)
 *
 * @param {Array<{start:number,end:number,text:string}>} segments - subtitle segments
 * @param {number} duration - video duration in seconds
 * @param {number} maxFrames - upper bound on returned timestamps
 * @param {Array<{time:number,reason?:string,text?:string}>} [extraCandidates]
 * @returns {Array<{time:number,reason:string,text:string}>} sorted capture plan
 */
export function selectKeyframeTimestamps(segments, duration, maxFrames, extraCandidates = []) {
  const cap = Number.isInteger(maxFrames) && maxFrames > 0 ? maxFrames : 6;
  const validDuration = Number.isFinite(duration) && duration > 0 ? duration : 0;

  // No transcript: even interval (with extra candidates kept first)
  if (!Array.isArray(segments) || segments.length === 0) {
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
    return out;
  }

  // 1. subtitle segments hitting a visual keyword -> segment midpoint
  const hits = [];
  for (const seg of segments) {
    const text = typeof seg.text === 'string' ? seg.text : '';
    if (!text) continue;
    const lower = text.toLowerCase();
    for (const keyword of VISUAL_HINT_KEYWORDS) {
      if (lower.includes(keyword)) {
        const mid = Math.round(((seg.start + seg.end) / 2) * 10) / 10;
        hits.push({
          time: mid,
          reason: 'subtitle contains [' + keyword + ']: ' + text.slice(0, 40),
          text,
        });
        break; // one hit per segment
      }
    }
  }
  hits.sort((a, b) => a.time - b.time);

  // dedupe subtitle hits
  const merged = [];
  for (const item of hits) {
    if (merged.length === 0 || item.time - merged[merged.length - 1].time > MIN_GAP_SECONDS) {
      merged.push(item);
    }
  }

  // 2. scene-change peaks (picture-driven) fill in
  const extras = (Array.isArray(extraCandidates) ? extraCandidates : [])
    .map((candidate) => normalizeCandidate(candidate, validDuration))
    .filter((candidate) => candidate !== null);
  extras.sort((a, b) => a.time - b.time);
  for (const item of extras) {
    if (merged.length >= cap) break;
    if (nearAny(merged, item.time)) continue;
    merged.push(item);
  }

  // 3. even-interval backfill
  if (merged.length < cap && validDuration > 0) {
    const step = Math.max(Math.floor(validDuration / (cap + 1)), 10);
    for (let i = 1; i <= cap && merged.length < cap; i++) {
      const t = step * i;
      if (t >= validDuration) break;
      if (nearAny(merged, t)) continue;
      merged.push({ time: t, reason: 'even interval', text: '' });
    }
  }

  merged.sort((a, b) => a.time - b.time);
  return merged.slice(0, cap);
}

/** seconds -> 'mm:ss' */
export function formatTime(seconds) {
  const s = Math.max(0, Math.round(Number(seconds) || 0));
  return String(Math.floor(s / 60)) + ':' + String(s % 60).padStart(2, '0');
}

