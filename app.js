'use strict';

/* ============================================================
 * Семейная связь — static GitHub Pages edition
 * Reverse-engineered from the original Node.js + Socket.io app.
 *
 * Architecture:
 *   - Auth: client-side PBKDF2 (Web Crypto) + localStorage
 *   - Rooms: localStorage + URL invite links (?room=CODE&invite=TOKEN)
 *   - WebRTC signaling: PeerJS public broker (no backend)
 *   - Chat: localStorage history + PeerJS data-channel live sync
 *   - Media mail (recorded): IndexedDB Blob storage
 *   - Files (uploaded): IndexedDB Blob storage
 *   - Admin: client-side user management in localStorage
 *
 * Default users: admin/admin, guest/guest  (change after first login)
 * ============================================================ */

/* ---------- Path / config ---------- */
const BASE_PATH = (function detectBase() {
  // GitHub Pages serves this at /call/ — derive from the script src so
  // it works no matter where the page is hosted.
  const scripts = document.getElementsByTagName('script');
  for (let i = 0; i < scripts.length; i++) {
    const src = scripts[i].src || '';
    const idx = src.lastIndexOf('/');
    if (idx >= 0 && src.slice(idx + 1).startsWith('app.js')) {
      const origin = new URL(src).origin;
      const path = src.slice(origin.length, idx); // like "/call/" or "/"
      return path.replace(/\/+$/, ''); // strip trailing slash -> "/call" or ""
    }
  }
  // Fallback: derive from pathname
  const path = location.pathname.replace(/\/index\.html$/, '/');
  return path.replace(/\/+$/, '');
})();
const APP_URL = (p = '/') => `${BASE_PATH}${p.startsWith('/') ? p : '/' + p}`;

/* ---------- PeerJS config ---------- */
const PEERJS_KEY = undefined; // use free public PeerJS broker
const PEER_ID_PREFIX = 'iac-call-v1-';
const ROOM_PEER_ID = (code) => `${PEER_ID_PREFIX}room-${code.toLowerCase()}`;
const ICE_SERVERS = [
  { urls: 'stun:stun.l.google.com:19302' },
  { urls: 'stun:stun1.l.google.com:19302' },
  { urls: 'stun:global.stun.twilio.com:3478' },
  // Free TURN servers from OpenRelay (for NAT traversal on mobile networks)
  { urls: 'turn:openrelay.metered.ca:80', username: 'openrelay', credential: 'openrelay' },
  { urls: 'turn:openrelay.metered.ca:443', username: 'openrelay', credential: 'openrelay' },
  { urls: 'turn:openrelay.metered.ca:443?transport=tcp', username: 'openrelay', credential: 'openrelay' }
];

/* ---------- IndexedDB shim removed — all media now lives in GitHub repo ---------- */

/* ---------- Icon helpers ---------- */
const iconClasses = {
  'video': 'fa-video',
  'microphone': 'fa-microphone',
  'phone': 'fa-phone',
  'phone-slash': 'fa-phone-slash',
  'comment': 'fa-comment',
  'folder': 'fa-folder',
  'user-gear': 'fa-user-gear',
  'right-to-bracket': 'fa-right-to-bracket',
  'right-from-bracket': 'fa-right-from-bracket',
  'rotate': 'fa-rotate',
  'download': 'fa-download',
  'upload': 'fa-upload',
  'cloud-arrow-up': 'fa-cloud-arrow-up',
  'plus': 'fa-plus',
  'copy': 'fa-copy',
  'paper-plane': 'fa-paper-plane',
  'record-vinyl': 'fa-record-vinyl',
  'square': 'fa-square',
  'signal': 'fa-signal',
  'xmark': 'fa-xmark',
  'eye': 'fa-eye',
  'trash': 'fa-trash',
  'wand': 'fa-wand-magic-sparkles',
  'file-video': 'fa-file-video',
  'file-audio': 'fa-file-audio',
  'file-image': 'fa-file-image',
  'file-pdf': 'fa-file-pdf',
  'file-lines': 'fa-file-lines',
  'file': 'fa-file',
  'bars': 'fa-bars',
  'user-plus': 'fa-user-plus',
  'key': 'fa-key'
};
function icon(name) { const fa = iconClasses[name] || 'fa-file'; return `<i class="fa-solid ${fa}" aria-hidden="true"></i>`; }
function renderIcons(root = document) { root.querySelectorAll('[data-icon]').forEach((el) => { el.innerHTML = icon(el.getAttribute('data-icon')); }); }

/* ---------- Tiny helpers ---------- */
const $ = (sel) => document.querySelector(sel);
const $$ = (sel) => Array.from(document.querySelectorAll(sel));
const on = (sel, event, handler) => { const el = $(sel); if (el) el.addEventListener(event, handler); };
const bindClick = (sel, handler) => on(sel, 'click', handler);
function toast(message, kind = 'info') { const t = $('#toast'); t.textContent = message; t.className = `toast ${kind}`; t.classList.remove('hidden'); clearTimeout(t._timer); t._timer = setTimeout(() => t.classList.add('hidden'), 4200); }
function fmtTime(iso) { if (!iso) return ''; try { return new Intl.DateTimeFormat('ru-RU', { dateStyle: 'short', timeStyle: 'short' }).format(new Date(iso)); } catch { return iso; } }
function fmtBytes(b) { const n = Number(b || 0); if (n < 1024) return `${n} B`; if (n < 1048576) return `${(n / 1024).toFixed(1)} KB`; if (n < 1073741824) return `${(n / 1048576).toFixed(1)} MB`; return `${(n / 1073741824).toFixed(2)} GB`; }
function escapeHtml(v) { return String(v ?? '').replace(/[&<>'"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', "'": '&#39;', '"': '&quot;' }[c])); }
function setStatus(el, text, kind = '') { if (!el) return; el.textContent = text; el.className = `status-pill ${kind}`.trim(); }

// Connection quality indicator — updates the call screen badge
function updateConnectionIndicator() {
  const badge = $('#connQuality');
  if (!badge) return;
  // Count peers from BOTH _peerNames (got hello) AND Trystero getPeers() (discovered)
  const trysteroPeers = state._room ? Object.keys(state._room.getPeers()).length : 0;
  const peerCount = Math.max(_peerNames.size, trysteroPeers);
  const calls = state.remoteStreams.size;
  const hasPeer = !!state.peer;
  const hasRoom = !!state.currentRoom;

  if (!hasRoom) {
    badge.className = 'conn-badge idle';
    badge.innerHTML = '<span class="conn-dot"></span><span>Нет комнаты</span>';
  } else if (!hasPeer) {
    badge.className = 'conn-badge connecting';
    badge.innerHTML = '<span class="conn-dot pulse"></span><span>Подключение…</span>';
  } else if (peerCount === 0) {
    badge.className = 'conn-badge waiting';
    badge.innerHTML = '<span class="conn-dot pulse"></span><span>Ожидание участников…</span>';
  } else if (calls > 0) {
    badge.className = 'conn-badge live';
    badge.innerHTML = '<span class="conn-dot live"></span><span>В эфире · ' + peerCount + ' участн.</span>';
  } else {
    badge.className = 'conn-badge ready';
    badge.innerHTML = '<span class="conn-dot"></span><span>' + peerCount + ' участн. в комнате</span>';
  }
  // Also update the interactive guide
  updateCallGuide();
}

/* ---------- Interactive call guide ---------- */
// Narrates the call setup sequence and highlights the next button to press.
// Steps: room -> camera -> mic -> wait -> call
function updateCallGuide() {
  const guide = $('#callGuide');
  if (!guide) return;

  const hasRoom = !!state.currentRoom;
  const hasVideo = hasVideoTrack(state.localStream);
  const hasAudio = hasAudioTrack(state.localStream);
  // Count peers from BOTH _peerNames (got hello) AND Trystero getPeers() (discovered)
  const trysteroPeers = state._room ? Object.keys(state._room.getPeers()).length : 0;
  const peerCount = Math.max(_peerNames.size, trysteroPeers);
  const inCall = state.remoteStreams.size > 0;

  // Highlight the actual control button for the active step
  highlightActiveButton(hasRoom ? (hasVideo ? (hasAudio ? (peerCount > 0 ? (inCall ? null : 'call') : 'wait') : 'mic') : 'camera') : 'room');

  if (inCall) {
    guide.innerHTML = '<div class="guide-narration done">✓ В эфире — связь установлена</div>';
    return;
  }

  // Build step list
  const steps = [
    { id: 'room', label: 'Выбрать комнату', done: hasRoom },
    { id: 'camera', label: 'Включить камеру', done: hasVideo },
    { id: 'mic', label: 'Включить микрофон', done: hasAudio },
    { id: 'wait', label: 'Дождаться участников', done: peerCount > 0 },
    { id: 'call', label: 'Нажать «Позвонить»', done: false }
  ];

  // Find the active (next) step
  const activeStep = steps.find((s) => !s.done);

  // Build narration text
  let narration = '';
  if (!hasRoom) {
    narration = 'Выберите комнату из списка ниже или создайте новую';
  } else if (!hasVideo) {
    narration = `Комната ${state.currentRoom.code} готова. Включите камеру ↓`;
  } else if (!hasAudio) {
    narration = 'Камера включена. Теперь включите микрофон ↓';
  } else if (peerCount === 0) {
    narration = 'Камера и микрофон готовы. Ждём других участников…';
  } else {
    narration = `${peerCount} участник(ов) в комнате. Нажмите «Позвонить» ↓`;
  }

  // Build room picker if no room selected
  let roomPicker = '';
  if (!hasRoom && state.rooms.length > 0) {
    roomPicker = '<div class="guide-rooms">' +
      state.rooms.map((r) => `<button class="guide-room-btn" data-room-id="${r.id}"><span class="guide-room-icon"><span data-icon="video"></span></span><span class="guide-room-label"><strong>Комната</strong> ${escapeHtml(r.title)}</span><span class="guide-room-code">${escapeHtml(r.code)}</span></button>`).join('') +
      '</div>';
  } else if (!hasRoom) {
    roomPicker = '<div class="guide-rooms-empty">Нет комнат. Нажмите кнопку 🎥 вверху слева, чтобы создать.</div>';
  }

  // Render steps
  const stepsHTML = steps.map((s, i) => {
    const cls = s.done ? 'done' : (s === activeStep ? 'active' : '');
    return `<div class="guide-step ${cls}"><span class="step-num">${s.done ? '✓' : (i + 1)}</span><span>${s.label}</span></div>`;
  }).join('');

  guide.innerHTML = `
    <div class="guide-narration ${activeStep ? activeStep.id : ''}">${narration}</div>
    ${roomPicker}
    <div class="guide-steps">${stepsHTML}</div>
  `;

  // Bind room picker clicks
  guide.querySelectorAll('.guide-room-btn').forEach((btn) => {
    btn.onclick = () => selectRoom(btn.dataset.roomId);
  });
}

// Highlight the actual call control button for the active step
function highlightActiveButton(stepId) {
  const buttons = {
    room: '#openRoomsBtn',
    camera: '#cameraBtn',
    mic: '#muteBtn',
    call: '#callBtn'
  };
  // Clear all highlights
  Object.values(buttons).forEach((sel) => {
    const el = $(sel);
    if (el) el.classList.remove('guide-highlight');
  });
  // Highlight the active one
  if (stepId && buttons[stepId]) {
    const el = $(buttons[stepId]);
    if (el) el.classList.add('guide-highlight');
  }
}
function isLocalOrigin() { return ['localhost', '127.0.0.1', '::1'].includes(location.hostname); }
function randomId(prefix = '') { return `${prefix}${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 10)}`; }
function randomCode() {
  // 8 chars: 4 chars - 4 chars, base32 (no ambiguous chars)
  const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  const pick = (n) => Array.from({ length: n }, () => alphabet[Math.floor(Math.random() * alphabet.length)]).join('');
  return `${pick(4)}-${pick(4)}`;
}
function randomToken() {
  const arr = new Uint8Array(9);
  crypto.getRandomValues(arr);
  return Array.from(arr).map((b) => b.toString(16).padStart(2, '0')).join('');
}

/* ---------- Media device helpers ---------- */
function mediaProblemMessage() {
  if (!window.isSecureContext && !isLocalOrigin()) return 'Камера и микрофон доступны только через HTTPS. Откройте сайт по публичному HTTPS‑адресу.';
  if (!navigator.mediaDevices && !navigator.getUserMedia && !navigator.webkitGetUserMedia && !navigator.mozGetUserMedia) return 'Этот браузер не отдаёт navigator.mediaDevices.getUserMedia.';
  return 'Камера/микрофон недоступны. Проверьте разрешения браузера и откройте сайт по HTTPS.';
}
function getUserMediaCompat(constraints) {
  if (navigator.mediaDevices && typeof navigator.mediaDevices.getUserMedia === 'function') return navigator.mediaDevices.getUserMedia(constraints);
  const legacy = navigator.getUserMedia || navigator.webkitGetUserMedia || navigator.mozGetUserMedia;
  if (legacy) return new Promise((resolve, reject) => legacy.call(navigator, constraints, resolve, reject));
  return Promise.reject(new Error(mediaProblemMessage()));
}
function normalizeMediaError(error, wantedVideo = false) {
  const name = error?.name || '', message = error?.message || '';
  if (String(message).includes('navigator.mediaDevices') || String(message).includes('undefined')) return mediaProblemMessage();
  if (name === 'NotAllowedError' || name === 'PermissionDeniedError') return 'Доступ к камере/микрофону запрещён. Разрешите доступ в настройках браузера.';
  if (name === 'NotFoundError' || name === 'DevicesNotFoundError') return wantedVideo ? 'Камера не найдена. Можно попробовать режим «Только микрофон».' : 'Микрофон не найдён.';
  if (name === 'NotReadableError' || name === 'TrackStartError') return 'Устройство занято другой вкладкой/приложением или недоступно системе.';
  if (name === 'OverconstrainedError') return 'Телефон не поддержал запрошенные параметры камеры.';
  return message || mediaProblemMessage();
}
function hasVideoTrack(s) { return !!s && s.getVideoTracks().some((t) => t.readyState !== 'ended'); }
function hasAudioTrack(s) { return !!s && s.getAudioTracks().some((t) => t.readyState !== 'ended'); }
function attachLocalStream(stream) { const v = $('#localVideo'); v.srcObject = stream || null; if (stream) { v.muted = true; v.playsInline = true; v.play?.().catch(() => {}); } }

