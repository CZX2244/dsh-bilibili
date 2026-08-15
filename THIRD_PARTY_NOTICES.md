# 第三方依赖与许可声明 / Third-Party Notices

dsh-bilibili 本体以 [MIT](LICENSE) 许可发布。本插件**不打包、不分发**以下任何第三方组件：外部程序与模型均由用户自行安装或下载，各自保留原有许可证；插件仅在运行时通过命令行调用它们。以下列出本插件直接引用或调用的开源项目与服务。

## 框架依赖（peerDependencies，由 DeepSeek Harness 提供）

| 包 | 上游 | 许可证 |
| --- | --- | --- |
| @deepseek-ai/cordis | [github.com/cordiverse/cordis](https://github.com/cordiverse/cordis) | MIT |
| @deepseek-ai/schemastery | [github.com/cordiverse/schemastery](https://github.com/cordiverse/schemastery) | MIT |
| @deepseek-ai/dsh-tools | [github.com/deepseek-ai/deepseek-harness](https://github.com/deepseek-ai/deepseek-harness) | MIT |

## 外部程序（用户自行安装，插件仅命令行调用）

| 组件 | 用途 | 许可证 |
| --- | --- | --- |
| FFmpeg | 视频解码、关键帧抓取、音频转码 | LGPL-2.1-or-later（部分构建含 GPL 组件，详见 [FFmpeg 官方说明](https://ffmpeg.org/legal.html)） |
| whisper.cpp | 本地 ASR 引擎（`whisper-local`） | [MIT](https://github.com/ggml-org/whisper.cpp/blob/master/LICENSE) |
| sherpa-onnx | 本地 ASR 引擎（`sherpa-onnx`，SenseVoice/Paraformer） | [Apache-2.0](https://github.com/k2-fsa/sherpa-onnx/blob/master/LICENSE) |
| Ollama | 本地视觉服务（帧图视觉描述，`visionProvider: ollama`） | [MIT](https://github.com/ollama/ollama/blob/main/LICENSE) |
| llama.cpp（llama-server） | 本地视觉服务（帧图视觉描述，`visionProvider: llama-cpp`） | [MIT](https://github.com/ggml-org/llama.cpp/blob/master/LICENSE) |

## 本地 ASR / 视觉模型（用户自行下载，插件不分发）

### ASR 模型

| 模型 | 来源 | 许可证 |
| --- | --- | --- |
| Whisper GGML 模型（`ggml-*.bin`） | OpenAI Whisper 权重经 whisper.cpp 社区转换为 GGML 格式发布（[huggingface.co/ggerganov/whisper.cpp](https://huggingface.co/ggerganov/whisper.cpp)） | MIT（OpenAI Whisper 权重） |
| SenseVoice / Paraformer | 阿里达摩院 FunASR 训练，sherpa-onnx 模型库发布（[k2-fsa/sherpa-onnx 模型下载页](https://k2-fsa.github.io/sherpa/onnx/sense-voice/index.html)） | Apache-2.0 |

### 视觉模型（经 Ollama / llama.cpp / OpenAI 兼容接口调用，模型由用户拉取）

| 模型 | 上游 | 许可证 |
| --- | --- | --- |
| Qwen3-VL 系列 | 阿里通义（[QwenLM/Qwen3-VL](https://github.com/QwenLM/Qwen3-VL)） | Apache-2.0 |
| MiniCPM-V 系列 | 面壁智能 OpenBMB（[OpenBMB/MiniCPM-V](https://github.com/OpenBMB/MiniCPM-V)） | Apache-2.0 |
| moondream2 | [vikhyat/moondream](https://github.com/vikhyat/moondream)（插件为其内置英文提示词：中文指令遵循较弱） | Apache-2.0 |

## 登录流程实现参考

| 项目 | 用途 | 许可证 |
| --- | --- | --- |
| Tsuk1ko/bilibili-qr-login | B 站扫码登录流程参考（passport 二维码 generate / poll 接口用法、状态码处理与 crossDomain 凭证解析方式） | [MIT](https://github.com/Tsuk1ko/bilibili-qr-login/blob/main/LICENSE) |

## 网络服务（非开源组件）

- **Bilibili Web API**（api.bilibili.com、comment.bilibili.com、passport.bilibili.com 登录接口等）：元数据、字幕、评论、弹幕、音视频流与扫码登录。
- **Bilibili 必剪（Bcut）ASR**（member.bilibili.com）：无字幕轨时的默认转写服务（B 站播放器「实时 AI 字幕」同款能力）。属 Bilibili 平台能力、匿名接口，存在限流与接口变更风险；返回文稿可能含识别错误。
- **OpenAI 兼容视觉接口**（可选，`visionProvider: openai-compatible`）：如 OpenAI、智谱、硅基流动等第三方视觉服务，由用户自行配置地址与密钥。
- **QR 码渲染服务**（api.qrserver.com，备用 api.liantu.com）：仅用于把 B 站登录链接渲染为二维码图片，便于在聊天界面直接展示扫码；离线时可直接打开返回的登录链接，用 B 站 App 扫码。
