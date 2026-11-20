// WebSocket Streaming ASR clients for Deepgram Nova-3 and OpenAI Realtime Transcription,
// plus a high-compatibility OpenAI HTTP smart-chunked transcription client (16kHz WAV + prompt context).

function joinTranscript(parts) {
  let out = '';
  for (const raw of parts) {
    const piece = raw.trim();
    if (!piece) continue;
    if (!out) {
      out = piece;
      continue;
    }
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

function makeWav16k(chunks, sampleRate = 16000) {
  let totalSamples = 0;
  for (const c of chunks) totalSamples += c.length;
  const pcmBytes = totalSamples * 2;
  const buffer = new ArrayBuffer(44 + pcmBytes);
  const view = new DataView(buffer);
  const writeStr = (offset, str) => {
    for (let i = 0; i < str.length; i++) view.setUint8(offset + i, str.charCodeAt(i));
  };
  writeStr(0, 'RIFF');
  view.setUint32(4, 36 + pcmBytes, true);
  writeStr(8, 'WAVEfmt ');
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);
  view.setUint16(22, 1, true);
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * 2, true);
  view.setUint16(32, 2, true);
  view.setUint16(34, 16, true);
  writeStr(36, 'data');
  view.setUint32(40, pcmBytes, true);

  const out = new Int16Array(buffer, 44);
  let offset = 0;
  for (const c of chunks) {
    out.set(c, offset);
    offset += c.length;
  }
  return new Blob([buffer], { type: 'audio/wav' });
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
    this.reconnectAttempts = 0;
    this.reconnectTimer = null;
    this.keepAliveTimer = null;
    this.diagTimer = null;
    this.lastAudioSentAt = 0;

    // Live diagnostics until first caption arrives
    this.gotFirstTranscript = false;
    this.framesSent = 0;
    this.peakRms = 0;
    this.commitsSent = 0;
    this.lastServerEvent = '';

    // Deepgram state
    this.pendingFinals = [];

    // OpenAI Realtime state
    this.itemBuffers = new Map();
    this.openaiUseBetaFallback = false;
    this.openaiBufferedMs = 0;
    this.openaiVoicedMs = 0;
    this.openaiQuietMs = 0;
    this.noiseFloor = 0.006;

    // OpenAI HTTP smart-chunked fallback state
    this.httpChunks = [];
    this.httpBufferedMs = 0;
    this.httpVoicedMs = 0;
    this.httpQuietMs = 0;
    this.httpLastPrompt = '';
    this.httpControllers = new Set();
  }

  startDiagnostics() {
    this.stopDiagnostics();
    this.diagTimer = setInterval(() => {
      if (this.closed || this.gotFirstTranscript) {
        this.stopDiagnostics();
        return;
      }
      const vol = Math.min(100, Math.round(this.peakRms * 500));
      const sec = (this.framesSent * 0.1).toFixed(1);
      if (this.framesSent === 0) {
        this.onStatus?.('已连接识别服务，等待播放器音频流…（请确认视频正在播放且未静音）');
      } else if (this.peakRms < 0.001) {
        this.onStatus?.(`已接收 ${sec}s 音频，但音量为 0%（请检查 YouTube 是否静音）`);
      } else {
        const extra = this.commitsSent > 0 ? ` · 已提交 ${this.commitsSent} 段` : '';
        const srv = this.lastServerEvent ? ` · ${this.lastServerEvent}` : '';
        this.onStatus?.(`监听中 · 音量 ${vol}% · 已推流 ${sec}s${extra}${srv}`);
      }
      this.peakRms = 0;
    }, 2000);
  }

  stopDiagnostics() {
    if (this.diagTimer) {
      clearInterval(this.diagTimer);
      this.diagTimer = null;
    }
  }

  emitInterim(text) {
    if (!text) return;
    this.gotFirstTranscript = true;
    this.stopDiagnostics();
    this.onInterim?.(text);
  }

  emitFinal(text) {
    if (!text) return;
    this.gotFirstTranscript = true;
    this.stopDiagnostics();
    this.onFinal?.(text);
  }

  async mintOpenAIEphemeralToken() {
    const transcription = { model: 'gpt-4o-mini-transcribe' };
    if (this.sourceLanguage && this.sourceLanguage !== 'multi') {
      transcription.language = this.sourceLanguage;
    }
    try {
      const resp = await fetch('https://api.openai.com/v1/realtime/client_secrets', {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${this.apiKey}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          session: {
            type: 'transcription',
            audio: {
              input: {
                format: { type: 'audio/pcm', rate: 24000 },
                transcription,
                turn_detection: null,
              },
            },
          },
        }),
        credentials: 'omit',
        signal: AbortSignal.timeout(8000),
      });
      if (resp.ok) {
        const data = await resp.json().catch(() => null);
        const token = data?.value || data?.client_secret?.value;
        if (token) return token;
      }
    } catch {
      // Fall back to direct key if client_secrets endpoint is unavailable
    }
    return null;
  }

  sendOpenAISessionConfig() {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) return;
    const transcription = { model: 'gpt-4o-mini-transcribe' };
    if (this.sourceLanguage && this.sourceLanguage !== 'multi') {
      transcription.language = this.sourceLanguage;
    }

    if (this.openaiUseBetaFallback) {
      this.ws.send(JSON.stringify({
        type: 'transcription_session.update',
        session: {
          input_audio_format: 'pcm16',
          input_audio_transcription: transcription,
          turn_detection: null,
        },
      }));
    } else {
      this.ws.send(JSON.stringify({
        type: 'session.update',
        session: {
          type: 'transcription',
          audio: {
            input: {
              format: { type: 'audio/pcm', rate: 24000 },
              transcription,
              turn_detection: null,
            },
          },
        },
      }));
    }
  }

  async connect() {
    if (this.closed) return;

    if (this.provider === 'openai-http') {
      this.onStatus?.('已就绪（OpenAI 转写 · 智能分段模式），正在监听音频…');
      this.startDiagnostics();
      return;
    }

    let wsToken = this.apiKey;
    if (this.provider === 'openai' && !this.openaiUseBetaFallback) {
      this.onStatus?.('正在向 OpenAI 申请实时转写会话…');
      const ek = await this.mintOpenAIEphemeralToken();
      if (ek) wsToken = ek;
    }

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
          const protocols = this.openaiUseBetaFallback
            ? ['realtime', `openai-insecure-api-key.${wsToken}`, 'openai-beta.realtime-v1']
            : ['realtime', `openai-insecure-api-key.${wsToken}`];
          this.ws = new WebSocket(url, protocols);
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
        this.reconnectAttempts = 0;
        this.lastAudioSentAt = Date.now();
        this.openaiBufferedMs = 0;
        this.openaiVoicedMs = 0;
        this.openaiQuietMs = 0;

        if (this.provider === 'openai') {
          this.sendOpenAISessionConfig();
        } else if (this.provider === 'deepgram') {
          this.startKeepAlive();
        }

        const label = this.provider === 'deepgram' ? 'Deepgram Nova-3' : 'OpenAI Realtime';
        this.onStatus?.(`已连接 ${label}，正在监听直播音频…`);
        this.startDiagnostics();
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
          done(reject, new Error(`无法连接 ${name}，请检查 API 密钥权限及网络（或切换为 OpenAI 兼容转写）。`));
        }
      };

      this.ws.onclose = (event) => {
        clearTimeout(openTimeout);
        this.stopKeepAlive();
        if (!settled) {
          const name = this.provider === 'deepgram' ? 'Deepgram' : 'OpenAI Realtime';
          done(reject, new Error(`${name} 拒绝连接（代码 ${event.code}），请检查密钥或切换为 OpenAI 兼容转写。`));
          return;
        }
        if (this.closed) return;

        if (this.pendingFinals.length) {
          const flushed = joinTranscript(this.pendingFinals);
          this.pendingFinals = [];
          if (flushed) this.emitFinal(flushed);
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

  sendAudio(int16Pcm, rms = 0.02, chunkMs = 100) {
    if (this.closed) return;
    this.framesSent++;
    if (rms > this.peakRms) this.peakRms = rms;
    this.lastAudioSentAt = Date.now();

    if (this.provider === 'openai-http') {
      this.pushHttpAudio(int16Pcm, rms, chunkMs);
      return;
    }

    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) return;

    if (this.provider === 'deepgram') {
      this.ws.send(int16Pcm.buffer);
      return;
    }

    if (this.provider === 'openai') {
      this.ws.send(JSON.stringify({
        type: 'input_audio_buffer.append',
        audio: int16ToBase64(int16Pcm),
      }));

      if (rms < this.noiseFloor) {
        this.noiseFloor = this.noiseFloor * 0.85 + rms * 0.15;
      } else {
        this.noiseFloor = Math.min(0.08, this.noiseFloor * 0.992 + rms * 0.008);
      }

      this.openaiBufferedMs += chunkMs;
      const isActiveSound = rms > 0.003;
      const isQuietDip = rms < Math.max(0.005, this.noiseFloor * 1.45);

      if (isActiveSound) this.openaiVoicedMs += chunkMs;
      this.openaiQuietMs = isQuietDip ? this.openaiQuietMs + chunkMs : 0;

      const naturalPause = this.openaiBufferedMs >= 1500 && this.openaiQuietMs >= 300;
      const maxWindowReached = this.openaiBufferedMs >= 3200;

      if (this.openaiVoicedMs >= 400 && (naturalPause || maxWindowReached)) {
        this.commitOpenAIBuffer();
      } else if (this.openaiBufferedMs >= 4000 && this.openaiVoicedMs < 400) {
        this.ws.send(JSON.stringify({ type: 'input_audio_buffer.clear' }));
        this.openaiBufferedMs = 0;
        this.openaiVoicedMs = 0;
        this.openaiQuietMs = 0;
      }
    }
  }

  pushHttpAudio(int16Pcm, rms, chunkMs) {
    if (rms < this.noiseFloor) {
      this.noiseFloor = this.noiseFloor * 0.85 + rms * 0.15;
    } else {
      this.noiseFloor = Math.min(0.08, this.noiseFloor * 0.992 + rms * 0.008);
    }

    this.httpChunks.push(int16Pcm);
    this.httpBufferedMs += chunkMs;
    const isActiveSound = rms > 0.003;
    const isQuietDip = rms < Math.max(0.005, this.noiseFloor * 1.45);
    if (isActiveSound) this.httpVoicedMs += chunkMs;
    this.httpQuietMs = isQuietDip ? this.httpQuietMs + chunkMs : 0;

    const naturalPause = this.httpBufferedMs >= 1800 && this.httpQuietMs >= 300;
    const maxWindowReached = this.httpBufferedMs >= 3600;

    if (this.httpVoicedMs >= 400 && (naturalPause || maxWindowReached)) {
      const chunksToSend = this.httpChunks;
      // Keep 200ms overlap so words at boundaries aren't sliced in half
      this.httpChunks = chunksToSend.slice(-2);
      this.httpBufferedMs = this.httpChunks.length * chunkMs;
      this.httpVoicedMs = 0;
      this.httpQuietMs = 0;
      void this.transcribeHttpChunks(chunksToSend);
    } else if (this.httpBufferedMs >= 4000 && this.httpVoicedMs < 400) {
      this.httpChunks = [];
      this.httpBufferedMs = 0;
      this.httpVoicedMs = 0;
      this.httpQuietMs = 0;
    }
  }

  async transcribeHttpChunks(chunks) {
    if (this.closed || !chunks.length) return;
    this.commitsSent++;
    const wav = makeWav16k(chunks, 16000);
    const form = new FormData();
    form.set('file', wav, 'live.wav');
    form.set('model', 'gpt-4o-mini-transcribe');
    if (this.sourceLanguage && this.sourceLanguage !== 'multi') {
      form.set('language', this.sourceLanguage);
    }
    if (this.httpLastPrompt) {
      form.set('prompt', this.httpLastPrompt.slice(-180));
    }

    const controller = new AbortController();
    this.httpControllers.add(controller);
    try {
      const resp = await fetch('https://api.openai.com/v1/audio/transcriptions', {
        method: 'POST',
        headers: { Authorization: `Bearer ${this.apiKey}` },
        body: form,
        credentials: 'omit',
        signal: AbortSignal.any([controller.signal, AbortSignal.timeout(12_000)]),
      });
      const data = await resp.json().catch(() => null);
      if (!resp.ok) {
        const msg = data?.error?.message || `HTTP ${resp.status}`;
        const fatal = [401, 402, 403].includes(resp.status) || data?.error?.code === 'insufficient_quota';
        this.onError?.(Object.assign(new Error(`OpenAI 转写失败：${msg}`), { fatal }));
        return;
      }
      const text = (data?.text || '').trim();
      if (text && !this.closed) {
        this.httpLastPrompt = text;
        this.emitFinal(text);
      }
    } catch (err) {
      if (!controller.signal.aborted && !this.closed) {
        this.onError?.(Object.assign(new Error(`OpenAI 转写请求失败：${err.message}`), { fatal: false }));
      }
    } finally {
      this.httpControllers.delete(controller);
    }
  }

  commitOpenAIBuffer() {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) return;
    this.commitsSent++;
    this.ws.send(JSON.stringify({ type: 'input_audio_buffer.commit' }));
    this.openaiBufferedMs = 0;
    this.openaiVoicedMs = 0;
    this.openaiQuietMs = 0;
  }

  flush() {
    if (this.pendingFinals.length) {
      const text = joinTranscript(this.pendingFinals);
      this.pendingFinals = [];
      if (text) this.emitFinal(text);
    }
    if (this.provider === 'openai' && this.openaiVoicedMs >= 300) {
      this.commitOpenAIBuffer();
    }
    if (this.provider === 'openai-http' && this.httpVoicedMs >= 300 && this.httpChunks.length) {
      const chunks = this.httpChunks;
      this.httpChunks = [];
      this.httpBufferedMs = 0;
      this.httpVoicedMs = 0;
      this.httpQuietMs = 0;
      void this.transcribeHttpChunks(chunks);
    }
    this.itemBuffers.clear();
  }

  handleDeepgramMessage(data) {
    this.lastServerEvent = data.type || '';
    if (data.type === 'Results') {
      const transcript = data.channel?.alternatives?.[0]?.transcript?.trim() || '';
      if (data.is_final) {
        if (transcript) this.pendingFinals.push(transcript);
        const combined = joinTranscript(this.pendingFinals);
        if (!combined) return;

        if (data.speech_final || endsWithSentencePunctuation(combined) || combined.length >= 110) {
          this.pendingFinals = [];
          this.emitFinal(combined);
        } else {
          this.emitInterim(combined);
        }
      } else if (transcript) {
        const preview = joinTranscript([...this.pendingFinals, transcript]);
        if (preview) this.emitInterim(preview);
      }
    } else if (data.type === 'UtteranceEnd') {
      if (this.pendingFinals.length) {
        const combined = joinTranscript(this.pendingFinals);
        this.pendingFinals = [];
        if (combined) this.emitFinal(combined);
      }
    } else if (data.type === 'Error') {
      const msg = data.message || data.description || 'Deepgram 识别出错。';
      this.onError?.(Object.assign(new Error(msg), { fatal: false }));
    }
  }

  handleOpenAIMessage(data) {
    const { type } = data;
    this.lastServerEvent = type || '';
    if (type === 'session.updated' || type === 'transcription_session.updated') {
      this.onStatus?.('OpenAI Realtime 就绪，正在监听音频…');
    } else if (type === 'conversation.item.input_audio_transcription.delta') {
      const id = data.item_id || 'default';
      const prev = this.itemBuffers.get(id) || '';
      const next = prev + (data.delta || '');
      this.itemBuffers.set(id, next);
      if (next.trim()) this.emitInterim(next.trim());
    } else if (type === 'conversation.item.input_audio_transcription.completed') {
      const id = data.item_id || 'default';
      this.itemBuffers.delete(id);
      const text = (data.transcript || '').trim();
      if (text) this.emitFinal(text);
    } else if (type === 'conversation.item.input_audio_transcription.failed') {
      const id = data.item_id || 'default';
      this.itemBuffers.delete(id);
      const errMsg = data.error?.message || 'OpenAI 实时语音转写失败。';
      const code = data.error?.code || '';
      const fatal = /invalid_api_key|insufficient_quota|authentication/i.test(`${code} ${errMsg}`);
      this.onError?.(Object.assign(new Error(`OpenAI 转写失败: ${errMsg}`), { fatal }));
    } else if (type === 'error') {
      const errMsg = data.error?.message || 'OpenAI Realtime 返回错误。';
      const code = data.error?.code || '';
      if (!this.openaiUseBetaFallback && /unknown_parameter|invalid_value|session\.update/i.test(`${code} ${errMsg}`)) {
        this.openaiUseBetaFallback = true;
        this.onStatus?.('正在切换 OpenAI 兼容协议重连…');
        try { this.ws?.close(1000, 'fallback'); } catch {}
        return;
      }
      const fatal = /invalid_api_key|insufficient_quota|authentication|session_expired/i.test(`${code} ${errMsg}`);
      this.onError?.(Object.assign(new Error(`OpenAI: ${errMsg}`), { fatal }));
    }
  }

  close() {
    this.closed = true;
    this.stopKeepAlive();
    this.stopDiagnostics();
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    for (const c of this.httpControllers) c.abort();
    this.httpControllers.clear();
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
    this.httpChunks = [];
  }
}