async function checkBrowserMediaSupport() {
  const secure = window.isSecureContext || isLocalOrigin();
  const gum = !!(navigator.mediaDevices?.getUserMedia || navigator.getUserMedia || navigator.webkitGetUserMedia || navigator.mozGetUserMedia);
  const rec = !!window.MediaRecorder;
  const msg = `Браузер: ${secure ? 'HTTPS ok' : 'нет HTTPS'} · камера ${gum ? 'доступна' : 'нет API'} · запись ${rec ? 'ok' : 'нет'}`;
  const el = $('#browserStatus'); if (el) setStatus(el, msg, secure && gum ? 'ok' : 'bad');
}

/* ============================================================
 * Crypto: PBKDF2 password hashing via Web Crypto API
 * ============================================================ */
const PBKDF2_ITER = 100000;
const HASH_BITS = 256;
function bufToHex(buf) { return Array.from(new Uint8Array(buf)).map((b) => b.toString(16).padStart(2, '0')).join(''); }
function hexToBuf(hex) { const arr = new Uint8Array(hex.length / 2); for (let i = 0; i < arr.length; i++) arr[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16); return arr.buffer; }
function newSalt() { const a = new Uint8Array(16); crypto.getRandomValues(a); return bufToHex(a.buffer); }
async function hashPassword(password, saltHex) {
  const enc = new TextEncoder();
  const keyMaterial = await crypto.subtle.importKey('raw', enc.encode(password), 'PBKDF2', false, ['deriveBits']);
  const bits = await crypto.subtle.deriveBits({ name: 'PBKDF2', salt: hexToBuf(saltHex), iterations: PBKDF2_ITER, hash: 'SHA-256' }, keyMaterial, HASH_BITS);
  return bufToHex(bits);
}
async function verifyPassword(password, saltHex, expectedHash) {
  const h = await hashPassword(password, saltHex);
  return h === expectedHash;
}

/* ============================================================
 * Storage layer — GitHub-backed via gh-store.js (GH global)
 * localStorage is only used for session tokens (per-device).
 * ============================================================ */
const LS_KEY = 'call-static-db-v1'; // legacy, kept for migration
const SESSION_KEY = 'call-static-session-v1';

// Cached DB loaded from GitHub
let _db = null;

// loadDb / saveDb / ensureDb are async now (hit GitHub)
async function loadDb() {
  const r = await GH.getDbCached();
  _db = r?.db || null;
  return _db;
}
// Synchronous accessor for places where we've already loaded _db
function dbNow() { return _db; }
async function saveDb(newDb) {
  // Push to GitHub (debounced internally); update local cache
  await GH.updateDb((cur) => {
    Object.assign(cur, newDb);
    return cur;
  }, `update db @ ${new Date().toISOString()}`);
  _db = (await GH.getDbCached()).db;
  return _db;
}
async function ensureDb() {
  if (!_db) await loadDb();
  if (!_db) {
    // Initialize a fresh db.json on GitHub
    _db = {
      version: 1,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      settings: { title: 'Семейная связь', inviteBasePath: APP_URL('/') },
      users: [], rooms: [], messages: [], media: [], events: []
    };
    await saveDb(_db);
  }
  return _db;
}
async function seedDefaultUsers() {
  await ensureDb();
  let changed = false;
  if (!_db.users.some((u) => u.username === 'admin')) {
    const salt = newSalt();
    const hash = await hashPassword('admin', salt);
    _db.users.push({ id: randomId('usr_'), username: 'admin', displayName: 'Администратор', role: 'admin', salt, hash, createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(), disabled: false });
    changed = true;
  }
  if (!_db.users.some((u) => u.username === 'guest')) {
    const salt = newSalt();
    const hash = await hashPassword('guest', salt);
    _db.users.push({ id: randomId('usr_'), username: 'guest', displayName: 'Гость семьи', role: 'guest', salt, hash, createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(), disabled: false });
    changed = true;
  }
  if (changed) await saveDb(_db);
}

/* ---------- Session (persists across tab close via localStorage) ---------- */
function setSession(user) {
  const token = randomToken();
  const session = { token, userId: user.id, username: user.username, displayName: user.displayName, role: user.role, createdAt: new Date().toISOString(), expiresAt: new Date(Date.now() + 14 * 86400 * 1000).toISOString() };
  // Use localStorage only (not sessionStorage) so login survives tab/browser close
  localStorage.setItem(SESSION_KEY, JSON.stringify(session));
}
function getSession() {
  try {
    const s = localStorage.getItem(SESSION_KEY);
    if (!s) return null;
    const session = JSON.parse(s);
    if (session.expiresAt && new Date(session.expiresAt) > new Date()) {
      return session;
    }
    // Expired — clean up
    localStorage.removeItem(SESSION_KEY);
  } catch {}
  return null;
}
function clearSession() {
  localStorage.removeItem(SESSION_KEY);
  // Also clear old sessionStorage entry from previous versions
  try { sessionStorage.removeItem(SESSION_KEY); } catch {}
  try { localStorage.removeItem(SESSION_KEY + '-long'); } catch {}
  // Clear persisted active tab so reload doesn't restore to a logged-out tab
  try { localStorage.removeItem('call-static-active-tab'); } catch {}
}

/* ============================================================
 * Global state
 * ============================================================ */
const state = {
  user: null,
  users: [],
  rooms: [],
  currentRoom: null,
  currentInviteToken: null,
  peer: null,           // PeerJS peer (my identity in the room mesh)
  peerId: null,         // my PeerJS id in the room
  peerConnections: new Map(), // peerId -> MediaConnection
  dataConnections: new Map(), // peerId -> DataConnection
  remoteStreams: new Map(),   // peerId -> MediaStream (currently rendered)
  localStream: null,
  pc: null,             // legacy single-PC field, kept for status display
  micMuted: false,
  camOff: false,
  recorder: null,
  recordChunks: [],
  recordStartedAt: 0,
  recordTimerId: null,
  installPrompt: null,
  health: { ok: true, storageWritable: true, ffmpegAvailable: false, maxUploadMb: 2048 },
  pendingJoin: null
};

/* ============================================================
 * Auth (client-side)
 * ============================================================ */
async function login() {
  const username = $('#loginUser').value.trim();
  const password = $('#loginPass').value;
  toast('Проверка учетных данных…', 'info');
  await ensureDb();
  const u = _db.users.find((x) => x.username === username && !x.disabled);
  if (!u) { toast('Пользователь не найден.', 'bad'); return; }
  const ok = await verifyPassword(password, u.salt, u.hash);
  if (!ok) { toast('Неверный пароль.', 'bad'); return; }
  // Set user state FIRST so login succeeds even if db write fails
  state.user = { id: u.id, username: u.username, displayName: u.displayName, role: u.role };
  setSession(state.user);
  requireLoginUi();
  toast('Вход выполнен.', 'ok');
  // Non-blocking: update lastLoginAt in background
  u.lastLoginAt = new Date().toISOString();
  saveDb(_db).catch((e) => console.warn('lastLoginAt save failed', e));
  await refreshAll();
  const joinedFromInvite = await autoJoinFromUrl();
  maybeOpenRoomChooser(joinedFromInvite);
}
async function logout() {
  clearSession();
  state.user = null;
  await disconnectPeer();
  resetCall();
  requireLoginUi();
  toast('Вы вышли.');
}
async function loadMe() {
  const s = getSession();
  if (!s) { state.user = null; requireLoginUi(); return; }
  await ensureDb();
  const u = _db.users.find((x) => x.id === s.userId && !x.disabled);
  if (!u) { clearSession(); state.user = null; requireLoginUi(); return; }
  state.user = { id: u.id, username: u.username, displayName: u.displayName, role: u.role };
  requireLoginUi();
  await refreshAll();
  const joinedFromInvite = await autoJoinFromUrl();
  maybeOpenRoomChooser(joinedFromInvite);
}

/* ============================================================
 * UI: auth state, panels, drawers
 * ============================================================ */
function requireLoginUi() {
  const logged = !!state.user;
  document.body.classList.toggle('is-logged-in', logged);
  document.body.classList.toggle('auth-only', !logged);
  $('#loginCard')?.classList.toggle('hidden', logged);
  $('#appScreen')?.classList.toggle('hidden', !logged);
  $('#userCard')?.classList.toggle('hidden', !logged);
  if (logged) $('#userName').textContent = `${state.user.displayName || state.user.username} · ${state.user.role}`;
  $$('.admin-only').forEach((el) => el.classList.toggle('hidden', !logged || state.user.role !== 'admin'));
  const params = new URLSearchParams(location.search);
  $('#inviteLoginHint')?.classList.toggle('hidden', !(params.get('room') && !logged));
}
function closeDrawers() { $('#appMenu')?.classList.remove('open'); $('#roomsDrawer')?.classList.remove('open'); $('#menuBackdrop')?.classList.remove('open'); $('#callStage')?.classList.remove('ui-hidden'); }
function enforceClosedDrawers() { $('#appMenu')?.classList.remove('open'); $('#roomsDrawer')?.classList.remove('open'); $('#menuBackdrop')?.classList.remove('open'); }
function enforceSingleActivePanel(name = 'calls') { $$('.tab').forEach((b) => b.classList.toggle('active', b.dataset.tab === name)); $$('.tab-panel').forEach((p) => p.classList.toggle('active', p.id === name)); }
function openMenu() { $('#roomsDrawer')?.classList.remove('open'); $('#appMenu')?.classList.add('open'); $('#menuBackdrop')?.classList.add('open'); }
function openRooms() { $('#appMenu')?.classList.remove('open'); $('#roomsDrawer')?.classList.add('open'); $('#menuBackdrop')?.classList.add('open'); }
function tab(name) {
  $$('.tab').forEach((b) => b.classList.toggle('active', b.dataset.tab === name));
  $$('.tab-panel').forEach((p) => p.classList.toggle('active', p.id === name));
  closeDrawers();
  // Persist active tab so it survives reload
  try { localStorage.setItem('call-static-active-tab', name); } catch {}
  // Lazy-render stats when the stats tab is opened
  if (name === 'stats') { refreshStats().catch(() => {}); }
  // Initialize mail guide when mail tab opens
  if (name === 'mail') { updateMailGuide(); }
}

/* ============================================================
 * Health check (static — always ok unless storage unavailable)
 * ============================================================ */
async function checkHealth() {
  try {
    const h = await GH.health();
    if (!h.ok) throw new Error(h.message || 'GH repo unreachable');
    state.health = { ok: true, storageWritable: true, ffmpegAvailable: false, maxUploadMb: h.maxUploadMb, gh: h };
    setStatus($('#apiStatus'), `API: ok · ${h.repo} · remaining ${h.remaining}/${h.limit} · upload ${h.maxUploadMb}MB`, 'ok');
    $('#uploadLimit').textContent = `до ${h.maxUploadMb} MB`;
  } catch (e) {
    state.health = { ok: false, storageWritable: false, ffmpegAvailable: false, maxUploadMb: 350 };
    setStatus($('#apiStatus'), `API: ошибка · ${e.message}`, 'bad');
    $('#uploadLimit').textContent = `до 100 MB`;
  }
}

/* ============================================================
 * Rooms (localStorage)
 * ============================================================ */
