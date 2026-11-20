// Real-time linear resampler + PCM16 frame chunker for streaming WebSocket ASR.
// Converts native tab audio (typically 48kHz stereo/mono) down to 16kHz (Deepgram)
// or 24kHz (OpenAI Realtime) Int16 mono frames every ~100ms.

class StreamingAudioProcessor extends AudioWorkletProcessor {
  constructor({ processorOptions = {} }) {
    super();
    this.targetRate = processorOptions.targetRate || 16000;
    this.chunkMs = processorOptions.chunkMs || 100;
    this.playing = Boolean(processorOptions.playing);
    this.revision = processorOptions.revision || 0;

    this.ratio = sampleRate / this.targetRate;
    this.chunkSamples = Math.max(320, Math.round((this.targetRate * this.chunkMs) / 1000));
    this.outBuffer = new Int16Array(this.chunkSamples);
    this.outIndex = 0;
    this.phase = 0;
    this.prevSample = 0;
    this.sumSq = 0;

    this.port.onmessage = ({ data }) => {
      if (typeof data.playing === 'boolean') {
        this.playing = data.playing;
        this.revision = data.revision ?? this.revision;
        if (!this.playing) this.flushReset();
      }
    };
  }

  flushReset() {
    this.outIndex = 0;
    this.phase = 0;
    this.prevSample = 0;
    this.sumSq = 0;
  }

  process(inputs) {
    const channels = inputs[0];
    if (!this.playing || !channels || !channels.length || !channels[0]?.length) {
      return true;
    }

    const ch0 = channels[0];
    const ch1 = channels.length > 1 ? channels[1] : null;
    const len = ch0.length;

    // Linear interpolation resampling from native sampleRate -> targetRate
    // Downmix stereo to mono on the fly so speech panned to L/R isn't lost.
    while (this.phase < len) {
      const idx = Math.floor(this.phase);
      const frac = this.phase - idx;

      const s0 = idx === 0
        ? this.prevSample
        : (ch1 ? (ch0[idx - 1] + ch1[idx - 1]) * 0.5 : ch0[idx - 1]);
      const s1 = ch1 ? (ch0[idx] + ch1[idx]) * 0.5 : ch0[idx];

      // Note: when phase is between idx and idx+1, interpolate between s1 and next
      // Simpler & exact: treat sample i as located at position i.
      let sample;
      if (idx + 1 < len) {
        const sNext = ch1 ? (ch0[idx + 1] + ch1[idx + 1]) * 0.5 : ch0[idx + 1];
        sample = s1 + (sNext - s1) * frac;
      } else {
        sample = s0 + (s1 - s0) * frac;
      }

      const clamped = sample < -1 ? -1 : sample > 1 ? 1 : sample;
      this.sumSq += clamped * clamped;
      this.outBuffer[this.outIndex++] = clamped < 0 ? Math.round(clamped * 32768) : Math.round(clamped * 32767);

      if (this.outIndex >= this.chunkSamples) {
        const pcm = this.outBuffer.slice(0, this.outIndex);
        const rms = Math.sqrt(this.sumSq / this.outIndex);
        this.port.postMessage(
          { type: 'pcm', pcm, rms, revision: this.revision },
          [pcm.buffer]
        );
        this.outIndex = 0;
        this.sumSq = 0;
      }

      this.phase += this.ratio;
    }

    this.prevSample = ch1 ? (ch0[len - 1] + ch1[len - 1]) * 0.5 : ch0[len - 1];
    this.phase -= len;
    return true;
  }
}

registerProcessor('streaming-audio', StreamingAudioProcessor);
