class CaptionAudio extends AudioWorkletProcessor {
  constructor({ processorOptions }) {
    super();
    this.maxSamples = Math.ceil(sampleRate * 2.2);
    this.buffer = new Int16Array(this.maxSamples + 512);
    this.preRoll = new Int16Array(Math.ceil(sampleRate * 0.14));
    this.setPlayback(processorOptions);
    this.port.onmessage = ({ data }) => this.setPlayback(data);
  }

  setPlayback({ playing, revision }) {
    this.playing = playing;
    this.revision = revision;
    this.reset();
  }

  reset() {
    this.preRollCursor = 0;
    this.preRollLength = 0;
    this.used = 0;
    this.voiced = 0;
    this.quiet = 0;
    this.voiceStart = this.voiceEnd = 0;
  }

  process(inputs) {
    const input = inputs[0]?.[0];
    if (!this.playing || !input?.length) return true;
    let power = 0;
    for (const sample of input) power += sample * sample;
    const speaking = power / input.length > 0.003 ** 2;

    if (!this.used && speaking) {
      this.voiceStart = currentFrame / sampleRate;
      const start = this.preRollCursor + this.preRoll.length - this.preRollLength;
      for (let i = 0; i < this.preRollLength; i++) {
        this.buffer[i] = this.preRoll[(start + i) % this.preRoll.length];
      }
      this.used = this.preRollLength;
    }

    if (this.used || speaking) {
      for (const sample of input) this.buffer[this.used++] = Math.max(-1, Math.min(1, sample)) * 32767;
      this.quiet = speaking ? 0 : this.quiet + input.length;
      if (speaking) {
        this.voiced += input.length;
        this.voiceEnd = (currentFrame + input.length) / sampleRate;
      }
      const paused = this.used >= sampleRate * 1.1 && this.quiet >= sampleRate * 0.26;
      if (paused || this.used >= this.maxSamples) {
        if (this.voiced >= sampleRate * 0.13) {
          const audio = this.buffer.slice(0, this.used);
          const audioEnd = (currentFrame + input.length) / sampleRate;
          this.port.postMessage({
            audio, audioEnd, voiceStart: this.voiceStart, voiceEnd: this.voiceEnd, revision: this.revision,
          }, [audio.buffer]);
        }
        this.reset();
      }
    } else {
      for (const sample of input) {
        this.preRoll[this.preRollCursor] = Math.max(-1, Math.min(1, sample)) * 32767;
        this.preRollCursor = (this.preRollCursor + 1) % this.preRoll.length;
      }
      this.preRollLength = Math.min(this.preRollLength + input.length, this.preRoll.length);
    }
    return true;
  }
}

registerProcessor('caption-audio', CaptionAudio);
