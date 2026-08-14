# dsh-bilibili

[![license](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)

DeepSeek Harness 工具插件：给 Agent 添加 `bilibili_extract` 工具。发一个 B 站链接，Agent 自动提取视频文字信息（文稿/评论/弹幕）并按需抓取关键帧，完成总结分析。

---

## ✨ 特性

- **文字信息全量提取**：元数据、完整字幕文稿（带时间戳）、热门评论（含楼中楼）、弹幕（高频 + 时间线样本）；**无字幕轨的视频自动用必剪 ASR 转写**（B站播放器「实时AI字幕」同款能力，匿名可用，24h 缓存）；单个信息源失败不影响整体（各自降级为空并带 note）；
- **混合信号自动选帧**：画面场景切换检测（主信号）+ 字幕视觉暗示词（加权）+ 均匀间隔兜底，5 秒去重；
- **两段式工作流**：模型先读文稿（秒级、零下载），再带 `timestamps` 定向抓帧——每帧自动配附近字幕，视频 24h 缓存复用，多轮迭代不重复下载；
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

安装后工具自动进入 Agent 的工具链：用户在对话里发 B 站链接（`bilibili.com/video/BV...`、`b23.tv` 短链或裸 BV 号），模型即可调用它分析。

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

## 🧠 推荐工作流（两段式）

工具描述与系统提示中已写入指引，模型会自然采用：

```
① bilibili_extract(url, extract_frames: false)   # 只拿文字，秒回、零下载
② agent 读文稿，自己判断哪些时刻需要画面辅助
③ bilibili_extract(url, timestamps: [32, 180])   # 定向抓帧，每帧附附近字幕
④ agent 用 read_image 看帧 → 总结
```

不传 `timestamps` 的单次调用则走混合自动选帧。

---

## 🔧 配置

默认值写在 `cordis.patch.yml`，可在 `$DSH_HOME/profiles/web/cordis.patch.yml` 覆盖（后写覆盖整行 config）：

```yaml
- override:
    - id: bilibili
      config:
        sessdata: '你的B站SESSDATA'  # 可选，解锁登录态字幕/更多评论
        commentLimit: 20             # 评论抓取数量上限
        maxFrames: 6                 # 最大抓帧数
        extractFrames: true          # 是否抓帧（false = 纯文字模式）
        downloadVideo: true          # 抓帧前先下载视频到本地（推荐）
        keepVideo: false             # true = 永久保留下载的视频文件
        maxVideoMinutes: 30          # 超过此时长的视频不下载，远程逐帧
        maxDownloadMb: 800           # 下载大小上限（MB）
        quality: 32                  # 16=360p 32=480p 64=720p 80=1080p
        detectScenes: true           # 场景切换检测（>20 分钟视频自动跳过）
        sceneThreshold: 0.4          # 场景切换阈值 0-1，越大越严格
        asrFallback: true            # 无字幕轨时自动 ASR 转写（必剪接口，匿名可用）
        framesDir: ''                 # 帧图输出目录，留空 = 系统临时目录/dsh-bilibili/<bvid>
        summaryTemplate: ''           # 输出模板路径，留空 = 内置 templates/summary.md
        timeoutMs: 300000            # 工具整体超时（毫秒）
```

---

## 📁 项目结构

```
dsh-bilibili/
├── lib/
│   ├── index.js        # Cordis 插件入口：注册工具 + 系统提示指引 + 配置 schema
│   ├── extractor.js    # 提取层：B站 API + 下载模块 + 场景检测 + ffmpeg 抓帧
│   ├── keyframes.js    # 纯函数：混合信号选帧、时间格式化
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
- 无字幕轨的视频自动用必剪 ASR 转写文稿；转写结果可能有识别错误，返回中会如实标注；
- 帧图落盘不自动清理（便于模型随时 read_image），代价是磁盘占用；
- Node fetch 不读系统代理环境变量，需要代理的网络环境待适配；
- 场景检测对 >20 分钟视频自动跳过（全片解码耗时）。

---

## 📄 License

[MIT](LICENSE)