async function refreshAll() {
  if (!state.user) return;
  await ensureDb();
  await Promise.allSettled([refreshRooms(), refreshMessages(), refreshMail(), refreshFiles(), refreshUsers()]);
}
async function refreshRooms() {
  if (!state.user) return;
  await ensureDb();
  state.rooms = _db.rooms.filter((r) => r.ownerId === state.user.id || r.guestUserIds?.includes(state.user.id) || r.isPublic);
  renderRooms();
}
function renderRooms() {
  const box = $('#roomsList');
  if (!state.rooms.length) { box.className = 'list empty'; box.textContent = 'Нет комнат.'; updateCallGuide(); return; }
  box.className = 'list';
  box.innerHTML = state.rooms.map((r) => `
    <div class="room-item ${state.currentRoom?.id === r.id ? 'selected' : ''}" data-room-id="${r.id}">
      <div class="item-row">
        <div><strong>${escapeHtml(r.title)}</strong><div class="meta">код ${escapeHtml(r.code)} · ${fmtTime(r.createdAt)}</div></div>
        <button class="small icon-action select-room" data-id="${r.id}" data-tip="Войти" title="Войти" aria-label="Войти"><span data-icon="eye"></span></button>
      </div>
      <div class="item-actions">
        <button class="small icon-action invite-room" data-id="${r.id}" data-tip="Ссылка" title="Ссылка" aria-label="Ссылка"><span data-icon="copy"></span></button>
        <button class="small icon-action danger delete-room" data-id="${r.id}" data-tip="Удалить" title="Удалить" aria-label="Удалить"><span data-icon="trash"></span></button>
      </div>
    </div>`).join('');
  renderIcons(box);
  box.querySelectorAll('.select-room').forEach((b) => b.onclick = () => selectRoom(b.dataset.id));
  box.querySelectorAll('.invite-room').forEach((b) => b.onclick = () => makeInvite(b.dataset.id, true));
  box.querySelectorAll('.delete-room').forEach((b) => b.onclick = () => deleteRoom(b.dataset.id));
  updateCallGuide();
}
async function createRoom() {
  await ensureDb();
  // Reuse existing room — don't create duplicates
  if (_db.rooms.length > 0) {
    const existing = _db.rooms[0];
    // Normalize the room to use the standard code/title
    let changed = false;
    if (existing.code !== 'SEMJA') { existing.code = 'SEMJA'; changed = true; }
    if (existing.title !== 'Семейная связь') { existing.title = 'Семейная связь'; changed = true; }
    if (changed) {
      existing.updatedAt = new Date().toISOString();
      await saveDb(_db);
    }
    // Update local state.rooms to match
    const idx = state.rooms.findIndex((x) => x.id === existing.id);
    if (idx >= 0) state.rooms[idx] = existing;
    else state.rooms.unshift(existing);
    toast('Вход в комнату…', 'info');
    await selectRoom(existing.id, existing.inviteToken);
    return;
  }
  // No room exists yet — create the default family room
  const title = 'Семейная связь';
  const code = 'SEMJA';
  const room = {
    id: randomId('room_'),
    code,
    title,
    ownerId: state.user.id,
    guestUserIds: [],
    active: true,
    inviteToken: randomToken(),
    isPublic: true,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    lastJoinAt: null
  };
  toast('Создание комнаты…', 'info');
  _db.rooms.unshift(room);
  await saveDb(_db);
  state.rooms.unshift(room);
  await selectRoom(room.id, room.inviteToken);
  toast('Комната создана.', 'ok');
  renderRooms();
}
async function selectRoom(id, inviteToken = null) {
  const room = state.rooms.find((x) => x.id === id);
  if (!room) return;
  state.currentRoom = room;
  state.currentInviteToken = inviteToken || state.currentInviteToken || room.inviteToken;
  $('#currentRoomTitle').textContent = room.title;
  $('#currentRoomCode').textContent = room.code;
  if ($('#currentRoomTitleMirror')) $('#currentRoomTitleMirror').textContent = room.title;
  if ($('#currentRoomCodeMirror')) $('#currentRoomCodeMirror').textContent = room.code;
  if ($('#callSubline')) $('#callSubline').textContent = `Комната ${room.code} готова. Откройте камеры и нажмите «Позвонить».`;
  $('#inviteLink').value = makeInviteUrl(room.code, state.currentInviteToken);
  await joinPeerRoom(room);
  renderRooms();
  renderPresence();
  updateConnectionIndicator();
  // Close the rooms drawer so user sees the call screen
  closeDrawers();
}
function makeInviteUrl(code, token) {
  const base = `${location.origin}${location.pathname.replace(/\/index\.html$/, '/')}`;
  const sep = base.includes('?') ? '&' : '?';
  return `${base}${sep}room=${encodeURIComponent(code)}&invite=${encodeURIComponent(token || '')}`;
}
async function makeInvite(id, copy = false) {
  const room = state.rooms.find((x) => x.id === id);
  if (!room) return;
  state.currentInviteToken = room.inviteToken;
  $('#inviteLink').value = makeInviteUrl(room.code, room.inviteToken);
  if (copy) {
    try { await navigator.clipboard?.writeText($('#inviteLink').value); toast('Ссылка приглашения скопирована.', 'ok'); }
    catch { toast('Скопируйте ссылку вручную.', 'warn'); }
  }
}
async function joinRoomByCodeManual() {
  const code = ($('#joinRoomCode')?.value || '').trim();
  const inviteToken = ($('#joinRoomToken')?.value || '').trim();
  if (!code) return toast('Введите код комнаты.', 'warn');
  await ensureDb();
  let room = _db.rooms.find((r) => r.code.toUpperCase() === code.toUpperCase());
  if (!room) {
    room = {
      id: randomId('room_'),
      code: code.toUpperCase(),
      title: `Комната ${code.toUpperCase()}`,
      ownerId: null,
      guestUserIds: [],
      active: true,
      inviteToken: inviteToken || randomToken(),
      isPublic: true,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      lastJoinAt: new Date().toISOString(),
      joinedByCode: true
    };
    _db.rooms.unshift(room);
    await saveDb(_db);
  }
  if (!state.rooms.some((x) => x.id === room.id)) state.rooms.unshift(room);
  state.currentInviteToken = inviteToken || room.inviteToken;
  await selectRoom(room.id, state.currentInviteToken);
  closeDrawers();
  toast('Вы вошли в комнату.', 'ok');
}
async function deleteRoom(id) {
  if (!confirm('Удалить комнату? Активный звонок в ней закончится.')) return;
  await ensureDb();
  _db.rooms = _db.rooms.filter((r) => r.id !== id);
  await saveDb(_db);
  state.rooms = state.rooms.filter((r) => r.id !== id);
  if (state.currentRoom?.id === id) leaveRoom();
  renderRooms();
  toast('Комната удалена.', 'ok');
}
async function leaveRoom() {
  hangup(false);
  await disconnectPeer();
  state.currentRoom = null;
  state.currentInviteToken = null;
  $('#currentRoomTitle').textContent = 'Комната не выбрана';
  $('#currentRoomCode').textContent = '-';
  if ($('#currentRoomTitleMirror')) $('#currentRoomTitleMirror').textContent = 'Комната не выбрана';
  if ($('#currentRoomCodeMirror')) $('#currentRoomCodeMirror').textContent = '-';
  if ($('#callSubline')) $('#callSubline').textContent = 'Выберите комнату ниже.';
  $('#inviteLink').value = '';
  $('#presenceBox').textContent = 'Участники: -';
  renderRooms();
  updateConnectionIndicator();
}
function maybeOpenRoomChooser(joinedFromInvite = false) {
  if (!state.user || joinedFromInvite) return;
  if (!state.currentRoom) {
    tab('calls');
    // Guide is shown inline on the call screen — no need to toast
  }
}
async function autoJoinFromUrl() {
  const params = new URLSearchParams(location.search);
  const code = params.get('room');
  const inviteToken = params.get('invite');
  if (!code || !state.user) return false;
  return await joinByCode(code, inviteToken);
}
async function joinByCode(code, inviteToken) {
  await ensureDb();
  let room = _db.rooms.find((r) => r.code.toUpperCase() === code.toUpperCase());
  if (!room) {
    room = {
      id: randomId('room_'),
      code: code.toUpperCase(),
      title: `Комната ${code.toUpperCase()}`,
      ownerId: null,
      guestUserIds: [],
      active: true,
      inviteToken: inviteToken || randomToken(),
      isPublic: true,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      lastJoinAt: new Date().toISOString(),
      joinedByCode: true
    };
    _db.rooms.unshift(room);
    await saveDb(_db);
  }
  if (!state.rooms.some((x) => x.id === room.id)) state.rooms.unshift(room);
  state.currentInviteToken = inviteToken || room.inviteToken;
  await selectRoom(room.id, state.currentInviteToken);
  tab('calls');
  closeDrawers();
  if ($('#callSubline')) $('#callSubline').textContent = `Вы вошли в комнату ${room.code} по приглашению.`;
  toast('Вы вошли в комнату по приглашению.', 'ok');
  // Clean URL
  try { history.replaceState({}, document.title, APP_URL('/')); } catch {}
  return true;
}
function renderPresence() {
  const me = state.user?.displayName || state.user?.username || 'Я';
  const others = Array.from(_peerNames.values());
  const all = [me, ...others];
  $('#presenceBox').textContent = `Участники: ${all.join(', ') || '-'}`;
}

/* ============================================================
 * FB Signaling — Firebase Realtime Database + WebRTC
 * Replaces Trystero. Uses Firebase REST API + SSE for peer discovery.
 * ============================================================ */

let _peerNames = new Map();
let _stopStreams = new Map();

async function ensureTrystero() {
  // No async import needed — FB is a global from fb-signaling.js
  return FB;
}

async function joinPeerRoom(room) {
  if (state._room) {
    await FB.leave();
    _peerNames.clear();
    for (const stop of _stopStreams.values()) { try { stop(); } catch {} }
    _stopStreams.clear();
    state.remoteStreams.clear();
    await new Promise((r) => setTimeout(r, 500));
  }

  state.currentRoom = room;
  state.currentRoomCode = room.code;

  await FB.joinRoom(room.code, {
    displayName: state.user.displayName || state.user.username,
    username: state.user.username
  });

  state.peer = { connected: true };
  state.peerId = FB.selfId;

  // Set up event handlers
  FB.onPeerJoin = (peerId) => {
    const peers = FB.getPeers();
    const info = peers[peerId];
    _peerNames.set(peerId, info?.displayName || 'Гость');
    renderPresence();
    updateConnectionIndicator();
    // Send hello
    if (state._sendHello) state._sendHello({ displayName: state.user.displayName || state.user.username, username: state.user.username }, peerId);
  };

  FB.onPeerLeave = (peerId) => {
    _peerNames.delete(peerId);
    state.remoteStreams.delete(peerId);
    _stopStreams.delete(peerId);
    renderPresence();
    updateRemoteVideo();
    updateConnectionIndicator();
  };

  FB.onPeerStream = async (stream, peerId) => {
    state.remoteStreams.set(peerId, stream);
    updateRemoteVideo();
    setStatus($('#peerStatus'), 'WebRTC: connected', 'ok');
    $('#pcState').textContent = `PC: connected (${state.remoteStreams.size})`;
    $('#iceState').textContent = `ICE: connected`;
    updateConnectionIndicator();
    // Auto-enter fullscreen when remote video first appears
    if (state.remoteStreams.size === 1) {
      const stage = $('#callStage');
      const video = $('#remoteVideo');
      if (stage) {
        let entered = false;
        if (stage.requestFullscreen) { try { await stage.requestFullscreen(); entered = true; } catch {} }
        if (!entered && stage.webkitRequestFullscreen) { try { stage.webkitRequestFullscreen(); entered = true; } catch {} }
        if (!entered && video?.webkitEnterFullscreen) { try { video.webkitEnterFullscreen(); entered = true; } catch {} }
        if (!entered) { stage.classList.add('ui-hidden'); window.scrollTo(0, 0); }
      }
      toast('Видео подключено ✓', 'ok');
    }
  };

  // Set up actions
  const [sendChat, onChat] = FB.makeAction('chat');
  const [sendHello, onHello] = FB.makeAction('hello');
  const [sendHangup, onHangup] = FB.makeAction('hangup');
  const [sendRing, onRing] = FB.makeAction('ring');
  const [sendRingAccept, onRingAccept] = FB.makeAction('ringAccept');
  const [sendRingDecline, onRingDecline] = FB.makeAction('ringDecline');

  state._sendChat = sendChat;
  state._sendHello = sendHello;
  state._sendHangup = sendHangup;
  state._sendRing = sendRing;
  state._sendRingAccept = sendRingAccept;
  state._sendRingDecline = sendRingDecline;
  state._room = FB;

  setStatus($('#socketStatus'), 'Сигналинг: подключён (Firebase) ✓', 'ok');
  updateConnectionIndicator();

  // Announce presence
  sendHello({ displayName: state.user.displayName || state.user.username, username: state.user.username });

  // Periodic re-announce for 60s
  if (state._helloInterval) clearInterval(state._helloInterval);
  state._helloInterval = setInterval(() => {
    if (!state._room) { clearInterval(state._helloInterval); return; }
    sendHello({ displayName: state.user.displayName || state.user.username, username: state.user.username });
    updateConnectionIndicator();
  }, 5000);
  setTimeout(() => { if (state._helloInterval) { clearInterval(state._helloInterval); state._helloInterval = null; } }, 60000);

  // Handlers
  onHello((data, peerId) => {
    _peerNames.set(peerId, data.displayName || data.username || 'Гость');
    renderPresence();
    updateConnectionIndicator();
  });

  onChat((data, peerId) => {
    (async () => {
      await ensureDb();
      if (!_db.messages.some((m) => m.id === data.message.id)) {
        _db.messages.push(data.message);
        await saveDb(_db);
        refreshMessages();
      }
    })();
  });

  onHangup((_data, peerId) => {
    state.remoteStreams.delete(peerId);
    _stopStreams.delete(peerId);
    updateRemoteVideo();
    updateConnectionIndicator();
    toast('Собеседник завершил звонок.');
  });

  onRing((data, peerId) => {
    const callerName = data?.displayName || 'Участник';
    if (state.remoteStreams.has(peerId)) return;
    if (state._callingPeer === peerId) return;
    showIncomingCall(callerName, peerId);
    _notifyIncomingCall(callerName);
  });

  onRingAccept((_data, peerId) => {
    toast('Звонок принят ✓', 'ok');
    state._callingPeer = null;
  });

  onRingDecline((_data, peerId) => {
    toast('Звонок отклонён.', 'warn');
    state._callingPeer = null;
    const stop = _stopStreams.get(peerId);
    if (stop) { try { stop(); } catch {} _stopStreams.delete(peerId); }
  });
}

function showIncomingCall(callerName, peerId) {
  if (document.getElementById('incomingCallDialog')) return;
  const dialog = document.createElement('div');
  dialog.id = 'incomingCallDialog';
  dialog.style.cssText = 'position:fixed;top:50%;left:50%;transform:translate(-50%,-50%);background:rgba(17,24,39,0.98);backdrop-filter:blur(40px);border:1px solid var(--glass-border-strong);border-radius:24px;padding:28px;text-align:center;z-index:300;box-shadow:var(--shadow-lg);min-width:280px';
  dialog.innerHTML = `
    <div style="width:64px;height:64px;border-radius:50%;margin:0 auto 16px;display:grid;place-items:center;font-size:24px;font-weight:800;background:var(--accent-grad);color:white;animation:avatarFloat 2s ease-in-out infinite">📞</div>
    <div style="font-size:18px;font-weight:700;margin-bottom:4px">Входящий звонок</div>
    <div style="font-size:14px;color:var(--text-muted);margin-bottom:20px">${escapeHtml(callerName)} звонит вам</div>
    <div style="display:flex;gap:10px;justify-content:center">
      <button id="declineCallBtn" style="min-height:48px;padding:0 24px;border-radius:14px;background:var(--danger-grad);color:white;border:none;font-weight:700;cursor:pointer">Отклонить</button>
      <button id="acceptCallBtn" style="min-height:48px;padding:0 24px;border-radius:14px;background:var(--success-grad);color:#021307;border:none;font-weight:700;cursor:pointer">Принять</button>
    </div>`;
  document.body.appendChild(dialog);

  document.getElementById('acceptCallBtn').onclick = async () => {
    dialog.remove();
    if (state._sendRingAccept) state._sendRingAccept({}, peerId);
    toast('Подключение к звонку…', 'info');
    try {
      await ensureLocalMedia(true).catch(async () => ensureLocalMedia(false));
      if (state.localStream) {
        FB.setLocalStream(state.localStream);
      }
      // Process the pending offer (or wait for it to arrive)
      await FB.acceptCall(peerId);
      toast('Видео подключено ✓', 'ok');
      updateCallGuide();
    } catch (e) { toast('Не удалось подключиться: ' + e.message, 'bad'); }
  };
  document.getElementById('declineCallBtn').onclick = () => {
    dialog.remove();
    if (state._sendRingDecline) state._sendRingDecline({}, peerId);
    toast('Звонок отклонён.', 'warn');
  };
  setTimeout(() => { if (document.getElementById('incomingCallDialog')) dialog.remove(); }, 30000);
}

