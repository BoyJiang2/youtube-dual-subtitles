const sentenceEnd = /[.!?。！？…]["'”’）)]*$/u;
const abbreviation = /(?:\b(?:Mr|Mrs|Ms|Dr|Prof|St|vs|e\.g|i\.e)|\b[A-Z])\.$/u;
const unfinished = /\b(?:and|but|because|with|the|going to|need to|should|could|would)\.$/iu;
const cjk = /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}]/u;

function join(left, right) {
  if (!left) return right;
  if (!right) return left;
  if (unfinished.test(left)) left = left.slice(0, -1);
  return left + (cjk.test(left.at(-1)) && cjk.test(right[0]) ? '' : ' ') + right;
}

export class CaptionPhrases {
  constructor(onInterim, onFinal, language) {
    this.onInterim = onInterim;
    this.onFinal = onFinal;
    this.segmenter = new Intl.Segmenter(language === 'multi' ? undefined : language, { granularity: 'sentence' });
    this.reset();
  }

  reset() {
    clearTimeout(this.timer);
    this.pending = '';
    this.silence = 0;
    this.drafting = false;
  }

  interim(text) {
    clearTimeout(this.timer);
    this.drafting = true;
    this.onInterim(join(this.pending, text));
  }

  final(text) {
    clearTimeout(this.timer);
    this.drafting = false;
    const combined = join(this.pending, text.trim());
    this.pending = '';
    for (const { segment } of this.segmenter.segment(combined)) {
      const part = join(this.pending, segment.trim());
      this.pending = part;
      if ((sentenceEnd.test(part) && !abbreviation.test(part) && !unfinished.test(part)) || part.length >= (cjk.test(part) ? 54 : 145)) {
        this.flush();
      }
    }
    if (this.pending) {
      if (this.silence >= 700) this.flush();
      else {
        this.onInterim(this.pending);
        this.timer = setTimeout(() => this.flush(), 3000);
      }
    }
  }

  quiet(milliseconds) {
    this.silence = milliseconds;
    if (!this.drafting && this.pending && milliseconds >= 700) this.flush();
  }

  flush() {
    clearTimeout(this.timer);
    if (this.pending) this.onFinal(this.pending);
    this.pending = '';
  }
}
