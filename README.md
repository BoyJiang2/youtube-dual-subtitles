# YouTube Live Subtitles

Get live captions on YouTube videos and streams, including those without built-in captions. The default uses one OpenAI key for live transcription and GPT-6 Luna translation into Simplified Chinese.

## Install and use

1. Download and unzip the [latest release](https://github.com/BoyJiang2/youtube-dual-subtitles/releases/latest).
2. In Chrome 116 or later, open `chrome://extensions`, enable **Developer mode**, choose **Load unpacked**, and select the folder containing `manifest.json`.
3. Play a YouTube video, open the extension, enter your API key, and start captions. To update, replace the files in the same folder and reload the extension.

## Features

- Show the original alone or alongside a streaming translation. Detect the spoken language automatically or select one of 15. Choose from 47 translation targets.
- Use OpenAI or Deepgram for transcription and OpenAI or DeepSeek for translation. An HTTP transcription option is available if WebSockets are unavailable.
- Captions appear as speech arrives and use punctuation and pauses for line breaks. Adjust their position, font size, and background, or copy recent lines from history.
- Detect music on-device and translate audible lyrics in bilingual mode. Optional song lookup suggests a title when two distinct lyric fragments match the catalog. Ambiguous covers show the title alone. Instrumental music gets a music indicator.

## Data

Keys stay in local Chrome storage and can be cleared in the popup. Audio goes to your transcription provider. Translation sends caption text and recent context to your translation provider. Song lookup sends two heard lines to that provider and only the suggested title to [LRCLIB](https://lrclib.net).
