import { defaultSourceLanguage, defaultTargetLanguage, sourceLanguages, targetLanguages } from './languages.js';

const asrProviderEl = document.querySelector('#asr-provider');
const asrKeyEl = document.querySelector('#asr-key');
const asrKeyLabelEl = document.querySelector('#asr-key-label');
const sourceLangEl = document.querySelector('#source-language');
const modeEl = document.querySelector('#subtitle-mode');
const translateSettingsEl = document.querySelector('#translate-settings');
const translateProviderEl = document.querySelector('#translate-provider');
const translateKeyGroupEl = document.querySelector('#translate-key-group');
const translateKeyEl = document.querySelector('#translate-key');
const translateKeyLabelEl = document.querySelector('#translate-key-label');
const sharedKeyNoteEl = document.querySelector('#shared-key-note');
const targetLangEl = document.querySelector('#target-language');
const toggleBtn = document.querySelector('#toggle');
const forgetBtn = document.querySelector('#forget');
const messageEl = document.querySelector('#message');

const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
const supported = /^https:\/\/www\.youtube\.com\/(watch\?|live\/[\w-]+)/.test(tab?.url ?? '');

// Populate language dropdowns
for (const { code, label } of sourceLanguages) {
  sourceLangEl.add(new Option(label, code));
}
const languageLabels = new Intl.DisplayNames(['zh-CN'], { type: 'language' });
for (const lang of targetLanguages) {
  targetLangEl.add(new Option(languageLabels.of(lang), lang));
}

let sessionState = await chrome.storage.session.get(null);
let localState = await chrome.storage.local.get(null);
let pending = false;

asrProviderEl.value = localState.asrProvider || 'openai-live';
translateProviderEl.value = localState.translateProvider || 'openai';
sourceLangEl.value = sourceLanguages.some((l) => l.code === localState.sourceLanguage)
  ? localState.sourceLanguage
  : defaultSourceLanguage;
modeEl.value = localState.originalOnly ? 'original' : 'dual';
targetLangEl.value = targetLanguages.includes(localState.targetLanguage)
  ? localState.targetLanguage
  : defaultTargetLanguage;

function report(text, isError = false) {
  messageEl.textContent = text;
  messageEl.dataset.error = String(isError);
}

function render() {
  const running = sessionState.liveCapture;
  const apiKeys = localState.apiKeys || {};
  const asrProv = asrProviderEl.value;
  const asrKeyBucket = asrProv === 'deepgram' ? 'deepgram' : 'openai';
  const transProv = translateProviderEl.value;
  const isOriginalOnly = modeEl.value === 'original';
  const sameProvider = !isOriginalOnly && asrKeyBucket === transProv;

  asrKeyLabelEl.textContent = asrKeyBucket === 'deepgram' ? 'Deepgram API 密钥' : 'OpenAI API 密钥';
  asrKeyEl.placeholder = apiKeys[asrKeyBucket] ? '已保存密钥（留空继续使用）' : `粘贴 ${asrKeyBucket === 'deepgram' ? 'Deepgram' : 'OpenAI'} API 密钥`;

  translateSettingsEl.hidden = isOriginalOnly;
  translateKeyGroupEl.hidden = sameProvider;
  sharedKeyNoteEl.hidden = !sameProvider;
  translateKeyLabelEl.textContent = transProv === 'deepseek' ? 'DeepSeek API 密钥' : 'OpenAI API 密钥';
  translateKeyEl.placeholder = apiKeys[transProv] ? '已保存密钥（留空继续使用）' : `粘贴 ${transProv === 'deepseek' ? 'DeepSeek' : 'OpenAI'} API 密钥`;

  const locked = Boolean(running) || pending;
  for (const el of [asrProviderEl, asrKeyEl, sourceLangEl, modeEl, translateProviderEl, translateKeyEl, targetLangEl]) {
    el.disabled = locked;
  }

  toggleBtn.textContent = running ? '停止实时字幕' : '启动实时字幕';
  toggleBtn.dataset.stopping = String(Boolean(running));
  toggleBtn.disabled = pending || (!supported && !running);

  forgetBtn.hidden = Object.keys(apiKeys).length === 0;
  forgetBtn.disabled = locked;

  if (pending) return;
  const notice = sessionState.captureNotice;
  const liveStatus = sessionState.liveStatus;
  if (running) {
    if (liveStatus && liveStatus.tabId === tab?.id && liveStatus.text) {
      report(liveStatus.text, Boolean(liveStatus.isError));
    } else {
      report(running.tabId === tab?.id ? '实时字幕正在当前页面运行。' : '实时字幕正在另一个 YouTube 标签页运行。');
    }
  } else if (notice && notice.tabId === tab?.id) {
    report(notice.text, true);
  } else {
    report(supported ? '' : '请先打开 YouTube 直播或视频页面。');
  }
}

async function operate(type) {
  pending = true;
  render();
  report({
    start: '正在连接流式语音识别并捕获音频…',
    stop: '正在停止…',
    forget: '正在清除已保存的密钥…',
  }[type]);

  let error = '';
  try {
    const result = await chrome.runtime.sendMessage({
      target: 'background',
      type,
      tabId: tab?.id,
      asrProvider: asrProviderEl.value,
      asrKey: type === 'start' ? asrKeyEl.value : undefined,
      translateProvider: translateProviderEl.value,
      translateKey: type === 'start' ? translateKeyEl.value : undefined,
      sourceLanguage: sourceLangEl.value,
      originalOnly: modeEl.value === 'original',
      targetLanguage: targetLangEl.value,
    });
    if (!result?.ok) {
      error = result?.error || '操作失败，请重试。';
    } else {
      asrKeyEl.value = '';
      translateKeyEl.value = '';
    }
  } catch {
    error = '扩展后台无响应，请关闭弹窗后重试。';
  }

  sessionState = await chrome.storage.session.get(null);
  localState = await chrome.storage.local.get(null);
  pending = false;
  render();
  if (error) report(error, true);
}

document.querySelector('form').addEventListener('submit', (event) => {
  event.preventDefault();
  if (!pending && !toggleBtn.disabled) {
    void operate(sessionState.liveCapture ? 'stop' : 'start');
  }
});

asrProviderEl.addEventListener('change', () => {
  asrKeyEl.value = '';
  render();
});

translateProviderEl.addEventListener('change', () => {
  translateKeyEl.value = '';
  render();
});

modeEl.addEventListener('change', render);
forgetBtn.addEventListener('click', () => void operate('forget'));

chrome.storage.onChanged.addListener((_, area) => {
  if (area === 'session') {
    void chrome.storage.session.get(null).then((next) => {
      sessionState = next;
      render();
    });
  } else if (area === 'local') {
    void chrome.storage.local.get(null).then((next) => {
      localState = next;
      render();
    });
  }
});

render();
