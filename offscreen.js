import { StreamingASR, getAsrSampleRate } from './streaming-asr.js';
import { ContextualTranslator } from './translator.js';

let active = null;
const MAX_IN_FLIGHT_TRANSLATIONS = 3;

function publish(session, payload) {
  return chrome.runtime.sendMessage({
    target: 'background',
    type: 'captureEvent',
    id: session.id,
    ...payload,
  }).catch(() => {});
}

function cancelTranslations(session) {
  if (session.previewController) {
    session.previewController.abort();
    session.previewController = null;
  }
  for (const controller of session.inFlight.values()) {
    controller.abort();
  }
  session.inFlight.clear();
}

function updatePlayback({ id, playing, revision }) {
  if (!active || active.id !== id || revision <= active.revision) return;
  active.revision = revision;
  active.playing = playing;
  if (!playing) {
    active.asr?.flush();
  }
  active.worklet?.port.postMessage({ playing, revision });
}

async function runPreviewTranslation(session, interimText) {
  if (session.originalOnly || !session.translator || Date.now() < session.translateResumeAt) return;
  const now = Date.now();
  if (now - session.lastPreviewAt < 1200) return;
  if (interimText === session.lastPreviewText) return;

  // Trigger preview only when speaker has been talking continuously without a pause
  const wordCount = interimText.trim().split(/\s+/).length;
  if (interimText.length < 40 && wordCount < 8) return;

  session.lastPreviewAt = now;
  session.lastPreviewText = interimText;

  if (session.previewController) {
    session.previewController.abort();
  }
  const controller = new AbortController();
  session.previewController = controller;
  const currentRevision = session.revision;

  try {
    let lastSent = 0;
    const translated = await session.translator.translateStream(interimText, {
      signal: controller.signal,
      commitToHistory: false,
      onDelta: (partial) => {
        if (active !== session || controller.signal.aborted) return;
        const t = Date.now();
        if (t - lastSent >= 80) {
          lastSent = t;
          void publish(session, {
            event: 'interimTranslation',
            translated: partial,
            targetLanguage: session.targetLanguage,
            revision: currentRevision,
          });
        }
      },
    });
    if (active === session && !controller.signal.aborted && translated) {
      void publish(session, {
        event: 'interimTranslation',
        translated,
        targetLanguage: session.targetLanguage,
        revision: currentRevision,
      });
    }
  } catch {
    // Preview translation errors are non-fatal; wait for final utterance
  } finally {
    if (session.previewController === controller) {
      session.previewController = null;
    }
  }
}

async function translateFinal(session, utteranceId, original, revision) {
  if (session.originalOnly || !session.translator) return;
  if (Date.now() < session.translateResumeAt) return;

  // Cap concurrent translations so slow networks don't pile up stale requests
  if (session.inFlight.size >= MAX_IN_FLIGHT_TRANSLATIONS) {
    const [oldestId] = session.inFlight.keys();
    session.inFlight.get(oldestId)?.abort();
    session.inFlight.delete(oldestId);
  }

  const controller = new AbortController();
  session.inFlight.set(utteranceId, controller);

  try {
    let lastSent = 0;
    const finalTranslated = await session.translator.translateStream(original, {
      signal: controller.signal,
      commitToHistory: true,
      onDelta: (partial) => {
        if (active !== session || controller.signal.aborted) return;
        const now = Date.now();
        if (now - lastSent >= 60) {
          lastSent = now;
          void publish(session, {
            event: 'translation',
            utteranceId,
            translated: partial,
            done: false,
            targetLanguage: session.targetLanguage,
            revision,
          });
        }
      },
    });

    if (active === session && !controller.signal.aborted && finalTranslated) {
      void publish(session, {
        event: 'translation',
        utteranceId,
        translated: finalTranslated,
        done: true,
        targetLanguage: session.targetLanguage,
        revision,
      });
    }
  } catch (error) {
    if (controller.signal.aborted || active !== session) return;
    if (error.fatal) {
      session.playing = false;
      cancelTranslations(session);
      void publish(session, { ended: true, notice: error.message });
      return;
    }
    session.translateResumeAt = Math.max(session.translateResumeAt, Date.now() + (error.backoff ?? 2500));
    void publish(session, { event: 'notice', notice: error.message, revision });
  } finally {
    session.inFlight.delete(utteranceId);
  }
}

async function stop() {
  const session = active;
  if (!session) return;
  active = null;
  cancelTranslations(session);
  session.asr?.close();
  session.worklet?.port.close();
  for (const track of session.stream?.getTracks() ?? []) {
    track.stop();
  }
  if (session.context && session.context.state !== 'closed') {
    await session.context.close().catch(() => {});
  }
}

