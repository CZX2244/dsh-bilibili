# dsh-bilibili

[**中文**](README.zh.md) | **English**

[![license](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)

A DeepSeek Harness tool plugin that gives agents a `bilibili_extract` tool. Send a Bilibili link and the agent extracts the video's text information (transcript / comments / danmaku), captures keyframes on demand, and produces a summary.

> This plugin bundles no third-party binaries or models; the open-source projects and services it invokes are listed in [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md).

---

## ✨ Features

- **Full text extraction**: metadata, complete timestamped transcript (long transcripts are truncated with a full-text time index), hot comments (with replies), danmaku (top repeated messages + **density-peak timeline samples** — opening spam no longer dominates); **videos without a subtitle track are auto-transcribed** — Bijian ASR by default (the same anonymous capability behind Bilibili's "live AI subtitles", 24h cache), or switch to local engines — **sherpa-onnx (Chinese, SenseVoice)** or **whisper.cpp** — fully offline; one failing source never breaks the rest (each degrades to empty with a note);
- **Optional frame vision descriptions**: vision-less main models can still "see" frames — send each frame to a local **Ollama / llama.cpp** backend (Qwen3-VL 2B/4B/8B tiers) or any OpenAI-compatible vision API for a text description; the report cites images only when needed;
- **Automatic frame selection (picture-driven only)**: scene-change detection (sampled pass beyond 20 minutes) + even-interval backfill, 5s dedupe; **no keyword guessing** — deciding "which transcript moments are incomplete and need visuals" is semantic analysis, left to the main agent's two-pass prompts;
- **Sharp-frame preference**: within ±1.5s of each target time, FFmpeg `blurdetect` scores every frame and the **sharpest one wins** — motion-blurred animation entrances and fade frames are skipped;
- **Two-pass workflow**: the agent reads the transcript first (instant, zero download), then requests frames with explicit `timestamps` — each frame is captioned with its nearby subtitle; the agent reports needed moments in a fixed `[建议抓帧] mm:ss` format; 24h video cache reuse across passes;
- **Replaceable output template**: a concise shareable summary template is bundled; `summaryTemplate` can point to any custom template file;
- **Download-first capture**: the video is downloaded locally before frame extraction (≤30 min / ≤800MB), with automatic fallback to remote per-frame extraction;
- **Robust**: exponential backoff on Bilibili 412 rate limits; login-required subtitles are detected with a SESSDATA hint; ffmpeg runs pipe-free, so it works in any environment.

---

## 🚀 Installation

Prerequisites: Node 18+, `ffmpeg` on PATH, `pnpm`.

```sh
# Option 1: install from GitHub (recommended)
dsh plugin --profile web add git+https://github.com/CZX2244/dsh-bilibili

# Option 2: local directory (development; link mode applies changes instantly)
dsh plugin --profile web add ./dsh-bilibili

# Restart the web profile (dsh web); bilibili_extract becomes available in new sessions
```

After installation the tool joins the agent's toolchain: when the user sends a Bilibili link (`bilibili.com/video/BV...`, a `b23.tv` short link, or a bare BV id), the model can call it for analysis.

---

## 🎨 Custom output templates

The output format is a **replaceable part** of the plugin: the tool provides the data (transcript / frames / danmaku / comments), the template decides what it looks like.

- **Bundled default**: `templates/summary.md` — a concise "time-saver" summary (one-sentence takeaway → timestamped key points → worth-watching segments → shareable closing lines);
- **Bundled alternative**: `templates/timeline.md` — a generic time-axis format (title → hook → timestamped sections with inline points → image anchors → conclusion); add images only when they help, never force them;
- **Switch templates**: set `summaryTemplate: 'C:/path/my-template.md'` in the config;
- **Change the default**: edit `templates/summary.md` directly in the plugin directory;
- An invalid custom path falls back to the bundled template, so the tool never breaks because of a template.

For richer output formats (study notes, review tables, timelines, Q&A cards, etc.), install the companion skill `bilibili-video-analyzer` (an A–K format catalog) and the agent picks by user intent.

---

## 🧠 Recommended workflow (two-pass; prompt-driven is the primary path)

**Frame selection is not keyword guessing** — the main agent uses the analysis prompts injected into the system prompt to read the transcript and decide **which moments are incomplete without the picture**. The built-in "content-completeness check" teaches the agent five gap types — **dangling reference / conclusion without data / unspoken operations / silent demos / visual comparisons** — and asks it to report them explicitly:

```
① bilibili_extract(url, extract_frames: false)      # text only: instant, zero download
② the agent scans the transcript for information gaps and picks the moments that need visuals
③ the agent lists them as [建议抓帧] mm:ss reason, then calls again with timestamps —
   the plugin aligns each moment to the most changed frame within ±4s (FFmpeg scene detection),
   then picks the sharpest frame within ±1.5s (blurdetect): semantic targeting → picture refinement → sharpness gate
④ the agent decides which images to cite in the report using description/citation_hint (or read_image)
```

> Fallback: only a **single call** (no `timestamps`) uses automatic selection — purely picture-driven: scene changes (sampled pass beyond 20 min) + even-interval backfill. That's insurance for "the model skipped the two-pass flow", with no keyword guessing.

---

## 🔧 Configuration

Defaults live in `cordis.patch.yml`; override any field in `$DSH_HOME/profiles/web/cordis.patch.yml` (later layers win per row):

```yaml
- override:
    - id: bilibili
      config:
        sessdata: ''                 # optional Bilibili SESSDATA (logged-in subtitles / more comments)
        commentLimit: 20             # max comments to fetch
        maxFrames: 6                 # max keyframes
        extractFrames: true          # false = text-only mode
        downloadVideo: true          # download video locally before capture (recommended)
        keepVideo: false             # true = keep downloaded video files
        maxVideoMinutes: 30          # videos longer than this are captured remotely per frame
        maxDownloadMb: 800           # download size cap (MB)
        quality: 32                  # 16=360p 32=480p 64=720p 80=1080p
        detectScenes: true           # scene-change detection (sampled pass beyond 20 min)
        sceneThreshold: 0.4          # scene threshold 0-1, higher = stricter
        sharpFrames: true            # sharp-frame preference: blurdetect picks the sharpest frame within ±1.5s
        asrProvider: 'bcut'          # ASR engine: bcut (default) | sherpa-onnx (Chinese) | whisper-local | auto | none
        sherpaBin: ''                # sherpa-onnx-offline binary path
        sherpaModel: ''              # sherpa model onnx path (SenseVoice/Paraformer)
        sherpaModelType: 'sense-voice'  # sense-voice | paraformer | zipformer2-ctc
        sherpaTokens: ''             # sherpa tokens.txt path
        sherpaThreads: 0             # sherpa CPU threads (0 = auto)
        whisperBin: 'whisper-cli'    # whisper.cpp binary (PATH or absolute path)
        whisperModel: 'medium'       # small / medium / large-v3, or a ggml-*.bin path
        whisperModelDir: ''          # model dir; empty = <whisperBin dir>/models
        whisperLanguage: 'zh'        # transcription language
        whisperThreads: 0            # whisper CPU threads (0 = auto)
        visionProvider: 'none'       # frame vision: none (default) | ollama | llama-cpp | openai-compatible
        visionBaseUrl: ''            # vision endpoint; empty + ollama = http://localhost:11434/v1
        visionModel: 'medium'        # low(2B) / medium(4B) / high(8B), or an explicit model name
        visionApiKey: ''             # cloud vision API key (empty for local)
        visionPrompt: ''             # vision prompt (empty = built-in per-model default)
        visionPromptByModel: {}      # per-model prompt overrides (explicit model name / low / medium)
        visionMaxFrames: 6           # max frames to describe (aligned with maxFrames)
        framesDir: ''                # frame output dir; empty = system temp/dsh-bilibili/<bvid>
        summaryTemplate: ''          # template path; empty = bundled templates/summary.md
        timeoutMs: 300000            # overall tool timeout (ms)
```

### Local ASR transcription (optional; sherpa-onnx recommended for Chinese)

No-subtitle videos default to Bijian (zero config, anonymous, China-friendly). To go fully offline or when Bijian fails, switch to a local engine. **The plugin ships no models — only the interface; models and binaries are downloaded by the user** (no API keys, quotas, or fees involved).

#### Recommended: sherpa-onnx (Chinese, SenseVoice)

Bilibili is mostly Chinese content, and SenseVoice beats Whisper on Chinese accuracy while being faster and smaller; official models are hosted on ModelScope (fast in China).

| Tier | Recommended model | Size (approx) | For |
|------|-------------------|---------------|-----|
| Low | SenseVoiceSmall (int8) | ~230 MB | low-end machines |
| Mid | SenseVoiceSmall (fp32) | ~900 MB | mainstream (recommended) |
| High | Paraformer-large | ~2.5 GB | high-end / maximum accuracy |

Steps:

1. Download the `sherpa-onnx-offline` binary for your OS from [sherpa-onnx](https://github.com/k2-fsa/sherpa-onnx);
2. Download a model (`model.onnx` + `tokens.txt`) — SenseVoice models are on [ModelScope](https://modelscope.cn) or the sherpa-onnx model list;
3. Set `asrProvider: 'sherpa-onnx'` and fill `sherpaBin` / `sherpaModel` / `sherpaTokens` (`sherpaModelType` defaults to `sense-voice`).

#### Alternative: whisper.cpp (general / English)

| Tier | whisperModel | Model file | Size | For |
|------|--------------|------------|------|-----|
| Low | `small` | `ggml-small.bin` | ~466 MB | low-end / fast drafts |
| Mid | `medium` | `ggml-medium.bin` | ~1.5 GB | mainstream |
| High | `large-v3` | `ggml-large-v3.bin` | ~3 GB | high-end |

1. Download `whisper-cli` from [whisper.cpp](https://github.com/ggml-org/whisper.cpp);
2. Download the matching `ggml-*.bin` model into a `models/` directory;
3. Set `asrProvider: 'whisper-local'` and fill `whisperBin` / `whisperModel`.

> Note: `asrProvider: 'auto'` falls back in order Bijian → sherpa-onnx → whisper-local. For Chinese, use at least `medium` (whisper) or pick SenseVoice (sherpa) directly. sherpa-onnx CLI flags vary slightly across versions — check `--help` of your build if something errors.

### 🔍 Frame vision descriptions (optional)

When the main model has no vision, enable this feature: each captured frame is sent to a **vision model** and returned with a `description` field, so the main model can decide **which images to cite in the report** — cite only when visual confirmation matters (charts / UIs / demo details); pure talking-head frames are not cited. Off by default; a vision failure never breaks the main flow (frame paths are still returned).

**Local (recommended)**: install [Ollama](https://ollama.com) and pull a model — no keys, offline, free:

| Tier | visionModel | Ollama model | RAM (approx) | For |
|------|-------------|--------------|--------------|-----|
| Low | `low` | `qwen3-vl:2b` | ~2 GB | ultra low-end |
| Mid | `medium` (default) | `qwen3-vl:4b` | ~4 GB | low-end to mainstream (recommended) |
| High | `high` | `qwen3-vl:8b` | ~6-8 GB | mainstream, best quality |

Larger models can be passed as explicit names (e.g. `qwen3-vl:32b`) — they are just no longer a default tier.

Mid-tier alternative **MiniCPM-V 4.0** (OpenBMB, 2026; officially claims to surpass GPT-4.1-mini, runs on phones; official GGUF/int4 releases — check the official library for its Ollama tag). `visionModel` also accepts explicit model names (Ollama tags or cloud model ids).

**Other non-Qwen models (verified on the Ollama library, 2026-08)**: `minicpm-v:8b` (OpenBMB MiniCPM-V 2.6, strong Chinese OCR), `moondream` (1.9B, English-first), `gemma3n` (Google, English-first). **Kimi-VL / InternVL / GLM-4V are not in the official Ollama library** — use community GGUFs via llama.cpp or cloud OpenAI-compatible APIs (e.g. Moonshot / Zhipu). MiniCPM-V 4.0's official GGUF works on the llama-cpp route.

> Selection rationale: this task is **understanding frame content + emitting a citation hint**, not OCR transcription — the weights are on Chinese scene understanding and instruction-following, so the default tiers use the Qwen3-VL family (consistent behavior, shared prompts); MiniCPM-V 4.0 for maximum edge efficiency.

**llama.cpp (local alternative)**: run `llama-server` with a vision GGUF (model + mmproj); it exposes an OpenAI-compatible API, and `visionModel` is simply the `--alias` you set at launch — matching the alias to a tier keyword reuses the tier config directly:

```sh
llama-server -m qwen3-vl-8b-q4_k_m.gguf --mmproj mmproj-qwen3-vl-8b.gguf --port 8080 --alias qwen3-vl:8b
# plugin config: visionProvider: 'llama-cpp' + visionModel: 'medium'
```

The three tiers are Qwen3-VL-first: low Qwen3-VL-2B, mid Qwen3-VL-4B (default), high Qwen3-VL-8B. Verified GGUFs: official `Qwen/Qwen3-VL-4B/8B-Thinking-GGUF` (with mmproj), community `unsloth/Qwen3-VL-4B-Instruct-GGUF`, etc. If your llama.cpp build doesn't support the Qwen3-VL architecture yet, fall back to Qwen2.5-VL-7B-Instruct-GGUF (official on ModelScope). llama.cpp also supports MiniCPM-V (incl. 4.0), InternVL, GLM-4V, LLaVA, gemma3n, moondream2, and more.

**Cloud**: any OpenAI-compatible endpoint via `visionProvider: 'openai-compatible'` + `visionBaseUrl` + `visionModel` + `visionApiKey`. Single-frame description doesn't need flagship multimodal models — budget tiers suffice: GLM-4V-Flash (free quota for Chinese) / GPT-4o-mini / SiliconFlow Qwen-VL.

**Per-model prompts**: every built-in prompt's task is **understanding the frame's content** (what's happening, what's shown) — visible text is paraphrased as key points only, never transcribed. The plugin picks prompts automatically per model (MiniCPM-V family gets a dedicated prompt, moondream2 gets English, small low-tier models get a shorter prompt); override with `visionPrompt` (global) or `visionPromptByModel` (per explicit model name or low/medium tier).

**Citation quality gate**: every vision description must end with a single line 「配图建议：适合/不适合」 (suitable = clear, informative, helps readers understand; unsuitable = talking head, blurry, or uninformative). Frames carry a `citation_hint` field, and reports cite **only suitable frames**, at most 1-2 per section.

**2B measured results** (2026-08, llama.cpp b10428 + Qwen3-VL-2B-Instruct-Q4_K_M, 16-thread CPU, 7 ground-truth test images): 100% citation-tail stability; chart values (120/240/180/300) and poster numbers (32% / 5M / three rounds) matched exactly; talking-head frames correctly marked unsuitable; 4-9s per frame. The low-tier short prompt was tuned from these live runs (anti-hallucination + citation criteria).

> Note: describing several frames on a CPU takes tens of seconds to minutes (faster on GPU); `visionMaxFrames` caps the count.

---

## 📁 Project structure

```
dsh-bilibili/
├── lib/
│   ├── index.js        # Cordis plugin entry: tool registration + system prompt + config schema
│   ├── extractor.js    # extraction layer: Bilibili API + downloads + scene detection + ffmpeg capture
│   ├── keyframes.js    # pure functions: automatic frame selection (picture-driven), time formatting
│   └── format.js       # pure functions: extraction result → model-facing text digest
├── templates/summary.md  # bundled default output template (replaceable)
├── test/                 # unit tests (node --test)
├── cordis.patch.yml      # bundle patch layer (recognized by the plugin system)
└── package.json          # dsh.bundle.patch declaration + peer dependencies
```

---

## 🔌 Plugin standard

This plugin follows the DeepSeek Harness plugin standard: the npm package declares `dsh.bundle.patch` → `dsh plugin add` reconciles it into `dsh.profile.bundles` → the Cordis loader mounts it after a profile restart. See the [deepseek-harness repo](https://github.com/deepseek-ai/deepseek-harness) for the standard.

---

## 🛠️ Local development (link mode)

`dsh plugin add` installs local directories via `link:` (changes take effect immediately). Because ESM resolves dependencies by real path, the plugin directory needs a junction pointing at the profile's node_modules:

```powershell
New-Item -ItemType Junction -Path ".\node_modules\@deepseek-ai" `
  -Target "$env:USERPROFILE\.dsh\profiles\node_modules\@deepseek-ai"
```

Restart the web profile after changes.

---

## ⚠️ Limitations

- Multi-part videos: only part 1 is handled for now;
- Videos without subtitles are transcribed via Bijian ASR by default (local sherpa-onnx / whisper.cpp available); transcripts may contain recognition errors and are labeled as such in the result;
- Bijian ASR is an anonymous endpoint and may rate-limit rapid repeated calls (returns errors); for frequent/stable transcription prefer `asrProvider: 'auto'` or a local sherpa-onnx setup;
- Frame images are not auto-cleaned (so the model can read_image anytime) — that costs disk space;
- Node's fetch doesn't read system proxy env vars; proxied networks are pending support;
- Scene detection switches to a sampled pass beyond 20 minutes (full decode cost).

---

## 📄 License

[MIT](LICENSE)
