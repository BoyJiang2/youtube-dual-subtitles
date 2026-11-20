# YouTube 双语直播字幕

在正在观看的 YouTube 直播或视频上显示实时字幕，无需视频自带 CC。首次使用默认选择 **OpenAI 低延迟直播 + GPT-6 Luna + 简体中文**。填一次 OpenAI API 密钥即可启动，音频识别和文字翻译共用这把密钥。

## 安装与升级

1. 从 [GitHub Releases](https://github.com/BoyJiang2/youtube-dual-subtitles/releases/latest) 下载扩展 ZIP 并解压，也可以克隆本仓库。
2. 在桌面版 Chrome 116 或更新版本打开 `chrome://extensions`，开启「开发者模式」，点击「加载已解压的扩展程序」，选择包含 `manifest.json` 的目录。
3. 打开 YouTube 直播或视频并播放，点击扩展图标。在「语音识别」填入 OpenAI API 密钥，点击「启动实时字幕」。知道主播使用英语时，可在「直播原语」选择英语。
4. 从旧版升级时，把新文件解压覆盖到 Chrome 原来加载的扩展目录，在扩展管理页点击「重新加载」，刷新视频页面并重新启动字幕。扩展会记住以前选过的引擎。要使用新版默认组合，请选「OpenAI 低延迟直播」和「OpenAI（GPT-6 Luna）」。

## 识别、翻译与费用

识别引擎和翻译引擎可以自由搭配。以下为 2026-11-20 核对的 OpenAI 标准 API 美元价格，识别和翻译分别计费。

| 识别选项 | 模型 | 什么时候出字 | 识别费用 |
| --- | --- | --- | --- |
| OpenAI 低延迟直播（首次默认） | `gpt-live-transcribe` | 用 24 kHz PCM 持续推流，`delay: low` 允许在说话期间收到原文并开始翻译 | $0.017/分钟，即 $1.02/小时 |
| OpenAI 经济转写 | `gpt-4o-mini-transcribe` | WebSocket 提交短语后收取识别结果。连续有声时，客户端最长每 2 秒提交一次 | 官方估算约 $0.003/分钟，即 $0.18/小时 |
| OpenAI 兼容转写 | `gpt-4o-mini-transcribe` | 通过 HTTP 上传 WAV 片段；持续有声时最长 2.4 秒一段，保留 0.2 秒重叠 | 同一模型，按实际提交音频计费 |
| Deepgram Nova-3 | `nova-3` | WebSocket 返回临时文字和断句结果 | 使用自己的 Deepgram 账户计费 |

[OpenAI 流式转写协议](https://developers.openai.com/api/docs/guides/realtime-transcription) · [低延迟直播模型价格](https://developers.openai.com/api/docs/models/gpt-live-transcribe) · [OpenAI API 价目表](https://developers.openai.com/api/docs/pricing?latest-pricing-expanded=true)

| 文字翻译 | 每百万输入 token | 每百万输出 token |
| --- | ---: | ---: |
| GPT-6 Luna（本版 OpenAI 默认） | $0.10 | $0.50 |
| GPT-4.1 mini（v2.1 使用的模型，供比价） | $0.40 | $1.60 |

Luna 使用流式输出，关闭额外推理。也可选 DeepSeek（`deepseek-chat`），使用自己的 DeepSeek 密钥。若一小时实际发送 30 万输入 token、生成 3 万输出 token，Luna 文字翻译费是 **$0.045**，搭配低延迟识别合计约 **$1.065/小时**。这个例子按未缓存输入计算。语速、预译次数、上下文长度都会改变实际用量。[GPT-6 Luna](https://developers.openai.com/api/docs/models/gpt-6-luna) · [GPT-4.1 mini](https://developers.openai.com/api/docs/models/gpt-4.1-mini)

## 字幕显示与操作

- **原文 + 翻译**显示当前短语，原文先更新，译文在同一张字幕卡内逐步补齐。源文本继续增长时，正在返回的预译可以先显示。更长的句子开始重译时，已读到的前半句保留在屏幕上，直到新译文跟上或定稿。识别定稿与预译文本一致时直接沿用这次翻译。源文本发生实质修订时会重新译。
- **仅显示实时原文**只调用识别服务。可自动检测原语，也可从 15 种原语中指定。翻译目标有 47 种，包括简繁中文、英语、日语、韩语、西班牙语、法语、德语、阿拉伯语和印地语。实际识别能力取决于引擎。
- 字幕直接叠加在原播放器上，支持全屏，只捕获标签页音频。悬停字幕可上下拖动、用 `A−` / `A+` 调字号、切换半透明／深底／描边背景。位置、字号、背景和历史面板偏好会保留。
- 点击「记录」可查看并复制最近 100 条已定稿字幕。上一句的翻译晚到会更新对应记录。较早的 OpenAI 音频片段如果直到新句显示后才返回识别结果，直播会跳过过时的结果。
- 点击「停止」结束当前识别。弹窗会显示连接状态、静音诊断和 API 错误。兼容转写可用于 WebSocket 连不通的网络。
- 本版只显示当前一句，按画面刷新节奏合并字幕更新，并为双语预留译文行。网络和模型响应仍会影响字幕与声音的时间差，音视频按播放器原速继续播放。

## 隐私与密钥

API 密钥保存在本机扩展的 `chrome.storage.local`，可在弹窗清除。音频直接发送给选定的识别服务，当前句和最多四条近期翻译上下文发送给选定的翻译服务。原文模式不会发送翻译请求。历史字幕保存在本次页面会话中。

## 开发与验证

扩展由原生 JavaScript 和 Chrome Manifest V3 构成，可直接加载。使用 Node.js 22 运行 `node --test`。已安装桌面 Chrome 和 Python Playwright 时，可运行 `python tests/overlay_replay.py` 回放短句、迟到译文与定稿，检查屏幕显示和历史记录。需要指定 Chrome 可执行文件时可设置 `CHROME_PATH`。

字幕更新参考了 LiveKit 用同一段 ID 关联临时结果与定稿的做法。研究时也对照了 Whisper-Streaming 以多次解码的一致前缀确认文本的方案。本扩展使用服务端流式结果和本地句子编号，无需安装 Python 推理服务或下载模型。[LiveKit 字幕接收实现](https://github.com/livekit/client-sdk-flutter/blob/main/lib/src/agent/chat/transcription_stream_receiver.dart) · [Whisper-Streaming](https://github.com/ufal/whisper_streaming)
