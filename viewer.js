const id = location.hash.slice(1);
const delay = 8;
const video = document.querySelector('video');
const original = document.querySelector('#original');
const translated = document.querySelector('#translated');
const status = document.querySelector('#status');
const play = document.querySelector('#play');
const stop = document.querySelector('#stop');
const stage = document.querySelector('#stage');
const source = new MediaSource();
const url = URL.createObjectURL(source);
const channel = new BroadcastChannel(`captions-${id}`);
const queue = [];
const captions = new Map();
let buffer;
let geometry;
let started = false;
let autoplayBlocked = false;
let closed = false;
let trimmedAt = 0;
let frame;
let reading = false;
let visibleCue;

video.src = url;
const connection = setTimeout(() => finish('同步画面未能连接。请返回 YouTube 后重试。', true), 20_000);

function finish(notice, stopCapture = false) {
  if (closed) return;
  closed = true;
  clearTimeout(connection);
  video.cancelVideoFrameCallback(frame);
  video.pause();
  video.removeAttribute('src');
  video.load();
  URL.revokeObjectURL(url);
  channel.close();
  queue.length = 0;
  captions.clear();
  original.textContent = translated.textContent = '';
  play.hidden = stop.disabled = true;
  status.textContent = notice;
  if (stopCapture) {
    void chrome.runtime.sendMessage({ target: 'background', type: 'stop', id, notice }).catch(() => {});
  }
}

function renderCaption(time) {
  let cue;
  for (const [sequence, candidate] of captions) {
    if (candidate.endTime + 0.15 < time) captions.delete(sequence);
    else if (candidate.startTime <= time && (!cue || sequence > cue.sequence)) cue = candidate;
  }
  if (cue === visibleCue) return;
  visibleCue = cue;
  original.textContent = cue?.original || '';
  translated.textContent = cue?.translated || '';
  translated.lang = cue?.targetLanguage || '';
}

function renderFrame(_, metadata) {
  renderCaption(metadata.mediaTime);
  frame = video.requestVideoFrameCallback(renderFrame);
}

function startPlayback() {
  play.hidden = true;
  started = true;
  void video.play().then(() => {
    if (!closed) status.textContent = '同步播放中 · 约晚于源画面 8 秒';
  }).catch(() => {
    if (closed) return;
    started = false;
    autoplayBlocked = true;
    play.hidden = false;
    status.textContent = '缓冲就绪，点击播放同步画面。';
  });
}

async function pump() {
  if (!buffer || buffer.updating || reading || closed) return;
  try {
    if (video.buffered.length) {
      const latest = video.buffered.end(video.buffered.length - 1);
      const earliest = video.buffered.start(0);
      if (started && latest - video.currentTime > delay + 4) video.currentTime = latest - delay;
      const trim = Math.max(video.currentTime - 4, latest - delay - 14);
      if (trim > Math.max(trimmedAt + 3, earliest + 3)) {
        trimmedAt = trim;
        buffer.remove(0, trim);
        return;
      }
      if (!started) {
        if (latest - earliest >= delay) {
          clearTimeout(connection);
          video.currentTime = Math.max(earliest + 0.04, latest - delay);
          if (!autoplayBlocked) startPlayback();
        } else {
          status.textContent = `正在缓冲画面和声音 · ${Math.floor(latest - earliest)} / ${delay} 秒`;
        }
      }
    }
    if (queue.length) {
      reading = true;
      const bytes = await queue.shift().arrayBuffer();
      if (!closed) buffer.appendBuffer(bytes);
    }
  } catch {
    finish('无法播放缓冲视频。请返回 YouTube 后重试。', true);
  } finally {
    reading = false;
  }
}

video.addEventListener('loadedmetadata', () => {
  const crop = geometry || { left: 0, top: 0, width: 1, height: 1 };
  stage.style.setProperty('--aspect', video.videoWidth * crop.width / (video.videoHeight * crop.height));
  if (geometry) {
    video.style.width = `${100 / crop.width}%`;
    video.style.height = `${100 / crop.height}%`;
    video.style.left = `${-100 * crop.left / crop.width}%`;
    video.style.top = `${-100 * crop.top / crop.height}%`;
    video.style.objectFit = 'fill';
  }
});
video.addEventListener('error', () => finish('浏览器无法解码同步视频。', true));

channel.onmessage = ({ data }) => {
  if (closed) return;
  if (data.type === 'init') {
    geometry = data.geometry;
    try {
      buffer = source.addSourceBuffer(data.mimeType);
      buffer.addEventListener('updateend', pump);
      buffer.addEventListener('error', () => finish('浏览器无法读取同步视频。', true));
      status.textContent = '正在缓冲画面和声音…';
    } catch {
      finish('浏览器无法初始化同步视频。', true);
    }
  } else if (data.type === 'media') {
    queue.push(data.chunk);
    if (queue.length > 40) finish('本机视频处理跟不上直播。请返回 YouTube 后重试。', true);
    else void pump();
  } else if (data.type === 'caption' && data.endTime >= video.currentTime && captions.size < 100) {
    captions.set(data.sequence, data);
    renderCaption(video.currentTime);
  } else if (data.type === 'notice') {
    status.textContent = data.notice;
  } else if (data.type === 'closed') {
    finish(data.notice);
  }
};

source.addEventListener('sourceopen', () => channel.postMessage({ type: 'ready' }), { once: true });
frame = video.requestVideoFrameCallback(renderFrame);
play.addEventListener('click', startPlayback);
stop.addEventListener('click', () => {
  finish('同步观看已停止。');
  void chrome.runtime.sendMessage({ target: 'background', type: 'stop', id }).catch(() => {});
});
document.querySelector('#fullscreen').addEventListener('click', () => {
  void stage.parentElement.requestFullscreen().catch(() => {});
});
chrome.runtime.onMessage.addListener((message, sender) => {
  if (sender.id === chrome.runtime.id && message.target === 'viewer' && message.type === 'stop' && message.id === id) {
    finish(message.notice || '同步观看已停止。');
  }
});