function trysteroBroadcast(obj) {
  if (!state._room) return;
  try {
    if (obj.kind === 'chat-message' && state._sendChat) state._sendChat(obj);
    else if (obj.kind === 'hello' && state._sendHello) state._sendHello(obj);
    else if (obj.kind === 'hangup' && state._sendHangup) state._sendHangup(obj);
  } catch (e) { console.warn('[fb] broadcast failed', e); }
}

async function disconnectPeer() {
  if (state._helloInterval) { clearInterval(state._helloInterval); state._helloInterval = null; }
  await FB.leave();
  _peerNames.clear();
  for (const stop of _stopStreams.values()) { try { stop(); } catch {} }
  _stopStreams.clear();
  state.remoteStreams.clear();
  state.peer = null;
  state.peerId = null;
  state._room = null;
  state._sendChat = null;
  state._sendHello = null;
  state._sendHangup = null;
  state._sendRing = null;
  state._sendRingAccept = null;
  state._sendRingDecline = null;
  setStatus($('#socketStatus'), 'Сигналинг: не подключён', 'warn');
  updateConnectionIndicator();
}

function updateRemoteVideo() {
  const streams = Array.from(state.remoteStreams.values());
  if (streams.length === 0) { $('#remoteVideo').srcObject = null; return; }
  if (streams.length === 1) { $('#remoteVideo').srcObject = streams[0]; return; }
  const mixed = new MediaStream();
  for (const s of streams) s.getTracks().forEach((t) => mixed.addTrack(t));
  $('#remoteVideo').srcObject = mixed;
}


/* ============================================================
 * Local media & call controls
 * ============================================================ */
function updateMediaControls() {
  const hasStream = !!state.localStream;
  const hasVideo = hasVideoTrack(state.localStream);
  const hasAudio = hasAudioTrack(state.localStream);
  // Camera button: shows "Камера" when off, "Выкл камеру" when on
  const camBtn = $('#cameraBtn');
  if (camBtn) {
    if (hasVideo && !state.camOff) {
      camBtn.innerHTML = `${icon('video')}<span>Выкл камеру</span>`;
      camBtn.classList.add('active');
    } else {
      camBtn.innerHTML = `${icon('video')}<span>Камера</span>`;
      camBtn.classList.remove('active');
    }
  }
  // Mic button: shows "Микрофон" when off, "Выкл микро" when on
  const micBtn = $('#muteBtn');
  if (micBtn) {
    if (hasAudio && !state.micMuted) {
      micBtn.innerHTML = `${icon('microphone')}<span>Выкл микро</span>`;
      micBtn.classList.add('active');
    } else {
      micBtn.innerHTML = `${icon('microphone')}<span>Микрофон</span>`;
      micBtn.classList.remove('active');
    }
  }
}
async function ensureLocalMedia(video = true) {
  if (state.localStream && (!video || hasVideoTrack(state.localStream))) {
    attachLocalStream(state.localStream);
    updateMediaControls();
    return state.localStream;
  }
  if (state.localStream && video && !hasVideoTrack(state.localStream)) {
    state.localStream.getTracks().forEach((t) => t.stop());
    state.localStream = null;
  }
  const constraints = video
    ? { video: { facingMode: 'user', width: { ideal: 1280 }, height: { ideal: 720 }, aspectRatio: 1.777 }, audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true } }
    : { video: false, audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true } };
  try {
    state.localStream = await getUserMediaCompat(constraints);
  } catch (e) {
    if (video && e?.name === 'OverconstrainedError') {
      state.localStream = await getUserMediaCompat({ video: true, audio: true });
    } else {
      throw new Error(normalizeMediaError(e, video));
    }
  }
  state.camOff = false; state.micMuted = false;
  attachLocalStream(state.localStream);
  updateMediaControls();
  toast(video ? 'Камера включена.' : 'Микрофон включён.', 'ok');
  return state.localStream;
}

async function startCall() {
  if (!state.currentRoom) return toast('Сначала выберите комнату.', 'warn');
  if (!state._room) return toast('Сигналинг не подключён.', 'bad');

  // Wait for Trystero to discover peers (can take 5-10s after room join)
  let peerIds = Object.keys(state._room.getPeers());
  if (peerIds.length === 0) {
    toast('Поиск участников в комнате…', 'info');
    for (let i = 0; i < 30; i++) {
      await new Promise((r) => setTimeout(r, 500));
      peerIds = Object.keys(state._room.getPeers());
      if (peerIds.length > 0) break;
    }
  }
  if (peerIds.length === 0) {
    return toast('В комнате нет других участников. Убедитесь, что оба выбрали одну комнату.', 'warn');
  }

  // Send ring notification to all peers BEFORE starting the call
  // This shows an "Incoming call" dialog on the other device
  if (state._sendRing) {
    state._sendRing({ displayName: state.user.displayName || state.user.username });
  }

  await ensureLocalMedia(true).catch(async (e) => {
    toast(`${e.message} Пробую только микрофон.`, 'warn');
    return ensureLocalMedia(false);
  }).catch(() => {});
  // Even without local media, proceed with the call — the other side
  // will send their video, and we can at least receive audio/video
  if (!state.localStream) {
    toast('Нет камеры/микрофона. Попытка звонка без медиа…', 'warn');
  }

  // Send our stream to each peer via FB signaling
  let initiated = 0;
  for (const peerId of peerIds) {
    if (_stopStreams.has(peerId)) continue;
    state._callingPeer = peerId;
    try {
      if (state.localStream) FB.setLocalStream(state.localStream);
      await FB.startCall(peerId);
      _stopStreams.set(peerId, () => FB.stopStream(peerId));
      initiated++;
    } catch (e) {
      console.warn('[call] failed for', peerId.slice(0, 12), e);
    }
  }

  if (initiated) {
    toast(`Звонок отправлен (${initiated}). Ожидание ответа…`, 'ok');
    setTimeout(() => {
      if (state.remoteStreams.size === 0) {
        toast('Соединение не установлено за 10с. Проверьте, что оба устройства в одной комнате.', 'warn');
      }
    }, 10000);
  } else {
    toast('Не удалось позвонить.', 'bad');
  }
}

function hangup(notify = true) {
  if (notify) trysteroBroadcast({ kind: 'hangup' });
  // Exit fullscreen if active
  if (document.fullscreenElement) { document.exitFullscreen?.().catch(() => {}); }
  else if (document.webkitFullscreenElement) { document.webkitExitFullscreen?.(); }
  for (const stop of _stopStreams.values()) { try { stop(); } catch {} }
  _stopStreams.clear();
  state.remoteStreams.clear();
  $('#remoteVideo').srcObject = null;
  $('#callStage')?.classList.remove('ui-hidden');
  setStatus($('#peerStatus'), 'WebRTC: нет соединения', 'warn');
  $('#pcState').textContent = 'PC: нет данных';
  $('#iceState').textContent = 'ICE: нет данных';
  updateConnectionIndicator();
}

function resetCall() {
  hangup(false);
  if (state.localStream) state.localStream.getTracks().forEach((t) => t.stop());
  state.localStream = null;
  attachLocalStream(null);
  updateMediaControls();
}

// Single toggle button for microphone:
// - If no audio stream: turn mic ON
// - If mic ON: turn mic OFF (mute)
// - If mic OFF (muted): turn mic ON (unmute)
async function toggleMute() {
  // No stream yet — start audio only
  if (!state.localStream || !hasAudioTrack(state.localStream)) {
    try { await ensureLocalMedia(false); } catch (e) { toast(e.message, 'bad'); return; }
    state.micMuted = false;
    updateMediaControls();
    updateCallGuide();
    toast('Микрофон включён ✓', 'ok');
    return;
  }
  // Toggle mute state
  state.micMuted = !state.micMuted;
  state.localStream.getAudioTracks().forEach((t) => t.enabled = !state.micMuted);
  updateMediaControls();
  updateCallGuide();
  toast(state.micMuted ? 'Микрофон выключен.' : 'Микрофон включён.', state.micMuted ? 'warn' : 'ok');
}

// Single toggle button for camera:
// - If no video stream: turn camera ON
// - If camera ON: turn camera OFF (disable video track, keep audio)
// - If camera OFF: turn camera ON (re-enable video track)
async function toggleCamera() {
  // No video stream yet — start camera + mic
  if (!state.localStream || !hasVideoTrack(state.localStream)) {
    try { await ensureLocalMedia(true); } catch (e) { toast(e.message, 'bad'); return; }
    state.camOff = false;
    updateMediaControls();
    updateCallGuide();
    toast('Камера включена ✓', 'ok');
    return;
  }
  // Toggle camera state (disable track, don't destroy — faster re-enable)
  state.camOff = !state.camOff;
  state.localStream.getVideoTracks().forEach((t) => t.enabled = !state.camOff);
  updateMediaControls();
  updateCallGuide();
  toast(state.camOff ? 'Камера выключена.' : 'Камера включена.', state.camOff ? 'warn' : 'ok');
}
async function checkConnection() {
  const peers = state._room ? state._room.getPeers() : {};
  const bits = [];
  bits.push(`API ${state.health?.ok ? 'ok' : '?'}`);
  bits.push(`trystero ${state.peer ? 'ok' : 'off'}`);
  bits.push(`room ${state.currentRoom ? state.currentRoom.code : 'none'}`);
  bits.push(`peers ${Object.keys(peers).length}`);
  bits.push(`known ${_peerNames.size}`);
  bits.push(`media ${state.localStream ? 'ok' : 'not started'}`);
  bits.push(`streams ${state.remoteStreams.size}`);
  toast(bits.join(' · '), 'info');
}

/* ============================================================
 * Chat (GitHub-backed db.json + PeerJS gossip for instant sync)
 * ============================================================ */
async function refreshMessages() {
  if (!state.user) return;
  await ensureDb();
  const all = _db.messages.filter((m) => !m.roomCode || m.roomCode === state.currentRoom?.code || !state.currentRoom);
  renderMessages(all);
}
function renderMessages(messages) {
  const box = $('#messagesList');
  if (!messages.length) { box.innerHTML = '<div class="list empty">Сообщений пока нет.</div>'; return; }
  box.innerHTML = messages.map((m) => `
    <div class="message ${m.authorId === state.user.id ? 'mine' : ''}" data-id="${m.id}">
      <div class="message-top"><strong>${escapeHtml(m.authorName)}</strong><span class="meta">${fmtTime(m.updatedAt || m.createdAt)}</span></div>
      <p>${escapeHtml(m.text)}</p>
      <div class="message-actions">
        ${m.authorId === state.user.id ? `<button class="small icon-action edit-msg" data-id="${m.id}" data-tip="Редактировать" title="Редактировать" aria-label="Редактировать"><span data-icon="file-lines"></span></button>` : ''}
        ${m.authorId === state.user.id ? `<button class="small icon-action danger delete-msg" data-id="${m.id}" data-tip="Удалить" title="Удалить" aria-label="Удалить"><span data-icon="trash"></span></button>` : ''}
      </div>
    </div>`).join('');
  renderIcons(box);
  box.querySelectorAll('.edit-msg').forEach((b) => b.onclick = () => editMessage(b.dataset.id));
  box.querySelectorAll('.delete-msg').forEach((b) => b.onclick = () => deleteMessage(b.dataset.id));
  box.scrollTop = box.scrollHeight;
}
async function sendMessage() {
  const text = $('#chatInput').value.trim();
  if (!text) return;
  if (!state.user) return;
  const msg = {
    id: randomId('msg_'),
    roomCode: state.currentRoom?.code || null,
    authorId: state.user.id,
    authorName: state.user.displayName || state.user.username,
    text,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString()
  };
  await ensureDb();
  _db.messages.push(msg);
  await saveDb(_db);
  $('#chatInput').value = '';
  await refreshMessages();
  // Gossip to peers (real-time push; db.json polling will catch it for others)
  trysteroBroadcast({ kind: 'chat-message', message: msg });
}
async function editMessage(id) {
  await ensureDb();
  const m = _db.messages.find((x) => x.id === id);
  if (!m) return;
  const text = prompt('Изменить сообщение:', m.text);
  if (text === null) return;
  m.text = text;
  m.updatedAt = new Date().toISOString();
  await saveDb(_db);
  await refreshMessages();
}
async function deleteMessage(id) {
  if (!confirm('Удалить сообщение?')) return;
  await ensureDb();
  _db.messages = _db.messages.filter((x) => x.id !== id);
  await saveDb(_db);
  await refreshMessages();
}

/* ============================================================
 * Media mail — record audio/video via MediaRecorder, store in IndexedDB
 * ============================================================ */
function setRecordMode(mode) {
  // Update the hidden radio input (this is what startRecording reads)
  const target = document.querySelector(`input[name="recordMode"][value="${mode}"]`);
  if (target) target.checked = true;
  // Update the visible button states
  $('#modeAudioBtn')?.classList.toggle('active', mode === 'audio');
  $('#modeVideoBtn')?.classList.toggle('active', mode === 'video');
  updateMailGuide();
}

