# dsh-bilibili

[**English**](README.md) | **中文**

[![license](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)

DeepSeek Harness 工具插件：给 Agent 添加 `bilibili_extract` 工具。发一个 B 站链接，Agent 自动提取视频文字信息（文稿/评论/弹幕）并按需抓取关键帧，完成总结分析。

> 本插件不打包任何第三方二进制或模型；所调用的开源项目与服务见 [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md)。

---

## ✨ 特性

- **文字信息全量提取**：元数据、完整字幕文稿（带时间戳，长文稿截断保留全文时间索引）、热门评论（含楼中楼）、弹幕（高频 + **密度峰时间线样本**，片头弹幕不霸榜）；**无字幕轨的视频默认用必剪 ASR 转写**（B站播放器「实时AI字幕」同款能力，匿名可用，24h 缓存），也可切换到本地引擎——**sherpa-onnx（中文推荐，SenseVoice）** 或 **whisper.cpp**（通用），离线可用、适配不同配置；单个信息源失败不影响整体（各自降级为空并带 note）；
- **可选帧图视觉描述**：无视觉能力的主模型也能「看到」画面——帧图可交给本地 **Ollama / llama.cpp**（Qwen3-VL 2B/4B/8B 三档）或任意 OpenAI 兼容视觉接口转成文字描述，报告按需引用配图；
- **自动选帧（纯画面信号）**：场景切换检测（>20 分钟自动切抽样式）+ 均匀间隔兜底，5 秒去重；**不做关键词猜测**——判断「文稿哪里不完整、必须看画面」是语义分析，交给主 Agent 的两段式提示词完成；
- **清晰帧优选**：抓帧时在目标时间点 ±1.5s 内用 FFmpeg `blurdetect` 逐帧测模糊度，**自动选最清晰的那一帧**——动画入场、运动模糊、淡入淡出的糊帧会被跳过；
- **两段式工作流**：模型先读文稿（秒级、零下载），再带 `timestamps` 定向抓帧——每帧自动配附近字幕，视频 24h 缓存复用，多轮迭代不重复下载；模型以「`[建议抓帧] mm:ss`」固定格式显式回报需要画面的时刻；
- **输出模板可替换**：内置简洁总结模板（省时 + 可转发），`summaryTemplate` 配置可指向任意自定义模板文件；
- **下载优先抓帧**：视频先下载到本地再从本地文件抓帧（≤30 分钟 / ≤800MB），失败或超限自动回退远程逐帧；
- **健壮**：B 站 412 限流指数退避重试；无字幕自动识别「需登录」并提示配置 SESSDATA；ffmpeg 无管道调用，任何环境可跑。

---

## 🚀 安装

前置：Node 18+、`ffmpeg` 在 PATH 中、`pnpm`。

```sh
# 方式一：从 GitHub 安装（推荐）
dsh plugin --profile web add git+https://github.com/CZX2244/dsh-bilibili

# 方式二：本地目录（开发用，link 模式改代码即生效）
dsh plugin --profile web add ./dsh-bilibili

# 重启 web profile（dsh web），新会话中即可使用 bilibili_extract 工具
```

安装后工具自动进入 Agent 的工具链：用户在对话里发 B 站链接（`bilibili.com/video/BV...`、`b23.tv` 短链或裸 BV 号），模型即可调用它分析。插件同时注册 `bilibili_login` 工具（B站扫码登录）和 `bilibili_doctor` 工具（环境体检，见下）。

---

## 🩺 环境体检（首用自动排查）

首次提取前，插件会自动做一次**三层环境排查**，报告缓存约 1 小时（相关配置变化自动失效）；缺什么才提示装什么，避免重复安装、二次下载与白付流量：

| 层 | 检查项 | 出问题时的行为 |
|---|---|---|
| 本地依赖 | ffmpeg / whisper-cli / sherpa-onnx 二进制、模型与 tokens 文件、视觉服务端点、输出目录可写 | **ffmpeg 缺失 → 直接跳过视频下载与抓帧**（不再先下 800MB 再报 spawn 错误）；本地 ASR 未就绪 → **下载音频之前**跳过，不再白付下载/转码 |
| 配置 | `asrProvider` 合法性、sherpa/whisper 必填项齐全性、visionBaseUrl 解析 | 非法/缺项标 `error`/`warn`，并给出补齐建议 |
| 云端 | B站主 API、必剪 ASR、登录服务连通性；SESSDATA 有效性（nav `isLogin` 实测，而非只看文件存在） | 不可达/失效标 `unreachable`/`warn`；B站主 API 不可达时明确提示「插件整体不可用」（本地引擎的音频流同样来自 playurl 接口） |

- 体检结果附在每次提取结果里（`Environment check` 段），有问题时 Agent 会把**处理建议**转达给用户；全部通过时一行带过；
- `bilibili_doctor` 工具可随时手动复查，`refresh=true` 强制重检（安装/更新依赖或改配置后使用）；
- 探针只做存在性/可达性检查：**不提交真实转写任务、不下载任何媒体**，单项失败只降级不阻塞提取；
- 体检报告不含任何原始凭证（SESSDATA 只显示有效性）。

---

## 🔑 扫码登录（拿到需要登录的字幕文稿）

部分视频的 AI 字幕轨需要登录才能读取（匿名请求返回 `need_login_subtitle`），登录后 `bilibili_extract` 能直接拿到**完整官方文稿**。三种方式：

1. **聊天内扫码（推荐）**：对 AI 说「登录 B 站」，Agent 调用 `bilibili_login(action=start)` 生成二维码（聊天内直接显示，也可打开返回的本地图片 / 链接），用手机 B 站 App 扫码并点确认，再调 `action=poll` 等待结果。成功后 SESSDATA 自动保存到插件目录 `.sessdata.json`，**后续提取自动生效，无需重启**。
2. **手动保存 Cookie**：浏览器开发者工具复制 `SESSDATA` 值，让 AI 调用 `bilibili_login(action=save, sessdata='...')`，或直接填到配置 `sessdata`（需重启 profile）。
3. **退出登录**：`bilibili_login(action=logout)` 删除本地凭证；`action=status` 查看当前登录状态（SESSDATA 已脱敏显示）。

> 安全提示：凭证以明文保存在插件目录 `.sessdata.json`（已加入 .gitignore）。SESSDATA 等同于账号登录态，请勿把该文件发给他人；不要直接在对话里粘贴完整 Cookie（工具输出与状态查询均只显示脱敏值）。

---

## 🎨 自定义输出模板

输出格式是插件的**可替换零件**：数据（文稿/帧/弹幕/评论）由工具提供，长什么样由模板决定。

- **内置默认**：`templates/summary.md` —— 简洁的「省时间」总结（一句话总结 → 带时间戳要点 → 值得看的片段 → 可转发的分享语）；
- **内置备选**：`templates/timeline.md` —— 通用时间轴式（主标题 → 开场钩子 → 时间轴分段小标题 + 内嵌时间戳要点 → 配图锚点 → 结尾结论），配图能配就配、配不了不强凑；
- **换模板**：在配置里设 `summaryTemplate: 'C:/path/我的模板.md'`，指向你自己的模板文件；
- **改默认**：直接编辑插件目录里的 `templates/summary.md`；
- **无效路径自动回退**内置模板，工具永不因模板问题失效。

如需更丰富的输出格式（学习笔记/评测表/时间线/复习卡等），可安装配套技能 `bilibili-video-analyzer`（A-K 格式目录），Agent 会按用户需求选用。

---

## 🧠 推荐工作流（两段式，主路径：提示词驱动）

**抓帧不是靠关键词自动猜，而是由主 Agent 用系统提示里的一套分析提示词，读完文稿后自己判断**哪些位置「离开画面就不完整」、必须看画面。系统提示内置的「内容完整性检查」教模型找五类信息缺失——**指代悬空 / 结论先行 / 操作无口述 / 无声演示 / 视觉对比**，并显式回报：

```
① bilibili_extract(url, extract_frames: false)      # 只拿文字，秒级、零下载
② agent 逐段检查文稿的「信息缺失」位置，确定必须看画面的时间点
③ agent 在回复末尾以 [建议抓帧] mm:ss 理由 列出清单，再带 timestamps 定向抓帧——插件先在该时间点 ±4s 内用 FFmpeg 场景检测**对齐到画面变化最明显的帧**，再在 ±1.5s 内用 blurdetect **选最清晰的帧**（语义定位 → 画面精修 → 清晰度把关）
④ 依据帧的 description/citation_hint（或 read_image）判断报告里引用哪些图
```

> 兜底：**单次调用**（不传 `timestamps`）时，插件才用自动选帧——纯画面信号：场景切换（>20 分钟抽样式）+ 均匀间隔。这是给「模型没走两段式」时的保险，不包含任何关键词猜测。

> 精度说明：帧实际时间与请求时间可能存在最多约 ±0.5s 偏差（快速 seek 依赖关键帧间隔），叠加场景对齐与清晰帧精修后偏差更大——精确时刻以报告中的「原始请求」标注为准。

---

## 🔧 配置

默认值写在 `cordis.patch.yml`，可在 `$DSH_HOME/profiles/web/cordis.patch.yml` 覆盖（后写覆盖整行 config）：

```yaml
- override:
    - id: bilibili
      config:
        sessdata: ''                 # 可选，B站 SESSDATA；留空时自动读取 bilibili_login 保存的 .sessdata.json
        commentLimit: 20             # 评论抓取数量上限
        maxFrames: 6                 # 最大抓帧数
        extractFrames: true          # 是否抓帧（false = 纯文字模式）
        downloadVideo: true          # 抓帧前先下载视频到本地（推荐）
        keepVideo: false             # true = 永久保留下载的视频文件
        maxVideoMinutes: 30          # 超过此时长的视频不下载，远程逐帧
        maxDownloadMb: 800           # 下载大小上限（MB）
        quality: 32                  # 16=360p 32=480p 64=720p 80=1080p
        detectScenes: true           # 场景切换检测（>20 分钟自动切抽样式）
        sceneThreshold: 0.4          # 场景切换阈值 0-1，越大越严格
        sharpFrames: true            # 清晰帧优选：目标时间点 ±1.5s 内 blurdetect 选最清晰帧
        asrProvider: 'bcut'          # ASR 引擎：bcut(必剪,默认) | sherpa-onnx(中文推荐) | whisper-local | auto | none
        sherpaBin: ''                # sherpa-onnx-offline 可执行文件路径
        sherpaModel: ''              # sherpa 模型 onnx 路径（SenseVoice/Paraformer）
        sherpaModelType: 'sense-voice'  # sense-voice | paraformer | zipformer2-ctc
        sherpaTokens: ''             # sherpa tokens.txt 路径
        sherpaThreads: 0             # sherpa CPU 线程数（0=自动）
        whisperBin: 'whisper-cli'    # whisper.cpp 可执行文件（PATH 或绝对路径）
        whisperModel: 'medium'       # 模型三档：small(低) / medium(中) / large-v3(高)，或 ggml-*.bin 路径
        whisperModelDir: ''          # 模型目录，留空 = <whisperBin 同目录>/models
        whisperLanguage: 'zh'        # 转写语言
        whisperThreads: 0            # whisper CPU 线程数（0=自动）
        visionProvider: 'none'       # 帧图视觉描述：none(默认) | ollama | llama-cpp | openai-compatible
        visionBaseUrl: ''            # 视觉服务地址，留空且 ollama = http://localhost:11434/v1
        visionModel: 'medium'        # 三档：low(2B) / medium(4B) / high(8B)，或显式模型名
        visionApiKey: ''             # 云端视觉 API Key（本地留空）
        visionPrompt: ''             # 识图提示词（留空 = 按模型自动选内置提示词）
        visionPromptByModel: {}      # 分模型提示词覆盖（显式模型名 / low / medium）
        visionMaxFrames: 6           # 最多描述几张帧（与 maxFrames 对齐）
        framesDir: ''                # 帧图输出目录，留空 = 系统临时目录/dsh-bilibili/<bvid>
        summaryTemplate: ''          # 输出模板路径，留空 = 内置 templates/summary.md
        timeoutMs: 300000            # 工具整体超时（毫秒）
```

### 本地 ASR 转写（可选，中文推荐 sherpa-onnx）

无字幕视频默认走必剪（零配置、匿名、国内直连）。想离线、或必剪不可用时，可切换到本地引擎。**插件不打包模型，只提供接口，模型与二进制需自行下载**（本地离线推理的物理前提，但不涉及任何 API key / 额度 / 付费）。

#### 推荐：sherpa-onnx（中文，SenseVoice）

B 站以中文内容为主，SenseVoice 的中文识别率明显高于 Whisper，且速度更快、模型更小；模型官方托管在 ModelScope（国内直连、下载快）。

| 档位 | 推荐模型 | 体积（约） | 适用 |
|------|----------|-----------|------|
| 低 | SenseVoiceSmall（int8） | ~230 MB | 低配电脑 |
| 中 | SenseVoiceSmall（fp32） | ~900 MB | 主流电脑（推荐） |
| 高 | Paraformer-large | ~2.5 GB | 高配电脑 / 极致精度 |

步骤：

1. 从 [sherpa-onnx](https://github.com/k2-fsa/sherpa-onnx) 下载对应系统的 `sherpa-onnx-offline` 可执行文件；
2. 下载模型（`model.onnx` + `tokens.txt`），SenseVoice 模型可在 [ModelScope](https://modelscope.cn) 或 sherpa-onnx 的模型列表获取；
3. 配置里设 `asrProvider: 'sherpa-onnx'`，并填 `sherpaBin` / `sherpaModel` / `sherpaTokens`（`sherpaModelType` 默认 `sense-voice`）。

#### 备选：whisper.cpp（通用 / 英文）

| 档位 | whisperModel | 模型文件 | 体积 | 适用 |
|------|--------------|----------|------|------|
| 低 | `small` | `ggml-small.bin` | ~466 MB | 低配电脑 / 快速出稿 |
| 中 | `medium` | `ggml-medium.bin` | ~1.5 GB | 主流电脑 |
| 高 | `large-v3` | `ggml-large-v3.bin` | ~3 GB | 高配电脑 |

1. 从 [whisper.cpp](https://github.com/ggml-org/whisper.cpp) 下载 `whisper-cli` 可执行文件；
2. 下载对应档位的 `ggml-*.bin` 模型，放到 `models/` 目录；
3. 配置里设 `asrProvider: 'whisper-local'` 并填 `whisperBin` / `whisperModel`。

> 提示：`asrProvider: 'auto'` 会按「必剪 → sherpa-onnx → whisper-local」依次降级；中文内容建议至少 `medium`（whisper）或直接选 SenseVoice（sherpa）。sherpa-onnx 的 CLI 参数随版本略有差异，如遇报错请以你所用版本的 `--help` 为准调整。

### 🔍 帧图视觉描述（可选）

DeepSeek 主模型没有视觉能力时，可开启本功能：抓帧后把每帧交给**视觉模型**转成文字描述（随帧返回 `description` 字段），主模型据此判断报告里**哪些画面值得引用**——仅当内容需要视觉确认（图表/界面/演示细节）时才配图，纯口播画面不配图。默认关闭；视觉服务失败不影响主流程（帧路径照常返回）。

**本地（推荐）**：安装 [Ollama](https://ollama.com) 后拉取模型即可，无 key、离线、不花钱：

| 档位 | visionModel | Ollama 模型 | 内存需求（约） | 适用 |
|------|-------------|-------------|---------------|------|
| 低 | `low` | `qwen3-vl:2b` | ~2 GB | 超低配电脑 |
| 中 | `medium`（默认） | `qwen3-vl:4b` | ~4 GB | 低配-主流电脑（推荐） |
| 高 | `high` | `qwen3-vl:8b` | ~6-8 GB | 主流电脑，质量最佳 |

想要更大模型直接填显式模型名（如 `qwen3-vl:32b`），插件原样透传——只是不再作为默认档位推荐。

中档备选 **MiniCPM-V 4.0**（面壁，2026 年新作，官方称超越 GPT-4.1-mini、手机可跑，官方提供 GGUF/int4；其 Ollama tag 名称请以官方库为准）。`visionModel` 也接受显式模型名（Ollama tag 或云端模型 id）。

**其他非千问模型（2026-08 已在 Ollama 官方库核实）**：`minicpm-v:8b`（面壁 MiniCPM-V 2.6，中文 OCR 强）、`moondream`（1.9B，英文为主）、`gemma3n`（谷歌，英文为主）。**Kimi-VL / InternVL / GLM-4V 暂不在 Ollama 官方库**——可通过 llama.cpp 的社区 GGUF 或云端 OpenAI 兼容接口（如 Moonshot/智谱 API）使用；MiniCPM-V 4.0 官方 GGUF 走 llama-cpp 路线即可。

> 选型依据：本任务是「**理解画面内容 + 输出配图建议**」而非 OCR 转录，权重放在**中文场景理解与指令遵循**上，因此默认三档用同族 Qwen3-VL（2B/4B/8B，行为一致、提示词可共用）；追求极致端侧省资源可选 MiniCPM-V 4.0。

**llama.cpp（本地备选）**：用 `llama-server` 启动视觉 GGUF（模型 + mmproj），它自带 OpenAI 兼容接口；`visionModel` 就是启动时 `--alias` 设置的名字——把别名设成档位关键词对应的名字，即可直接复用档位配置：

```sh
llama-server -m qwen3-vl-8b-q4_k_m.gguf --mmproj mmproj-qwen3-vl-8b.gguf --port 8080 --alias qwen3-vl:8b
# 插件配置：visionProvider: 'llama-cpp' + visionModel: 'medium'
```

三档推荐以**千问 Qwen3-VL 为主**：低档 Qwen3-VL-2B、中档 Qwen3-VL-4B（默认）、高档 Qwen3-VL-8B。GGUF 已核实：官方 `Qwen/Qwen3-VL-4B/8B-Thinking-GGUF`（含 mmproj）、社区 `unsloth/Qwen3-VL-4B-Instruct-GGUF` 等；若所用 llama.cpp 版本暂不支持 Qwen3-VL 架构，可先改用 Qwen2.5-VL-7B-Instruct-GGUF（ModelScope 官方）。llama.cpp 还支持 MiniCPM-V（含 4.0）、InternVL、GLM-4V、LLaVA、gemma3n、moondream2 等架构。

**云端**：任何 OpenAI 兼容接口，例如 `visionProvider: 'openai-compatible'` + `visionBaseUrl` + `visionModel` + `visionApiKey`。单帧描述任务不需要旗舰多模态，便宜档即可：GLM-4V-Flash（中文有免费额度）/ GPT-4o-mini / 硅基流动 Qwen-VL 系列。

**分模型提示词**：所有内置提示词的任务都是**理解这一帧的内容**（画面里发生了什么、展示了什么），文字只转述要点、不做逐字转录。插件会按模型自动选提示词：MiniCPM-V 家族有专属提示词、moondream2 用英文提示词、低档小模型用更短的提示词；你也可以用 `visionPrompt`（全局）或 `visionPromptByModel`（按显式模型名或档位 low/medium）覆盖。

**配图质量把关**：视觉描述末尾会要求模型输出「配图建议：适合/不适合」（适合=画面清晰、信息明确、能帮助读者理解；不适合=纯口播/模糊/无信息量）。帧数据带 `citation_hint` 字段，总结报告**只引用「适合」的帧**，每段至多 1-2 张。

**2B 实测结论**（2026-08，llama.cpp b10428 + Qwen3-VL-2B-Instruct-Q4_K_M，16 线程 CPU，7 张已知内容测试图）：配图建议输出 100% 稳定；图表数值（120/240/180/300 万元）与海报数字（32%/500 万/三轮融资）与原文完全一致；纯口播画面正确判「不适合」；单张 4-9 秒。低档 2B 的短提示词已按实测调优（含防幻觉与判定标准）。

> 提示：本地 CPU 描述数张帧需要几十秒到几分钟（GPU 更快）；`visionMaxFrames` 控制描述帧数上限。

---

## 📁 项目结构

```
dsh-bilibili/
├── lib/
│   ├── index.js        # Cordis 插件入口：注册工具 + 系统提示指引 + 配置 schema
│   ├── extractor.js    # 提取层：B站 API + 下载模块 + 场景检测 + ffmpeg 抓帧
│   ├── keyframes.js    # 纯函数：自动选帧（纯画面信号）、时间格式化
│   └── format.js       # 纯函数：提取结果 → 模型可见文本摘要
├── templates/summary.md  # 内置默认输出模板（可替换）
├── test/                 # 单元测试（node --test）
├── cordis.patch.yml      # bundle 补丁层（被插件系统识别）
└── package.json          # dsh.bundle.patch 声明 + peer 依赖
```

---

## 🔌 插件标准

本插件遵循 DeepSeek Harness 插件标准：npm 包声明 `dsh.bundle.patch` → `dsh plugin add` 安装后自动 reconcile 进 `dsh.profile.bundles` → 重启 profile 后由 Cordis loader 挂载。标准详见 [deepseek-harness 仓库](https://github.com/deepseek-ai/deepseek-harness)。

---

## 🛠️ 本地开发（link 模式）

`dsh plugin add` 对本地目录用 `link:` 安装（改代码即生效）。由于 ESM 按真实路径解析依赖，插件目录需要一条指向 profile node_modules 的 junction：

```powershell
New-Item -ItemType Junction -Path ".\node_modules\@deepseek-ai" `
  -Target "$env:USERPROFILE\.dsh\profiles\node_modules\@deepseek-ai"
```

改动后重启 web profile 即生效。

---

## ⚠️ 限制

- 多分 P 视频当前只取第一 P；
- 无字幕轨的视频默认用必剪 ASR 转写文稿，可切本地 sherpa-onnx / whisper.cpp；转写结果可能有识别错误，返回中会如实标注；
- 必剪 ASR 是匿名接口，高频连续调用可能被限流（返回错误）；需要高频/稳定转写时建议 `asrProvider: 'auto'`（自动降级）或直接切本地 sherpa-onnx；
- 帧图落盘不自动清理（便于模型随时 read_image），代价是磁盘占用；
- Node fetch 不读系统代理环境变量，需要代理的网络环境待适配；
- 场景检测对 >20 分钟视频自动切抽样式（全片解码耗时）。

---

## 📄 License

[MIT](LICENSE)
