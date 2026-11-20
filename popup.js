import { defaultTargetLanguage, targetLanguages } from './languages.js';

const provider = document.querySelector('#provider');
const key = document.querySelector('#key');
const synchronized = document.querySelector('#synchronized');
const mode = document.querySelector('#subtitle-mode');
const target = document.querySelector('#target-language');
const targetSetting = document.querySelector('#target-setting');
const toggle = document.querySelector('#toggle');
const forget = document.querySelector('#forget');
const message = document.querySelector('#message');
const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
const supported = /^https:\/\/www\.youtube\.com\/(watch\?|live\/[\w-]+)/.test(tab?.url ?? '');
let state = await chrome.storage.session.get(null);
let pending = false;
provider.value = state.selectedProvider || 'openai';
synchronized.value = state.synchronized === false ? 'no' : 'yes';
mode.value = state.originalOnly ? 'original' : 'dual';
const languageLabels = new Intl.DisplayNames(['zh-CN'], { type: 'language' });
for (const language of targetLanguages) target.add(new Option(languageLabels.of(language), language));
target.value = targetLanguages.includes(state.targetLanguage) ? state.targetLanguage : defaultTargetLanguage;

function report(text, isError = false) {
  message.textContent = text;
  message.dataset.error = isError;
}

function render() {
  const running = state.liveCapture;
  toggle.textContent = running ? '停止字幕' : '启动字幕';
  toggle.dataset.stopping = Boolean(running);
  provider.disabled = key.disabled = synchronized.disabled = Boolean(running) || pending;
  mode.disabled = target.disabled = Boolean(running) || pending;
  targetSetting.hidden = mode.value === 'original';
  toggle.disabled = pending || (!supported && !running);
  forget.hidden = !Object.keys(state.apiKeys || {}).length;
  forget.disabled = pending || Boolean(running);
  key.placeholder = state.apiKeys?.[provider.value] ? '已有密钥，留空继续使用' : '粘贴所选服务商的密钥';
  if (pending) return;
  const notice = state.captureNotice;
  if (running) {
    report(running.synchronized ? '同步观看正在运行。' :
      (running.tabId === tab?.id ? '正在显示字幕。' : '字幕正在另一个标签页运行。'));
  } else if (notice?.tabId === tab?.id && notice) {
    report(notice.text, true);
  } else {
    report(supported ? '' : '打开 YouTube 直播或视频页面后再启动。');
  }
}

async function operate(type) {
  pending = true;
  render();
  report({ start: '正在连接标签页音频…', stop: '正在停止…', forget: '正在清除…' }[type]);
  let error;
  try {
    const result = await chrome.runtime.sendMessage({
      target: 'background', type, tabId: tab?.id, provider: provider.value,
      synchronized: synchronized.value === 'yes',
      originalOnly: mode.value === 'original', targetLanguage: target.value,
      key: type === 'start' ? key.value : undefined,
    });
    if (!result?.ok) error = result?.error || '扩展未能完成操作，请重试。';
    else key.value = '';
  } catch {
    error = '扩展未能完成操作，请关闭弹窗后重试。';
  }
  state = await chrome.storage.session.get(null);
  pending = false;
  render();
  if (error) report(error, true);
}

document.querySelector('form').addEventListener('submit', event => {
  event.preventDefault();
  if (!pending && !toggle.disabled) void operate(state.liveCapture ? 'stop' : 'start');
});
provider.addEventListener('change', () => {
  key.value = '';
  render();
});
mode.addEventListener('change', render);
forget.addEventListener('click', () => void operate('forget'));
chrome.storage.onChanged.addListener((_, area) => {
  if (area === 'session') void chrome.storage.session.get(null).then(next => { state = next; render(); });
});
render();