/* ---------- Interactive mail guide ---------- */
// Narrates the recording sequence and highlights the next button to press.
// Steps: choose mode (audio/video) -> record -> stop
function updateMailGuide() {
  const guide = $('#mailGuide');
  if (!guide) return;

  const isRecording = state.recorder && state.recorder.state === 'recording';
  const modeInput = document.querySelector('input[name="recordMode"]:checked');
  const mode = modeInput ? modeInput.value : 'audio';

  // Clear all button highlights
  ['#modeAudioBtn', '#modeVideoBtn', '#startRecordBtn', '#stopRecordBtn'].forEach((sel) => {
    $(sel)?.classList.remove('guide-highlight');
  });

  if (isRecording) {
    guide.innerHTML = '<div class="guide-narration done">● Идёт запись… нажмите «Стоп» чтобы завершить</div>';
    $('#stopRecordBtn')?.classList.add('guide-highlight');
    return;
  }

  // Build steps
  const steps = [
    { id: 'mode', label: 'Выбрать режим', done: true }, // mode is always chosen (defaults to audio)
    { id: 'record', label: 'Нажать «Записать»', done: false },
    { id: 'stop', label: 'Нажать «Стоп»', done: false }
  ];

  let narration = '';
  let highlightBtn = '';
  if (mode === 'audio') {
    narration = 'Аудио режим. Нажмите «Записать» ↓';
    highlightBtn = '#startRecordBtn';
  } else {
    narration = 'Видео режим. Нажмите «Записать» ↓';
    highlightBtn = '#startRecordBtn';
  }

  const stepsHTML = steps.map((s, i) => {
    const cls = s.done ? 'done' : (i === 1 ? 'active' : '');
    return `<div class="guide-step ${cls}"><span class="step-num">${s.done ? '✓' : (i + 1)}</span><span>${s.label}</span></div>`;
  }).join('');

  guide.innerHTML = `
    <div class="guide-narration ${mode}">${narration}</div>
    <div class="guide-steps">${stepsHTML}</div>
  `;
  if (highlightBtn) $(highlightBtn)?.classList.add('guide-highlight');
}
function pickMime(list) { return list.find((m) => window.MediaRecorder && MediaRecorder.isTypeSupported(m)) || ''; }
function startRecordTimer() {
  clearInterval(state.recordTimerId);
  state.recordTimerId = setInterval(() => {
    const s = Math.floor((Date.now() - state.recordStartedAt) / 1000);
    $('#recordTimer').textContent = `${String(Math.floor(s / 60)).padStart(2, '0')}:${String(s % 60).padStart(2, '0')}`;
  }, 500);
}
function stopRecordTimer() { clearInterval(state.recordTimerId); $('#recordTimer').textContent = '00:00'; }

async function startRecording() {
  try {
    const modeInput = document.querySelector('input[name="recordMode"]:checked');
    const mode = modeInput ? modeInput.value : 'audio';
    if (!window.MediaRecorder) throw new Error('Этот браузер не поддерживает MediaRecorder.');
    toast(`Запрос доступа к ${mode === 'video' ? 'камере и микрофону' : 'микрофону'}…`, 'info');
    const stream = await getUserMediaCompat(mode === 'video'
      ? { video: { facingMode: 'user', width: { ideal: 1280 }, height: { ideal: 720 }, aspectRatio: 1.777 }, audio: true }
      : { audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true }, video: false });
    state.recordChunks = [];
    const mime = mode === 'video' ? pickMime(['video/webm;codecs=vp9,opus', 'video/webm', 'video/mp4']) : pickMime(['audio/webm;codecs=opus', 'audio/webm', 'audio/ogg;codecs=opus']);
    state.recorder = new MediaRecorder(stream, mime ? { mimeType: mime } : undefined);
    state.recorder.ondataavailable = (e) => { if (e.data && e.data.size) state.recordChunks.push(e.data); };
    state.recorder.onstop = async () => {
      const blob = new Blob(state.recordChunks, { type: state.recorder.mimeType || (mode === 'video' ? 'video/webm' : 'audio/webm') });
      stream.getTracks().forEach((t) => t.stop());
      const note = $('#mailNote').value.trim();
      const name = `${mode}-mail-${Date.now()}.webm`;
      toast('Сохранение в GitHub…', 'info');
      await saveMediaBlob(blob, 'mail', note, name, mode);
      $('#recordPreview').srcObject = null;
      $('#recordPreview').classList.add('hidden');
      $('#mailEmpty')?.classList.remove('hidden');
      $('#mailNote').value = '';
      await refreshMail();
      updateMailGuide();
      toast('Сообщение сохранено ✓', 'ok');
    };
    state.recorder.start(1000);
    state.recordStartedAt = Date.now();
    $('#startRecordBtn').disabled = true;
    $('#stopRecordBtn').disabled = false;
    // Show live preview during recording
    if (mode === 'video') {
      $('#mailEmpty')?.classList.add('hidden');
      $('#recordPreview').classList.remove('hidden');
      $('#recordPreview').srcObject = stream;
      $('#recordPreview').muted = true; // avoid feedback
    } else {
      // Keep the guide visible during audio recording (it shows the "stop" narration)
      $('#mailEmpty')?.classList.remove('hidden');
    }
    updateMailGuide();
    toast(`Запись начата (${mode === 'video' ? 'видео' : 'аудио'}) ✓`, 'ok');
    startRecordTimer();
  } catch (e) {
    console.error('[recording] error', e);
    toast(`Запись: ${e.message || e.name || 'ошибка'}`, 'bad');
  }
}
function stopRecording() {
  if (state.recorder && state.recorder.state !== 'inactive') state.recorder.stop();
  $('#startRecordBtn').disabled = false;
  $('#stopRecordBtn').disabled = true;
  stopRecordTimer();
  updateMailGuide();
}

/* ============================================================
 * Files / media storage in GitHub repo (call-data)
 *   - File blob -> files/<media_id> (base64 via Contents API)
 *   - Metadata  -> db.json media array
 * ============================================================ */
function kindForFile(file) {
  const t = (file.type || '').toLowerCase();
  const n = (file.name || '').toLowerCase();
  // MIME-based detection (primary)
  if (t.startsWith('video/')) return 'video';
  if (t.startsWith('audio/')) return 'audio';
  if (t.startsWith('image/')) return 'image';
  if (t === 'application/pdf') return 'pdf';
  if (t.startsWith('text/')) return 'text';
  // Extension-based fallback (when browser doesn't set MIME)
  if (/\.(mp4|mov|avi|mkv|webm|m4v|mpg|mpeg|m2ts|3gp|flv|wmv|ts)$/.test(n)) return 'video';
  if (/\.(mp3|wav|ogg|aac|flac|m4a|opus|wma|aiff)$/.test(n)) return 'audio';
  if (/\.(jpg|jpeg|png|gif|webp|bmp|svg|heic|heif|tiff|tif|avif)$/.test(n)) return 'image';
  if (n.endsWith('.pdf')) return 'pdf';
  if (/\.(txt|md|log|csv|json|js|html|css|xml|yml|yaml)$/.test(n)) return 'text';
  return 'other';
}
async function saveMediaBlob(blob, type, note, originalName, mode) {
  const id = randomId('media_');
  const kind = mode || kindForFile({ name: originalName, type: blob.type });
  const record = {
    id,
    type,           // 'mail' | 'file'
    kind,           // 'video' | 'audio' | 'image' | 'pdf' | 'text' | 'other'
    note: note || '',
    originalName,
    mime: blob.type || 'application/octet-stream',
    size: blob.size,
    uploadedBy: state.user.id,
    uploadedByName: state.user.displayName || state.user.username,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    downloadCount: 0,
    lastDownloadedByName: null,
    lastDownloadedAt: null
  };
  // 1. Upload blob to files/<id>
  const sizeMB = (blob.size / 1048576).toFixed(1);
  if (blob.size > 5 * 1024 * 1024) {
    const numChunks = Math.ceil(blob.size / (5 * 1024 * 1024));
    toast(`Загрузка ${originalName} (${sizeMB} MB, ${numChunks} частей)…`, 'info');
  } else {
    toast(`Загрузка ${originalName} (${sizeMB} MB)…`, 'info');
  }
  await GH.putFile(id, blob, `upload ${originalName} (${type})`);
  // 2. Add metadata to db.json
  await ensureDb();
  _db.media.push(record);
  await saveDb(_db);
  toast('Сохранено в GitHub.', 'ok');
}
async function uploadFiles() {
  const files = Array.from($('#fileInput').files || []);
  if (!files.length) return toast('Выберите файл.', 'warn');
  const note = $('#fileNote').value.trim();
  for (const file of files) {
    if (file.size > 350 * 1024 * 1024) { toast(`${file.name}: больше 350 MB. Максимум — 350 MB.`, 'bad'); continue; }
    try {
      await saveMediaBlob(file, 'file', note, file.name);
      toast(`Загружено: ${file.name}`, 'ok');
    } catch (e) { toast(`${file.name}: ${e.message}`, 'bad'); }
  }
  $('#fileInput').value = '';
  updateFilePickerText();
  $('#fileNote').value = '';
  await refreshFiles();
}
async function refreshMail() {
  if (!state.user) return;
  await ensureDb();
  const items = _db.media.filter((m) => m.type === 'mail' && !m.deletedAt).sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  renderMediaList($('#mailList'), items, 'mail');
}
async function refreshFiles() {
  if (!state.user) return;
  await ensureDb();
  const items = _db.media.filter((m) => m.type === 'file' && !m.deletedAt).sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  renderMediaList($('#filesList'), items, 'file');
}
function kindIcon(kind) { return { video: 'file-video', audio: 'file-audio', image: 'file-image', pdf: 'file-pdf', text: 'file-lines', other: 'file' }[kind] || 'file'; }
function downloadStats(m) {
  const count = Number(m.downloadCount || 0);
  if (!count) return 'Downloads: 0';
  const who = m.lastDownloadedByName || 'user';
  const when = m.lastDownloadedAt ? fmtTime(m.lastDownloadedAt) : '';
  return `Downloads: ${count} · last ${who}${when ? ' · ' + when : ''}`;
}
function renderMediaList(box, items, listKey) {
  if (!box) return;
  // Skip re-render if the list hasn't changed (prevents race condition where
  // poll-triggered re-renders destroy inline players that are still downloading
  // large files from the Git Blobs API)
  const fingerprint = items.map((m) => m.id + ':' + m.size + ':' + (m.updatedAt || '')).join('|');
  if (box._lastFingerprint === fingerprint) return;
  box._lastFingerprint = fingerprint;

  if (!items.length) { box.className = 'media-list empty'; box.textContent = 'Пока пусто.'; return; }
  box.className = 'media-list';
  box.innerHTML = items.map((m) => `
    <div class="media-item" data-id="${m.id}">
      <div class="media-top">
        <div class="media-kind"><span data-icon="${kindIcon(m.kind)}"></span></div>
        <div class="media-title">
          <strong title="${escapeHtml(m.originalName)}">${escapeHtml(m.originalName)}</strong>
          <span class="meta media-info">${escapeHtml(m.uploadedByName)} · ${fmtTime(m.createdAt)} · ${fmtBytes(m.size)}</span>
          <span class="meta media-download-stats">${escapeHtml(downloadStats(m))}</span>
        </div>
      </div>
      ${m.note ? `<div class="media-note">${escapeHtml(m.note)}</div>` : ''}
      <div class="media-placeholder" data-id="${m.id}"><span class="meta">Загрузка…</span></div>
      <div class="media-actions">
        <button class="small icon-action preview-media" data-id="${m.id}" title="Открыть" aria-label="Открыть"><span data-icon="eye"></span></button>
        <button class="small icon-action download-media" data-id="${m.id}" title="Скачать оригинал" aria-label="Скачать оригинал"><span data-icon="download"></span></button>
        <button class="small icon-action danger delete-media" data-id="${m.id}" title="Удалить" aria-label="Удалить"><span data-icon="trash"></span></button>
      </div>
    </div>`).join('');
  renderIcons(box);
  box.querySelectorAll('.preview-media').forEach((b) => b.onclick = () => openPreview(items.find((m) => m.id === b.dataset.id)));
  box.querySelectorAll('.download-media').forEach((b) => b.onclick = () => downloadMedia(items.find((m) => m.id === b.dataset.id)));
  box.querySelectorAll('.delete-media').forEach((b) => b.onclick = () => deleteMedia(b.dataset.id));
  // Auto-load inline players for all media types
  box.querySelectorAll('.media-placeholder').forEach((holder) => {
    const m = items.find((x) => x.id === holder.dataset.id);
    if (m) inlinePlayerInto(m, holder);
  });
}
// Inline player — auto-loads inline preview/player for all media types
async function inlinePlayerInto(m, holder) {
  if (!holder) return;
  holder.innerHTML = '<span class="meta">Загрузка…</span>';
  try {
    const url = await GH.getFileUrl(m.id, m.mime);
    // Check if holder is still in the DOM (might have been replaced by a re-render)
    if (!holder.isConnected) return;
    if (!url) { holder.innerHTML = '<span class="meta warn-text">Файл не найден.</span>'; return; }
    m._url = url;
    const lowerName = m.originalName.toLowerCase();
    const isHeic = lowerName.endsWith('.heic') || lowerName.endsWith('.heif') || m.mime === 'image/heic' || m.mime === 'image/heif';
    if (m.kind === 'audio') holder.innerHTML = `<div class="media-player"><audio controls src="${url}"></audio></div>`;
    else if (m.kind === 'video') {
      holder.innerHTML = `<div class="media-player"><video controls playsinline src="${url}"></video></div>`;
      const v = holder.querySelector('video');
      v.addEventListener('error', () => {
        if (!holder.isConnected) return;
        holder.innerHTML = `<div class="media-placeholder" style="padding:20px;text-align:center">
          <span class="meta" style="display:block;margin-bottom:8px">Видео не поддерживается браузером</span>
          <a class="button small" href="${url}" download="${escapeHtml(m.originalName)}"><span data-icon="download"></span><span>Скачать оригинал</span></a>
        </div>`;
        renderIcons(holder);
      });
    }
    else if (m.kind === 'image' && !isHeic) {
      holder.innerHTML = `<div class="media-player"><img src="${url}" alt="${escapeHtml(m.originalName)}" loading="lazy" style="max-width:100%;border-radius:14px"></div>`;
      const img = holder.querySelector('img');
      img.addEventListener('error', () => {
        if (!holder.isConnected) return;
        holder.innerHTML = `<div class="media-placeholder" style="padding:20px;text-align:center">
          <span class="meta" style="display:block;margin-bottom:8px">Изображение не поддерживается</span>
          <a class="button small" href="${url}" download="${escapeHtml(m.originalName)}"><span data-icon="download"></span><span>Скачать оригинал</span></a>
        </div>`;
        renderIcons(holder);
      });
    }
    else if (m.kind === 'image' && isHeic) {
      holder.innerHTML = `<div class="media-placeholder" style="padding:16px;text-align:center">
        <span class="meta" style="display:block;margin-bottom:8px">HEIC фото (iPhone) — не отображается в браузере</span>
        <a class="button small" href="${url}" download="${escapeHtml(m.originalName)}"><span data-icon="download"></span><span>Скачать оригинал</span></a>
      </div>`;
      renderIcons(holder);
    }
    else if (m.kind === 'pdf') holder.innerHTML = `<div class="media-player"><iframe src="${url}"></iframe></div>`;
    else {
      holder.innerHTML = `<div class="media-placeholder" style="padding:16px;text-align:center">
        <a class="button small" href="${url}" download="${escapeHtml(m.originalName)}"><span data-icon="download"></span><span>Скачать ${escapeHtml(m.originalName)}</span></a>
      </div>`;
      renderIcons(holder);
    }
  } catch (e) { if (holder.isConnected) holder.innerHTML = `<span class="meta warn-text">Ошибка: ${escapeHtml(e.message)}</span>`; }
}
async function openPreview(m) {
  if (!m) return;
  $('#previewTitle').textContent = m.originalName;
  const body = $('#previewBody');
  body.innerHTML = '<p class="meta">Загрузка из GitHub…</p>';
  $('#previewDialog').showModal();
  try {
    const url = m._url || await GH.getFileUrl(m.id, m.mime);
    if (!url) { body.innerHTML = '<p>Файл не найден.</p>'; return; }
    m._url = url;
    $('#previewDownload').href = url;
    $('#previewDownload').setAttribute('download', m.originalName);
    body.innerHTML = '';
    if (m.kind === 'video') {
      const isMov = (m.mime === 'video/quicktime' || m.originalName.toLowerCase().endsWith('.mov'));
      body.innerHTML = `<video controls autoplay playsinline src="${url}"></video>`;
      const v = body.querySelector('video');
      v.addEventListener('error', () => {
        body.innerHTML = `
          <div style="text-align:center;padding:20px">
            <p style="margin:0 0 12px;font-size:15px">Видео не может быть воспроизведено в браузере.</p>
            <p style="margin:0 0 16px;font-size:13px;color:var(--text-muted)">${isMov ? 'MOV файлы с необычным кодеком не поддерживаются. ' : ''}Скачайте оригинал, чтобы открыть в видеоплеере.</p>
            <a class="primary" href="${url}" download="${escapeHtml(m.originalName)}" style="display:inline-flex"><span data-icon="download"></span><span>Скачать оригинал</span></a>
          </div>`;
        renderIcons(body);
      });
    }
    else if (m.kind === 'audio') body.innerHTML = `<audio controls autoplay src="${url}"></audio>`;
    else if (m.kind === 'image') body.innerHTML = `<img src="${url}" alt="${escapeHtml(m.originalName)}" />`;
    else if (m.kind === 'pdf') body.innerHTML = `<iframe src="${url}"></iframe>`;
    else if (m.kind === 'text') {
      try {
        const r = await fetch(url, { credentials: 'same-origin' });
        const txt = await r.text();
        body.innerHTML = `<pre>${escapeHtml(txt.slice(0, 200000))}</pre>`;
      } catch { body.textContent = 'Не удалось прочитать текст.'; }
    } else {
      body.innerHTML = `<p>Этот формат лучше скачать оригиналом.</p>`;
    }
  } catch (e) { body.innerHTML = `<p>Ошибка: ${escapeHtml(e.message)}</p>`; }
}
async function downloadMedia(m) {
  if (!m) return;
  toast(`Скачивание ${m.originalName}…`, 'info');
  try {
    const url = m._url || await GH.getFileUrl(m.id, m.mime);
    if (!url) { toast('Файл не найден.', 'bad'); return; }
    const a = document.createElement('a');
    a.href = url; a.download = m.originalName; a.style.display = 'none';
    document.body.appendChild(a); a.click(); a.remove();
    // Track download
    await ensureDb();
    const rec = _db.media.find((x) => x.id === m.id);
    if (rec) { rec.downloadCount = (rec.downloadCount || 0) + 1; rec.lastDownloadedByName = state.user?.displayName || state.user?.username; rec.lastDownloadedAt = new Date().toISOString(); await saveDb(_db); }
  } catch (e) { toast(`Скачивание: ${e.message}`, 'bad'); }
}
async function deleteMedia(id) {
  if (!confirm('Удалить запись из приложения?')) return;
  await ensureDb();
  const rec = _db.media.find((x) => x.id === id);
  if (!rec) return;
  // Revoke cached blob URL to free memory
  GH.revokeBlobUrl(id);
  // Soft-delete metadata, attempt blob deletion (may fail if file already gone)
  rec.deletedAt = new Date().toISOString();
  await saveDb(_db);
  try { await GH.deleteFile(id, `delete ${rec.originalName}`); } catch (e) { console.warn('blob delete failed', e); }
  // Force re-render by clearing fingerprint
  $('#filesList')._lastFingerprint = null;
  $('#mailList')._lastFingerprint = null;
  await refreshMail();
  await refreshFiles();
  toast('Удалено.', 'ok');
}

