import { CaptionPhrases } from './caption-phrases.js';
import { MusicListener } from './music.js';
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
  clearTimeout(session.interimTimer);
  session.interimTimer = null;
  session.lastInterimAt = 0;
  clearTimeout(session.previewTimer);
  session.preview?.controller.abort();
  session.preview = null;
  session.interim = '';
  for (const job of session.inFlight.values()) job.controller.abort();
  session.inFlight.clear();
}

function updatePlayback({ id, playing, revision }) {
  if (!active || active.id !== id || revision <= active.revision) return;
  cancelTranslations(active);
  active.phrases?.reset();
  active.quietMs = 0;
  active.music?.reset(revision);
  active.revision = revision;
  active.playing = playing;
  if (!playing) active.asr?.flush();
  active.worklet?.port.postMessage({ playing, revision });
}

function phrase(text) {
  return text.trim().replace(/[.。]+$/u, '').trimEnd();
}

function queuePreview(session) {
  const text = session.interim;
  if (!session.translator || !text || Date.now() < session.translateResumeAt) return;
  const previous = session.preview;
  if (previous && (!previous.finished || phrase(previous.text) === phrase(text))) return;
  const shortPhrase = /\s|[。！？.!?]$/u.test(text) || /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]{3}/u.test(text);
  if (text.length < 8 && !shortPhrase) return;
  // Coalesce expansions while a stream is in flight, then translate the latest text.
  const delay = previous ? previous.started + 650 - Date.now() : 0;
  clearTimeout(session.previewTimer);
  if (delay > 0) {
    session.previewTimer = setTimeout(() => queuePreview(session), delay);
    return;
  }
  startTranslation(session, session.nextId, text, false);
}

function startTranslation(session, id, text, final) {
  const revision = session.revision;
  const job = { text, final, partial: '', finished: false, started: Date.now(), controller: new AbortController() };
  if (!final) session.preview = job;
  session.inFlight.delete(id); // A revised final can replace an aborted preview for this ID.
  if (session.inFlight.size >= MAX_IN_FLIGHT_TRANSLATIONS) {
    const [oldId, oldest] = session.inFlight.entries().next().value;
    oldest.controller.abort();
    session.inFlight.delete(oldId);
  }
  session.inFlight.set(id, job);
  const valid = () => active === session && session.revision === revision && !job.controller.signal.aborted;
  function send(translated, done) {
    if (!valid()) return;
    job.partial = translated;
    if (!job.final && !phrase(session.interim).startsWith(phrase(job.text))) return;
    void publish(session, {
      event: job.final ? 'translation' : 'interimTranslation',
      utteranceId: id, original: job.text, translated, done, revision,
    });
  }

  let lastSent = 0;
  session.translator.translateStream(text, {
    signal: job.controller.signal,
    commitToHistory: false,
    lyrics: session.music?.kind === 'singing',
    onDelta: partial => {
      job.partial = partial;
      if (Date.now() - lastSent >= 60) {
        lastSent = Date.now();
        send(partial, false);
      }
    },
  }).then(translated => {
    if (!valid()) return;
    job.finished = true;
    if (translated) {
      send(translated, true);
      if (job.final) session.translator.record(job.text, translated);
    }
    if (!job.final && session.preview === job) queuePreview(session);
  }).catch(error => {
    if (!valid()) return;
    job.finished = true;
    job.partial = '';
    if (error.fatal) {
      session.playing = false;
      cancelTranslations(session);
      void publish(session, { ended: true, notice: error.message });
    } else if (job.final || error.backoff) {
      session.translateResumeAt = Date.now() + (error.backoff ?? 2500);
      void publish(session, { event: 'notice', notice: error.message, revision });
    }
  }).finally(() => {
    if (session.inFlight.get(id) === job) session.inFlight.delete(id);
  });
}

async function stop() {
  const session = active;
  if (!session) return;
  active = null;
  cancelTranslations(session);
  session.phrases?.reset();
  session.music?.close();
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
  musicMode,
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
    nextId: 1,
    quietMs: 0,
    lastInterimAt: 0,
    interimTimer: null,
    inFlight: new Map(),
    preview: null,
    interim: '',
    previewTimer: null,
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
    const paintInterim = () => {
      session.interimTimer = null;
      session.lastInterimAt = Date.now();
      void publish(session, { event: 'interim', utteranceId: session.nextId, text: session.interim, revision: session.revision });
      queuePreview(session);
    };
    const onInterim = text => {
      if (active !== session || !session.playing || text === session.interim) return;
      session.interim = text;
      if (session.interimTimer !== null) return;
      const wait = session.lastInterimAt + 80 - Date.now();
      if (wait > 0) session.interimTimer = setTimeout(paintInterim, wait);
      else paintInterim();
    };
    const onFinal = text => {
      const id = session.nextId;
      if (active !== session || !session.playing || !text) return;
      clearTimeout(session.previewTimer);
      clearTimeout(session.interimTimer);
      session.interimTimer = null;
      session.lastInterimAt = 0;
      session.music?.line(text);
      const preview = session.preview;
      const reuse = preview && phrase(text) === phrase(preview.text) &&
        (!preview.finished || Boolean(preview.partial));
      const translated = preview && phrase(text).startsWith(phrase(preview.text)) ? preview.partial : '';
      session.preview = null;
      session.interim = '';
      session.nextId = id + 1;
      void publish(session, {
        event: 'final', utteranceId: id, original: text, translated, done: Boolean(reuse && preview.finished),
        originalOnly: session.originalOnly, targetLanguage: session.targetLanguage, revision: session.revision,
      });
      if (reuse) {
        preview.final = true;
        preview.text = text;
        if (preview.finished) session.translator.record(text, preview.partial);
      } else {
        preview?.controller.abort();
        if (session.translator && Date.now() >= session.translateResumeAt) startTranslation(session, id, text, true);
      }
    };
    session.phrases = new CaptionPhrases(onInterim, onFinal, sourceLanguage);
    session.asr = new StreamingASR({
      provider: asrProvider,
      apiKey: asrKey,
      sourceLanguage,
      onStatus: (notice) => {
        if (active === session) {
          void publish(session, { event: 'status', notice, revision: session.revision });
        }
      },
      onInterim: text => { if (session.playing) session.phrases.interim(text); },
      onFinal: text => { if (session.playing) session.phrases.final(text); },
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

    if (musicMode && musicMode !== 'off') {
      const unavailable = () => {
        if (active === session) void publish(session, { event: 'notice', notice: '音乐检测未能启动，语音字幕继续运行。', revision: session.revision });
      };
      try {
        session.music = new MusicListener(targetRate, musicMode === 'identify' ? session.translator : null, (kind, track) => {
          if (active === session && session.playing) {
            void publish(session, { event: 'music', kind, track, revision: session.revision });
          }
        }, unavailable);
        session.music.reset(session.revision);
      } catch {
        unavailable();
      }
    }

    worklet.port.onmessage = ({ data }) => {
      if (active !== session || !session.playing || data.revision !== session.revision) return;
      if (data.type === 'pcm' && data.pcm) {
        session.asr.sendAudio(data.pcm, data.rms ?? 0.02, 100);
        session.quietMs = data.rms < 0.004 ? session.quietMs + 100 : 0;
        session.phrases.quiet(session.quietMs);
        session.music?.push(data.pcm);
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