async function start({
  id,
  streamId,
  asrProvider,
  asrKey,
  translateProvider,
  translateKey,
  sourceLanguage,
  originalOnly,
  targetLanguage,
  playback,
}) {
  if (active) throw new Error('字幕已在运行中，请先停止。');

  const session = {
    id,
    asrProvider,
    translateProvider,
    sourceLanguage,
    originalOnly: Boolean(originalOnly),
    targetLanguage,
    playing: Boolean(playback?.playing),
    revision: playback?.revision || 0,
    utteranceId: 0,
    inFlight: new Map(),
    previewController: null,
    lastPreviewAt: 0,
    lastPreviewText: '',
    translateResumeAt: 0,
  };
  active = session;

  try {
    // 1. Initialize contextual translator if needed
    if (!session.originalOnly) {
      session.translator = new ContextualTranslator({
        provider: translateProvider,
        apiKey: translateKey,
        targetLanguage,
      });
    }

    // 2. Connect Streaming WebSocket ASR first (validates key & network immediately)
    const targetRate = getAsrSampleRate(asrProvider);
    session.asr = new StreamingASR({
      provider: asrProvider,
      apiKey: asrKey,
      sourceLanguage,
      onStatus: (notice) => {
        if (active === session) {
          void publish(session, { event: 'status', notice, revision: session.revision });
        }
      },
      onInterim: (text) => {
        if (active !== session) return;
        void publish(session, {
          event: 'interim',
          text,
          revision: session.revision,
        });
        if (text) {
          void runPreviewTranslation(session, text);
        }
      },
      onFinal: (text) => {
        if (active !== session || !text) return;
        if (session.previewController) {
          session.previewController.abort();
          session.previewController = null;
        }
        session.lastPreviewText = '';
        const utteranceId = ++session.utteranceId;
        const rev = session.revision;
        void publish(session, {
          event: 'final',
          utteranceId,
          original: text,
          originalOnly: session.originalOnly,
          targetLanguage: session.targetLanguage,
          revision: rev,
        });
        if (!session.originalOnly) {
          void translateFinal(session, utteranceId, text, rev);
        }
      },
      onError: (error) => {
        if (active !== session) return;
        if (error.fatal) {
          session.playing = false;
          cancelTranslations(session);
          void publish(session, { ended: true, notice: error.message });
        } else {
          void publish(session, { event: 'notice', notice: error.message, revision: session.revision });
        }
      },
    });

    await session.asr.connect();

    // 3. Capture tab audio only (zero video encoding overhead!)
    session.stream = await navigator.mediaDevices.getUserMedia({
      audio: {
        mandatory: {
          chromeMediaSource: 'tab',
          chromeMediaSourceId: streamId,
        },
      },
      video: false,
    });

    for (const track of session.stream.getTracks()) {
      track.addEventListener('ended', () => {
        if (active === session) {
          void publish(session, { ended: true, notice: '标签页音频捕获已结束。' });
        }
      });
    }

    // 4. Route audio: source -> speakers (normal playback) AND source -> worklet -> silentGain -> destination
    const context = (session.context = new AudioContext());
    const source = context.createMediaStreamSource(session.stream);
    source.connect(context.destination);

    await context.audioWorklet.addModule('audio-worklet.js');
    const worklet = (session.worklet = new AudioWorkletNode(context, 'streaming-audio', {
      numberOfInputs: 1,
      numberOfOutputs: 1,
      channelCount: 2,
      channelCountMode: 'explicit',
      processorOptions: {
        targetRate,
        chunkMs: 100,
        playing: session.playing,
        revision: session.revision,
      },
    }));

    source.connect(worklet).connect(context.destination);

    worklet.port.onmessage = ({ data }) => {
      if (active !== session || !session.playing || data.revision !== session.revision) return;
      if (data.type === 'pcm' && data.pcm) {
        session.asr.sendAudio(data.pcm, data.rms ?? 0.02, 100);
      }
    };

    worklet.addEventListener('processorerror', () => {
      if (active === session) {
        void publish(session, { ended: true, notice: '音频处理意外中断，请重新启动字幕。' });
      }
    });

    let timer;
    try {
      await Promise.race([
        context.resume(),
        new Promise((_, reject) => {
          timer = setTimeout(() => reject(new Error('Chrome 未能启用标签页音频。')), 4000);
        }),
      ]);
    } finally {
      clearTimeout(timer);
    }
  } catch (error) {
    await stop();
    throw error;
  }
}

chrome.runtime.onMessage.addListener((message, sender, reply) => {
  if (message.target !== 'offscreen' || sender.id !== chrome.runtime.id || sender.tab) return;
  if (message.type === 'playback') {
    updatePlayback(message);
    reply({ ok: true });
    return;
  }
  const operation = message.type === 'start' ? start(message) : stop();
  operation.then(
    () => reply({ ok: true }),
    (err) => reply({ error: err?.message || '无法启动实时字幕，请检查播放器及网络后重试。' })
  );
  return true;
});
