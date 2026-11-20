import { defaultTargetLanguage, targetLanguages } from './languages.js';

const offscreenURL = chrome.runtime.getURL('offscreen.html');
const popupURL = chrome.runtime.getURL('popup.html');
const viewerURL = chrome.runtime.getURL('viewer.html');
let operations = Promise.resolve();

function enqueue(operation) {
  const next = operations.then(operation);
  operations = next.catch(() => {});
  return next;
}

function videoId(url) {
  if (!url) return null;
  const page = new URL(url);
  if (page.origin !== 'https://www.youtube.com') return null;
  if (page.pathname === '/watch') return page.searchParams.get('v');
  return /^\/live\/([\w-]+)\/?$/.exec(page.pathname)?.[1] ?? null;
}

async function captureDocument() {
  const [context] = await chrome.runtime.getContexts({ contextTypes: ['OFFSCREEN_DOCUMENT'], documentUrls: [offscreenURL] });
  return context;
}

function render(tabId, data) {
  return chrome.tabs.sendMessage(tabId, { target: 'overlay', ...data }).catch(() => {});
}

async function stop(session, notice = '') {
  if (session.synchronized) {
    await chrome.runtime.sendMessage({ target: 'viewer', type: 'stop', id: session.id, notice }).catch(() => {});
  }
  if (await captureDocument()) {
    await chrome.runtime.sendMessage({ target: 'offscreen', type: 'stop' }).catch(() => {});
    await chrome.offscreen.closeDocument().catch(() => {});
  }
  await chrome.storage.session.remove('liveCapture');
  if (notice) await chrome.storage.session.set({ captureNotice: { tabId: session.tabId, text: notice } });
  await render(session.tabId, { type: 'stop', id: session.id, notice });
}

async function start({ tabId, provider, key, synchronized, originalOnly, targetLanguage = defaultTargetLanguage }) {
  const { liveCapture, apiKeys = {} } = await chrome.storage.session.get(['liveCapture', 'apiKeys']);
  if (liveCapture) throw new Error('已有标签页正在显示字幕，请先停止。');
  if (!['openai', 'deepseek'].includes(provider)) throw new Error('请选择服务商。');
  if (!targetLanguages.includes(targetLanguage)) throw new Error('请选择要翻译的语言。');
  const apiKey = key?.trim() || apiKeys[provider];
  if (!apiKey) throw new Error('请填写所选服务商的 API 密钥。');
  if (!/^[\x21-\x7e]{1,512}$/.test(apiKey)) throw new Error('API 密钥格式无效，请检查是否复制完整。');

  const tab = await chrome.tabs.get(tabId);
  const video = videoId(tab.url);
  if (!tab.active || !video) throw new Error('请从正在播放的 YouTube 视频页面打开扩展。');

  const session = { id: crypto.randomUUID(), tabId, video, provider, synchronized: synchronized === true };
  try {
    await chrome.scripting.executeScript({ target: { tabId }, files: ['overlay.js'] });
    if (!(await captureDocument())) {
      await chrome.offscreen.createDocument({
        url: 'offscreen.html', reasons: ['USER_MEDIA'],
        justification: '处理当前 YouTube 标签页的字幕音频并保留声音播放。',
      });
    }
    const streamId = await chrome.tabCapture.getMediaStreamId({ targetTabId: tabId });
    if (videoId((await chrome.tabs.get(tabId)).url) !== video) throw new Error('视频页面已切换。');

    await chrome.storage.session.remove('captureNotice');
    await chrome.storage.session.set({ liveCapture: session });
    const playback = await render(tabId, { type: 'start', id: session.id, synchronized: session.synchronized });
    if (!playback) throw new Error('无法连接 YouTube 播放器，请刷新页面后重试。');
    const result = await chrome.runtime.sendMessage({
      target: 'offscreen', type: 'start', id: session.id, streamId, provider, key: apiKey, playback,
      synchronized: session.synchronized, originalOnly: originalOnly === true, targetLanguage,
    });
    if (!result?.ok) throw new Error(result?.error || '音频捕获没有启动。');
    if (session.synchronized) {
      const viewer = await chrome.tabs.create({ url: `${viewerURL}#${session.id}`, openerTabId: tabId });
      session.viewerTabId = viewer.id;
      await chrome.storage.session.set({ liveCapture: session });
    }
  } catch (error) {
    await stop(session);
    if (error.message?.includes('invoked')) throw new Error('请在 YouTube 页面点击 Chrome 工具栏里的扩展图标，再启动字幕。');
    throw new Error(error.message || '音频捕获没有启动。');
  }
  await chrome.storage.session.set({
    apiKeys: { ...apiKeys, [provider]: apiKey }, selectedProvider: provider, synchronized: session.synchronized,
    originalOnly: originalOnly === true, targetLanguage,
  });
}