/* ============================================================
 * Admin: user management (GitHub-backed db.json)
 * ============================================================ */
async function refreshUsers() {
  if (!state.user || state.user.role !== 'admin') return;
  await ensureDb();
  state.users = _db.users;
  renderUsers();
}
function renderUsers() {
  const box = $('#usersList');
  if (!state.users.length) { box.className = 'list empty'; box.textContent = 'Нет пользователей.'; return; }
  box.className = 'list';
  box.innerHTML = state.users.map((u) => `
    <div class="user-item" data-id="${u.id}">
      <div class="user-row"><div><strong>${escapeHtml(u.displayName || u.username)}</strong><div class="meta">${escapeHtml(u.username)} · ${u.role}${u.disabled ? ' · отключён' : ''}</div></div></div>
      <div class="user-password-row">
        <input class="user-pass-input" data-id="${u.id}" type="password" placeholder="Новый пароль для ${escapeHtml(u.username)}" autocomplete="new-password" />
        <button class="small icon-action primary change-pass" data-id="${u.id}" data-tip="Сменить пароль" title="Сменить пароль" aria-label="Сменить пароль"><span data-icon="key"></span></button>
      </div>
      <div class="user-actions">
        <button class="small icon-action edit-user" data-id="${u.id}" data-tip="Имя/роль" title="Имя/роль" aria-label="Имя/роль"><span data-icon="file-lines"></span></button>
        ${u.id !== state.user.id ? `<button class="small icon-action danger delete-user" data-id="${u.id}" data-tip="Удалить" title="Удалить" aria-label="Удалить"><span data-icon="trash"></span></button>` : ''}
      </div>
    </div>`).join('');
  renderIcons(box);
  box.querySelectorAll('.change-pass').forEach((b) => b.onclick = () => changeUserPassword(b.dataset.id));
  box.querySelectorAll('.edit-user').forEach((b) => b.onclick = () => editUser(b.dataset.id));
  box.querySelectorAll('.delete-user').forEach((b) => b.onclick = () => deleteUser(b.dataset.id));
}
async function changeUserPassword(id) {
  const input = $(`.user-pass-input[data-id="${CSS.escape(id)}"]`);
  const password = input?.value || '';
  if (!password) return toast('Введите новый пароль.', 'warn');
  await ensureDb();
  const u = _db.users.find((x) => x.id === id);
  if (!u) return;
  u.salt = newSalt();
  u.hash = await hashPassword(password, u.salt);
  u.updatedAt = new Date().toISOString();
  await saveDb(_db);
  if (input) input.value = '';
  await refreshUsers();
  toast('Пароль изменён.', 'ok');
}
async function addUser() {
  const username = $('#newUserName').value.trim();
  const displayName = $('#newDisplayName').value.trim();
  const password = $('#newPassword').value;
  const role = $('#newRole').value;
  if (!username || !password) return toast('Логин и пароль обязательны.', 'warn');
  await ensureDb();
  if (_db.users.some((u) => u.username === username)) return toast('Логин уже занят.', 'bad');
  const salt = newSalt();
  const hash = await hashPassword(password, salt);
  _db.users.push({
    id: randomId('usr_'),
    username, displayName: displayName || username, role,
    salt, hash,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    disabled: false
  });
  await saveDb(_db);
  $('#newUserName').value = $('#newDisplayName').value = $('#newPassword').value = '';
  await refreshUsers();
  toast('Пользователь добавлен.', 'ok');
}
async function editUser(id) {
  await ensureDb();
  const u = _db.users.find((x) => x.id === id);
  if (!u) return;
  const displayName = prompt('Имя на экране:', u.displayName || u.username);
  if (displayName === null) return;
  const password = prompt('Новый пароль (пусто = не менять):', '');
  if (password === null) return;
  const role = prompt('Роль: admin или guest', u.role) || u.role;
  u.displayName = displayName;
  u.role = (role === 'admin') ? 'admin' : 'guest';
  if (password) { u.salt = newSalt(); u.hash = await hashPassword(password, u.salt); }
  u.updatedAt = new Date().toISOString();
  await saveDb(_db);
  await refreshUsers();
  toast('Пользователь обновлён.', 'ok');
}
async function deleteUser(id) {
  if (!confirm('Удалить пользователя?')) return;
  await ensureDb();
  _db.users = _db.users.filter((u) => u.id !== id);
  await saveDb(_db);
  await refreshUsers();
  toast('Пользователь удалён.', 'ok');
}

async function resetAllData() {
  if (!confirm('Удалить ВСЕ данные в GitHub (пользователи, комнаты, сообщения, файлы)?')) return;
  if (!confirm('Точно? Это действие необратимо и затронет все устройства.')) return;
  // Clear session on this device
  clearSession();
  // Reset db.json to empty
  _db = {
    version: 1,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    settings: { title: 'Семейная связь' },
    users: [], rooms: [], messages: [], media: [], events: []
  };
  await saveDb(_db);
  await seedDefaultUsers();
  state.user = null;
  state.rooms = [];
  state.currentRoom = null;
  await disconnectPeer();
  resetCall();
  requireLoginUi();
  toast('Данные сброшены.', 'ok');
}

/* ---------- File picker text ---------- */
function updateFilePickerText() {
  const files = Array.from($('#fileInput')?.files || []);
  const el = $('#filePickerText');
  if (!el) return;
  if (!files.length) { el.textContent = 'MOV, MPG, MP4, PDF, фото, аудио, текст'; return; }
  const total = files.reduce((s, f) => s + f.size, 0);
  el.textContent = files.length === 1 ? `${files[0].name} · ${fmtBytes(total)}` : `${files.length} файлов · ${fmtBytes(total)}`;
}

/* ---------- Icon-action tooltips ---------- */
function showTipFor(el) {
  const text = el?.dataset?.tip || el?.getAttribute('aria-label') || el?.getAttribute('title') || '';
  if (!text) return;
  toast(text, 'ok');
}
function initIconTooltips(root = document) {
  root.querySelectorAll('.icon-action,[data-tip]').forEach((el) => {
    if (el.dataset.tipReady === 'true') return;
    el.dataset.tipReady = 'true';
    el.addEventListener('focus', () => showTipFor(el));
    el.addEventListener('pointerdown', () => showTipFor(el));
  });
}

/* ============================================================
 * Event bindings & init
 * ============================================================ */
/* ============================================================
 * ECharts Stats Dashboard
 * ============================================================ */
const _charts = {};

function ensureChart(id) {
  if (typeof echarts === 'undefined') return null;
  if (_charts[id]) { _charts[id].dispose(); }
  const el = document.getElementById(id);
  if (!el) return null;
  _charts[id] = echarts.init(el, null, { renderer: 'canvas' });
  return _charts[id];
}

