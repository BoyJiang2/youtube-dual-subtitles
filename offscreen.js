import { transcribe, translate } from './api.js';

let active;
const maxInFlight = 3;
const maxCaptionAge = 4000;

function publish(session, event) {
  return chrome.runtime.sendMessage({ target: 'background', type: 'captureEvent', id: session.id, ...event })
    .catch(() => {});
}

function openSynchronizedView(session, geometry) {
  const mimeType = 'video/webm;codecs=vp8,opus';
  const recorder = new MediaRecorder(session.stream, { mimeType, videoBitsPerSecond: 2_800_000 });
  const channel = new BroadcastChannel(`captions-${session.id}`);
  const view = session.view = { recorder, channel };
  channel.onmessage = ({ data }) => {
    if (data.type !== 'ready') return;
    if (recorder.state !== 'inactive') {
      channel.postMessage({ type: 'closed', notice: '同步页面已刷新。请在 YouTube 页面重新启动。' });
      void publish(session, { ended: true });
      return;
    }
    view.startedAt = performance.now();
    session.worklet.port.postMessage({ playing: session.playing, revision: session.revision });
    channel.postMessage({ type: 'init', mimeType, geometry });
    recorder.start(250);
  };
  recorder.ondataavailable = ({ data }) => {
    if (active === session && data.size) channel.postMessage({ type: 'media', chunk: data });
  };
  recorder.onerror = () => void publish(session, { ended: true, notice: '同步视频编码已中断，请重新启动。' });
}

function makeWav(samples, rate) {
  const header = new DataView(new ArrayBuffer(44));
  const tag = (offset, value) => {
    for (let i = 0; i < value.length; i++) header.setUint8(offset + i, value.charCodeAt(i));
  };
  tag(0, 'RIFF');
  header.setUint32(4, 36 + samples.byteLength, true);
  tag(8, 'WAVEfmt ');
  header.setUint32(16, 16, true);
  header.setUint16(20, 1, true);
  header.setUint16(22, 1, true);
  header.setUint32(24, rate, true);
  header.setUint32(28, rate * 2, true);
  header.setUint16(32, 2, true);
  header.setUint16(34, 16, true);
  tag(36, 'data');
  header.setUint32(40, samples.byteLength, true);
  return new Blob([header.buffer, samples], { type: 'audio/wav' });
}

function cancelPending(session) {
  for (const controller of session.inFlight.values()) controller.abort();
  session.inFlight.clear();
}

function updatePlayback({ id, playing, revision }) {
  if (!active || active.id !== id || revision <= active.revision) return;
  active.revision = revision;
  active.playing = playing;
  if (!active.view) cancelPending(active);
  active.worklet?.port.postMessage({ playing, revision });
}