chrome.runtime.onMessage.addListener((message, sender, reply) => {
  if (message.target !== 'background' || sender.id !== chrome.runtime.id) return;
  if (sender.url === offscreenURL && message.type === 'captureEvent') {
    const operation = enqueue(async () => {
      const { liveCapture } = await chrome.storage.session.get('liveCapture');
      if (liveCapture?.id !== message.id) return;
      const { id, original, translated, targetLanguage, notice, sequence, revision, expiresAt } = message;
      if (message.ended) await stop(liveCapture, notice);
      else await render(liveCapture.tabId, { type: 'caption', id, original, translated, targetLanguage, notice, sequence, revision, expiresAt });
    });
    operation.then(() => reply(), () => reply());
    return true;
  }

  if (sender.url?.split('#')[0] === viewerURL && message.type === 'stop') {
    enqueue(async () => {
      const { liveCapture } = await chrome.storage.session.get('liveCapture');
      if (liveCapture?.id === message.id && liveCapture.viewerTabId === sender.tab?.id) {
        await stop(liveCapture, message.notice || '');
      }
    }).then(() => reply({ ok: true }), () => reply({ error: '无法停止同步观看。' }));
    return true;
  }

  if (sender.tab && sender.frameId === 0 && message.type === 'playback') {
    const operation = enqueue(async () => {
      const { liveCapture } = await chrome.storage.session.get('liveCapture');
      if (liveCapture?.id !== message.id || liveCapture.tabId !== sender.tab.id) return;
      const { id, playing, revision } = message;
      await chrome.runtime.sendMessage({ target: 'offscreen', type: 'playback', id, playing, revision });
    });
    operation.then(() => reply(), () => reply());
    return true;
  }

  if (sender.url !== popupURL || !['start', 'stop', 'forget'].includes(message.type)) return;
  enqueue(async () => {
    if (message.type === 'start') {
      await start(message);
    } else {
      const { liveCapture } = await chrome.storage.session.get('liveCapture');
      if (liveCapture) await stop(liveCapture);
      await chrome.storage.session.remove(message.type === 'forget' ? ['apiKeys', 'captureNotice'] : 'captureNotice');
    }
  }).then(() => reply({ ok: true }), error => reply({ error: error.message }));
  return true;
});

chrome.tabs.onUpdated.addListener((tabId, change) => {
  if (change.status !== 'loading' && !change.url) return;
  void enqueue(async () => {
    const { liveCapture } = await chrome.storage.session.get('liveCapture');
    if (liveCapture?.tabId === tabId && (change.status === 'loading' || videoId(change.url) !== liveCapture.video)) {
      await stop(liveCapture);
    } else if (liveCapture?.viewerTabId === tabId && change.url && !change.url.startsWith(`${viewerURL}#`)) {
      await stop(liveCapture);
    }
  });
});

chrome.tabs.onRemoved.addListener(tabId => {
  void enqueue(async () => {
    const { liveCapture } = await chrome.storage.session.get('liveCapture');
    if (liveCapture && (liveCapture.tabId === tabId || liveCapture.viewerTabId === tabId)) await stop(liveCapture);
  });
});