async function refreshStats() {
  if (typeof echarts === 'undefined') {
    toast('ECharts не загружен.', 'bad');
    return;
  }
  await ensureDb();
  const rl = await GH.rateLimitInfo().catch(() => null);
  const h = state.health?.gh || {};

  // Calculate storage size (approximate: db.json size + sum of all media sizes)
  const dbStr = JSON.stringify(_db);
  const dbSize = new Blob([dbStr]).size;
  const filesTotalSize = (_db.media || []).reduce((s, m) => s + (m.size || 0), 0);
  const totalSize = dbSize + filesTotalSize;
  const githubRepoLimit = 1024 * 1024 * 1024; // 1 GB soft limit for free repos

  // Stats pills
  $('#statUsers').textContent = (_db.users || []).length;
  $('#statRooms').textContent = (_db.rooms || []).length;
  $('#statMessages').textContent = (_db.messages || []).length;
  $('#statFiles').textContent = (_db.media || []).filter(m => !m.deletedAt).length;
  $('#statSize').textContent = fmtBytes(totalSize);
  $('#statApiRemaining').textContent = rl?.remaining ?? h.remaining ?? '?';

  // Chart 1: Storage gauge
  const c1 = ensureChart('chartStorage');
  if (c1) {
    c1.setOption({
      series: [{
        type: 'gauge',
        startAngle: 200, endAngle: -20,
        min: 0, max: githubRepoLimit,
        progress: { show: true, width: 14, roundCap: true },
        axisLine: { lineStyle: { width: 14, color: [[0.5, '#10b981'], [0.8, '#f59e0b'], [1, '#ef4444']] } },
        pointer: { show: false },
        axisTick: { show: false },
        splitLine: { show: false },
        axisLabel: { show: false },
        data: [{ value: totalSize, name: 'Использовано' }],
        title: { offsetCenter: [0, '70%'], fontSize: 12, color: '#94a3b8' },
        detail: {
          offsetCenter: [0, '30%'],
          formatter: () => fmtBytes(totalSize) + ' / 1 GB',
          color: '#f1f5f9', fontSize: 14, fontWeight: 700
        }
      }]
    });
  }

  // Chart 2: API limit gauge
  const c2 = ensureChart('chartApiLimit');
  if (c2) {
    const remaining = rl?.remaining ?? h.remaining ?? 0;
    const limit = rl?.limit ?? h.limit ?? 5000;
    const used = limit - remaining;
    c2.setOption({
      series: [{
        type: 'gauge',
        startAngle: 200, endAngle: -20,
        min: 0, max: limit,
        progress: { show: true, width: 14, roundCap: true, itemStyle: { color: '#6366f1' } },
        axisLine: { lineStyle: { width: 14, color: [[1, 'rgba(255,255,255,0.08)']] } },
        pointer: { show: false },
        axisTick: { show: false },
        splitLine: { show: false },
        axisLabel: { show: false },
        data: [{ value: remaining, name: 'Осталось' }],
        title: { offsetCenter: [0, '70%'], fontSize: 12, color: '#94a3b8' },
        detail: {
          offsetCenter: [0, '30%'],
          formatter: () => remaining + ' / ' + limit,
          color: '#f1f5f9', fontSize: 14, fontWeight: 700
        }
      }]
    });
  }

  // Chart 3: Activity timeline (last 14 days)
  const c3 = ensureChart('chartActivity');
  if (c3) {
    const days = 14;
    const now = new Date();
    const labels = [];
    const msgCounts = [];
    const fileCounts = [];
    for (let i = days - 1; i >= 0; i--) {
      const d = new Date(now); d.setDate(d.getDate() - i);
      const dayStr = d.toISOString().slice(0, 10);
      labels.push(d.toLocaleDateString('ru-RU', { day: 'numeric', month: 'short' }));
      msgCounts.push((_db.messages || []).filter(m => (m.createdAt || '').slice(0, 10) === dayStr).length);
      fileCounts.push((_db.media || []).filter(m => (m.createdAt || '').slice(0, 10) === dayStr).length);
    }
    c3.setOption({
      tooltip: { trigger: 'axis', backgroundColor: 'rgba(17,24,39,0.95)', borderColor: 'rgba(255,255,255,0.1)', textStyle: { color: '#f1f5f9' } },
      legend: { data: ['Сообщения', 'Файлы'], textStyle: { color: '#94a3b8' }, top: 0 },
      grid: { left: 30, right: 16, top: 36, bottom: 24 },
      xAxis: { type: 'category', data: labels, axisLabel: { color: '#64748b', fontSize: 10 }, axisLine: { lineStyle: { color: 'rgba(255,255,255,0.1)' } } },
      yAxis: { type: 'value', minInterval: 1, axisLabel: { color: '#64748b', fontSize: 10 }, splitLine: { lineStyle: { color: 'rgba(255,255,255,0.05)' } } },
      series: [
        { name: 'Сообщения', type: 'bar', data: msgCounts, itemStyle: { color: '#6366f1', borderRadius: [4, 4, 0, 0] } },
        { name: 'Файлы', type: 'bar', data: fileCounts, itemStyle: { color: '#10b981', borderRadius: [4, 4, 0, 0] } }
      ]
    });
  }

  // Chart 4: File types pie
  const c4 = ensureChart('chartFileTypes');
  if (c4) {
    const typeCount = {};
    (_db.media || []).filter(m => !m.deletedAt).forEach(m => { typeCount[m.kind] = (typeCount[m.kind] || 0) + 1; });
    const pieData = Object.entries(typeCount).map(([name, value]) => ({ name, value }));
    const colorMap = { video: '#6366f1', audio: '#10b981', image: '#f59e0b', pdf: '#ef4444', text: '#38bdf8', other: '#8b5cf6' };
    c4.setOption({
      tooltip: { backgroundColor: 'rgba(17,24,39,0.95)', borderColor: 'rgba(255,255,255,0.1)', textStyle: { color: '#f1f5f9' } },
      series: [{
        type: 'pie', radius: ['45%', '70%'], center: ['50%', '52%'],
        data: pieData.length ? pieData : [{ name: 'Нет данных', value: 1, itemStyle: { color: 'rgba(255,255,255,0.08)' } }],
        label: { color: '#94a3b8', fontSize: 11 },
        itemStyle: { borderColor: 'rgba(11,15,30,0.8)', borderWidth: 2 },
        color: pieData.map(d => colorMap[d.name] || '#8b5cf6')
      }]
    });
  }

  toast('Статистика обновлена.', 'ok');
}

/* ============================================================
 * Drag-and-drop file upload
 * ============================================================ */
function setupDragAndDrop() {
  const overlay = $('#dropOverlay');
  if (!overlay) return;
  let dragCounter = 0;

  window.addEventListener('dragenter', (e) => {
    if (!state.user) return;
    e.preventDefault();
    dragCounter++;
    overlay.classList.add('active');
  });
  window.addEventListener('dragleave', (e) => {
    e.preventDefault();
    dragCounter--;
    if (dragCounter <= 0) { dragCounter = 0; overlay.classList.remove('active'); }
  });
  window.addEventListener('dragover', (e) => { e.preventDefault(); });
  window.addEventListener('drop', async (e) => {
    e.preventDefault();
    dragCounter = 0;
    overlay.classList.remove('active');
    if (!state.user) return;
    const files = Array.from(e.dataTransfer?.files || []);
    if (!files.length) return;
    // Switch to files tab
    tab('files');
    const note = '';
    for (const file of files) {
      if (file.size > 350 * 1024 * 1024) { toast(`${file.name}: больше 350 MB.`, 'bad'); continue; }
      try {
        await saveMediaBlob(file, 'file', note, file.name);
        toast(`Загружено: ${file.name}`, 'ok');
      } catch (e) { toast(`${file.name}: ${e.message}`, 'bad'); }
    }
    await refreshFiles();
  });
}

function bind() {
  $$('.tab').forEach((b) => b.addEventListener('click', () => tab(b.dataset.tab)));
  $$('.menu-open').forEach((b) => b.addEventListener('click', openMenu));
  bindClick('#closeMenuBtn', closeDrawers);
  bindClick('#menuBackdrop', closeDrawers);
  bindClick('#openRoomsBtn', openRooms);
  bindClick('#closeRoomsBtn', closeDrawers);
  bindClick('#joinRoomByCodeBtn', joinRoomByCodeManual);
  bindClick('#showUiBtn', () => $('#callStage')?.classList.remove('ui-hidden'));
  // Fullscreen toggle — handles iOS Safari (no Fullscreen API on divs)
  bindClick('#fullscreenBtn', async () => {
    const stage = $('#callStage');
    const video = $('#remoteVideo');
    if (!stage) return;

    // Check if we're in any fullscreen mode
    const isFullscreen = document.fullscreenElement || document.webkitFullscreenElement || stage.classList.contains('ui-hidden');

    if (isFullscreen) {
      // Exit fullscreen
      if (document.fullscreenElement) { await document.exitFullscreen?.().catch(() => {}); }
      else if (document.webkitFullscreenElement) { document.webkitExitFullscreen?.(); }
      stage.classList.remove('ui-hidden');
      toast('Полный экран выключен', 'info');
    } else {
      // Enter fullscreen — try multiple methods
      let entered = false;
      // Method 1: Standard Fullscreen API (Android Chrome, desktop)
      if (stage.requestFullscreen) {
        try { await stage.requestFullscreen(); entered = true; } catch {}
      }
      // Method 2: WebKit Fullscreen API (older Safari)
      if (!entered && stage.webkitRequestFullscreen) {
        try { stage.webkitRequestFullscreen(); entered = true; } catch {}
      }
      // Method 3: iOS Safari video fullscreen (native player)
      if (!entered && video && video.webkitEnterFullscreen) {
        try { video.webkitEnterFullscreen(); entered = true; } catch {}
      }
      // Method 4: Fallback — hide UI with CSS (works everywhere including iOS Safari)
      if (!entered) {
        stage.classList.add('ui-hidden');
        // Scroll to top to hide Safari address bar
        window.scrollTo(0, 0);
        entered = true;
      }
      if (entered) toast('Полный экран включён. Нажмите «Экран» для выхода.', 'ok');
    }
  });
  // Click on remote video = toggle UI (for iOS where fullscreen API doesn't work)
  $('#remoteVideo')?.addEventListener('click', (e) => {
    e.stopPropagation();
    $('#callStage')?.classList.toggle('ui-hidden');
    window.scrollTo(0, 0); // hide Safari address bar
  });
  // Click on stage areas (not buttons/video) = toggle UI
  $('#callStage')?.addEventListener('click', (e) => {
    if (e.target.closest('button') || e.target.closest('.bottom-drawer') || e.target.closest('.menu-drawer') || e.target.closest('video')) return;
    $('#callStage')?.classList.toggle('ui-hidden');
    window.scrollTo(0, 0);
  });
  // Exit fullscreen on hangup
  document.addEventListener('fullscreenchange', () => {
    if (!document.fullscreenElement) {
      $('#callStage')?.classList.remove('ui-hidden');
    }
  });
  document.addEventListener('webkitfullscreenchange', () => {
    if (!document.webkitFullscreenElement) {
      $('#callStage')?.classList.remove('ui-hidden');
    }
  });
  bindClick('#loginBtn', login);
  bindClick('#logoutBtn', logout);
  bindClick('#refreshAllBtn', refreshAll);
  bindClick('#createRoomBtn', createRoom);
  bindClick('#newRoomBtn', () => $('#roomTitle')?.focus());
  bindClick('#copyInviteBtn', async () => {
    if (!$('#inviteLink')?.value) return;
    try { await navigator.clipboard?.writeText($('#inviteLink').value); toast('Ссылка скопирована.', 'ok'); }
    catch { toast('Скопируйте ссылку вручную.', 'warn'); }
  });
  bindClick('#leaveRoomBtn', leaveRoom);
  bindClick('#callBtn', () => startCall().catch((e) => toast(e.message, 'bad')));
  bindClick('#hangupBtn', () => hangup(true));
  bindClick('#muteBtn', () => toggleMute().catch((e) => toast(e.message, 'bad')));
  bindClick('#cameraBtn', () => toggleCamera().catch((e) => toast(e.message, 'bad')));
  bindClick('#checkConnectionBtn', checkConnection);
  bindClick('#refreshPeersBtn', async () => {
    toast('Поиск участников…', 'info');
    // Re-announce our presence so other peers see us
    trysteroBroadcast({ kind: 'hello', displayName: state.user.displayName || state.user.username, username: state.user.username });
    await new Promise((r) => setTimeout(r, 1500));
    updateConnectionIndicator();
    const n = _peerNames.size;
    toast(n ? `Найдено участников: ${n}` : 'Участники не найдены. Убедитесь, что оба выбрали одну комнату.', n ? 'ok' : 'warn');
  });
  bindClick('#sendChatBtn', sendMessage);
  bindClick('#refreshChatBtn', refreshMessages);
  $('#chatInput')?.addEventListener('keydown', (e) => { if (e.ctrlKey && e.key === 'Enter') sendMessage(); });
  bindClick('#startRecordBtn', startRecording);
  bindClick('#stopRecordBtn', stopRecording);
  bindClick('#modeAudioBtn', () => { setRecordMode('audio'); toast('Аудио режим', 'info'); });
  bindClick('#modeVideoBtn', () => { setRecordMode('video'); toast('Видео режим', 'info'); });
  initIconTooltips();
  bindClick('#refreshMailBtn', refreshMail);
  bindClick('#uploadFilesBtn', uploadFiles);
  $('#fileInput')?.addEventListener('change', updateFilePickerText);
  bindClick('#refreshFilesBtn', refreshFiles);
  bindClick('#refreshStatsBtn', refreshStats);
  bindClick('#addUserBtn', addUser);
  bindClick('#refreshUsersBtn', refreshUsers);
  bindClick('#resetAllBtn', resetAllData);
  bindClick('#closePreviewBtn', () => $('#previewDialog')?.close());
  $('#previewDialog')?.addEventListener('click', (e) => {
    if (e.target === $('#previewDialog')) $('#previewDialog').close();
  });
  window.addEventListener('beforeinstallprompt', (e) => { e.preventDefault(); state.installPrompt = e; $('#installBtn')?.classList.remove('hidden'); });
  bindClick('#installBtn', async () => { if (state.installPrompt) await state.installPrompt.prompt(); });
  bindClick('#notifSettingsBtn', () => {
    _requestNotifPermission();
    _showNotificationSettings();
  });
  $('#loginUser')?.addEventListener('keydown', (e) => { if (e.key === 'Enter') $('#loginPass')?.focus(); });
  $('#loginPass')?.addEventListener('keydown', (e) => { if (e.key === 'Enter') login(); });

  // Drag-and-drop file upload
  setupDragAndDrop();
}