async function processChunk(session, { audio, audioEnd, voiceStart, voiceEnd, revision }) {
  const { provider, key, context, inFlight, view, targetLanguage } = session;
  if (view && view.startedAt === undefined) return;
  const age = Math.max(0, (context.currentTime - audioEnd) * 1000);
  const remaining = (view ? 5500 : maxCaptionAge) - age;
  if (remaining <= 0) return;
  const offset = view ? (performance.now() - view.startedAt) / 1000 - context.currentTime : 0;
  const startTime = Math.max(0, voiceStart + offset);
  const endTime = voiceEnd + offset;
  const sequence = ++session.sequence;
  const expiresAt = Date.now() + remaining;
  if (inFlight.size >= (view ? 5 : maxInFlight)) {
    const [oldest] = inFlight.keys();
    inFlight.get(oldest).abort();
    inFlight.delete(oldest);
  }
  const controller = new AbortController();
  const { signal } = controller;
  inFlight.set(sequence, controller);
  const timeout = setTimeout(() => controller.abort(), remaining);
  let originalTimer;
  let original;

  function show(translated = '') {
    if (signal.aborted || Date.now() >= expiresAt) return;
    if (view) {
      if (endTime > startTime) {
        view.channel.postMessage({ type: 'caption', sequence, original, translated, targetLanguage, startTime, endTime });
      }
    } else if (sequence >= session.latestDisplayed) {
      session.latestDisplayed = sequence;
      void publish(session, { original, translated, targetLanguage, sequence, revision, expiresAt });
    }
  }

  try {
    original = await transcribe(provider, key, makeWav(audio, context.sampleRate), signal);
    if (!original || signal.aborted || (!view && sequence < session.latestDisplayed)) return;
    if (session.originalOnly) {
      show();
      return;
    }
    // A fast translation can appear with the original as one pair.
    if (view) show();
    else {
      originalTimer = setTimeout(() => {
        const [oldest] = inFlight.keys();
        if (oldest === sequence) show();
      }, 650);
    }
    const translated = await translate(provider, key, original, targetLanguage, signal);
    show(translated);
  } catch (error) {
    if (signal.aborted) return;
    if (error.fatal) {
      session.playing = false;
      cancelPending(session);
      void publish(session, { ended: true, notice: error.message });
      return;
    }
    session.resumeAt = Math.max(session.resumeAt, Date.now() + (error.backoff ?? 2000));
    if (view) view.channel.postMessage({ type: 'notice', notice: error.message });
    else if (sequence >= session.latestDisplayed) {
      void publish(session, { original, revision, sequence, expiresAt, notice: error.message });
    }
  } finally {
    clearTimeout(originalTimer);
    clearTimeout(timeout);
    inFlight.delete(sequence);
  }
}

async function stop() {
  const session = active;
  if (!session) return;
  active = undefined;
  cancelPending(session);
  if (session.view) {
    const { recorder, channel } = session.view;
    if (recorder.state !== 'inactive') recorder.stop();
    channel.close();
  }
  session.worklet?.port.close();
  for (const track of session.stream?.getTracks() ?? []) track.stop();
  if (session.context && session.context.state !== 'closed') await session.context.close();
}

async function start({ id, streamId, provider, key, playback, synchronized, originalOnly, targetLanguage }) {
  if (active) throw new Error('字幕已经启动。');
  const session = { id, provider, key, originalOnly, targetLanguage, ...playback,
    inFlight: new Map(), sequence: 0, latestDisplayed: 0, resumeAt: 0 };
  active = session;
  try {
    session.stream = await navigator.mediaDevices.getUserMedia({
      audio: { mandatory: { chromeMediaSource: 'tab', chromeMediaSourceId: streamId } },
      video: synchronized ? { mandatory: {
        chromeMediaSource: 'tab', chromeMediaSourceId: streamId,
        maxWidth: 1600, maxHeight: 1000, maxFrameRate: 30,
      } } : false,
    });
    for (const track of session.stream.getTracks()) {
      track.addEventListener('ended', () => {
        if (active === session) void publish(session, { ended: true, notice: '标签页捕获已结束。' });
      });
    }

    const context = session.context = new AudioContext({ sampleRate: 48_000 });
    const source = context.createMediaStreamSource(session.stream);
    if (!synchronized) source.connect(context.destination);
    await context.audioWorklet.addModule('audio-worklet.js');
    const worklet = session.worklet = new AudioWorkletNode(context, 'caption-audio', {
      channelCount: 1, channelCountMode: 'explicit',
      processorOptions: { playing: session.playing, revision: session.revision },
    });
    worklet.port.onmessage = ({ data }) => {
      if (active !== session || !session.playing || data.revision !== session.revision || Date.now() < session.resumeAt) return;
      void processChunk(session, data);
    };
    worklet.addEventListener('processorerror', () => {
      if (active === session) void publish(session, { ended: true, notice: '音频处理已中断，请重新启动字幕。' });
    });
    source.connect(worklet).connect(context.destination);
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
    if (synchronized) openSynchronizedView(session, playback.geometry);
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
  operation.then(() => reply({ ok: true }), () => reply({ error: '无法启用标签页音频。请检查播放器是否正在播放，然后重试。' }));
  return true;
});
