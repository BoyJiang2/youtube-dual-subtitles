import { defaultSourceLanguage, defaultTargetLanguage, sourceLanguages, targetLanguages } from './languages.js';

const offscreenURL = chrome.runtime.getURL('offscreen.html');
const popupURL = chrome.runtime.getURL('popup.html');
let operations = Promise.resolve();

function enqueue(operation) {
  const next = operations.then(operation);
  operations = next.catch(() => {});
  return next;
}

function videoId(url) {
  if (!url) return null;
  try {
    const page = new URL(url);
    if (page.origin !== 'https://www.youtube.com') return null;
    if (page.pathname === '/watch') return page.searchParams.get('v');
    return /^\/live\/([\w-]+)\/?$/.exec(page.pathname)?.[1] ?? null;
  } catch {
    return null;
  }
}

async function captureDocument() {
  const [context] = await chrome.runtime.getContexts({
    contextTypes: ['OFFSCREEN_DOCUMENT'],
    documentUrls: [offscreenURL],
  });
  return context;
}

function sendToOverlay(tabId, data) {
  return chrome.tabs.sendMessage(tabId, { target: 'overlay', ...data }).catch(() => null);
}

async function stop(session, notice = '') {
  if (await captureDocument()) {
    await chrome.runtime.sendMessage({ target: 'offscreen', type: 'stop' }).catch(() => {});
    await chrome.offscreen.closeDocument().catch(() => {});
  }
  await chrome.storage.session.remove(['liveCapture', 'liveStatus']);
  if (notice) {
    await chrome.storage.session.set({ captureNotice: { tabId: session.tabId, text: notice } });
  }
  await sendToOverlay(session.tabId, { type: 'stop', id: session.id, notice });
}

function validateKey(key, label) {
  if (!key) throw new Error(`请填写 ${label} 的 API 密钥。`);
  if (!/^[\x21-\x7e]{1,512}$/.test(key)) {
    throw new Error(`${label} API 密钥格式无效，请检查是否有多余空格或换行。`);
  }
}

async function start({
  tabId,
  asrProvider = 'deepgram',
  asrKey,
  translateProvider = 'deepseek',
  translateKey,
  sourceLanguage = defaultSourceLanguage,
  originalOnly = false,
  targetLanguage = defaultTargetLanguage,
}) {
  const { liveCapture } = await chrome.storage.session.get('liveCapture');
  if (liveCapture) throw new Error('已有标签页正在运行实时字幕，请先停止。');

  const saved = await chrome.storage.local.get('apiKeys');
  const apiKeys = saved.apiKeys || {};

  if (!['deepgram', 'openai'].includes(asrProvider)) throw new Error('请选择语音识别服务。');
  if (!originalOnly && !['deepseek', 'openai'].includes(translateProvider)) throw new Error('请选择翻译服务。');
  if (!sourceLanguages.some((l) => l.code === sourceLanguage)) sourceLanguage = defaultSourceLanguage;
  if (!targetLanguages.includes(targetLanguage)) targetLanguage = defaultTargetLanguage;

  const resolvedAsrKey = asrKey?.trim() || apiKeys[asrProvider];
  validateKey(resolvedAsrKey, asrProvider === 'deepgram' ? 'Deepgram' : 'OpenAI');

  let resolvedTranslateKey = '';
  if (!originalOnly) {
    if (translateProvider === asrProvider) {
      resolvedTranslateKey = translateKey?.trim() || resolvedAsrKey;
    } else {
      resolvedTranslateKey = translateKey?.trim() || apiKeys[translateProvider];
    }
    validateKey(resolvedTranslateKey, translateProvider === 'deepseek' ? 'DeepSeek' : 'OpenAI');
  }

  const tab = await chrome.tabs.get(tabId);
  const video = videoId(tab.url);
  if (!tab.active || !video) throw new Error('请在正在播放的 YouTube 直播或视频页面打开扩展。');

  const session = {
    id: crypto.randomUUID(),
    tabId,
    video,
    asrProvider,
    translateProvider: originalOnly ? null : translateProvider,
    originalOnly: Boolean(originalOnly),
  };

  try {
    await chrome.scripting.executeScript({ target: { tabId }, files: ['overlay.js'] });
    if (!(await captureDocument())) {
      await chrome.offscreen.createDocument({
        url: 'offscreen.html',
        reasons: ['USER_MEDIA'],
        justification: '捕获当前 YouTube 标签页音频以进行实时流式语音识别与翻译。',
      });
    }

    const streamId = await chrome.tabCapture.getMediaStreamId({ targetTabId: tabId });
    if (videoId((await chrome.tabs.get(tabId)).url) !== video) {
      throw new Error('视频页面已切换，请重新启动。');
    }

    await chrome.storage.session.remove('captureNotice');
    await chrome.storage.session.set({ liveCapture: session });

    const playback = await sendToOverlay(tabId, {
      type: 'start',
      id: session.id,
      originalOnly: session.originalOnly,
      targetLanguage,
    });
    if (!playback) throw new Error('无法连接 YouTube 播放器，请刷新页面后重试。');

    const result = await chrome.runtime.sendMessage({
      target: 'offscreen',
      type: 'start',
      id: session.id,
      streamId,
      asrProvider,
      asrKey: resolvedAsrKey,
      translateProvider,
      translateKey: resolvedTranslateKey,
      sourceLanguage,
      originalOnly: session.originalOnly,
      targetLanguage,
      playback,
    });
    if (!result?.ok) throw new Error(result?.error || '无法启动实时语音识别。');
  } catch (error) {
    await stop(session);
    if (error.message?.includes('invoked')) {
      throw new Error('请先在 YouTube 页面点击工具栏上的扩展图标，再启动字幕。');
    }
    throw new Error(error.message || '实时字幕启动失败。');
  }

  const nextKeys = { ...apiKeys, [asrProvider]: resolvedAsrKey };
  if (!originalOnly && resolvedTranslateKey) {
    nextKeys[translateProvider] = resolvedTranslateKey;
  }

  await chrome.storage.local.set({
    apiKeys: nextKeys,
    asrProvider,
    translateProvider,
    sourceLanguage,
    originalOnly: Boolean(originalOnly),
    targetLanguage,
  });
}

