import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import vm from 'node:vm';
import { StreamingASR, getAsrSampleRate } from '../streaming-asr.js';
import { ContextualTranslator } from '../translator.js';
import { defaultSourceLanguage, defaultTargetLanguage, sourceLanguages, targetLanguages } from '../languages.js';

test('manifest.json is valid MV3 v2.0.3 with required permissions', () => {
  const manifest = JSON.parse(readFileSync(new URL('../manifest.json', import.meta.url), 'utf8'));
  assert.equal(manifest.manifest_version, 3);
  assert.equal(manifest.version, '2.0.3');
  assert.ok(manifest.host_permissions.includes('wss://api.deepgram.com/*'));
  assert.ok(manifest.host_permissions.includes('wss://api.openai.com/*'));
  assert.ok(manifest.host_permissions.includes('https://api.deepseek.com/*'));
});

test('languages.js exports valid source and target language lists', () => {
  assert.equal(defaultSourceLanguage, 'multi');
  assert.equal(defaultTargetLanguage, 'zh-Hans');
  assert.ok(sourceLanguages.some((l) => l.code === 'en'));
  assert.ok(targetLanguages.includes('zh-Hans'));
  assert.equal(targetLanguages.length, 47);
});

test('audio-worklet.js resamples 48kHz stereo to 16kHz Int16 mono PCM chunks', () => {
  const code = readFileSync(new URL('../audio-worklet.js', import.meta.url), 'utf8');
  let RegisteredClass;
  const posted = [];

  class FakeAudioWorkletProcessor {
    constructor() {
      this.port = {
        onmessage: null,
        postMessage(msg) {
          posted.push(msg);
        },
      };
    }
  }

  const sandbox = {
    AudioWorkletProcessor: FakeAudioWorkletProcessor,
    sampleRate: 48000,
    registerProcessor(name, cls) {
      assert.equal(name, 'streaming-audio');
      RegisteredClass = cls;
    },
  };
  vm.runInNewContext(code, sandbox);
  assert.ok(RegisteredClass);

  const proc = new RegisteredClass({
    processorOptions: { targetRate: 16000, chunkMs: 100, playing: true, revision: 1 },
  });

  // Feed 4800 samples (= 100ms at 48kHz) in 128-sample WebAudio render quanta
  const totalFrames = 4800;
  for (let offset = 0; offset < totalFrames; offset += 128) {
    const ch0 = new Float32Array(128).fill(0.5);
    const ch1 = new Float32Array(128).fill(0.5);
    proc.process([[ch0, ch1]]);
  }

  assert.equal(posted.length, 1);
  assert.equal(posted[0].type, 'pcm');
  assert.equal(posted[0].pcm.length, 1600);
  assert.ok(posted[0].rms > 0.45 && posted[0].rms < 0.55);
  assert.ok(posted[0].pcm[100] > 16000 && posted[0].pcm[100] < 16500);
});

test('StreamingASR Deepgram WebSocket protocol, interim/final stitching, and CloseStream', async () => {
  assert.equal(getAsrSampleRate('deepgram'), 16000);
  assert.equal(getAsrSampleRate('openai'), 24000);

  let mockWs;
  const OriginalWebSocket = globalThis.WebSocket;
  globalThis.WebSocket = class MockWebSocket {
    static OPEN = 1;
    constructor(url, protocols) {
      this.url = url;
      this.protocols = protocols;
      this.readyState = 1;
      this.sent = [];
      mockWs = this;
      queueMicrotask(() => this.onopen?.());
    }
    send(data) {
      this.sent.push(data);
    }
    close() {
      this.readyState = 3;
      this.onclose?.({ code: 1000 });
    }
  };

  try {
    const interims = [];
    const finals = [];
    const asr = new StreamingASR({
      provider: 'deepgram',
      apiKey: 'dg-test-key',
      sourceLanguage: 'en',
      onInterim: (t) => interims.push(t),
      onFinal: (t) => finals.push(t),
    });

    await asr.connect();
    assert.ok(mockWs.url.startsWith('wss://api.deepgram.com/v1/listen?'));
    assert.ok(mockWs.url.includes('model=nova-3'));
    assert.ok(mockWs.url.includes('language=en'));
    assert.deepEqual(mockWs.protocols, ['token', 'dg-test-key']);

    // Send PCM
    const pcm = new Int16Array([100, -100, 200, -200]);
    asr.sendAudio(pcm);
    assert.equal(mockWs.sent.length, 1);

    // Interim result
    mockWs.onmessage({
      data: JSON.stringify({
        type: 'Results',
        is_final: false,
        channel: { alternatives: [{ transcript: 'hello' }] },
      }),
    });
    assert.deepEqual(interims, ['hello']);

    // Final clause without speech_final or sentence punctuation -> stays interim until speech_final
    mockWs.onmessage({
      data: JSON.stringify({
        type: 'Results',
        is_final: true,
        speech_final: false,
        channel: { alternatives: [{ transcript: 'hello everyone' }] },
      }),
    });
    assert.equal(finals.length, 0);
    assert.equal(interims.at(-1), 'hello everyone');

    // Second clause with speech_final -> emits combined final
    mockWs.onmessage({
      data: JSON.stringify({
        type: 'Results',
        is_final: true,
        speech_final: true,
        channel: { alternatives: [{ transcript: 'welcome to the stream.' }] },
      }),
    });
    assert.deepEqual(finals, ['hello everyone welcome to the stream.']);

    asr.close();
    assert.ok(mockWs.sent.some((s) => typeof s === 'string' && s.includes('CloseStream')));
  } finally {
    globalThis.WebSocket = OriginalWebSocket;
  }
});

