// Contextual streaming (SSE) translator for live YouTube subtitles.
// Supports DeepSeek (deepseek-chat) and OpenAI (gpt-6-luna) with a rolling
// 4-utterance context window so translations stay coherent across live speech.

export const translationProviders = Object.freeze({
  deepseek: {
    name: 'DeepSeek',
    endpoint: 'https://api.deepseek.com/chat/completions',
    body: {
      model: 'deepseek-chat',
      temperature: 0.2,
      max_tokens: 256,
      stream: true,
    },
  },
  openai: {
    name: 'OpenAI',
    endpoint: 'https://api.openai.com/v1/chat/completions',
    body: {
      model: 'gpt-6-luna',
      reasoning_effort: 'none',
      max_completion_tokens: 256,
      store: false,
      stream: true,
    },
  },
});

export class ContextualTranslator {
  constructor({ provider, apiKey, targetLanguage, maxHistory = 4 }) {
    this.provider = provider;
    this.apiKey = apiKey;
    this.targetLanguage = targetLanguage;
    this.maxHistory = maxHistory;
    this.history = [];
    this.languageName = new Intl.DisplayNames(['en'], { type: 'language' }).of(targetLanguage) || targetLanguage;
  }

  clearHistory() {
    this.history = [];
  }

  record(original, translated) {
    if (!original || !translated) return;
    this.history.push({ original, translated });
    if (this.history.length > this.maxHistory) {
      this.history.shift();
    }
  }

  buildMessages(original) {
    const systemPrompt = [
      `You are a real-time live-stream subtitle translator translating spoken audio into natural, concise ${this.languageName} (${this.targetLanguage}).`,
      'Rules:',
      '1. Use any provided <context> only to keep pronouns, terminology, names, and tone consistent.',
      '2. Translate ONLY the text inside <current>. Do NOT repeat or translate <context>.',
      '3. Keep it natural and subtitle-friendly (concise, spoken style). Preserve names, numbers, and game/tech terms.',
      '4. Output ONLY the translated text. No quotes, no tags, no explanations.',
    ].join('\n');

    let userContent = `<current>${original}</current>`;
    if (this.history.length > 0) {
      const ctxLines = this.history
        .map((item) => `- ${item.original} => ${item.translated}`)
        .join('\n');
      userContent = `<context>\n${ctxLines}\n</context>\n<current>${original}</current>`;
    }

    return [
      { role: 'system', content: systemPrompt },
      { role: 'user', content: userContent },
    ];
  }

  async translateStream(original, { signal, onDelta, commitToHistory = true } = {}) {
    const config = translationProviders[this.provider];
    if (!config) throw Object.assign(new Error(`不支持的翻译服务：${this.provider}`), { fatal: true });

    const combinedSignal = signal
      ? AbortSignal.any([signal, AbortSignal.timeout(15_000)])
      : AbortSignal.timeout(15_000);

    let response;
    try {
      response = await fetch(config.endpoint, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${this.apiKey}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          ...config.body,
          messages: this.buildMessages(original),
        }),
        credentials: 'omit',
        redirect: 'error',
        signal: combinedSignal,
      });
    } catch (err) {
      if (signal?.aborted) throw err;
      throw new Error(`${config.name} 翻译请求超时或连接失败。`);
    }

    if (!response.ok) {
      const data = await response.json().catch(() => null);
      const { status } = response;
      let reason = `服务返回 HTTP ${status}。`;
      let fatal = [400, 401, 402, 403, 404, 422].includes(status);
      if ([401, 403].includes(status)) reason = '请检查翻译 API 密钥或模型权限。';
      if (status === 402 || data?.error?.code === 'insufficient_quota') {
        reason = '请检查翻译 API 账户余额或配额。';
        fatal = true;
      } else if (status === 429) {
        reason = '翻译触发限流，稍后自动继续。';
      }
      const retryAfter = Number(response.headers.get('Retry-After')) * 1000;
      throw Object.assign(new Error(`${config.name} 翻译失败：${reason}`), {
        fatal,
        backoff: status === 429 ? Math.max(5000, retryAfter || 0) : 2000,
      });
    }

    const reader = response.body?.getReader();
    if (!reader) {
      throw new Error(`${config.name} 未返回流式响应。`);
    }

    const decoder = new TextDecoder();
    let buffer = '';
    let fullText = '';

    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split('\n');
        buffer = lines.pop() ?? '';

        for (const rawLine of lines) {
          const line = rawLine.trim();
          if (!line.startsWith('data:')) continue;
          const payload = line.slice(5).trim();
          if (!payload || payload === '[DONE]') continue;
          try {
            const parsed = JSON.parse(payload);
            const delta = parsed.choices?.[0]?.delta?.content;
            if (delta) {
              fullText += delta;
              onDelta?.(fullText.trim());
            }
          } catch {
            // ignore malformed keepalive lines
          }
        }
      }
    } finally {
      reader.releaseLock();
    }

    const cleaned = fullText.trim();
    if (cleaned && commitToHistory) {
      this.record(original, cleaned);
    }
    return cleaned;
  }
}