chrome.runtime.onMessage.addListener((message, sender, reply) => {
  if (message.target !== 'background' || sender.id !== chrome.runtime.id) return;

  if (sender.url === offscreenURL && message.type === 'captureEvent') {
    const operation = enqueue(async () => {
      const { liveCapture } = await chrome.storage.session.get('liveCapture');
      if (liveCapture?.id !== message.id) return;
      if (message.ended) {
        await stop(liveCapture, message.notice || '');
      } else {
        if (message.event === 'status' || message.event === 'notice') {
          await chrome.storage.session.set({
            liveStatus: { tabId: liveCapture.tabId, text: message.notice || '', isError: message.event === 'notice' },
          });
        } else if (message.event === 'interim' || message.event === 'final') {
          await chrome.storage.session.remove('liveStatus');
        }
        await sendToOverlay(liveCapture.tabId, { ...message, type: 'captionEvent' });
      }
    });
    operation.then(() => reply(), () => reply());
    return true;
  }

  if (sender.tab && sender.frameId === 0 && message.type === 'playback') {
    const operation = enqueue(async () => {
      const { liveCapture } = await chrome.storage.session.get('liveCapture');
      if (liveCapture?.id !== message.id || liveCapture.tabId !== sender.tab.id) return;
      await chrome.runtime.sendMessage({
        target: 'offscreen',
        type: 'playback',
        id: message.id,
        playing: message.playing,
        revision: message.revision,
      }).catch(() => {});
    });
    operation.then(() => reply(), () => reply());
    return true;
  }

  if (sender.tab && sender.frameId === 0 && message.type === 'overlayStop') {
    enqueue(async () => {
      const { liveCapture } = await chrome.storage.session.get('liveCapture');
      if (liveCapture?.id === message.id && liveCapture.tabId === sender.tab.id) {
        await stop(liveCapture);
      }
    }).then(() => reply({ ok: true }), () => reply({ ok: false }));
    return true;
  }

  if (sender.url !== popupURL || !['start', 'stop', 'forget'].includes(message.type)) return;
  enqueue(async () => {
    if (message.type === 'start') {
      await start(message);
    } else if (message.type === 'stop') {
      const { liveCapture } = await chrome.storage.session.get('liveCapture');
      if (liveCapture) await stop(liveCapture);
      await chrome.storage.session.remove('captureNotice');
    } else if (message.type === 'forget') {
      const { liveCapture } = await chrome.storage.session.get('liveCapture');
      if (liveCapture) await stop(liveCapture);
      await chrome.storage.local.remove('apiKeys');
      await chrome.storage.session.remove('captureNotice');
    }
  }).then(
    () => reply({ ok: true }),
    (error) => reply({ error: error.message })
  );
  return true;
});

chrome.tabs.onUpdated.addListener((tabId, change) => {
  if (change.status !== 'loading' && !change.url) return;
  void enqueue(async () => {
    const { liveCapture } = await chrome.storage.session.get('liveCapture');
    if (liveCapture?.tabId === tabId && (change.status === 'loading' || videoId(change.url) !== liveCapture.video)) {
      await stop(liveCapture);
    }
  });
});

chrome.tabs.onRemoved.addListener((tabId) => {
  void enqueue(async () => {
    const { liveCapture } = await chrome.storage.session.get('liveCapture');
    if (liveCapture?.tabId === tabId) await stop(liveCapture);
  });
});
