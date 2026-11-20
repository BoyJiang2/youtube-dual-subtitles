(() => {
  const prev = globalThis.youtubeDualSubtitlesV2;
  if (prev && prev.runtimeId === chrome.runtime?.id) return;
  try { prev?.teardown?.(); } catch {}

  const STORAGE_PREFS_KEY = 'yt_dual_subs_overlay_prefs_v2';
  // bgMode: 'glass' (default translucent dark) | 'solid' (high contrast) | 'outline' (transparent text outline)
  let prefs = { bottomPct: 10, fontScale: 1.0, showHistory: false, bgMode: 'glass' };
  try {
    const raw = localStorage.getItem(STORAGE_PREFS_KEY);
    if (raw) prefs = { ...prefs, ...JSON.parse(raw) };
  } catch {
    // ignore storage errors
  }

  function savePrefs() {
    try {
      localStorage.setItem(STORAGE_PREFS_KEY, JSON.stringify(prefs));
    } catch {
      // ignore
    }
  }

  const host = document.createElement('div');
  host.id = 'yt-dual-subtitles-host';
  const shadow = host.attachShadow({ mode: 'open' });
  const styles = new CSSStyleSheet();
  styles.replaceSync(`
    :host {
      position: absolute;
      inset: 0;
      z-index: 60;
      pointer-events: none;
      font-family: "Inter", "PingFang SC", "Hiragino Sans GB", "Microsoft YaHei", system-ui, -apple-system, sans-serif;
      -webkit-font-smoothing: antialiased;
    }

    @keyframes pulseDot {
      0%, 100% { opacity: 1; transform: scale(1); }
      50% { opacity: 0.4; transform: scale(0.78); }
    }

    .caption-stage {
      position: absolute;
      left: 50%;
      transform: translateX(-50%);
      bottom: var(--bottom-pct, 10%);
      width: min(84%, 960px);
      display: flex;
      flex-direction: column;
      align-items: center;
      gap: 6px;
      pointer-events: auto;
      transition: opacity 0.35s ease;
      user-select: text;
    }

    .caption-stage.faded {
      opacity: 0;
      pointer-events: none;
    }

    .toolbar {
      display: inline-flex;
      align-items: center;
      gap: 3px;
      padding: 4px 8px;
      border-radius: 999px;
      background: rgba(14, 18, 24, 0.88);
      border: 1px solid rgba(255, 255, 255, 0.14);
      box-shadow: 0 6px 20px rgba(0, 0, 0, 0.42);
      backdrop-filter: blur(14px);
      -webkit-backdrop-filter: blur(14px);
      opacity: 0;
      transform: translateY(5px);
      transition: opacity 0.18s ease, transform 0.18s ease;
      user-select: none;
    }

    .caption-stage:hover .toolbar,
    .caption-stage.dragging .toolbar {
      opacity: 1;
      transform: translateY(0);
    }

    .toolbar .divider {
      width: 1px;
      height: 12px;
      background: rgba(255, 255, 255, 0.14);
      margin: 0 2px;
    }

    .toolbar button, .drag-handle {
      border: 0;
      background: transparent;
      color: #d7e5df;
      font: 600 11.5px/1 system-ui, sans-serif;
      padding: 5px 8px;
      border-radius: 999px;
      cursor: pointer;
      transition: background 0.15s ease, color 0.15s ease;
    }

    .toolbar button:hover {
      background: rgba(255, 255, 255, 0.14);
      color: #ffffff;
    }

    .toolbar button.active {
      background: rgba(82, 229, 169, 0.22);
      color: #9bf7cf;
    }

    .toolbar button.stop-btn:hover {
      background: rgba(248, 113, 113, 0.24);
      color: #fecaca;
    }

    .drag-handle {
      cursor: ns-resize;
      color: #8ea89d;
      letter-spacing: 0.5px;
    }

    .music-label {
      position: absolute; top: 5%; left: 3%; max-width: 68%;
      padding: 4px 9px; border-radius: 5px;
      background: rgba(9, 13, 18, .78); color: #f4fff9;
      font: 500 14px/1.4 system-ui, sans-serif; pointer-events: none;
    }

    .cue-card {
      display: flex;
      flex-direction: column;
      align-items: stretch;
      box-sizing: border-box;
      width: min(100%, 62ch);
      max-width: 100%;
      padding: 8px 18px;
      border-radius: 12px;
      background: rgba(9, 13, 18, 0.74);
      border: 1px solid rgba(255, 255, 255, 0.1);
      box-shadow: 0 8px 28px rgba(0, 0, 0, 0.42);
      text-align: start;
      text-shadow: 0 1px 3px rgba(0, 0, 0, 0.85);
      transition: opacity 0.22s ease, transform 0.22s ease, background 0.2s ease;
    }

    /* Background style variants */
    .caption-stage[data-bg="solid"] .cue-card {
      background: rgba(6, 9, 13, 0.92);
      border-color: rgba(255, 255, 255, 0.12);
      backdrop-filter: none;
    }

    .caption-stage[data-bg="outline"] .cue-card {
      background: transparent;
      border-color: transparent;
      box-shadow: none;
      backdrop-filter: none;
      padding: 2px 10px;
      text-shadow:
        0 2px 4px rgba(0, 0, 0, 0.95),
        0 0 10px rgba(0, 0, 0, 0.9),
        1px 1px 0 rgba(0, 0, 0, 0.95),
        -1px -1px 0 rgba(0, 0, 0, 0.95),
        1px -1px 0 rgba(0, 0, 0, 0.95),
        -1px 1px 0 rgba(0, 0, 0, 0.95);
    }

    .cue-card.bilingual .line-translated:empty {
      min-height: 1.4em;
    }

    .cue-card:empty, .cue-card[hidden] {
      display: none;
    }

    .line-original {
      color: rgba(235, 243, 240, 0.9);
      font-weight: 500;
      font-size: calc(clamp(13px, 1.28vw, 20px) * var(--font-scale, 1));
      line-height: 1.38;
      letter-spacing: 0.01em;
      overflow-wrap: anywhere;
    }

    .line-original.interim {
      color: rgba(203, 221, 214, 0.88);
    }

    .line-original.interim::before {
      content: "";
      display: inline-block;
      width: 7px;
      height: 7px;
      border-radius: 50%;
      background: #4ade80;
      box-shadow: 0 0 8px rgba(74, 222, 128, 0.8);
      margin-right: 7px;
      vertical-align: middle;
      animation: pulseDot 1.2s ease-in-out infinite;
    }

    .line-translated {
      color: #ffffff;
      font-weight: 700;
      font-size: calc(clamp(16px, 1.72vw, 28px) * var(--font-scale, 1));
      line-height: 1.4;
      margin-top: 3px;
      letter-spacing: 0.015em;
      overflow-wrap: anywhere;
      text-shadow: 0 2px 6px rgba(0, 0, 0, 0.85), 0 0 18px rgba(74, 222, 128, 0.16);
    }

    .line-translated.preview {
      color: #c8f7df;
      opacity: 0.9;
    }

    .status-pill {
      display: inline-flex;
      align-items: center;
      gap: 8px;
      padding: 6px 14px;
      border-radius: 999px;
      background: rgba(12, 17, 23, 0.86);
      color: #e6f4ee;
      font-size: 12.5px;
      font-weight: 600;
      border: 1px solid rgba(110, 231, 183, 0.28);
      box-shadow: 0 6px 20px rgba(0, 0, 0, 0.4);
      backdrop-filter: blur(12px);
      -webkit-backdrop-filter: blur(12px);
    }

    .status-pill::before {
      content: "";
      width: 7px;
      height: 7px;
      border-radius: 50%;
      background: #52e5a9;
      box-shadow: 0 0 8px rgba(82, 229, 169, 0.85);
      animation: pulseDot 1.4s ease-in-out infinite;
      flex-shrink: 0;
    }

    .status-pill[data-error="true"] {
      color: #ffd5c2;
      border-color: rgba(248, 113, 113, 0.4);
    }

    .status-pill[data-error="true"]::before {
      background: #f87171;
      box-shadow: 0 0 8px rgba(248, 113, 113, 0.8);
      animation: none;
    }

    .status-pill[hidden] {
      display: none;
    }

    .history-drawer {
      position: absolute;
      top: 18px;
      right: 18px;
      bottom: 84px;
      width: min(370px, 38vw);
      background: rgba(10, 14, 20, 0.88);
      border: 1px solid rgba(255, 255, 255, 0.14);
      border-radius: 14px;
      backdrop-filter: blur(16px);
      -webkit-backdrop-filter: blur(16px);
      display: flex;
      flex-direction: column;
      pointer-events: auto;
      color: #edf3f0;
      overflow: hidden;
      box-shadow: 0 14px 40px rgba(0, 0, 0, 0.55);
    }

    .history-drawer[hidden] {
      display: none;
    }

    .history-header {
      display: flex;
      align-items: center;
      justify-content: space-between;
      padding: 12px 14px;
      border-bottom: 1px solid rgba(255, 255, 255, 0.1);
      background: rgba(255, 255, 255, 0.03);
      font-size: 13px;
      font-weight: 700;
      user-select: none;
    }

    .history-actions {
      display: flex;
      gap: 6px;
    }

    .history-actions button {
      border: 1px solid rgba(255, 255, 255, 0.16);
      background: rgba(255, 255, 255, 0.08);
      color: #dff5eb;
      font-size: 11.5px;
      font-weight: 600;
      padding: 4px 10px;
      border-radius: 6px;
      cursor: pointer;
      transition: background 0.15s ease;
    }

    .history-actions button:hover {
      background: rgba(255, 255, 255, 0.18);
    }

    .history-list {
      flex: 1;
      overflow-y: auto;
      padding: 12px 14px;
      display: flex;
      flex-direction: column;
      gap: 12px;
      user-select: text;
    }

    .history-list::-webkit-scrollbar {
      width: 6px;
    }

    .history-list::-webkit-scrollbar-thumb {
      background: rgba(255, 255, 255, 0.18);
      border-radius: 3px;
    }

    .history-item {
      border-bottom: 1px solid rgba(255, 255, 255, 0.07);
      padding-bottom: 10px;
    }

    .history-item:last-child {
      border-bottom: 0;
    }

    .history-time {
      display: inline-block;
      font-size: 10.5px;
      color: #8ea89d;
      background: rgba(255, 255, 255, 0.06);
      padding: 1px 6px;
      border-radius: 4px;
      margin-bottom: 4px;
    }

    .history-orig {
      font-size: 12.5px;
      color: rgba(226, 236, 232, 0.82);
      line-height: 1.45;
    }

    .history-trans {
      font-size: 14px;
      color: #a8f5d0;
      font-weight: 650;
      line-height: 1.5;
      margin-top: 3px;
    }
  `);
  shadow.adoptedStyleSheets = [styles];

  // Build DOM
  const stage = document.createElement('section');
  stage.className = 'caption-stage';

  const toolbar = document.createElement('div');
  toolbar.className = 'toolbar';
  const dragHandle = document.createElement('span');
  dragHandle.className = 'drag-handle';
  dragHandle.textContent = '⋮⋮ 拖动';
  dragHandle.title = '上下拖动调整字幕位置';

  const div1 = document.createElement('span');
  div1.className = 'divider';

  const btnSmaller = document.createElement('button');
  btnSmaller.type = 'button';
  btnSmaller.textContent = 'A-';
  btnSmaller.title = '缩小字号';

  const btnLarger = document.createElement('button');
  btnLarger.type = 'button';
  btnLarger.textContent = 'A+';
  btnLarger.title = '放大字号';

  const btnBgMode = document.createElement('button');
  btnBgMode.type = 'button';
  btnBgMode.title = '切换字幕背景风格（半透 / 纯黑 / 无底描边）';

  const div2 = document.createElement('span');
  div2.className = 'divider';

  const btnHistory = document.createElement('button');
  btnHistory.type = 'button';
  btnHistory.textContent = '记录';
  btnHistory.title = '展开/收起双语字幕历史记录';

  const btnStop = document.createElement('button');
  btnStop.type = 'button';
  btnStop.className = 'stop-btn';
  btnStop.textContent = '停止';
  btnStop.title = '停止实时字幕';

  toolbar.append(dragHandle, div1, btnSmaller, btnLarger, btnBgMode, div2, btnHistory, btnStop);

  const currCard = document.createElement('div');
  currCard.className = 'cue-card';
  currCard.hidden = true;
  const currOrig = document.createElement('div');
  currOrig.className = 'line-original';
  currOrig.dir = 'auto';
  const currTrans = document.createElement('div');
  currTrans.className = 'line-translated';
  currTrans.dir = 'auto';
  currCard.append(currOrig, currTrans);

  const statusPill = document.createElement('div');
  statusPill.className = 'status-pill';
  statusPill.hidden = true;
  statusPill.setAttribute('role', 'status');

  stage.append(toolbar, currCard, statusPill);

  // History drawer
  const drawer = document.createElement('aside');
  drawer.className = 'history-drawer';
  drawer.hidden = true;
  const drawerHeader = document.createElement('div');
  drawerHeader.className = 'history-header';
  const drawerTitle = document.createElement('span');
  drawerTitle.textContent = '双语字幕记录';
  const drawerActions = document.createElement('div');
  drawerActions.className = 'history-actions';
  const btnCopy = document.createElement('button');
  btnCopy.type = 'button';
  btnCopy.textContent = '复制全部';
  const btnCloseDrawer = document.createElement('button');
  btnCloseDrawer.type = 'button';
  btnCloseDrawer.textContent = '收起';
  drawerActions.append(btnCopy, btnCloseDrawer);
  drawerHeader.append(drawerTitle, drawerActions);

  const historyList = document.createElement('div');
  historyList.className = 'history-list';
  drawer.append(drawerHeader, historyList);

  const musicLabel = document.createElement('div');
  musicLabel.className = 'music-label';
  musicLabel.hidden = true;
  shadow.append(stage, drawer, musicLabel);

  const BG_MODES = ['glass', 'solid', 'outline'];
  const BG_LABELS = { glass: '半透', solid: '深底', outline: '无底' };

  function applyPrefs() {
    stage.style.setProperty('--bottom-pct', `${prefs.bottomPct}%`);
    stage.style.setProperty('--font-scale', String(prefs.fontScale));
    stage.dataset.bg = BG_MODES.includes(prefs.bgMode) ? prefs.bgMode : 'glass';
    btnBgMode.textContent = BG_LABELS[stage.dataset.bg];
    drawer.hidden = !prefs.showHistory;
    btnHistory.classList.toggle('active', prefs.showHistory);
  }
  applyPrefs();

  // Drag vertical positioning
  let dragStartY = 0;
  let dragStartBottom = 10;
  dragHandle.addEventListener('pointerdown', (e) => {
    e.preventDefault();
    e.stopPropagation();
    const player = document.querySelector('#movie_player');
    if (!player) return;
    dragStartY = e.clientY;
    dragStartBottom = prefs.bottomPct;
    stage.classList.add('dragging');
    dragHandle.setPointerCapture(e.pointerId);

    const onMove = (ev) => {
      const rect = player.getBoundingClientRect();
      if (!rect.height) return;
      const deltaPct = ((dragStartY - ev.clientY) / rect.height) * 100;
      prefs.bottomPct = Math.max(4, Math.min(78, Math.round((dragStartBottom + deltaPct) * 10) / 10));
      applyPrefs();
    };
    const onUp = () => {
      stage.classList.remove('dragging');
      dragHandle.removeEventListener('pointermove', onMove);
      dragHandle.removeEventListener('pointerup', onUp);
      dragHandle.removeEventListener('pointercancel', onUp);
      savePrefs();
    };
    dragHandle.addEventListener('pointermove', onMove);
    dragHandle.addEventListener('pointerup', onUp);
    dragHandle.addEventListener('pointercancel', onUp);
  });

  btnSmaller.addEventListener('click', (e) => {
    e.stopPropagation();
    prefs.fontScale = Math.max(0.7, Math.round((prefs.fontScale - 0.1) * 10) / 10);
    applyPrefs();
    savePrefs();
  });

  btnLarger.addEventListener('click', (e) => {
    e.stopPropagation();
    prefs.fontScale = Math.min(1.6, Math.round((prefs.fontScale + 0.1) * 10) / 10);
    applyPrefs();
    savePrefs();
  });

  btnBgMode.addEventListener('click', (e) => {
    e.stopPropagation();
    const nextIdx = (BG_MODES.indexOf(prefs.bgMode) + 1) % BG_MODES.length;
    prefs.bgMode = BG_MODES[nextIdx];
    applyPrefs();
    savePrefs();
  });

  btnHistory.addEventListener('click', (e) => {
    e.stopPropagation();
    prefs.showHistory = !prefs.showHistory;
    applyPrefs();
    savePrefs();
  });

  btnCloseDrawer.addEventListener('click', (e) => {
    e.stopPropagation();
    prefs.showHistory = false;
    applyPrefs();
    savePrefs();
  });

  btnCopy.addEventListener('click', (e) => {
    e.stopPropagation();
    const lines = historyEntries.map((entry) =>
      entry.translated ? `[${entry.time}] ${entry.original}\n${entry.translated}` : `[${entry.time}] ${entry.original}`
    );
    if (!lines.length) return;
    navigator.clipboard?.writeText(lines.join('\n\n')).then(() => {
      btnCopy.textContent = '已复制 ✓';
      setTimeout(() => { btnCopy.textContent = '复制全部'; }, 1500);
    }).catch(() => {});
  });

  btnStop.addEventListener('click', (e) => {
    e.stopPropagation();
    if (currentId) {
      safeSend({ target: 'background', type: 'overlayStop', id: currentId });
    }
  });

  // Caption state
  let currentId = null;
  let playing = false;
  let revision = 0;
  let fadeTimer = null;
  let noticeTimer = null;

  const utterances = new Map();
  const historyEntries = [];
  let latestFinalId = 0;
  let interimId = 0;
  let previewSource = '';
  let renderFrame = 0;
  let interimText = '';
  let interimTranslated = '';
  let currentTargetLang = '';

  function formatTime() {
    return new Date().toTimeString().slice(0, 8);
  }

  function bumpActivity() {
    stage.classList.remove('faded');
    clearTimeout(fadeTimer);
    fadeTimer = setTimeout(() => {
      if (currentId && statusPill.hidden) stage.classList.add('faded');
    }, 4_000);
  }

  function showNotice(text, persistMs = 4000, isError = false) {
    clearTimeout(noticeTimer);
    statusPill.textContent = text || '';
    statusPill.dataset.error = String(Boolean(isError));
    statusPill.hidden = !text;
    if (text) {
      bumpActivity();
      if (persistMs > 0) {
        noticeTimer = setTimeout(() => {
          statusPill.hidden = true;
        }, persistMs);
      }
    }
  }

  function visibleTranslation(current, message) {
    const next = message.translated || '';
    // A longer source may start a fresh stream. Keep the readable prefix until
    // its replacement catches up, or accept the finished wording at any length.
    return message.done || next.length >= current.length ? next : current;
  }

  function renderCards() {
    if (renderFrame) return;
    renderFrame = requestAnimationFrame(() => {
      renderFrame = 0;
      const latest = utterances.get(latestFinalId);
      const original = interimText || latest?.original || '';
      const translated = interimText ? interimTranslated : latest?.translated || '';
      currCard.hidden = !original;
      if (currOrig.textContent !== original) currOrig.textContent = original;
      if (currTrans.textContent !== translated) currTrans.textContent = translated;
      currOrig.classList.toggle('interim', Boolean(interimText));
      currTrans.classList.toggle('preview', Boolean(interimText));
    });
  }

  function appendHistoryItem(entry) {
    const item = document.createElement('div');
    item.className = 'history-item';
    const timeEl = document.createElement('div');
    timeEl.className = 'history-time';
    timeEl.textContent = entry.time;
    const origEl = document.createElement('div');
    origEl.className = 'history-orig';
    origEl.dir = 'auto';
    origEl.textContent = entry.original;
    const transEl = document.createElement('div');
    transEl.className = 'history-trans';
    transEl.dir = 'auto';
    transEl.lang = entry.targetLanguage || currentTargetLang;
    transEl.textContent = entry.translated || '';
    transEl.hidden = !entry.translated;
    item.append(timeEl, origEl, transEl);

    entry.domTrans = transEl;

    const atBottom = !drawer.hidden && historyList.scrollHeight - historyList.scrollTop - historyList.clientHeight < 48;
    historyList.append(item);
    historyEntries.push(entry);
    drawerTitle.textContent = `双语字幕记录 (${historyEntries.length})`;

    if (historyEntries.length > 100) {
      const removed = historyEntries.shift();
      utterances.delete(removed.utteranceId);
      historyList.firstElementChild?.remove();
    }
    if (atBottom) {
      historyList.scrollTop = historyList.scrollHeight;
    }
  }

  function attach() {
    const player = document.querySelector('#movie_player');
    if (player && host.parentElement !== player) {
      player.append(host);
    }
  }

  function resetState() {
    musicLabel.hidden = true;
    utterances.clear();
    historyEntries.length = 0;
    historyList.replaceChildren();
    drawerTitle.textContent = '双语字幕记录';
    latestFinalId = 0;
    interimId = 0;
    previewSource = '';
    interimText = '';
    interimTranslated = '';
    currCard.hidden = true;
  }

  const PLAYBACK_EVENTS = ['playing', 'canplay', 'timeupdate', 'pause', 'seeking', 'seeked', 'ended', 'emptied'];

  function teardown() {
    currentId = null;
    clearTimeout(fadeTimer);
    clearTimeout(noticeTimer);
    for (const event of PLAYBACK_EVENTS) {
      document.removeEventListener(event, onPlayback, true);
    }
    cancelAnimationFrame(renderFrame);
    try { chrome.runtime.onMessage.removeListener(onMessage); } catch {}
    host.remove();
    if (globalThis.youtubeDualSubtitlesV2?.teardown === teardown) {
      delete globalThis.youtubeDualSubtitlesV2;
    }
  }

  function safeSend(message) {
    if (!chrome.runtime?.id) {
      teardown();
      return;
    }
    try {
      const result = chrome.runtime.sendMessage(message);
      if (result && typeof result.catch === 'function') {
        result.catch(() => {});
      }
    } catch {
      teardown();
    }
  }

  function isPlaying(video) {
    return Boolean(video && !video.paused && !video.ended);
  }

  function onPlayback(event) {
    if (!chrome.runtime?.id) {
      teardown();
      return;
    }
    if (!currentId || !event.target.matches?.('#movie_player video')) return;
    if (event.type === 'waiting') return;
    const next = ['playing', 'seeked', 'canplay', 'timeupdate'].includes(event.type)
      ? isPlaying(event.target)
      : false;
    if (next === playing) return;
    playing = next;
    revision++;
    if (!playing) {
      musicLabel.hidden = true;
      latestFinalId = 0;
      interimId = 0;
      previewSource = '';
      interimText = '';
      interimTranslated = '';
      renderCards();
    }
    safeSend({
      target: 'background',
      type: 'playback',
      id: currentId,
      revision,
      playing,
    });
  }

  for (const event of PLAYBACK_EVENTS) {
    document.addEventListener(event, onPlayback, true);
  }

  function onMessage(message, sender, reply) {
    if (message.target !== 'overlay' || sender.id !== chrome.runtime.id) return;

    if (message.type === 'start') {
      currentId = message.id;
      revision = 0;
      currentTargetLang = message.targetLanguage || '';
      currTrans.lang = currentTargetLang;
      currTrans.hidden = Boolean(message.originalOnly);
      currCard.classList.toggle('bilingual', !message.originalOnly);
      resetState();
      attach();
      const player = document.querySelector('#movie_player');
      playing = isPlaying(player?.querySelector('video'));
      showNotice(playing ? '正在连接实时语音识别…' : '播放视频后自动开始实时字幕。', 0, false);
      reply({ revision, playing });
      return;
    }

    if (message.id !== currentId) return;

    if (message.type === 'stop') {
      currentId = null;
      clearTimeout(fadeTimer);
      clearTimeout(noticeTimer);
      if (message.notice) {
        showNotice(message.notice, 5000, true);
        setTimeout(() => {
          if (!currentId) host.remove();
        }, 5200);
      } else {
        host.remove();
      }
      return;
    }

    if (message.type === 'captionEvent') {
      attach();
      const { event } = message;

      if (event === 'status') {
        const hasCaptions = Boolean(latestFinalId || interimText);
        showNotice(message.notice, hasCaptions ? 3500 : 0, false);
        return;
      }

      if (event === 'notice') {
        showNotice(message.notice, 8000, true);
        return;
      }

      if (message.revision !== undefined && message.revision !== revision) return;

      if (event === 'music') {
        musicLabel.hidden = !message.kind;
        const kind = message.kind === 'singing' ? '歌声' : '背景音乐';
        musicLabel.textContent = message.track
          ? '♪ 可能是 ' + [message.track.title, message.track.artist].filter(Boolean).join(' · ') + '（歌词匹配）'
          : '♪ ' + kind;
        return;
      }
      if (event === 'interim') {
        statusPill.hidden = true;
        if (message.utteranceId <= latestFinalId || message.utteranceId < interimId) return;
        interimText = message.text || '';
        if (interimId !== message.utteranceId || !interimText.startsWith(previewSource)) {
          interimTranslated = '';
          previewSource = '';
        }
        interimId = message.utteranceId;
        bumpActivity();
        renderCards();
      } else if (event === 'interimTranslation') {
        const source = (message.original || '').replace(/[.。]+$/u, '').trimEnd();
        if (interimId !== message.utteranceId || !source || !interimText.startsWith(source)) return;
        const next = visibleTranslation(interimTranslated, message);
        if (next === message.translated) previewSource = source;
        interimTranslated = next;
        renderCards();
      } else if (event === 'final') {
        if (message.utteranceId <= latestFinalId || message.utteranceId < interimId) return;
        statusPill.hidden = true;
        const carried = interimId === message.utteranceId && message.original.startsWith(previewSource)
          ? interimTranslated : '';
        interimText = '';
        interimTranslated = '';
        previewSource = '';
        interimId = 0;
        latestFinalId = message.utteranceId;
        const entry = {
          utteranceId: message.utteranceId,
          original: message.original,
          translated: visibleTranslation(carried, message),
          targetLanguage: message.targetLanguage || currentTargetLang,
          time: formatTime(),
        };
        utterances.set(entry.utteranceId, entry);
        appendHistoryItem(entry);
        bumpActivity();
        renderCards();
      } else if (event === 'translation') {
        const entry = utterances.get(message.utteranceId);
        if (!entry) return;
        const next = visibleTranslation(entry.translated, message);
        if (next === entry.translated) return;
        entry.translated = next;
        if (entry.domTrans) {
          entry.domTrans.textContent = entry.translated;
          entry.domTrans.hidden = !entry.translated;
        }
        if (!interimText && latestFinalId === entry.utteranceId) renderCards();
      }
    }
  }

  chrome.runtime.onMessage.addListener(onMessage);
  globalThis.youtubeDualSubtitlesV2 = { runtimeId: chrome.runtime?.id, teardown };
})();
