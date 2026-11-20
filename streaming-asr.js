// WebSocket Streaming ASR clients for Deepgram Nova-3 and OpenAI Realtime Transcription.

function joinTranscript(parts) {
  let out = '';
  for (const raw of parts) {
    const piece = raw.trim();
    if (!piece) continue;
    if (!out) {
      out = piece;
      continue;
    }
    // Avoid adding extra spaces between CJK characters
    const cjkBoundary = /[\u3040-\u30ff\u3400-\u9fff\uac00-\ud7af]$/.test(out) &&
      /^[\u3040-\u30ff\u3400-\u9fff\uac00-\ud7af]/.test(piece);
    out += cjkBoundary ? piece : ` ${piece}`;
  }
  return out;
}

function endsWithSentencePunctuation(text) {
  return /[.!?。！？…]["'”’）)]*$/.test(text.trim());
}

function int16ToBase64(int16) {
  const bytes = new Uint8Array(int16.buffer, int16.byteOffset, int16.byteLength);
  let binary = '';
  const step = 0x4000;
  for (let i = 0; i < bytes.length; i += step) {
    binary += String.fromCharCode(...bytes.subarray(i, i + step));
  }
  return btoa(binary);
}

export function getAsrSampleRate(provider) {
  return provider === 'openai' ? 24000 : 16000;
}

export class StreamingASR {
  constructor({ provider, apiKey, sourceLanguage = 'multi', onInterim, onFinal, onStatus, onError }) {
    this.provider = provider;
    this.apiKey = apiKey;
    this.sourceLanguage = sourceLanguage;
    this.onInterim = onInterim;
    this.onFinal = onFinal;
    this.onStatus = onStatus;
    this.onError = onError;

    this.ws = null;
    this.closed = false;
    this.connectedOnce = false;
    this.reconnectAttempts = 0;
    this.reconnectTimer = null;
    this.keepAliveTimer = null;
    this.lastAudioSentAt = 0;

    // Deepgram accumulation state
    this.pendingFinals = [];
    // OpenAI delta accumulation state by item_id
    this.itemBuffers = new Map();
  }

  connect() {
    if (this.closed) return Promise.resolve();
    return new Promise((resolve, reject) => {
      let settled = false;
      const done = (fn, arg) => {
        if (settled) return;
        settled = true;
        fn(arg);
      };

      try {
        if (this.provider === 'deepgram') {
          const params = new URLSearchParams({
            model: 'nova-3',
            language: this.sourceLanguage || 'multi',
            encoding: 'linear16',
            sample_rate: '16000',
            channels: '1',
            interim_results: 'true',
            smart_format: 'true',
            punctuate: 'true',
            endpointing: '350',
            utterance_end_ms: '1000',
          });
          const url = `wss://api.deepgram.com/v1/listen?${params.toString()}`;
          this.ws = new WebSocket(url, ['token', this.apiKey]);
        } else if (this.provider === 'openai') {
          const url = 'wss://api.openai.com/v1/realtime?intent=transcription';
          this.ws = new WebSocket(url, [
            'realtime',
            `openai-insecure-api-key.${this.apiKey}`,
            'openai-beta.realtime-v1',
          ]);
        } else {
          done(reject, new Error(`不支持的语音识别服务：${this.provider}`));
          return;
        }
      } catch (err) {
        done(reject, new Error(`无法建立语音识别连接：${err.message}`));
        return;
      }

      const openTimeout = setTimeout(() => {
        if (!settled) {
          this.ws?.close();
          done(reject, new Error('连接语音识别服务超时，请检查网络或 API 密钥。'));
        }
      }, 10_000);

      this.ws.onopen = () => {
        clearTimeout(openTimeout);
        this.connectedOnce = true;
        this.reconnectAttempts = 0;
        this.lastAudioSentAt = Date.now();

        if (this.provider === 'openai') {
          const transcription = { model: 'gpt-4o-mini-transcribe' };
          if (this.sourceLanguage && this.sourceLanguage !== 'multi') {
            transcription.language = this.sourceLanguage;
          }
          this.ws.send(JSON.stringify({
            type: 'transcription_session.update',
            session: {
              input_audio_format: 'pcm16',
              input_audio_transcription: transcription,
              turn_detection: {
                type: 'server_vad',
                threshold: 0.5,
                prefix_padding_ms: 300,
                silence_duration_ms: 450,
              },
            },
          }));
        } else if (this.provider === 'deepgram') {
          this.startKeepAlive();
        }

        this.onStatus?.('已连接实时语音识别');
        done(resolve);
      };

      this.ws.onmessage = (event) => {
        if (this.closed || typeof event.data !== 'string') return;
        let payload;
        try {
          payload = JSON.parse(event.data);
        } catch {
          return;
        }
        if (this.provider === 'deepgram') this.handleDeepgramMessage(payload);
        else this.handleOpenAIMessage(payload);
      };

      this.ws.onerror = () => {
        if (!settled) {
          clearTimeout(openTimeout);
          const name = this.provider === 'deepgram' ? 'Deepgram' : 'OpenAI Realtime';
          done(reject, new Error(`无法连接 ${name}，请检查 API 密钥权限及网络连接。`));
        }
      };

      this.ws.onclose = (event) => {
        clearTimeout(openTimeout);
        this.stopKeepAlive();
        if (!settled) {
          const name = this.provider === 'deepgram' ? 'Deepgram' : 'OpenAI Realtime';
          done(reject, new Error(`${name} 拒绝连接（代码 ${event.code}），请检查 API 密钥或余额。`));
          return;
        }
        if (this.closed) return;

        // Flush any pending Deepgram partial finals before reconnecting
        if (this.pendingFinals.length) {
          const flushed = joinTranscript(this.pendingFinals);
          this.pendingFinals = [];
          if (flushed) this.onFinal?.(flushed);
        }

        if (this.reconnectAttempts >= 5) {
          this.onError?.(Object.assign(new Error('实时语音识别连接已断开，请重新启动字幕。'), { fatal: true }));
          return;
        }

        const delay = Math.min(1000 * 2 ** this.reconnectAttempts, 10_000);
        this.reconnectAttempts++;
        this.onStatus?.(`识别连接中断，${Math.round(delay / 1000)} 秒后自动重连…`);
        this.reconnectTimer = setTimeout(() => {
          if (!this.closed) {
            void this.connect().catch(() => {});
          }
        }, delay);
      };
    });
  }

  startKeepAlive() {
    this.stopKeepAlive();
    this.keepAliveTimer = setInterval(() => {
      if (this.closed || !this.ws || this.ws.readyState !== WebSocket.OPEN) return;
      if (Date.now() - this.lastAudioSentAt >= 5000) {
        this.ws.send(JSON.stringify({ type: 'KeepAlive' }));
      }
    }, 5000);
  }

  stopKeepAlive() {
    if (this.keepAliveTimer) {
      clearInterval(this.keepAliveTimer);
      this.keepAliveTimer = null;
    }
  }

  sendAudio(int16Pcm) {
    if (this.closed || !this.ws || this.ws.readyState !== WebSocket.OPEN) return;
    this.lastAudioSentAt = Date.now();
    if (this.provider === 'deepgram') {
      this.ws.send(int16Pcm.buffer);
    } else if (this.provider === 'openai') {
      this.ws.send(JSON.stringify({
        type: 'input_audio_buffer.append',
        audio: int16ToBase64(int16Pcm),
      }));
    }
  }

  flush() {
    if (this.pendingFinals.length) {
      const text = joinTranscript(this.pendingFinals);
      this.pendingFinals = [];
      if (text) this.onFinal?.(text);
    }
    this.itemBuffers.clear();
  }

  handleDeepgramMessage(data) {
    if (data.type === 'Results') {
      const transcript = data.channel?.alternatives?.[0]?.transcript?.trim() || '';
      if (data.is_final) {
        if (transcript) this.pendingFinals.push(transcript);
        const combined = joinTranscript(this.pendingFinals);
        if (!combined) return;

        // Finalize on natural speech boundary, sentence punctuation, or long run-on speech
        if (data.speech_final || endsWithSentencePunctuation(combined) || combined.length >= 110) {
          this.pendingFinals = [];
          this.onFinal?.(combined);
        } else {
          this.onInterim?.(combined);
        }
      } else if (transcript) {
        const preview = joinTranscript([...this.pendingFinals, transcript]);
        if (preview) this.onInterim?.(preview);
      }
    } else if (data.type === 'UtteranceEnd') {
      if (this.pendingFinals.length) {
        const combined = joinTranscript(this.pendingFinals);
        this.pendingFinals = [];
        if (combined) this.onFinal?.(combined);
      }
    } else if (data.type === 'Error') {
      const msg = data.message || data.description || 'Deepgram 识别出错。';
      this.onError?.(Object.assign(new Error(msg), { fatal: false }));
    }
  }

  handleOpenAIMessage(data) {
    const { type } = data;
    if (type === 'conversation.item.input_audio_transcription.delta') {
      const id = data.item_id || 'default';
      const prev = this.itemBuffers.get(id) || '';
      const next = prev + (data.delta || '');
      this.itemBuffers.set(id, next);
      if (next.trim()) this.onInterim?.(next.trim());
    } else if (type === 'conversation.item.input_audio_transcription.completed') {
      const id = data.item_id || 'default';
      this.itemBuffers.delete(id);
      const text = (data.transcript || '').trim();
      if (text) this.onFinal?.(text);
    } else if (type === 'conversation.item.input_audio_transcription.failed') {
      const id = data.item_id || 'default';
      this.itemBuffers.delete(id);
      const errMsg = data.error?.message || 'OpenAI 实时语音转写失败。';
      const code = data.error?.code || '';
      const fatal = /invalid_api_key|insufficient_quota|authentication/i.test(`${code} ${errMsg}`);
      this.onError?.(Object.assign(new Error(errMsg), { fatal }));
    } else if (type === 'error') {
      const errMsg = data.error?.message || 'OpenAI Realtime 返回错误。';
      const code = data.error?.code || '';
      const fatal = /invalid_api_key|insufficient_quota|authentication|session_expired/i.test(`${code} ${errMsg}`);
      this.onError?.(Object.assign(new Error(errMsg), { fatal }));
    }
  }

  close() {
    this.closed = true;
    this.stopKeepAlive();
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    if (this.ws) {
      try {
        if (this.ws.readyState === WebSocket.OPEN && this.provider === 'deepgram') {
          this.ws.send(JSON.stringify({ type: 'CloseStream' }));
        }
        this.ws.close(1000, 'stopped');
      } catch {
        // ignore close errors
      }
      this.ws = null;
    }
    this.pendingFinals = [];
    this.itemBuffers.clear();
  }
}
