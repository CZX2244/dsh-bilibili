# 插件市场展示图

这三张图片是依据插件现有代码绘制的**功能示意图，不是真实运行截图**。
图片不包含真实或虚构的视频分析结果、账号信息、登录二维码、运行成功状态或性能数据。
按根目录 [`screenshots.json`](../../screenshots.json) 中的顺序展示。

| 图片 | 展示内容 | 实现依据 |
| --- | --- | --- |
| `01-video-materials.png` | 视频链接 / 短链 / BV 号输入，元数据、文稿、热门评论与弹幕；主 Agent 生成报告 | [`lib/extractor.js`](../../lib/extractor.js)、[`lib/format.js`](../../lib/format.js)、[`lib/index.js`](../../lib/index.js) |
| `02-transcript-asr.png` | 字幕优先、必剪 ASR 默认值、可配置的本地转写、`auto` 降级顺序、扫码登录 | [`lib/extractor.js`](../../lib/extractor.js)、[`lib/index.js`](../../lib/index.js)、[`lib/login.js`](../../lib/login.js) |
| `03-keyframes-vision.png` | 主 Agent 选择时间点、FFmpeg 定向抓帧、本地场景对齐与清晰帧优选、可选视觉描述 | [`lib/index.js`](../../lib/index.js)、[`lib/extractor.js`](../../lib/extractor.js) |

功能核对基准：`v0.7.5`，提交 `b4a02753469d0e4368fe827a49fa76c5e8735737`（2026-10-10 核对）。

## 内容边界

- 插件为主 Agent 提供资料和输出模板，不独立保证生成报告或正确分析。
- 字幕、评论、弹幕的可用性受视频、登录态、服务与网络等条件影响。
- 默认 ASR 是 `bcut`；只有设置 `asrProvider: 'auto'` 才按必剪 → sherpa-onnx → whisper-local 逐级尝试。图中的 whisper.cpp 是引擎名，对应配置值 `whisper-local`。
- 本地转写需要另装二进制、模型和相关配置；获取 B 站音频仍需联网。
- 场景对齐和清晰帧优选描述的是本地视频抓帧路径；图片不承诺精确到帧的时间定位。
- 视觉描述默认关闭，需要另行配置 Ollama、llama.cpp 或 OpenAI 兼容视觉服务。

## 格式与更新

- PNG，1440 × 960，3:2，无透明背景；三图保持相同尺寸、字体层级与色彩。
- 字体为 [Noto Sans SC](https://github.com/google/fonts/tree/main/ofl/notosanssc) 和 DejaVu Sans Mono；图片只包含已栅格化字形，不分发字体文件。流程符号为本项目绘制，无第三方视频画面。
- 以 dsh-market 官方 [`assets/demo-zh.png`](https://github.com/dsh-market/dsh-market/blob/main/assets/demo-zh.png) 和其缩略图样式作为展示环境参考，不复制宿主界面。
- 文件名使用小写 ASCII；`screenshots.json` 使用相对于仓库根目录的路径。移动或重命名时同步更新配置。
- 依据 [上游截图规范](https://github.com/awesome-dsh-plugin/awesome-dsh-plugin/blob/main/contributing.md#screenshots--截图optional-recommended--可选推荐)：声明 1–8 张图，路径不能以 `/` 开头或包含 `..`，无须修改上游旧的 `data/screenshots.json`。
- 上游下一次构建采集仓库声明，市场展示还取决于目录刷新与缓存。提交完成不代表市场已即时刷新。

改图时保留“功能示意 · 非运行截图”标记；若以后加入真实截图，请单独明确标注并清除凭证和私人信息。
