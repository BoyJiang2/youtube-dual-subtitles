import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import vm from 'node:vm';
import { StreamingASR } from '../streaming-asr.js';

// Drive the offscreen entry point with incremental recognition and a manually
// paced translation stream. No credentials, wall-clock sleeps or network.
async function capture(originalOnly = false, clock = Date) {
  const requests = [];
  const events = [];
  const history = [];
  let asr, listener;
  const node = { connect() { return this; } };
  const sandbox = {
    AbortController, setTimeout, clearTimeout, Date: clock,
    chrome: { runtime: { id: 'test', sendMessage: async m => events.push(m),
      onMessage: { addListener: f => { listener = f; } } } },
    navigator: { mediaDevices: { getUserMedia: async () => ({ getTracks: () => [] }) } },
    getAsrSampleRate: () => 16000,
    StreamingASR: class {
      constructor(options) { asr = options; }
      async connect() {}
      close() {}
    },
    ContextualTranslator: class {
      translateStream(text, options) {
        return new Promise(resolve => requests.push({ text, ...options, resolve }));
      }
      record(text, translated) { history.push([text, translated]); }
    },
    AudioContext: class {
      audioWorklet = { addModule: async () => {} };
      createMediaStreamSource() { return node; }
      async resume() {}
      async close() {}
    },
    AudioWorkletNode: class {
      port = { close() {} };
      addEventListener() {}
    },
  };
  const source = readFileSync(new URL('../offscreen.js', import.meta.url), 'utf8');
  vm.runInNewContext(source.replace(/^import .*;$/gm, ''), sandbox);
  const send = message => new Promise(resolve => listener(
    { id: 'capture', target: 'offscreen', ...message }, { id: 'test' }, resolve));
  const result = await send({ type: 'start', playback: { playing: true }, originalOnly });
  assert.equal(result.ok, true, result.error);
  return { asr, requests, events, history, stop: () => send({ type: 'stop' }) };
}

test('a short interim begins translation before the final and the same stream finishes it', async () => {
  const { asr, requests, events, history, stop } = await capture();
  try {
    asr.onInterim('Take the turn');
    assert.equal(requests.length, 1, 'short phrase is already translating');
    requests[0].onDelta('转');
    asr.onFinal('Take the turn.');
    assert.equal(requests.length, 1, 'final reuses the in-flight preview');
    assert.equal(requests[0].signal.aborted, false);
    assert.equal(events.find(e => e.event === 'final').translated, '转');
    requests[0].resolve('转弯。');
    await new Promise(setImmediate);
    assert.equal(events.filter(e => e.event === 'translation' && e.done).at(-1).translated, '转弯。');
    assert.deepEqual(history, [['Take the turn.', '转弯。']]);
  } finally { await stop(); }
});

test('a completed preview is reused and a changed final gets its own translation', async () => {
  const { asr, requests, events, stop } = await capture();
  try {
    asr.onInterim('Go to the right and follow the main road');
    requests[0].resolve('右转后沿主路走');
    await new Promise(setImmediate);
    asr.onFinal('Go to the right and follow the main road.');
    assert.equal(requests.length, 1);
    assert.equal(events.find(e => e.event === 'final').translated, '右转后沿主路走');
    asr.onInterim('We are heading north');
    const wrong = requests.at(-1);
    asr.onFinal('We are heading south.');
    assert.equal(wrong.signal.aborted, true);
    assert.equal(requests.at(-1).text, 'We are heading south.');
    assert.equal(events.filter(e => e.event === 'final').at(-1).translated, '');
  } finally { await stop(); }
});

test('original-only produces source events without any translation requests', async () => {
  const { asr, requests, events, stop } = await capture(true);
  try {
    asr.onInterim('Take the turn');
    asr.onFinal('Take the turn.');
    assert.deepEqual(requests, []);
    assert.deepEqual(events.map(e => e.event), ['interim', 'final']);
  } finally { await stop(); }
});

test('out-of-order HTTP recognition cannot replace a newer caption', async t => {
  const pending = [];
  t.mock.method(globalThis, 'fetch', () => new Promise(resolve => pending.push(resolve)));
  const finals = [];
  const asr = new StreamingASR({ provider: 'openai-http', onFinal: text => finals.push(text) });
  const first = asr.transcribeHttpChunks([new Int16Array(1600)]);
  const second = asr.transcribeHttpChunks([new Int16Array(1600)]);
  pending[1](Response.json({ text: 'new' }));
  await second;
  pending[0](Response.json({ text: 'old' }));
  await first;
  assert.deepEqual(finals, ['new']);
  assert.equal(asr.httpLastPrompt, 'new');
});

