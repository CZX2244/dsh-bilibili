/**
 * Subtitle-driven keyframe timestamp selection (pure functions, the core idea):
 * scan transcript segments for visual-hint keywords, take the segment
 * midpoint as the capture time, dedupe near hits, and backfill with an
 * even interval when hits are sparse.
 *
 * @module dsh-bilibili/keyframes
 */

/** 强信号关键词：命中几乎必有视觉价值，优先选帧。 */
export const STRONG_KEYWORDS = [
  '如图', '如图所示', '这张图', '这个图', '这张表', '这个表', '图表', '曲线',
  '对比', '区别', '不同', '变化', '区别在于',
  '展示', '显示', '演示', '表示', '放大', '画面', '镜头', '特写',
  '点击', '选择', '输入', '设置', '配置', '安装', '运行', '终端', '命令行', '代码',
  '界面', '屏幕', '切换到', '打开',
  '注意看', '仔细看', '大家看', '我们来看', '来看一下',
  '重点', '关键', '核心', '值得注意的是',
  'show', 'look', 'see', 'as you can see', 'demonstrate', 'display', 'compare', 'result',
];

/** 弱信号关键词：口语高频、虚警多，仅在强信号不足时补位。 */
export const WEAK_KEYWORDS = [
  '看', '看到', '看一下', '你们看',
  '这里', '这里边', '这边', '这地方', '这个地方',
  '接下来', '然后', '现在',
  '跳到', '进入',
  'here', 'this',
];

/** 全部关键词（强+弱），兼容旧导出。 */
export const VISUAL_HINT_KEYWORDS = [...STRONG_KEYWORDS, ...WEAK_KEYWORDS];

/**
 * 内容缺失（gap）模式：检测的是「缺口」而非「话题」——
 * 这段话离开了画面就不完整。四类：指代悬空 / 结论先行 / 操作无口述 / 视觉对比。
 */
export const GAP_PATTERNS = [
  { pattern: /(这个|这样|这里|这张图|这个效果|就这样|就是它|看这个|看这里)/, weight: 2, type: "指代悬空" },
  { pattern: /(很明显|差距|提升巨大|效果好|一目了然|肉眼可见|高下立判)/, weight: 2, type: "结论先行" },
  { pattern: /(点一下|点这里|选这个|调成这样|拖过来|按这个|改成这样)/, weight: 2, type: "操作无口述" },
  { pattern: /(对比一下|区别在哪|差别|相比)/, weight: 3, type: "视觉对比" },
];

const GAP_LOOKAHEAD_CHARS = 25;
/** 落点标记：指代词后紧跟这些具体内容，说明口述已补全，悬空不成立。 */
const GAP_ANCHOR_RE = /[0-9]|[红蓝绿黑白灰]|按钮|图标|菜单|选项|页面|窗口|图表|代码|文件|目录|位置|数字|颜色|尺寸|比例/;
const SILENT_GAP_SECONDS = 3;

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

const ASCII_KEYWORD_RE = /^[a-z0-9\s]+$/i;

/** 英文关键词按词边界匹配（防止 see 命中 seek），中文关键词保持子串匹配。 */
function keywordMatches(text, keyword) {
  if (ASCII_KEYWORD_RE.test(keyword)) {
    const escaped = keyword.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    return new RegExp("\\b" + escaped + "\\b", "i").test(text);
  }
  return text.includes(keyword);
}

function collectKeywordHits(segments, keywords) {
  const hits = [];
  for (const seg of segments) {
    const text = typeof seg.text === 'string' ? seg.text : '';
    if (!text) continue;
    for (const keyword of keywords) {
      if (keywordMatches(text, keyword)) {
        hits.push({
          time: Math.round(((seg.start + seg.end) / 2) * 10) / 10,
          reason: 'subtitle contains [' + keyword + ']: ' + text.slice(0, 40),
          text,
        });
        break; // one hit per segment
      }
    }
  }
  return hits;
}

/**
 * 检测「内容缺失」候选帧（gap-driven，第一优先级信号）：
 * 1. GAP 模式命中（指代悬空/结论先行/操作无口述/视觉对比）；
 * 2. 指代悬空做「落点检查」——后续文本有具体落点则降权，真悬空提权；
 * 3. 无声演示——相邻字幕间隔 ≥ SILENT_GAP_SECONDS 的空隙中点。
 */
export function detectGapCandidates(segments) {
  const segs = Array.isArray(segments) ? segments : [];
  const candidates = [];
  for (let i = 0; i < segs.length; i++) {
    const seg = segs[i];
    const text = String(seg.text ?? '');
    if (!text) continue;
    for (const gp of GAP_PATTERNS) {
      if (!gp.pattern.test(text)) continue;
      let weight = gp.weight;
      if (gp.type === '指代悬空') {
        let lookahead = '';
        for (let j = i; j < segs.length && lookahead.length < GAP_LOOKAHEAD_CHARS; j++) {
          lookahead += String(segs[j].text ?? '');
        }
        lookahead = lookahead.slice(0, GAP_LOOKAHEAD_CHARS);
        weight += GAP_ANCHOR_RE.test(lookahead) ? -1 : 1; // 有落点降权，真悬空提权
      }
      candidates.push({
        time: Math.round(((seg.start + seg.end) / 2) * 10) / 10,
        reason: 'gap: ' + gp.type + ' (' + text.slice(0, 20) + ')',
        text,
        weight,
      });
      break; // 一段一个 gap 命中
    }
  }
  // 无声演示空隙
  for (let i = 0; i < segs.length - 1; i++) {
    const gap = segs[i + 1].start - segs[i].end;
    if (gap >= SILENT_GAP_SECONDS) {
      candidates.push({
        time: Math.round(((segs[i].end + segs[i + 1].start) / 2) * 10) / 10,
        reason: 'gap: silent demo (' + Math.round(gap) + 's)',
        text: '',
        weight: 3,
      });
    }
  }
  candidates.sort((a, b) => b.weight - a.weight || a.time - b.time);
  return candidates;
}

/**
 * Pick capture timestamps from a transcript, plus optional extra candidates
 * (scene-change peaks, explicit timestamps). Priority order:
 *   1. gap-driven candidates (content-missing moments, by weight)
 *   2. strong keyword hits
 *   3. weak keyword hits (fill-in only)
 *   4. extraCandidates (picture-driven: scene changes)
 *   5. even-interval backfill (fallback)
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

  // 1-3. 内容缺失候选（按权重）→ 强关键词 → 弱关键词（补位），5 秒去重
  const merged = [];
  const ranked = [
    ...detectGapCandidates(segments),
    ...collectKeywordHits(segments, STRONG_KEYWORDS),
    ...collectKeywordHits(segments, WEAK_KEYWORDS),
  ];
  for (const item of ranked) {
    if (merged.length >= cap) break;
    if (nearAny(merged, item.time)) continue;
    merged.push({ time: item.time, reason: item.reason, text: item.text });
  }

  // 4. scene-change peaks (picture-driven) fill in
  const extras = (Array.isArray(extraCandidates) ? extraCandidates : [])
    .map((candidate) => normalizeCandidate(candidate, validDuration))
    .filter((candidate) => candidate !== null);
  extras.sort((a, b) => a.time - b.time);
  for (const item of extras) {
    if (merged.length >= cap) break;
    if (nearAny(merged, item.time)) continue;
    merged.push(item);
  }

  // 5. even-interval backfill
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

