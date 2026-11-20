(() => {
  if (globalThis.youtubeDualSubtitlesV2) return;
  globalThis.youtubeDualSubtitlesV2 = true;

  const STORAGE_PREFS_KEY = 'yt_dual_subs_overlay_prefs_v2';
  let prefs = { bottomPct: 11, fontScale: 1.0, showHistory: false };
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
      font-family: system-ui, -apple-system, "Segoe UI", "PingFang SC", "Microsoft YaHei", sans-serif;
    }

    .caption-stage {
      position: absolute;
      left: 50%;
      transform: translateX(-50%);
      bottom: var(--bottom-pct, 11%);
      width: min(86%, 980px);
      display: flex;
      flex-direction: column;
      align-items: center;
      gap: 4px;
      pointer-events: auto;
      transition: opacity 0.35s ease;
      user-select: text;
    }

    .caption-stage.faded {
      opacity: 0;
      pointer-events: none;
    }

    .toolbar {
      display: flex;
      align-items: center;
      gap: 4px;
      padding: 3px 8px;
      border-radius: 999px;
      background: rgba(12, 16, 22, 0.85);
      border: 1px solid rgba(255, 255, 255, 0.14);
      backdrop-filter: blur(8px);
      opacity: 0;
      transform: translateY(4px);
      transition: opacity 0.18s ease, transform 0.18s ease;
      margin-bottom: 2px;
      user-select: none;
    }

    .caption-stage:hover .toolbar,
    .caption-stage.dragging .toolbar {
      opacity: 1;
      transform: translateY(0);
    }

    .toolbar button, .drag-handle {
      border: 0;
      background: transparent;
      color: #d8e4df;
      font: 600 11px/1 system-ui, sans-serif;
      padding: 4px 7px;
      border-radius: 999px;
      cursor: pointer;
    }

    .toolbar button:hover {
      background: rgba(255, 255, 255, 0.14);
      color: #ffffff;
    }

    .toolbar button.active {
      background: rgba(130, 232, 186, 0.24);
      color: #a6f2cf;
    }

    .toolbar button.stop-btn:hover {
      background: rgba(248, 113, 113, 0.25);
      color: #fecaca;
    }

    .drag-handle {
      cursor: ns-resize;
      color: #9bb3a9;
      letter-spacing: 1px;
    }

    .cue-card {
      display: flex;
      flex-direction: column;
      align-items: center;
      max-width: 100%;
      padding: 6px 14px;
      border-radius: 8px;
      background: rgba(10, 14, 18, 0.82);
      box-shadow: 0 2px 12px rgba(0, 0, 0, 0.35);
      text-align: center;
      text-shadow: 0 1px 2px rgba(0, 0, 0, 0.85);
      transition: opacity 0.2s ease;
    }

    .cue-card.prev {
      opacity: 0.68;
      padding: 4px 12px;
      transform: scale(0.93);
    }

    .cue-card:empty, .cue-card[hidden] {
      display: none;
    }

    .line-original {
      color: #eef4f1;
      font-weight: 500;
      font-size: calc(clamp(13px, 1.35vw, 22px) * var(--font-scale, 1));
      line-height: 1.38;
      overflow-wrap: anywhere;
    }

    .line-original.interim {
      color: #c5d4ce;
      font-style: italic;
    }

    .line-translated {
      color: #a8f5d0;
      font-weight: 650;
      font-size: calc(clamp(15px, 1.65vw, 27px) * var(--font-scale, 1));
      line-height: 1.4;
      margin-top: 2px;
      overflow-wrap: anywhere;
    }

    .line-translated.preview {
      color: #c7ecd9;
      opacity: 0.86;
    }

    .status-pill {
      padding: 4px 11px;
      border-radius: 999px;
      background: rgba(12, 16, 22, 0.86);
      color: #ffe3a8;
      font-size: 12px;
      font-weight: 600;
      border: 1px solid rgba(255, 227, 168, 0.25);
    }

    .status-pill[hidden] {
      display: none;
    }

    .history-drawer {
      position: absolute;
      top: 16px;
      right: 16px;
      bottom: 76px;
      width: min(360px, 38vw);
      background: rgba(11, 15, 20, 0.9);
      border: 1px solid rgba(255, 255, 255, 0.14);
      border-radius: 10px;
      backdrop-filter: blur(10px);
      display: flex;
      flex-direction: column;
      pointer-events: auto;
      color: #e9f0ed;
      overflow: hidden;
      box-shadow: 0 8px 30px rgba(0, 0, 0, 0.45);
    }

    .history-drawer[hidden] {
      display: none;
    }

    .history-header {
      display: flex;
      align-items: center;
      justify-content: space-between;
      padding: 10px 12px;
      border-bottom: 1px solid rgba(255, 255, 255, 0.1);
      font-size: 13px;
      font-weight: 700;
      user-select: none;
    }

    .history-actions {
      display: flex;
      gap: 6px;
    }

    .history-actions button {
      border: 1px solid rgba(255, 255, 255, 0.18);
      background: rgba(255, 255, 255, 0.08);
      color: #dff5eb;
      font-size: 11px;
      padding: 3px 8px;
      border-radius: 5px;
      cursor: pointer;
    }

    .history-actions button:hover {
      background: rgba(255, 255, 255, 0.18);
    }

    .history-list {
      flex: 1;
      overflow-y: auto;
      padding: 10px 12px;
      display: flex;
      flex-direction: column;
      gap: 10px;
      user-select: text;
    }

    .history-item {
      border-bottom: 1px solid rgba(255, 255, 255, 0.07);
      padding-bottom: 8px;
    }

    .history-time {
      font-size: 11px;
      color: #8ea59b;
      margin-bottom: 2px;
    }

    .history-orig {
      font-size: 12.5px;
      color: #d6e2dd;
      line-height: 1.4;
    }

    .history-trans {
      font-size: 13.5px;
      color: #a8f5d0;
      font-weight: 600;
      line-height: 1.45;
      margin-top: 2px;
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

  const btnSmaller = document.createElement('button');
  btnSmaller.type = 'button';
  btnSmaller.textContent = 'A-';
  btnSmaller.title = '缩小字号';

  const btnLarger = document.createElement('button');
  btnLarger.type = 'button';
  btnLarger.textContent = 'A+';
  btnLarger.title = '放大字号';

  const btnHistory = document.createElement('button');
  btnHistory.type = 'button';
  btnHistory.textContent = '记录';
  btnHistory.title = '展开/收起双语字幕历史记录';

  const btnStop = document.createElement('button');
  btnStop.type = 'button';
  btnStop.className = 'stop-btn';
  btnStop.textContent = '停止';
  btnStop.title = '停止实时字幕';

  toolbar.append(dragHandle, btnSmaller, btnLarger, btnHistory, btnStop);

  const prevCard = document.createElement('div');
  prevCard.className = 'cue-card prev';
  prevCard.hidden = true;
  const prevOrig = document.createElement('div');
  prevOrig.className = 'line-original';
  prevOrig.dir = 'auto';
  const prevTrans = document.createElement('div');
  prevTrans.className = 'line-translated';
  prevTrans.dir = 'auto';
  prevCard.append(prevOrig, prevTrans);

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

  stage.append(toolbar, prevCard, currCard, statusPill);

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
  btnCopy.textContent = '复制';
  const btnCloseDrawer = document.createElement('button');
  btnCloseDrawer.type = 'button';
  btnCloseDrawer.textContent = '收起';
  drawerActions.append(btnCopy, btnCloseDrawer);
  drawerHeader.append(drawerTitle, drawerActions);

  const historyList = document.createElement('div');
  historyList.className = 'history-list';
  drawer.append(drawerHeader, historyList);

  shadow.append(stage, drawer);

  function applyPrefs() {
    stage.style.setProperty('--bottom-pct', `${prefs.bottomPct}%`);
    stage.style.setProperty('--font-scale', String(prefs.fontScale));
    drawer.hidden = !prefs.showHistory;
    btnHistory.classList.toggle('active', prefs.showHistory);
  }
  applyPrefs();

  // Drag vertical positioning
  let dragStartY = 0;
  let dragStartBottom = 11;
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
      btnCopy.textContent = '已复制';
      setTimeout(() => { btnCopy.textContent = '复制'; }, 1500);
    }).catch(() => {});
  });

  btnStop.addEventListener('click', (e) => {
    e.stopPropagation();
    if (currentId) {
      void chrome.runtime.sendMessage({ target: 'background', type: 'overlayStop', id: currentId }).catch(() => {});
    }
  });

  // Caption state
  let currentId = null;
  let playing = false;
  let revision = 0;
  let fadeTimer = null;
  let noticeTimer = null;

  // Map of utteranceId -> { utteranceId, original, translated, targetLanguage, time, domOrig, domTrans }
  const utterances = new Map();
  const historyEntries = [];
  let latestFinalId = 0;
  let prevFinalId = 0;
  let interimText = '';
  let interimTranslated = '';
  let currentTargetLang = '';

  function formatTime() {
    const d = new Date();
    return d.toTimeString().slice(0, 8);
  }

  function bumpActivity() {
    stage.classList.remove('faded');
    clearTimeout(fadeTimer);
    fadeTimer = setTimeout(() => {
      if (currentId) stage.classList.add('faded');
    }, 15_000);
  }

  function showNotice(text, persistMs = 4000) {
    clearTimeout(noticeTimer);
    statusPill.textContent = text || '';
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

  function renderCards() {
    const latestFinal = utterances.get(latestFinalId);
    const prevFinal = utterances.get(prevFinalId);

    // If there is live interim speech, put latestFinal in prev slot and interim in curr slot!
    if (interimText) {
      if (latestFinal) {
        prevCard.hidden = false;
        prevOrig.textContent = latestFinal.original;
        prevTrans.textContent = latestFinal.translated || '';
        prevTrans.hidden = !latestFinal.translated;
        prevTrans.lang = latestFinal.targetLanguage || currentTargetLang;
      } else {
        prevCard.hidden = true;
      }

      currCard.hidden = false;
      currOrig.textContent = interimText;
      currOrig.className = 'line-original interim';
      currTrans.textContent = interimTranslated || '';
      currTrans.className = 'line-translated preview';
      currTrans.hidden = !interimTranslated;
      currTrans.lang = currentTargetLang;
      return;
    }

    // No interim speech: show prevFinal in prev slot and latestFinal in curr slot
    if (prevFinal) {
      prevCard.hidden = false;
      prevOrig.textContent = prevFinal.original;
      prevTrans.textContent = prevFinal.translated || '';
      prevTrans.hidden = !prevFinal.translated;
      prevTrans.lang = prevFinal.targetLanguage || currentTargetLang;
    } else {
      prevCard.hidden = true;
    }

    if (latestFinal) {
      currCard.hidden = false;
      currOrig.textContent = latestFinal.original;
      currOrig.className = 'line-original';
      currTrans.textContent = latestFinal.translated || '';
      currTrans.className = 'line-translated';
      currTrans.hidden = !latestFinal.translated;
      currTrans.lang = latestFinal.targetLanguage || currentTargetLang;
    } else {
      currCard.hidden = true;
    }
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

    const atBottom = historyList.scrollHeight - historyList.scrollTop - historyList.clientHeight < 48;
    historyList.append(item);
    historyEntries.push(entry);

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
    utterances.clear();
    historyEntries.length = 0;
    historyList.replaceChildren();
    latestFinalId = 0;
    prevFinalId = 0;
    interimText = '';
    interimTranslated = '';
    prevCard.hidden = true;
    currCard.hidden = true;
  }

  function isPlaying(video) {
    return Boolean(video && !video.paused && !video.ended);
  }

  function onPlayback(event) {
    if (!currentId || !event.target.matches?.('#movie_player video')) return;
    // Ignore transient 'waiting' micro-buffering on YouTube Live so audio stream isn't killed
    if (event.type === 'waiting') return;
    const next = ['playing', 'seeked', 'canplay', 'timeupdate'].includes(event.type)
      ? isPlaying(event.target)
      : false;
    if (next === playing) return;
    playing = next;
    revision++;
    if (!playing) {
      interimText = '';
      interimTranslated = '';
      renderCards();
    }
    void chrome.runtime.sendMessage({
      target: 'background',
      type: 'playback',
      id: currentId,
      revision,
      playing,
    }).catch(() => {});
  }

  for (const event of ['playing', 'canplay', 'timeupdate', 'pause', 'seeking', 'seeked', 'ended', 'emptied']) {
    document.addEventListener(event, onPlayback, true);
  }

  chrome.runtime.onMessage.addListener((message, sender, reply) => {
    if (message.target !== 'overlay' || sender.id !== chrome.runtime.id) return;

    if (message.type === 'start') {
      currentId = message.id;
      revision = 0;
      currentTargetLang = message.targetLanguage || '';
      resetState();
      attach();
      const player = document.querySelector('#movie_player');
      playing = isPlaying(player?.querySelector('video'));
      showNotice(playing ? '正在连接实时语音识别…' : '播放视频后自动开始实时字幕。', 0);
      reply({ revision, playing });
      return;
    }

    if (message.id !== currentId) return;

    if (message.type === 'stop') {
      currentId = null;
      clearTimeout(fadeTimer);
      clearTimeout(noticeTimer);
      if (message.notice) {
        showNotice(message.notice, 5000);
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
        showNotice(message.notice, 3000);
        return;
      }

      if (event === 'notice') {
        showNotice(message.notice, 4500);
        return;
      }

      if (message.revision !== undefined && message.revision !== revision) return;

      if (event === 'interim') {
        statusPill.hidden = true;
        interimText = message.text || '';
        if (!interimText) interimTranslated = '';
        bumpActivity();
        renderCards();
      } else if (event === 'interimTranslation') {
        if (interimText) {
          interimTranslated = message.translated || '';
          bumpActivity();
          renderCards();
        }
      } else if (event === 'final') {
        statusPill.hidden = true;
        interimText = '';
        interimTranslated = '';
        if (latestFinalId && latestFinalId !== message.utteranceId) {
          prevFinalId = latestFinalId;
        }
        latestFinalId = message.utteranceId;
        const entry = {
          utteranceId: message.utteranceId,
          original: message.original,
          translated: '',
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
        entry.translated = message.translated || '';
        if (entry.domTrans) {
          entry.domTrans.textContent = entry.translated;
          entry.domTrans.hidden = !entry.translated;
        }
        bumpActivity();
        renderCards();
      }
    }
  });
})();
