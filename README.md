# YouTube 双语直播字幕

在桌面版 Chrome 识别当前 YouTube 标签页的声音。可以只看原文，也可以同时看翻译。两种字幕内容都支持同步观看和直接显示，使用你自己的 OpenAI 或 DeepSeek API 密钥。

[下载最新版本](https://github.com/BoyJiang2/youtube-dual-subtitles/releases/latest)

## 功能

| 功能 | 行为 |
| --- | --- |
| 同步观看 | 默认模式。另开一个播放标签页，将原画面和声音一起在本机缓冲约 8 秒，为识别和翻译留出时间。字幕按缓冲视频的播放时间显示。支持全屏。 |
| 直接显示 | 字幕叠加在原 YouTube 播放器上。原直播画面照常播放，字幕在收到识别结果后显示。接口较慢时会跳过太旧的结果。 |
| 只显示原文 | 仅调用语音识别 API，显示识别出来的原语字幕。 |
| 原文 + 翻译 | 识别原语后翻译成所选语言。默认简体中文。原文与对应译文使用同一段音频的时间区间。 |
| 自动判断原语 | 语音语言由所选服务商的识别接口判断。从两种服务中任选其一，一把密钥即可完成识别和翻译。 |

## 安装和使用

1. 从 [GitHub Releases](https://github.com/BoyJiang2/youtube-dual-subtitles/releases/latest) 下载扩展 ZIP 并解压。需要桌面版 Chrome 116 或更新版本。
2. 在地址栏打开 `chrome://extensions`，开启「开发者模式」，点击「加载已解压的扩展程序」。选择包含 `manifest.json` 的 `YouTube-Dual-Subtitles` 文件夹。也可以克隆此仓库，直接加载仓库根目录。
3. 播放 YouTube 直播或视频。从工具栏的拼图菜单打开「YouTube 双语直播字幕」，选择 OpenAI 或 DeepSeek，粘贴该服务的 API 密钥。
4. 选择播放模式及字幕内容。选「原文 + 翻译」时，再选择目标语言。点「启动字幕」。同步观看会打开新标签页，缓冲完成后如果浏览器要求手动播放，点击「播放同步画面」。
5. 观看时保留源 YouTube 标签页。同步页的「停止同步」或扩展弹窗的「停止字幕」会结束捕获。关闭同步页、关闭源页面或切换到其他视频也会停止。

更新时，用新版文件覆盖原来的扩展目录，然后在 `chrome://extensions` 点击「重新加载」，刷新已打开的 YouTube 页面。

## 服务和语言

| API 服务 | 语音识别 | 文本翻译 |
| --- | --- | --- |
| OpenAI | [`gpt-transcribe`](https://developers.openai.com/api/docs/guides/speech-to-text) | [`gpt-4.1-mini`](https://developers.openai.com/api/docs/models/gpt-4.1-mini) |
| DeepSeek | [Speech to Text](https://api-docs.deepseek.com/guides/asr/) | [`deepseek-flash`](https://api-docs.deepseek.com/) |

语音**输入**的可识别语言以各服务商的语音识别文档为准。**翻译目标**提供以下 47 个选项。地区和书写变体单独列出。

- 简体中文、繁体中文、英语、日语、韩语、西班牙语、法语、德语、葡萄牙语、巴西葡萄牙语、意大利语、俄语
- 越南语、泰语、印度尼西亚语、马来语、菲律宾语、阿拉伯语、印地语、孟加拉语、乌尔都语、波斯语、希伯来语、土耳其语
- 乌克兰语、波兰语、荷兰语、捷克语、斯洛伐克语、匈牙利语、罗马尼亚语、希腊语、瑞典语、丹麦语、挪威博克马尔语、芬兰语
- 泰米尔语、泰卢固语、马拉地语、古吉拉特语、旁遮普语、卡纳达语、马拉雅拉姆语、斯瓦希里语、塞尔维亚语、克罗地亚语、保加利亚语

## 同步方式与限制

- 扩展将有声音的音频切成约 1.1–2.2 秒的片段并并行请求接口。同步观看把画面和声音录成短片段在本机缓冲，让已返回的字幕能在对应片段播放时出现。缓冲会给直播增加约 8 秒观看延迟。字幕定位到音频片段，精度约为短句级别。
- 如果译文来得太晚，仍可显示及时返回的原文。播放时间已经过去的字幕会跳过。直接显示模式的延迟随采集时长和 API 响应变化。
- 游戏音效、背景音乐、主播和游戏对白会一起进入语音识别。不同声音重叠时，可能出现漏字、识别错误或翻译偏差。游戏画面里烧录的字幕不会作为文本读取。
- 保持源 YouTube 标签页在播放器可见的位置。同步页按启动时的播放器位置裁切。源页被滚动或改成其他布局后，可以重新启动同步。录制和播放同时运行会增加本机负载。

## 隐私、密钥和费用

- 使用所选 API 平台签发的密钥。密钥只放在 Chrome 的扩展会话内存里。退出 Chrome 会清除，也可以在停止后点「清除本次会话的密钥」。扩展将其用于向所选服务商认证。
- 音频片段直接发送到选择的 OpenAI 或 DeepSeek API。选择翻译时，识别文本也会发送给该服务商。同步观看的视频画面和音视频缓冲保存在本机内存里，会在停止时释放。
- API 费用由所选服务商账户结算。「只显示原文」只产生识别请求。

## 排查

| 现象 | 操作 |
| --- | --- |
| 字幕仍明显落后于直播 | 在扩展里选「同步观看」，然后看新开的同步标签页。 |
| 同步画面等待播放 | 等待缓冲完成，点击「播放同步画面」。 |
| 没有字幕 | 确认源视频正在播放、说话声清楚，并检查扩展或同步页的状态消息。 |
| 提示认证、余额或权限错误 | 检查服务商、API 账户余额，以及密钥能否访问上表列出的接口。 |
| 画面字幕重叠 | 可以关闭 YouTube 自带的 CC。直播内容内嵌的字幕会随画面一起显示。 |

直播片段的时间顺序处理参考了 [WhisperLive](https://github.com/collabora/WhisperLive/blob/main/whisper_live/client.py)，播放器暂停时停止提交音频的处理参考了 [LiveTranslate](https://github.com/xieyuanqing/live-translate-extension)。

## 开发与验证

扩展使用 Manifest V3 原生 API，从源码加载即可运行。修改文件后，在 `chrome://extensions` 重新加载并刷新测试页。

仓库附有 Windows Chrome 集成测试。测试使用隔离浏览器配置、合成音视频和本机模拟 API。需要支持扩展调试的 Chrome、Python、Playwright、OpenSSL 和 FFmpeg。Chrome 不在默认安装位置时，可设置 `CHROME_PATH`。

```powershell
python -m pip install playwright
python tests/browser_smoke.py
python tests/browser_smoke.py --latency
python tests/browser_smoke.py --latency=deepseek --slow-translation
python tests/browser_smoke.py --sync
python tests/browser_smoke.py --sync=deepseek --original
```

测试覆盖两个服务的请求格式、直接显示、慢请求下的字幕更新、暂停和跳转、同步播放的画面和字幕对应关系、日语翻译目标，以及纯原文模式下不发送翻译请求。真实直播效果取决于输入音频和 API 响应。
