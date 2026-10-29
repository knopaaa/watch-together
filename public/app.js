// =============================================================
//  Watch Together — клиент (v3, с HLS)
//  Поддержка: YouTube, VK Video (sync), mp4 (sync), m3u8/HLS (sync),
//             screen-share (WebRTC), чат, реакции, PWA
// =============================================================

const socket = io();
let myName = '';
let myRoom = '';

const $ = (id) => document.getElementById(id);
const loginEl = $('login');
const appEl = $('app');
const nameInput = $('nameInput');
const roomInput = $('roomInput');
const joinBtn = $('joinBtn');
const roomLabel = $('roomLabel');
const usersList = $('usersList');
const urlInput = $('urlInput');
const loadBtn = $('loadBtn');
const playerContainer = $('playerContainer');
const emptyState = $('emptyState');
const playerWrap = $('playerWrap');
const screenVideo = $('screenVideo');
const messagesEl = $('messages');
const chatInput = $('chatInput');
const sendBtn = $('sendBtn');
const leaveBtn = $('leaveBtn');
const copyLinkBtn = $('copyLinkBtn');
const shareScreenBtn = $('shareScreenBtn');
const stopScreenBtn = $('stopScreenBtn');
const emojiLayer = $('emojiLayer');

// ---------- префилл имени и комнаты ----------
nameInput.value = localStorage.getItem('wt_name') || '';
const pathRoom = location.pathname.match(/^\/r\/([^/]+)/);
if (pathRoom) roomInput.value = decodeURIComponent(pathRoom[1]);

// =============================================================
//  ДИНАМИЧЕСКАЯ ЗАГРУЗКА hls.js
// =============================================================
let hlsLibLoading = null;
function ensureHlsLib() {
  if (window.Hls) return Promise.resolve(window.Hls);
  if (hlsLibLoading) return hlsLibLoading;
  hlsLibLoading = new Promise((resolve, reject) => {
    const s = document.createElement('script');
    s.src = 'https://cdn.jsdelivr.net/npm/hls.js@1.5.13/dist/hls.min.js';
    s.onload = () => resolve(window.Hls);
    s.onerror = reject;
    document.head.appendChild(s);
  });
  return hlsLibLoading;
}

// ---------- ВХОД ----------
function doJoin() {
  const name = nameInput.value.trim();
  const room = roomInput.value.trim() || 'main';
  if (!name) return alert('Введи имя');
  myName = name;
  myRoom = room;
  localStorage.setItem('wt_name', name);
  socket.emit('join', { roomId: room, name });

  history.replaceState(null, '', '/r/' + encodeURIComponent(room));
  loginEl.classList.add('hidden');
  appEl.classList.remove('hidden');
  roomLabel.textContent = room;
}
joinBtn.addEventListener('click', doJoin);
[nameInput, roomInput].forEach((el) =>
  el.addEventListener('keydown', (e) => e.key === 'Enter' && doJoin())
);

// ---------- ПОЛЬЗОВАТЕЛИ ----------
socket.on('users', (users) => {
  usersList.innerHTML = '';
  users.forEach((u) => {
    const b = document.createElement('span');
    b.className = 'user-badge';
    b.style.background = u.color;
    b.textContent = u.name;
    usersList.appendChild(b);
  });
});

// ---------- INIT ----------
socket.on('init', ({ video, time, playing, history }) => {
  if (Array.isArray(history)) {
    messagesEl.innerHTML = '';
    history.forEach(addMsg);
  }
  if (video) loadVideo(video, { time, playing, remote: true });
});

// ---------- СМЕНА ВИДЕО ОТ ДРУГОГО ----------
socket.on('setVideo', (video) => loadVideo(video, { remote: true }));

// ---------- СИНХРОНИЗАЦИЯ ----------
socket.on('sync', ({ time, playing }) => applySync({ time, playing }));

// ---------- ЧАТ ----------
socket.on('chat', addMsg);
socket.on('system', (m) => addMsg({ system: true, text: m.text }));