test('StreamingASR OpenAI Realtime protocol mints ephemeral token, sends session.update, and auto-commits noisy audio', async () => {
  let mockWs;
  const OriginalWebSocket = globalThis.WebSocket;
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (url) => {
    if (String(url).includes('/v1/realtime/client_secrets')) {
      return new Response(JSON.stringify({ value: 'ek_test_ephemeral' }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      });
    }
    throw new Error(`Unexpected fetch: ${url}`);
  };
  globalThis.WebSocket = class MockWebSocket {
    static OPEN = 1;
    constructor(url, protocols) {
      this.url = url;
      this.protocols = protocols;
      this.readyState = 1;
      this.sent = [];
      mockWs = this;
      queueMicrotask(() => this.onopen?.());
    }
    send(data) {
      this.sent.push(data);
    }
    close() {
      this.readyState = 3;
      this.onclose?.({ code: 1000 });
    }
  };

  try {
    const interims = [];
    const finals = [];
    const asr = new StreamingASR({
      provider: 'openai',
      apiKey: 'sk-test-key',
      sourceLanguage: 'ja',
      onInterim: (t) => interims.push(t),
      onFinal: (t) => finals.push(t),
    });

    await asr.connect();
    assert.equal(mockWs.url, 'wss://api.openai.com/v1/realtime?intent=transcription');
    assert.deepEqual(mockWs.protocols, [
      'realtime',
      'openai-insecure-api-key.ek_test_ephemeral',
    ]);

    const initMsg = JSON.parse(mockWs.sent[0]);
    assert.equal(initMsg.type, 'session.update');
    assert.equal(initMsg.session.type, 'transcription');
    assert.equal(initMsg.session.audio.input.transcription.model, 'gpt-4o-mini-transcribe');
    assert.equal(initMsg.session.audio.input.transcription.language, 'ja');
    assert.equal(initMsg.session.audio.input.turn_detection, null);

    // Simulate 3.2 seconds of continuous loud game audio (32 chunks * 100ms, rms=0.15)
    for (let i = 0; i < 32; i++) {
      asr.sendAudio(new Int16Array([1000, -1000, 2000, -2000]), 0.15, 100);
    }
    const audioMsg = JSON.parse(mockWs.sent[1]);
    assert.equal(audioMsg.type, 'input_audio_buffer.append');
    assert.ok(typeof audioMsg.audio === 'string' && audioMsg.audio.length > 0);
    // Must auto-commit at 3.2s even without silence!
    assert.ok(mockWs.sent.some((m) => JSON.parse(m).type === 'input_audio_buffer.commit'));

    mockWs.onmessage({
      data: JSON.stringify({
        type: 'conversation.item.input_audio_transcription.delta',
        item_id: 'item_1',
        delta: 'こんに',
      }),
    });
    mockWs.onmessage({
      data: JSON.stringify({
        type: 'conversation.item.input_audio_transcription.delta',
        item_id: 'item_1',
        delta: 'ちは',
      }),
    });
    assert.deepEqual(interims, ['こんに', 'こんにちは']);

    mockWs.onmessage({
      data: JSON.stringify({
        type: 'conversation.item.input_audio_transcription.completed',
        item_id: 'item_1',
        transcript: 'こんにちは！',
      }),
    });
    assert.deepEqual(finals, ['こんにちは！']);

    asr.close();
  } finally {
    globalThis.WebSocket = OriginalWebSocket;
    globalThis.fetch = originalFetch;
  }
});

test('ContextualTranslator streams SSE deltas and maintains rolling context window', async () => {
  const requests = [];
  const originalFetch = globalThis.fetch;

  globalThis.fetch = async (url, opts) => {
    requests.push({ url, body: JSON.parse(opts.body) });
    const chunks = [
      'data: {"choices":[{"delta":{"content":"大家好"}}]}\n\n',
      'data: {"choices":[{"delta":{"content":"，欢迎来到直播间！"}}]}\n\n',
      'data: [DONE]\n\n',
    ];
    const stream = new ReadableStream({
      start(controller) {
        for (const chunk of chunks) {
          controller.enqueue(new TextEncoder().encode(chunk));
        }
        controller.close();
      },
    });
    return new Response(stream, { status: 200, headers: { 'Content-Type': 'text/event-stream' } });
  };

  try {
    const translator = new ContextualTranslator({
      provider: 'deepseek',
      apiKey: 'ds-test-key',
      targetLanguage: 'zh-Hans',
    });

    const deltas = [];
    const first = await translator.translateStream('Hello everyone, welcome to the stream!', {
      onDelta: (d) => deltas.push(d),
    });

    assert.equal(first, '大家好，欢迎来到直播间！');
    assert.deepEqual(deltas, ['大家好', '大家好，欢迎来到直播间！']);
    assert.equal(requests[0].url, 'https://api.deepseek.com/chat/completions');
    assert.equal(requests[0].body.model, 'deepseek-chat');
    assert.equal(requests[0].body.stream, true);

    // Second call should include previous utterance in <context>
    await translator.translateStream('Today we are playing Elden Ring.');
    const secondUserMsg = requests[1].body.messages[1].content;
    assert.ok(secondUserMsg.includes('<context>'));
    assert.ok(secondUserMsg.includes('Hello everyone, welcome to the stream! => 大家好，欢迎来到直播间！'));
    assert.ok(secondUserMsg.includes('<current>Today we are playing Elden Ring.</current>'));
  } finally {
    globalThis.fetch = originalFetch;
  }
});