async function init() {
  renderIcons(document);
  bind();
  // Restore active tab from previous session (default to 'calls')
  const savedTab = (function() {
    try { return localStorage.getItem('call-static-active-tab') || 'calls'; } catch { return 'calls'; }
  })();
  enforceSingleActivePanel(savedTab);
  enforceClosedDrawers();
  updateMediaControls();
  await checkBrowserMediaSupport();
  if ('serviceWorker' in navigator && (window.isSecureContext || isLocalOrigin())) {
    try { await navigator.serviceWorker.register(APP_URL('/service-worker.js'), { scope: APP_URL('/') }); }
    catch (e) { console.warn('SW register failed:', e); }
  }
  await checkHealth();
  await seedDefaultUsers();
  await loadMe();
  // If logged in, re-apply saved tab (loadMe may have reset it)
  if (state.user) {
    enforceSingleActivePanel(savedTab);
    if (savedTab === 'stats') refreshStats().catch(() => {});
  }
  // Start polling GitHub for db.json changes every 10s (chat / rooms / files sync)
  GH.startPolling(10000);
  GH.onDbChange((newDb) => {
    _db = newDb;
    if (state.user) {
      try { refreshRooms(); } catch {}
      try { refreshMessages(); } catch {}
      try { refreshMail(); } catch {}
      try { refreshFiles(); } catch {}
      try { if (state.user.role === 'admin') refreshUsers(); } catch {}
    }
  });
  // Periodic health check (rate limit display)
  setInterval(checkHealth, 60000);
  // Leave Trystero room on page close
  window.addEventListener('beforeunload', () => {
    if (state._room) { try { FB.leave(); } catch {} }
  });
  window.addEventListener('pagehide', () => {
    if (state._room) { try { FB.leave(); } catch {} }
  });
  // Show invite hint on login screen if there's a room in URL
  const params = new URLSearchParams(location.search);
  if (params.get('room')) {
    $('#inviteLoginHint')?.classList.remove('hidden');
  }
}

init().catch((e) => toast(e.message, 'bad'));

/* ============================================================
 * Notifications — browser push + sound + tab flash + Teams webhook
 * ============================================================ */
let _notifSound = null;
let _originalTitle = document.title;
let _titleFlashTimer = null;
let _lastMessageCount = 0;
let _lastMediaCount = 0;
let _teamsWebhookUrl = '';

// Load Teams webhook URL from localStorage
try { _teamsWebhookUrl = localStorage.getItem('teams-webhook-url') || ''; } catch {}

function _playSound(freq = 800, duration = 300, pattern = 'ring') {
  try {
    if (!_notifSound) {
      const ctx = new (window.AudioContext || window.webkitAudioContext)();
      _notifSound = ctx;
    }
    const ctx = _notifSound;
    if (ctx.state === 'suspended') ctx.resume();
    
    if (pattern === 'ring') {
      // Phone ring pattern: two tones
      for (let i = 0; i < 3; i++) {
        const osc = ctx.createOscillator();
        const gain = ctx.createGain();
        osc.connect(gain); gain.connect(ctx.destination);
        osc.frequency.value = freq;
        osc.type = 'sine';
        gain.gain.setValueAtTime(0.3, ctx.currentTime + i * 0.4);
        gain.gain.exponentialRampToValueAtTime(0.01, ctx.currentTime + i * 0.4 + 0.3);
        osc.start(ctx.currentTime + i * 0.4);
        osc.stop(ctx.currentTime + i * 0.4 + 0.3);
      }
    } else if (pattern === 'chime') {
      // Notification chime: ascending notes
      const notes = [523, 659, 784];
      notes.forEach((f, i) => {
        const osc = ctx.createOscillator();
        const gain = ctx.createGain();
        osc.connect(gain); gain.connect(ctx.destination);
        osc.frequency.value = f;
        osc.type = 'sine';
        gain.gain.setValueAtTime(0.2, ctx.currentTime + i * 0.15);
        gain.gain.exponentialRampToValueAtTime(0.01, ctx.currentTime + i * 0.15 + 0.2);
        osc.start(ctx.currentTime + i * 0.15);
        osc.stop(ctx.currentTime + i * 0.15 + 0.2);
      });
    }
  } catch (e) { /* audio not available */ }
}

function _flashTabTitle(text) {
  if (_titleFlashTimer) clearInterval(_titleFlashTimer);
  let toggle = false;
  _titleFlashTimer = setInterval(() => {
    document.title = toggle ? text : _originalTitle;
    toggle = !toggle;
  }, 800);
  // Stop flashing after 30s or when tab gets focus
  setTimeout(() => { _stopTabFlash(); }, 30000);
  window.addEventListener('focus', _stopTabFlash, { once: true });
}
function _stopTabFlash() {
  if (_titleFlashTimer) { clearInterval(_titleFlashTimer); _titleFlashTimer = null; }
  document.title = _originalTitle;
}

async function _showNotification(title, body, icon) {
  const iconUrl = icon || 'icon.svg';
  
  // Method 1: Service Worker notification (works on iOS PWA 16.4+, Android, desktop)
  if ('serviceWorker' in navigator && navigator.serviceWorker.controller) {
    try {
      navigator.serviceWorker.controller.postMessage({
        type: 'SHOW_NOTIFICATION',
        title, body, icon: iconUrl, tag: title
      });
    } catch {}
  }
  
  // Method 2: Window Notification API (works on desktop, Android Chrome)
  // iOS Safari blocks this in PWA mode — SW method above handles iOS
  if ('Notification' in window && Notification.permission === 'granted') {
    try {
      const notif = new Notification(title, {
        body, icon: iconUrl, badge: 'icon.svg', tag: title,
        requireInteraction: false, silent: true // silent=true because we play our own sound
      });
      notif.onclick = () => { window.focus(); notif.close(); };
    } catch {}
  }
  
  // Method 3: In-app banner (works when app is in foreground — visible to user)
  _showInAppBanner(title, body);
  
  // Method 4: Teams webhook (optional)
  if (_teamsWebhookUrl) {
    try {
      await fetch(_teamsWebhookUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ text: `**${title}**\n${body}` })
      });
    } catch {}
  }
}

// In-app banner notification — slides in from top, auto-dismisses
function _showInAppBanner(title, body) {
  let banner = document.getElementById('inAppBanner');
  if (!banner) {
    banner = document.createElement('div');
    banner.id = 'inAppBanner';
    banner.style.cssText = `
      position: fixed; top: calc(8px + env(safe-area-inset-top, 0px)); left: 50%;
      transform: translateX(-50%) translateY(-120px);
      background: rgba(17, 24, 39, 0.97); backdrop-filter: blur(24px);
      border: 1px solid rgba(99, 102, 241, 0.4); border-radius: 16px;
      padding: 12px 18px; z-index: 500; max-width: 90vw;
      box-shadow: 0 12px 40px rgba(0,0,0,0.4), 0 0 24px rgba(99,102,241,0.2);
      transition: transform 0.4s cubic-bezier(0.34, 1.56, 0.64, 1);
      display: flex; gap: 12px; align-items: center; cursor: pointer;
    `;
    document.body.appendChild(banner);
    banner.onclick = () => { banner.style.transform = 'translateX(-50%) translateY(-120px)'; };
  }
  banner.innerHTML = `
    <div style="font-size: 14px; font-weight: 700; color: #c7d2fe;">${escapeHtml(title)}</div>
    <div style="font-size: 12px; color: #94a3b8; max-width: 250px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap;">${escapeHtml(body)}</div>
  `;
  // Slide in
  requestAnimationFrame(() => {
    banner.style.transform = 'translateX(-50%) translateY(0)';
  });
  // Auto dismiss after 5s
  clearTimeout(banner._timer);
  banner._timer = setTimeout(() => {
    banner.style.transform = 'translateX(-50%) translateY(-120px)';
  }, 5000);
}

async function _requestNotifPermission() {
  // On iOS PWA, Notification.requestPermission must be called from a user gesture
  // and the app must be installed (standalone mode)
  const isStandalone = window.matchMedia('(display-mode: standalone)').matches || window.navigator.standalone;
  
  if ('Notification' in window) {
    if (Notification.permission === 'default') {
      try {
        const result = await Notification.requestPermission();
        if (result === 'granted') {
          toast('Уведомления включены ✓', 'ok');
          // Test notification
          setTimeout(() => _showNotification('✓ Тест', 'Уведомления работают'), 500);
        } else if (result === 'denied' && isStandalone) {
          toast('Уведомления заблокированы. Настройки → Safari → Уведомления', 'warn');
        }
      } catch (e) {
        // iOS might not support requestPermission directly
        toast('Разрешите уведомления в настройках браузера', 'info');
      }
    } else if (Notification.permission === 'granted') {
      toast('Уведомления уже включены', 'ok');
    }
  }
}

// Check for new messages/files on db.json poll
function _checkForNewItems(newDb) {
  if (!state.user || !newDb) return;
  
  // Check new messages
  const msgCount = (newDb.messages || []).length;
  if (_lastMessageCount > 0 && msgCount > _lastMessageCount) {
    const newMsgs = (newDb.messages || []).slice(_lastMessageCount);
    for (const m of newMsgs) {
      if (m.authorId !== state.user.id) {
        const name = m.authorName || 'Участник';
        _showNotification('💬 Новое сообщение', `${name}: ${m.text?.slice(0, 50) || '...'}`);
        _playSound(659, 200, 'chime');
        _flashTabTitle('💬 Новое сообщение!');
      }
    }
  }
  _lastMessageCount = msgCount;
  
  // Check new media (files + mail)
  const mediaCount = (newDb.media || []).filter(m => !m.deletedAt).length;
  if (_lastMediaCount > 0 && mediaCount > _lastMediaCount) {
    const allMedia = (newDb.media || []).filter(m => !m.deletedAt);
    const newItems = allMedia.slice(0, mediaCount - _lastMediaCount);
    for (const m of newItems) {
      if (m.uploadedBy !== state.user.id) {
        const name = m.uploadedByName || 'Участник';
        const type = m.type === 'mail' ? 'видео/аудио почту' : 'файл';
        _showNotification('📎 Новый файл', `${name} загрузил ${type}: ${m.originalName}`);
        _playSound(659, 200, 'chime');
        _flashTabTitle('📎 Новый файл!');
      }
    }
  }
  _lastMediaCount = mediaCount;
}

// Notify incoming call (called from onRing handler)
function _notifyIncomingCall(callerName) {
  _showNotification('📞 Входящий звонок', `${callerName} звонит вам`);
  _playSound(800, 300, 'ring');
  _flashTabTitle('📞 Входящий звонок!');
}

// Settings UI for Teams webhook
function _showNotificationSettings() {
  const current = _teamsWebhookUrl;
  const url = prompt('Teams Webhook URL (оставьте пустым чтобы отключить):', current);
  if (url !== null) {
    _teamsWebhookUrl = url.trim();
    try { localStorage.setItem('teams-webhook-url', _teamsWebhookUrl); } catch {}
    toast(_teamsWebhookUrl ? 'Teams уведомления включены' : 'Teams уведомления выключены', 'ok');
  }
}

/* ============================================================
 * Pull-to-refresh — pull down on any content page to refresh
 * ============================================================ */
(function() {
  let _pullStartY = 0;
  let _pullCurrentY = 0;
  let _pulling = false;
  let _pullDistance = 0;
  const PULL_THRESHOLD = 70; // px needed to trigger refresh
  const PULL_MAX = 120; // max visual pull distance

  const indicator = () => document.getElementById('ptrIndicator');
  const arrow = () => document.getElementById('ptrArrow');

  // Only enable on content pages (not calls)
  function _isEnabled() {
    const active = document.querySelector('.tab-panel.active');
    if (!active) return false;
    // Calls page is position:fixed, no scroll — skip it
    if (active.id === 'calls') return false;
    // Only trigger when scrolled to top
    return active.scrollTop <= 0;
  }

  document.addEventListener('touchstart', (e) => {
    if (!_isEnabled()) return;
    _pullStartY = e.touches[0].clientY;
    _pulling = false;
    _pullDistance = 0;
  }, { passive: true });

  document.addEventListener('touchmove', (e) => {
    if (!_isEnabled() && !_pulling) return;
    _pullCurrentY = e.touches[0].clientY;
    const diff = _pullCurrentY - _pullStartY;

    if (diff > 5 && _isEnabled()) {
      _pulling = true;
      _pullDistance = Math.min(diff, PULL_MAX);

      const ind = indicator();
      if (ind) {
        ind.classList.add('visible');
        ind.style.transform = `translateX(-50%) translateY(${_pullDistance - 50}px)`;

        // Flip arrow when threshold reached
        const ar = arrow();
        if (ar) {
          if (_pullDistance >= PULL_THRESHOLD) {
            ar.classList.add('flip');
            ar.style.display = 'block';
          } else {
            ar.classList.remove('flip');
            ar.style.display = 'block';
          }
        }
      }
    }
  }, { passive: true });

  document.addEventListener('touchend', async () => {
    if (!_pulling) return;
    _pulling = false;

    const ind = indicator();
    const ar = arrow();

    if (_pullDistance >= PULL_THRESHOLD) {
      // Trigger refresh
      if (ind) {
        ind.style.transform = 'translateX(-50%) translateY(10px)';
        // Show spinner
        if (ar) ar.outerHTML = '<div class="ptr-spinner" id="ptrArrow"></div>';
      }
      // Refresh appropriate content based on active tab
      const activeTab = document.querySelector('.tab-panel.active')?.id;
      try {
        if (activeTab === 'chat') await refreshMessages();
        else if (activeTab === 'mail') await refreshMail();
        else if (activeTab === 'files') await refreshFiles();
        else if (activeTab === 'stats') await refreshStats();
        else await refreshAll();
        toast('Обновлено ✓', 'ok');
      } catch (e) {
        toast('Ошибка обновления', 'bad');
      }
    }

    // Reset indicator
    setTimeout(() => {
      if (ind) {
        ind.classList.remove('visible');
        ind.style.transform = 'translateX(-50%) translateY(-60px)';
      }
      // Restore arrow for next time
      const currentArrow = document.getElementById('ptrArrow');
      if (currentArrow && currentArrow.classList.contains('ptr-spinner')) {
        currentArrow.outerHTML = '<div class="ptr-arrow" id="ptrArrow"><svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round"><polyline points="6 9 12 15 18 9"/></svg></div>';
      }
    }, 500);

    _pullDistance = 0;
  }, { passive: true });
})();