function addMsg({ name, color, text, system }) {
  const div = document.createElement('div');
  div.className = 'msg' + (system ? ' system' : '');
  if (system) {
    div.textContent = '— ' + text;
  } else {
    const a = document.createElement('span');
    a.className = 'author';
    a.style.color = color || '#ff2d78';
    a.textContent = name + ':';
    div.appendChild(a);
    div.appendChild(document.createTextNode(text));
  }
  messagesEl.appendChild(div);
  messagesEl.scrollTop = messagesEl.scrollHeight;
}

function sendChat() {
  const t = chatInput.value.trim();
  if (!t) return;
  socket.emit('chat', t);
  chatInput.value = '';
}
sendBtn.addEventListener('click', sendChat);
chatInput.addEventListener('keydown', (e) => e.key === 'Enter' && sendChat());

// ---------- ВЫХОД / ССЫЛКА ----------
leaveBtn.addEventListener('click', () => location.reload());
copyLinkBtn.addEventListener('click', async () => {
  try {
    await navigator.clipboard.writeText(location.href);
    copyLinkBtn.textContent = '✅';
    setTimeout(() => (copyLinkBtn.textContent = '🔗'), 1200);
  } catch { prompt('Скопируй ссылку:', location.href); }
});

// ---------- РЕАКЦИИ ----------
document.querySelectorAll('.react-btn').forEach((b) => {
  b.addEventListener('click', () => socket.emit('reaction', b.dataset.emoji));
});

socket.on('reaction', ({ emoji }) => spawnEmoji(emoji));

function spawnEmoji(emoji) {
  const el = document.createElement('div');
  el.className = 'floating-emoji';
  el.textContent = emoji;
  el.style.left = (5 + Math.random() * 90) + '%';
  el.style.fontSize = (32 + Math.random() * 24) + 'px';
  el.style.animationDuration = (2 + Math.random() * 1.2) + 's';
  emojiLayer.appendChild(el);
  setTimeout(() => el.remove(), 3600);
}

// =============================================================
//  ПЛЕЕРЫ
// =============================================================
let currentType = null;   // 'youtube' | 'vk' | 'file'
let ytPlayer = null;
let vkIframe = null;
let vkPlayerInited = false;
let pendingVkSync = null;
let vkLastSent = 0;
let fileVideoEl = null;
let hlsInstance = null;
let suppressSync = false;
let lastSentTime = 0;

// ---------- YOUTUBE ----------
window.onYouTubeIframeAPIReady = () => { /* готов */ };

function extractYouTubeId(url) {
  const m = String(url).match(
    /(?:youtu\.be\/|youtube\.com\/(?:watch\?v=|embed\/|shorts\/|live\/))([\w-]{11})/
  );
  return m ? m[1] : null;
}

function createYouTube(videoId, { time = 0, playing = false } = {}) {
  clearPlayerArea();
  currentType = 'youtube';
  emptyState.classList.add('hidden');

  const div = document.createElement('div');
  div.id = 'ytPlayer';
  div.style.width = '100%';
  div.style.height = '100%';
  playerContainer.appendChild(div);

  if (!window.YT) {
    setTimeout(() => createYouTube(videoId, { time, playing }), 500);
    return;
  }

  ytPlayer = new YT.Player('ytPlayer', {
    videoId,
    playerVars: { rel: 0, modestbranding: 1, playsinline: 1 },
    events: {
      onReady: (e) => {
        e.target.seekTo(time, true);
        if (playing) e.target.playVideo();
        else e.target.pauseVideo();
      },
      onStateChange: (e) => {
        if (suppressSync) return;
        const st = e.data;
        
        // Если это реклама (состояние 5 или 3), МЫ НЕ ОТПРАВЛЯЕМ время, чтобы не сбить других
        if (st === 3 || st === 5) return; 
        
        if (st === YT.PlayerState.PLAYING || st === YT.PlayerState.PAUSED) {
          sendSync({ time: e.target.getCurrentTime(), playing: st === YT.PlayerState.PLAYING });
        }
      }
    }
  });
}