test('a late Realtime completion cannot replace the next speaking turn', () => {
  const events = [];
  const asr = new StreamingASR({ provider: 'openai', onFinal: t => events.push(t), onInterim: t => events.push(t) });
  for (const id of ['a', 'b']) asr.handleOpenAIMessage({ type: 'input_audio_buffer.committed', item_id: id });
  asr.handleOpenAIMessage({ type: 'conversation.item.input_audio_transcription.delta', item_id: 'b', delta: 'new' });
  asr.handleOpenAIMessage({ type: 'conversation.item.input_audio_transcription.completed', item_id: 'a', transcript: 'old' });
  asr.handleOpenAIMessage({ type: 'conversation.item.input_audio_transcription.completed', item_id: 'b', transcript: 'new final' });
  assert.deepEqual(events, ['new', 'new final']);
});

test('continuous audio is submitted within 2s on Realtime and 2.4s on HTTP', () => {
  for (const [provider, limit] of [['openai', 2000], ['openai-http', 2400]]) {
    const asr = new StreamingASR({ provider });
    let submits = 0;
    asr.ws = { readyState: WebSocket.OPEN, send(s) { if (JSON.parse(s).type === 'input_audio_buffer.commit') submits++; } };
    asr.transcribeHttpChunks = () => { submits++; };
    for (let ms = 0; ms < limit; ms += 100) asr.sendAudio(new Int16Array(16), 0.15, 100);
    assert.equal(submits, 1, provider);
  }
});

test('low-delay OpenAI config uses the same live model and language hints for both session messages', async t => {
  const messages = [];
  t.mock.method(globalThis, 'fetch', async (_, options) => {
    messages.push(JSON.parse(options.body).session);
    return Response.json({ value: 'dummy' });
  });
  for (const language of ['en', 'multi']) {
    const asr = new StreamingASR({ provider: 'openai-live', sourceLanguage: language });
    asr.ws = { readyState: WebSocket.OPEN, send: s => messages.push(JSON.parse(s).session) };
    await asr.mintOpenAIEphemeralToken();
    asr.sendOpenAISessionConfig();
    for (const session of messages.splice(0)) {
      const input = session.audio.input;
      assert.deepEqual(input.transcription, {
        model: 'gpt-live-transcribe', delay: 'low', ...(language === 'multi' ? {} : { languages: [language] }),
      });
      assert.equal(input.format.rate, 24000);
      assert.equal(input.turn_detection, null);
    }
  }
});

test('OpenAI translation requests Luna with reasoning disabled and streams the text', async t => {
  const { ContextualTranslator } = await import('../translator.js');
  t.mock.method(globalThis, 'fetch', async (url, options) => {
    assert.equal(url, 'https://api.openai.com/v1/chat/completions');
    const body = JSON.parse(options.body);
    assert.equal(body.model, 'gpt-6-luna');
    assert.equal(body.reasoning_effort, 'none');
    assert.equal(body.stream, true);
    return new Response('data: {"choices":[{"delta":{"content":"转弯"}}]}\n\n');
  });
  const translator = new ContextualTranslator({ provider: 'openai', targetLanguage: 'zh-Hans' });
  assert.equal(await translator.translateStream('Turn.'), '转弯');
});

test('continuous interim revisions keep a slow request alive and coalesce the next preview', async () => {
  let now = 5000;
  const { asr, requests, events, stop } = await capture(false, { now: () => now });
  try {
    const first = 'We are driving down the road towards home';
    asr.onInterim(first);
    now += 1400;
    asr.onInterim(first + ' tonight');
    assert.equal(requests.length, 1);
    assert.equal(requests[0].signal.aborted, false);
    requests[0].resolve('我们正在开车回家');
    await new Promise(setImmediate);
    assert.equal(events.filter(e => e.event === 'interimTranslation').at(-1).utteranceId, 1);
    assert.equal(requests.length, 2);
    assert.equal(requests[1].text, first + ' tonight');
  } finally { await stop(); }
});

test('native live transcription streams text during a continuous clause before committing it', () => {
  const interims = [];
  const commits = [];
  const asr = new StreamingASR({ provider: 'openai-live', onInterim: t => interims.push(t) });
  asr.ws = { readyState: WebSocket.OPEN, send: s => {
    if (JSON.parse(s).type === 'input_audio_buffer.commit') commits.push(asr.framesSent);
  } };
  for (let n = 0; n < 45; n++) {
    asr.sendAudio(new Int16Array(16), 0.15, 100);
    if (n === 6) asr.handleOpenAIMessage({
      type: 'conversation.item.input_audio_transcription.delta', item_id: 'live', delta: 'turn right',
    });
  }
  assert.deepEqual(interims, ['turn right']);
  assert.deepEqual(commits, [45]);
});
