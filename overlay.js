(() => {
  if (globalThis.youtubeDualSubtitles) return;
  globalThis.youtubeDualSubtitles = true;

  const host = document.createElement('div');
  const shadow = host.attachShadow({ mode: 'open' });
  const styles = new CSSStyleSheet();
  styles.replaceSync(`
    :host { position: absolute; inset: 0; z-index: 58; pointer-events: none; }
    section { position: absolute; inset-inline: 7%; bottom: max(13%, 60px); text-align: center;
      color: white; font: 600 clamp(13px, 1.55vw, 26px)/1.42 system-ui, sans-serif; }
    p { margin: 4px auto; padding: .18em .6em; width: fit-content; max-width: 100%;
      background: #0c1016e8; border-radius: 6px; overflow-wrap: anywhere; }
    [data-translation] { color: #e4fff1; font-size: 1.07em; }
    [data-notice] { color: #ffebbf; font-size: .7em; }
  `);
  shadow.adoptedStyleSheets = [styles];
  const box = document.createElement('section');
  const original = document.createElement('p');
  const translated = document.createElement('p');
  const notice = document.createElement('p');
  original.dir = translated.dir = 'auto';
  translated.dataset.translation = '';
  notice.dataset.notice = '';
  notice.setAttribute('role', 'status');
  box.append(original, translated, notice);
  shadow.append(box);

  let current;
  let timer;
  let playing;
  let revision;
  let sequence;
  let synchronized;

  function isPlaying(video) {
    return Boolean(video && !video.paused && !video.seeking && video.readyState >= 3);
  }

  function onPlayback(event) {
    if (!current || !event.target.matches?.('#movie_player video')) return;
    const next = ['playing', 'seeked'].includes(event.type) && isPlaying(event.target);
    if (next === playing) return;
    playing = next;
    revision++;
    clearTimeout(timer);
    host.remove();
    void chrome.runtime.sendMessage({ target: 'background', type: 'playback', id: current, revision, playing })
      .catch(() => {});
  }

  for (const event of ['playing', 'pause', 'seeking', 'seeked', 'waiting', 'ended', 'emptied']) {
    document.addEventListener(event, onPlayback, true);
  }

  function attach() {
    const player = document.querySelector('#movie_player');
    if (player && host.parentElement !== player) player.append(host);
  }

  chrome.runtime.onMessage.addListener((message, sender, reply) => {
    if (message.target !== 'overlay' || sender.id !== chrome.runtime.id) return;
    if (message.type === 'start') {
      current = message.id;
      revision = sequence = 0;
      synchronized = message.synchronized;
      const player = document.querySelector('#movie_player');
      playing = isPlaying(player?.querySelector('video'));
      const rect = player?.getBoundingClientRect();
      const left = Math.max(0, rect?.left ?? 0);
      const top = Math.max(0, rect?.top ?? 0);
      const width = Math.min(innerWidth, rect?.right ?? innerWidth) - left;
      const height = Math.min(innerHeight, rect?.bottom ?? innerHeight) - top;
      const geometry = width > 0 && height > 0 ? {
        left: left / innerWidth, top: top / innerHeight, width: width / innerWidth, height: height / innerHeight,
      } : undefined;
      reply({ revision, playing, geometry });
    }
    if (message.id !== current) return;
    if (synchronized) {
      if (message.type === 'stop') current = undefined;
      return;
    }
    if (message.type === 'caption') {
      if (!playing || message.revision !== revision || message.sequence < sequence ||
          (message.expiresAt && message.expiresAt <= Date.now())) return;
      if (message.original) sequence = message.sequence;
    }
    clearTimeout(timer);
    attach();

    original.textContent = message.original || '';
    translated.textContent = message.translated || '';
    translated.lang = message.targetLanguage || '';
    notice.textContent = message.notice || (message.type === 'start' ?
      (playing ? '正在监听标签页音频…' : '播放视频后自动开始识别。') : '');
    for (const line of [original, translated, notice]) line.hidden = !line.textContent;

    if (message.type === 'stop') {
      current = undefined;
      if (!message.notice) host.remove();
    }
    const duration = message.expiresAt ? Math.min(2600, message.expiresAt - Date.now()) : 5000;
    timer = setTimeout(() => host.remove(), duration);
  });
})();