// ---------- VK VIDEO ----------
function extractVK(url) {
  try {
    const u = new URL(url);
    
    // Если ссылка вида https://vk.com/video-123_456
    const m = u.pathname.match(/\/video(-?\d+)_(\d+)/) || url.match(/video(-?\d+)_(\d+)/);
    if (m) {
      const params = new URLSearchParams({
        oid: m[1], id: m[2], hd: '2', js_api: '1', autoplay: '0'
      });
      return { embedUrl: `https://vk.com/video_ext.php?${params.toString()}` };
    }

    // Если это уже готовая embed-ссылка
    if (u.pathname.includes('video_ext.php')) {
      u.searchParams.set('js_api', '1');
      u.searchParams.set('autoplay', '0');
      return { embedUrl: u.toString() };
    }
  } catch {}
  return null;
}

function createVK(embedUrl, opts = {}) {
  clearPlayerArea();
  currentType = 'vk';
  vkPlayerInited = false;
  emptyState.classList.add('hidden');

  vkIframe = document.createElement('iframe');
  vkIframe.src = embedUrl;
  vkIframe.allow = 'autoplay; encrypted-media; fullscreen; picture-in-picture';
  vkIframe.allowFullscreen = true;
  vkIframe.style.width = '100%';
  vkIframe.style.height = '100%';
  vkIframe.style.border = '0';
  playerContainer.appendChild(vkIframe);

  window.addEventListener('message', onVkMessage);
}

function vkPost(method, params = {}) {
  if (!vkIframe || !vkIframe.contentWindow) return;
  try {
    vkIframe.contentWindow.postMessage(JSON.stringify({ method, params }), '*');
  } catch {}
}

function onVkMessage(e) {
  if (currentType !== 'vk' || !vkIframe) return;
  let data = e.data;
  try { if (typeof data === 'string') data = JSON.parse(data); } catch { return; }
  if (!data || !data.event) return;

  switch (data.event) {
    case 'inited':
      vkPlayerInited = true;
      if (pendingVkSync) {
        vkPost('seek', { time: pendingVkSync.time });
        if (pendingVkSync.playing) vkPost('play');
        pendingVkSync = null;
      }
      break;

    // Если видео переключили прямо внутри ВК
    case 'videostart':
      if (suppressSync) return;
      // data.videoId содержит ID нового видео, например -123_456
      if (data.videoId) {
        const newUrl = `https://vk.com/video${data.videoId}`;
        socket.emit('setVideo', { type: 'vk', id: null, url: newUrl });
      }
      break;

    case 'started':
    case 'resumed':
      if (suppressSync || data.ad) return; 
      sendSync({ time: data.time ?? 0, playing: true });
      break;

    case 'paused':
      if (suppressSync || data.ad) return;
      sendSync({ time: data.time ?? 0, playing: false });
      break;

    case 'timeupdate': {
      if (suppressSync || data.ad) return;
      const now = Date.now();
      if (now - vkLastSent > 3000) {
        vkLastSent = now;
        sendSync({ time: data.time ?? 0, playing: true });
      }
      break;
    }
  }
}

function applyVkSync({ time, playing }) {
  if (!vkPlayerInited) {
    pendingVkSync = { time, playing };
    return;
  }
  // Принудительно перематываем, если отставание больше 2 секунд
  if (typeof time === 'number') {
    vkPost('seek', { time });
  }
  if (playing) {
    vkPost('play');
  } else {
    vkPost('pause');
  }
}

// ---------- FILE / HLS ----------
function createFile(url, opts = {}) {
  clearPlayerArea();
  currentType = 'file';
  emptyState.classList.add('hidden');

  fileVideoEl = document.createElement('video');
  fileVideoEl.controls = true;
  fileVideoEl.playsInline = true;
  fileVideoEl.crossOrigin = 'anonymous';
  fileVideoEl.style.width = '100%';
  fileVideoEl.style.height = '100%';
  playerContainer.appendChild(fileVideoEl);

  const isHls = /\.m3u8(\?|#|$)/i.test(url);

  if (isHls) {
    // сначала проверим нативную поддержку (Safari / iOS)
    const canNative = fileVideoEl.canPlayType('application/vnd.apple.mpegurl');
    if (canNative) {
      fileVideoEl.src = url;
    } else {
      ensureHlsLib().then((Hls) => {
        if (!Hls || !Hls.isSupported()) {
          fileVideoEl.src = url; // последняя попытка
          return;
        }
        hlsInstance = new Hls({
          maxBufferLength: 30,
          maxMaxBufferLength: 60,
          enableWorker: true,
          lowLatencyMode: false
        });
        hlsInstance.loadSource(url);
        hlsInstance.attachMedia(fileVideoEl);

        hlsInstance.on(Hls.Events.ERROR, (_, data) => {
          console.warn('[hls] error', data);
          if (!data.fatal) return;
          if (data.type === Hls.ErrorTypes.NETWORK_ERROR) hlsInstance.startLoad();
          else if (data.type === Hls.ErrorTypes.MEDIA_ERROR) hlsInstance.recoverMediaError();
          else hlsInstance.destroy();
        });
      }).catch((e) => {
        console.error('hls.js load failed', e);
        fileVideoEl.src = url;
      });
    }
  } else {
    fileVideoEl.src = url;
  }

  // синхронизация
  const send = (playing) => {
    if (suppressSync) return;
    sendSync({ time: fileVideoEl.currentTime, playing });
  };
  fileVideoEl.addEventListener('play', () => send(true));
  fileVideoEl.addEventListener('pause', () => send(false));
  fileVideoEl.addEventListener('seeked', () => send(!fileVideoEl.paused));

  if (opts.remote && typeof opts.time === 'number') {
    const seek = () => {
      try { fileVideoEl.currentTime = opts.time; } catch {}
      if (opts.playing) fileVideoEl.play().catch(() => {});
    };
    if (fileVideoEl.readyState >= 1) seek();
    else fileVideoEl.addEventListener('loadedmetadata', seek, { once: true });
  }
}

// ---------- УНИВЕРСАЛЬНАЯ ЗАГРУЗКА ----------
function loadVideo(video, opts = {}) {
  const { type, id } = video;
  if (type === 'youtube') createYouTube(id, opts);
  else if (type === 'vk') createVK(id, opts);
  else if (type === 'file') createFile(id, opts);
}

loadBtn.addEventListener('click', () => {
  const url = urlInput.value.trim();
  if (!url) return;

  const ytId = extractYouTubeId(url);
  if (ytId) {
    socket.emit('setVideo', { type: 'youtube', id: ytId, url });
    return;
  }
  const vk = extractVK(url);
  if (vk) {
    // Передаем embedUrl для ВК
    socket.emit('setVideo', { type: 'vk', id: vk.embedUrl, url });
    return;
  }
  // прямой файл
  socket.emit('setVideo', { type: 'file', id: url, url });
});
urlInput.addEventListener('keydown', (e) => e.key === 'Enter' && loadBtn.click());

// ---------- SYNC ----------
function sendSync({ time, playing }) {
  const now = Date.now();
  if (now - lastSentTime < 400) return;
  lastSentTime = now;
  socket.emit('sync', { time, playing });
}

function applySync({ time, playing }) {
  if (suppressSync) return; 
  suppressSync = true;
  
  try {
    if (currentType === 'youtube' && ytPlayer && ytPlayer.seekTo) {
      // Проверяем, не крутится ли у нас реклама сейчас
      const state = ytPlayer.getPlayerState();
      if (state === 3 || state === 5) return; // если реклама — игнорируем

      const currentTime = ytPlayer.getCurrentTime();
      
      // Если отставание больше 2 секунд, принудительно перематываем
      if (typeof time === 'number' && Math.abs(currentTime - time) > 2) {
        ytPlayer.seekTo(time, true);
      }
      
      if (playing) {
        ytPlayer.playVideo();
      } else {
        ytPlayer.pauseVideo();
      }
    } else if (currentType === 'vk') {
      applyVkSync({ time, playing });
    } else if (currentType === 'file' && fileVideoEl) {
      const currentTime = fileVideoEl.currentTime;
      if (typeof time === 'number' && Math.abs(currentTime - time) > 2) {
         fileVideoEl.currentTime = time;
      }
      if (playing) {
        fileVideoEl.play().catch(() => {
           fileVideoEl.muted = true;
           fileVideoEl.play().then(() => { fileVideoEl.muted = false; }).catch(()=>{});
        });
      } else {
        fileVideoEl.pause();
      }
    }
  } finally {
    setTimeout(() => { suppressSync = false; }, 500);
  }
}

// периодическая коррекция дрейфа
setInterval(() => {
  if (suppressSync) return;
  if (currentType === 'youtube' && ytPlayer?.getPlayerState) {
    if (ytPlayer.getPlayerState() === 1) {
      sendSync({ time: ytPlayer.getCurrentTime(), playing: true });
    }
  } else if (currentType === 'file' && fileVideoEl && !fileVideoEl.paused) {
    sendSync({ time: fileVideoEl.currentTime, playing: true });
  }
}, 5000);

// ---------- очистка ----------
function clearPlayerArea() {
  window.removeEventListener('message', onVkMessage);
  if (ytPlayer?.destroy) { try { ytPlayer.destroy(); } catch {} }
  ytPlayer = null;
  vkIframe = null;
  vkPlayerInited = false;
  pendingVkSync = null;
  fileVideoEl = null;
  if (hlsInstance) { try { hlsInstance.destroy(); } catch {} hlsInstance = null; }
  playerContainer.innerHTML = '';
}

// =============================================================
//  SCREEN SHARE (WebRTC)
// =============================================================
let peer = null;
let localStream = null;

shareScreenBtn.addEventListener('click', async () => {
  try {
    localStream = await navigator.mediaDevices.getDisplayMedia({
      video: { frameRate: { ideal: 30 } },
      audio: true
    });
    screenVideo.srcObject = localStream;
    screenVideo.classList.remove('hidden');
    playerContainer.classList.add('hidden');
    emptyState.classList.add('hidden');
    shareScreenBtn.classList.add('hidden');
    stopScreenBtn.classList.remove('hidden');

    await ensurePeer();
    localStream.getTracks().forEach((t) => {
      t.addEventListener('ended', stopShare);
      peer.addTrack(t, localStream);
    });
    const offer = await peer.createOffer();
    await peer.setLocalDescription(offer);
    socket.emit('rtc-offer', { sdp: offer });
  } catch (e) {
    console.warn('Screen share cancelled:', e);
  }
});

stopScreenBtn.addEventListener('click', stopShare);

function stopShare() {
  if (localStream) localStream.getTracks().forEach((t) => t.stop());
  localStream = null;
  screenVideo.srcObject = null;
  screenVideo.classList.add('hidden');
  playerContainer.classList.remove('hidden');
  shareScreenBtn.classList.remove('hidden');
  stopScreenBtn.classList.add('hidden');
  if (peer) { peer.close(); peer = null; }
  socket.emit('rtc-stop');
}

async function ensurePeer() {
  if (peer) return peer;
  peer = new RTCPeerConnection({
    iceServers: [
      { urls: 'stun:stun.l.google.com:19302' },
      { urls: 'stun:stun1.l.google.com:19302' }
    ]
  });
  peer.onicecandidate = (e) => {
    if (e.candidate) socket.emit('rtc-ice', { candidate: e.candidate });
  };
  peer.ontrack = (e) => {
    screenVideo.srcObject = e.streams[0];
    screenVideo.classList.remove('hidden');
    playerContainer.classList.add('hidden');
    emptyState.classList.add('hidden');
  };
  return peer;
}

socket.on('rtc-offer', async ({ sdp }) => {
  await ensurePeer();
  await peer.setRemoteDescription(new RTCSessionDescription(sdp));
  const answer = await peer.createAnswer();
  await peer.setLocalDescription(answer);
  socket.emit('rtc-answer', { sdp: answer });
});
socket.on('rtc-answer', async ({ sdp }) => {
  if (!peer) return;
  await peer.setRemoteDescription(new RTCSessionDescription(sdp));
});
socket.on('rtc-ice', async ({ candidate }) => {
  if (!peer || !candidate) return;
  try { await peer.addIceCandidate(new RTCIceCandidate(candidate)); } catch {}
});
socket.on('rtc-stop', () => {
  screenVideo.srcObject = null;
  screenVideo.classList.add('hidden');
  playerContainer.classList.remove('hidden');
  emptyState.classList.remove('hidden');
  if (peer) { peer.close(); peer = null; }
});
