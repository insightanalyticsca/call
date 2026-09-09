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

/* ---------- Version ---------- */
const APP_VERSION = 'lk19';

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
  { urls: 'stun:stun2.l.google.com:19302' },
  { urls: 'stun:global.stun.twilio.com:3478' },
  { urls: 'turn:global.relay.metered.ca:80', username: 'b726935ca3b6889e1570d25b', credential: '3onGED6BKzsBVZch' },
  { urls: 'turn:global.relay.metered.ca:443', username: 'b726935ca3b6889e1570d25b', credential: '3onGED6BKzsBVZch' },
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
  'key': 'fa-key',
  'users': 'fa-users',
  'phone-volume': 'fa-phone-volume',
  'circle-xmark': 'fa-circle-xmark'
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
      users: [], rooms: [], messages: [], media: [], events: [], pendingCalls: []
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
  _recordingCall: false,  // true while recording an active call (lk9)
  _callActive: false,     // lk16: true when a call is active (ring sent/accepted)
  _callingPeer: null,     // lk11: peerId of the person we're calling
  _callTimeout: null,     // lk11: timeout for auto-cancel
  _pendingCallId: null,   // lk13: db.json pendingCall ID for fallback ring
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
  try { refreshUsers(); } catch {}
  try { monitorPendingCalls(); } catch (e) { console.warn('monitorPendingCalls:', e); }
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
  try { refreshUsers(); } catch {}
  try { monitorPendingCalls(); } catch (e) { console.warn('monitorPendingCalls:', e); }
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
  // Leave any existing room
  if (state._room) {
    try { await LK.leave(); } catch {}
    _peerNames.clear();
    _stopStreams.clear();
    state.remoteStreams.clear();
  }

  state.currentRoom = room;
  state.currentRoomCode = room.code;

  setStatus($('#socketStatus'), 'Подключение к LiveKit…', 'warn');

  // ============================================================
  // CRITICAL (lk10): set up ALL callbacks BEFORE joinRoom.
  // LiveKit fires trackSubscribed for existing participants'
  // tracks DURING await connect(). If the callbacks aren't set
  // yet, those events are lost and we get asymmetric video.
  // livekit.js also buffers events as a safety net, but setting
  // callbacks first is the correct fix.
  // ============================================================

  // --- Set up messaging actions FIRST (so dataReceived dispatcher has handlers) ---
  const [sendChat, onChat] = LK.makeAction('chat');
  const [sendHello, onHello] = LK.makeAction('hello');
  const [sendHangup, onHangup] = LK.makeAction('hangup');
  const [sendRing, onRing] = LK.makeAction('ring');
  const [sendRingAccept, onRingAccept] = LK.makeAction('ringAccept');
  const [sendRingDecline, onRingDecline] = LK.makeAction('ringDecline');

  state._sendChat = sendChat;
  state._sendHello = sendHello;
  state._sendHangup = sendHangup;
  state._sendRing = sendRing;
  state._sendRingAccept = sendRingAccept;
  state._sendRingDecline = sendRingDecline;
  state._room = LK;

  // --- Register message handlers BEFORE joinRoom ---
  // Map of LiveKit peerSid -> { displayName, username, userId }
  // userId is resolved from _db.users by matching username.
  onHello((data, peerId) => {
    const displayName = data.displayName || data.username || 'Гость';
    const username = data.username || '';
    // Resolve userId from db
    let userId = null;
    if (username && _db) {
      const u = (_db.users || []).find((x) => x.username === username);
      if (u) userId = u.id;
    }
    _peerNames.set(peerId, displayName);
    // Store extended peer info for callUser-by-peerId lookup
    if (!state._peerInfo) state._peerInfo = new Map();
    state._peerInfo.set(peerId, { displayName, username, userId });
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
    updateRemoteVideo();
    updateConnectionIndicator();
    // lk11: remote hung up — stop our camera + unpublish too
    try { LK.unpublishAll(); } catch (e) { console.warn('[onHangup] unpublish:', e.message); }
    if (state.localStream) {
      state.localStream.getTracks().forEach((t) => { try { t.stop(); } catch {} });
      state.localStream = null;
    }
    attachLocalStream(null);
    updateMediaControls();
    state._callingPeer = null;
    state._callActive = false;  // lk16
    _setCallingState(false);
    toast('Собеседник завершил звонок.');
  });

  onRing((data, peerId) => {
    const callerName = data?.displayName || 'Участник';
    console.log('[onRing] received from peer:', peerId, 'caller:', callerName);
    // lk14: removed the remoteStreams.has(peerId) guard — it prevented
    // the dialog from showing if stale streams existed. Always show the dialog.
    if (state._callingPeer === peerId) return;  // we're calling them, ignore their ring
    if (document.getElementById('incomingCallDialog')) return;  // already showing
    showIncomingCall(callerName, peerId);
  });

  onRingAccept((_data, peerId) => {
    console.log('[onRingAccept] received from peer:', peerId);
    toast('Звонок принят ✓', 'ok');
    state._callingPeer = null;
    if (state._callTimeout) { clearTimeout(state._callTimeout); state._callTimeout = null; }
    _setCallingState(false);
    // Callee accepted — NOW publish our tracks so they see us
    if (state.localStream && state._room && state._room.publishLocalStream) {
      state._room.publishLocalStream(state.localStream).catch((e) => {
        console.warn('[onRingAccept] publish failed:', e.message);
      });
    }
    // Also mark the pendingCall as accepted in db.json (so monitorPendingCalls doesn't re-trigger)
    if (state._pendingCallId) {
      _markPendingCallAccepted(state._pendingCallId);
      state._pendingCallId = null;
    }
  });

  onRingDecline((_data, peerId) => {
    console.log('[onRingDecline] received from peer:', peerId);
    toast('Звонок отклонён.', 'warn');
    state._callingPeer = null;
    state._callActive = false;  // lk16
    if (state._callTimeout) { clearTimeout(state._callTimeout); state._callTimeout = null; }
    _setCallingState(false);
    // Callee declined — stop camera, unpublish
    if (state.localStream) {
      state.localStream.getTracks().forEach((t) => { try { t.stop(); } catch {} });
      state.localStream = null;
    }
    attachLocalStream(null);
    updateMediaControls();
    try { LK.unpublishAll(); } catch (e) { console.warn('[onRingDecline] unpublish:', e.message); }
    // Also mark the pendingCall as declined in db.json
    if (state._pendingCallId) {
      _markPendingCallDeclined(state._pendingCallId);
      state._pendingCallId = null;
    }
  });

  // --- Set peer event callbacks BEFORE joinRoom ---
  // livekit.js will buffer any events that fire during connect()
  // and flush them when these setters are called. But setting
  // them before joinRoom is still the correct order.
  LK.onPeerJoin = (peerId) => {
    const peers = LK.getPeers();
    const name = peers[peerId]?.displayName || 'Гость';
    _peerNames.set(peerId, name);
    renderPresence();
    updateConnectionIndicator();
  };

  LK.onPeerLeave = (peerId) => {
    _peerNames.delete(peerId);
    state.remoteStreams.delete(peerId);
    renderPresence();
    updateRemoteVideo();
    updateConnectionIndicator();
  };

  LK.onPeerStream = (stream, peerId) => {
    // lk16: Only display remote video when a call is active.
    if (!state._callActive) {
      console.log('[lk16] onPeerStream: ignoring remote track — no active call (state._callActive=false)');
      return;
    }
    console.log('[lk16] onPeerStream: accepting remote track (call active)');

    // lk17: MEDIA-BASED ACCEPT DETECTION
    // If we're the caller (state._callingPeer is set) and we receive the
    // callee's tracks, that means they accepted the call. The ringAccept
    // data channel message may not have reached us (unreliable on mobile),
    // but the MEDIA definitely arrives. So auto-publish our tracks now.
    if (state._callingPeer && state._callingPeer === peerId) {
      console.log('[lk17] caller received callee tracks — auto-publishing (media-based accept)');
      state._callingPeer = null;
      if (state._callTimeout) { clearTimeout(state._callTimeout); state._callTimeout = null; }
      _setCallingState(false);
      if (state.localStream && state._room && state._room.publishLocalStream) {
        state._room.publishLocalStream(state.localStream).catch((e) => {
          console.warn('[lk17] auto-publish failed:', e.message);
        });
      }
      // Mark pendingCall as accepted in db.json (if we have one)
      if (state._pendingCallId) {
        _markPendingCallAccepted(state._pendingCallId);
        state._pendingCallId = null;
      }
    }

    // LiveKit sends tracks one at a time — merge into existing stream
    let existing = state.remoteStreams.get(peerId);
    if (existing) {
      stream.getTracks().forEach(t => {
        existing.getTracks().forEach(old => {
          if (old.kind === t.kind) existing.removeTrack(old);
        });
        existing.addTrack(t);
      });
    } else {
      state.remoteStreams.set(peerId, stream);
    }
    updateRemoteVideo();
    setStatus($('#peerStatus'), 'WebRTC: connected', 'ok');
    $('#pcState').textContent = 'PC: connected (' + state.remoteStreams.size + ')';
    $('#iceState').textContent = 'ICE: connected (LiveKit)';
    updateConnectionIndicator();
    if (state.remoteStreams.size === 1) {
      toast('Видео подключено ✓ Нажмите «Экран» для полного экрана', 'ok');
    }
  };

  // --- NOW join the room ---
  await LK.joinRoom(room.code, {
    displayName: state.user.displayName || state.user.username,
    username: state.user.username
  });

  state.peer = { connected: true };
  state.peerId = LK.selfId;

  setStatus($('#socketStatus'), 'LiveKit: подключён ✓', 'ok');
  updateConnectionIndicator();

  // NOTE (lk11): We do NOT capture/publish camera here.
  // Room join = presence only. The camera turns on only when a call
  // is initiated (startCall) or accepted (showIncomingCall accept).
  // This gives the normal phone-call flow: ring → accept → video.

  sendHello({ displayName: state.user.displayName || state.user.username, username: state.user.username });
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
    // lk16: Mark call as active BEFORE sending ringAccept or awaiting getUserMedia.
    // This ensures the caller's tracks (which arrive after ringAccept) aren't blocked.
    state._callActive = true;
    if (state._sendRingAccept) state._sendRingAccept({}, peerId);
    toast('Подключение к звонку…', 'info');
    try {
      // lk11: Capture camera + publish tracks to LiveKit.
      // The caller receives ringAccept and publishes their tracks too.
      // Both sides start publishing simultaneously → both see each other.
      toast('Включение камеры…', 'info');
      try {
        await ensureLocalMedia(true).catch(async () => ensureLocalMedia(false));
      } catch (e) {
        console.warn('[APP] camera/mic failed, continuing without:', e.message);
      }
      toast('Видео подключено ✓', 'ok');
      updateCallGuide();
    } catch (e) {
      console.error('[APP] acceptCall failed:', e.message, e.stack);
      toast('Не удалось подключиться: ' + e.message, 'bad');
    }
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
  try { await LK.unpublishAll(); } catch (e) { console.warn('[disconnectPeer] unpublishAll:', e.message); }
  await LK.leave();
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
  const stage = document.querySelector('.remote-stage');
  const v = $('#remoteVideo');
  if (streams.length === 0) {
    v.srcObject = null;
    stage?.classList.remove('has-remote');
    _showVideoControls(false);  // lk19: hide video controls
    _vidReset();                // lk19: reset transform
    updateCallRecordButton();
    return;
  }
  stage?.classList.add('has-remote');
  if (streams.length === 1) {
    v.srcObject = streams[0];
  } else {
    const mixed = new MediaStream();
    for (const s of streams) s.getTracks().forEach((t) => mixed.addTrack(t));
    v.srcObject = streams[0]; // For 1:1 calls, just use the first stream
  }
  // lk15: Force play with retry — iOS Safari sometimes pauses video.
  _forcePlayVideo(v);
  // lk19: Show video controls + setup drag/pinch
  _showVideoControls(true);
  _setupVideoDragPan();
  _setupPinchZoom();
  _applyVideoTransform();
  updateCallRecordButton();
}

// lk15: Force video to play, retrying if it pauses.
// iOS Safari and some Android browsers pause video elements when they
// think the user isn't interacting. This keeps the remote video playing.
function _forcePlayVideo(v) {
  if (!v) return;
  v.muted = false;
  v.play?.().catch((e) => {
    console.warn('[updateRemoteVideo] play() failed:', e.message);
    // If autoplay was blocked, try muting and playing (browsers allow muted autoplay)
    if (e.name === 'NotAllowedError') {
      v.muted = true;
      v.play?.().catch(() => {});
      // Unmute after 1s (user interaction may have happened by then)
      setTimeout(() => { v.muted = false; }, 1000);
    }
  });
}

// lk15: Global pause detector — if the remote video pauses for any reason,
// immediately try to resume it. This prevents "freeze after a few seconds".
(function _setupRemoteVideoPauseGuard() {
  // Defer until DOM is ready
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', _attachPauseGuard);
  } else {
    _attachPauseGuard();
  }
  function _attachPauseGuard() {
    const v = document.getElementById('remoteVideo');
    if (!v || v._lk15PauseGuard) return;
    v._lk15PauseGuard = true;
    v.addEventListener('pause', () => {
      // Don't force play if srcObject is null (call ended)
      if (v.srcObject) {
        console.log('[lk15] remote video paused — forcing play()');
        v.play?.().catch(() => {});
      }
    });
    v.addEventListener('stalled', () => {
      if (v.srcObject) {
        console.log('[lk15] remote video stalled — forcing play()');
        v.play?.().catch(() => {});
      }
    });
    v.addEventListener('suspend', () => {
      if (v.srcObject) {
        console.log('[lk15] remote video suspended — forcing play()');
        v.play?.().catch(() => {});
      }
    });
  }
})();

/* ============================================================
 * lk19: Video transform controls (zoom, rotate, pan, fit)
 * ============================================================ */

// Transform state — applied to #remoteVideo via CSS transform.
state._vidTransform = { zoom: 1, rotate: 0, panX: 0, panY: 0, fit: 'cover' };

function _applyVideoTransform() {
  const v = $('#remoteVideo');
  if (!v) return;
  const t = state._vidTransform;
  // Apply object-fit separately (not a transform)
  v.style.objectFit = t.fit;
  // CSS transform: translate first, then scale, then rotate
  v.style.transform = `translate(${t.panX}px, ${t.panY}px) scale(${t.zoom}) rotate(${t.rotate}deg)`;
}

function _showVideoControls(show) {
  const c = $('#videoControls');
  if (!c) return;
  // Show only when there's a remote stream
  const hasRemote = state.remoteStreams.size > 0;
  c.classList.toggle('hidden', !(show && hasRemote));
}

function _vidZoomIn() {
  state._vidTransform.zoom = Math.min(state._vidTransform.zoom + 0.25, 4);
  _applyVideoTransform();
  toast(`Zoom: ${Math.round(state._vidTransform.zoom * 100)}%`, 'info');
}

function _vidZoomOut() {
  state._vidTransform.zoom = Math.max(state._vidTransform.zoom - 0.25, 0.5);
  _applyVideoTransform();
  toast(`Zoom: ${Math.round(state._vidTransform.zoom * 100)}%`, 'info');
}

function _vidRotate() {
  state._vidTransform.rotate = (state._vidTransform.rotate + 90) % 360;
  _applyVideoTransform();
  toast(`Поворот: ${state._vidTransform.rotate}°`, 'info');
}

function _vidFit() {
  const v = $('#remoteVideo');
  if (!v) return;
  // Toggle between 'cover' (fill, may crop) and 'contain' (letterbox, see all)
  state._vidTransform.fit = (state._vidTransform.fit === 'cover') ? 'contain' : 'cover';
  _applyVideoTransform();
  // Update button active state
  const btn = $('#vidFit');
  if (btn) btn.classList.toggle('fit-active', state._vidTransform.fit === 'contain');
  toast(state._vidTransform.fit === 'cover' ? 'Заполнить экран' : 'Вписать целиком', 'info');
}

function _vidReset() {
  state._vidTransform = { zoom: 1, rotate: 0, panX: 0, panY: 0, fit: 'cover' };
  _applyVideoTransform();
  const btn = $('#vidFit');
  if (btn) btn.classList.remove('fit-active');
  toast('Видео сброшено', 'info');
}

// Drag-to-pan on the remote video (touch + mouse)
function _setupVideoDragPan() {
  const v = $('#remoteVideo');
  if (!v || v._lk19DragSetup) return;
  v._lk19DragSetup = true;

  let dragging = false;
  let startX = 0, startY = 0;
  let startPanX = 0, startPanY = 0;

  function onStart(e) {
    // Only pan when there's a remote stream
    if (state.remoteStreams.size === 0) return;
    // Don't start drag if clicking on a button
    if (e.target.closest('button')) return;
    dragging = true;
    v.classList.add('dragging');
    const pt = e.touches ? e.touches[0] : e;
    startX = pt.clientX;
    startY = pt.clientY;
    startPanX = state._vidTransform.panX;
    startPanY = state._vidTransform.panY;
    e.preventDefault();
  }

  function onMove(e) {
    if (!dragging) return;
    const pt = e.touches ? e.touches[0] : e;
    const dx = pt.clientX - startX;
    const dy = pt.clientY - startY;
    state._vidTransform.panX = startPanX + dx;
    state._vidTransform.panY = startPanY + dy;
    _applyVideoTransform();
    e.preventDefault();
  }

  function onEnd() {
    if (!dragging) return;
    dragging = false;
    v.classList.remove('dragging');
    // Mark that we just dragged so the click handler doesn't toggle UI
    v._lk19JustDragged = true;
    setTimeout(() => { v._lk19JustDragged = false; }, 100);
  }

  v.addEventListener('mousedown', onStart);
  v.addEventListener('touchstart', onStart, { passive: false });
  document.addEventListener('mousemove', onMove);
  document.addEventListener('touchmove', onMove, { passive: false });
  document.addEventListener('mouseup', onEnd);
  document.addEventListener('touchend', onEnd);
  document.addEventListener('touchcancel', onEnd);
}

// Pinch-to-zoom on touch devices
function _setupPinchZoom() {
  const v = $('#remoteVideo');
  if (!v || v._lk19PinchSetup) return;
  v._lk19PinchSetup = true;

  let pinchDist = 0;
  let pinchZoomStart = 1;

  function getDist(touches) {
    const dx = touches[0].clientX - touches[1].clientX;
    const dy = touches[0].clientY - touches[1].clientY;
    return Math.sqrt(dx * dx + dy * dy);
  }

  v.addEventListener('touchstart', (e) => {
    if (e.touches.length === 2 && state.remoteStreams.size > 0) {
      pinchDist = getDist(e.touches);
      pinchZoomStart = state._vidTransform.zoom;
      e.preventDefault();
    }
  }, { passive: false });

  v.addEventListener('touchmove', (e) => {
    if (e.touches.length === 2 && pinchDist > 0) {
      const newDist = getDist(e.touches);
      const ratio = newDist / pinchDist;
      state._vidTransform.zoom = Math.max(0.5, Math.min(pinchZoomStart * ratio, 4));
      _applyVideoTransform();
      e.preventDefault();
    }
  }, { passive: false });

  v.addEventListener('touchend', (e) => {
    if (e.touches.length < 2) pinchDist = 0;
  });
}

/* ---------- Call-recording toggle (lk9) ----------
 * The 'Запись' button is hidden by default and only appears when
 * there's an active call (state.remoteStreams.size > 0). Clicking it
 * starts recording the remote stream immediately (mode = 'call').
 * Clicking again stops recording. There is NO persistent 'Звонок'
 * mode button in the Почта tab anymore — recording a call is opt-in
 * via this single button.
 */
function updateCallRecordButton() {
  const btn = $('#recordCallBtn');
  if (!btn) return;
  const hasCall = state.remoteStreams && state.remoteStreams.size > 0;
  const isRecording = !!(state.recorder && state.recorder.state === 'recording' && state._recordingCall);
  if (hasCall || isRecording) {
    btn.classList.remove('hidden');
    btn.classList.toggle('recording', isRecording);
    btn.innerHTML = isRecording
      ? `${icon('square')}<span>Стоп</span>`
      : `${icon('record-vinyl')}<span>Запись</span>`;
  } else {
    btn.classList.add('hidden');
    btn.classList.remove('recording');
  }
}

async function toggleCallRecording() {
  // If we're recording a call right now -> stop
  if (state.recorder && state.recorder.state === 'recording' && state._recordingCall) {
    stopRecording();
    return;
  }
  // Otherwise -> start call recording (mode = 'call')
  if (state.remoteStreams.size === 0) {
    return toast('Нет активного звонка. Сначала позвоните кому-нибудь.', 'warn');
  }
  setRecordMode('call');
  await startRecording();
  // Mark this as a call recording so updateCallRecordButton knows
  if (state.recorder && state.recorder.state === 'recording') {
    state._recordingCall = true;
    _startCallRecIndicator();
    updateCallRecordButton();
  }
}

function _startCallRecIndicator() {
  const ind = $('#callRecIndicator');
  if (!ind) return;
  ind.classList.remove('hidden');
  const timerEl = $('#callRecTimer');
  const startedAt = Date.now();
  if (ind._timer) clearInterval(ind._timer);
  ind._timer = setInterval(() => {
    if (!timerEl) return;
    const s = Math.floor((Date.now() - startedAt) / 1000);
    timerEl.textContent = `${String(Math.floor(s / 60)).padStart(2, '0')}:${String(s % 60).padStart(2, '0')}`;
  }, 500);
}

function _stopCallRecIndicator() {
  const ind = $('#callRecIndicator');
  if (!ind) return;
  ind.classList.add('hidden');
  if (ind._timer) { clearInterval(ind._timer); ind._timer = null; }
  const timerEl = $('#callRecTimer');
  if (timerEl) timerEl.textContent = '00:00';
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
async function ensureLocalMedia(video = true, publish = true) {
  if (state.localStream && (!video || hasVideoTrack(state.localStream))) {
    attachLocalStream(state.localStream);
    updateMediaControls();
    // Re-publish in case new tracks were added (e.g. video re-enabled after audio-only)
    if (publish && state._room && state._room.publishLocalStream) {
      try { await state._room.publishLocalStream(state.localStream); } catch (e) { console.warn('[APP] republish failed:', e.message); }
    }
    return state.localStream;
  }
  if (state.localStream && video && !hasVideoTrack(state.localStream)) {
    // Stop old tracks then re-capture with video
    state.localStream.getTracks().forEach((t) => t.stop());
    state.localStream = null;
  }
  // HD capture: 1080p ideal, fall back to 720p, then to whatever the device supports.
  const constraints = video
    ? { video: { facingMode: 'user', width: { ideal: 1920, min: 640 }, height: { ideal: 1080, min: 480 }, frameRate: { ideal: 30, max: 30 } }, audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true } }
    : { video: false, audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true } };
  try {
    state.localStream = await getUserMediaCompat(constraints);
  } catch (e) {
    // Try 720p fallback
    if (video && (e?.name === 'OverconstrainedError' || e?.name === 'NotReadableError')) {
      console.warn('[ensureLocalMedia] 1080p failed, trying 720p:', e.message);
      try {
        state.localStream = await getUserMediaCompat({ video: { facingMode: 'user', width: { ideal: 1280 }, height: { ideal: 720 } }, audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true } });
      } catch (e2) {
        // Last resort: any video + audio
        state.localStream = await getUserMediaCompat({ video: true, audio: true });
      }
    } else {
      throw new Error(normalizeMediaError(e, video));
    }
  }
  state.camOff = false; state.micMuted = false;
  attachLocalStream(state.localStream);
  updateMediaControls();
  // Publish tracks to LiveKit if we're in a room AND publish is requested
  if (publish && state._room && state._room.publishLocalStream) {
    try { await state._room.publishLocalStream(state.localStream); } catch (e) { console.warn('[APP] publish failed:', e.message); }
  }
  toast(video ? 'Камера включена.' : 'Микрофон включён.', 'ok');
  return state.localStream;
}

async function startCall() {
  if (!state.currentRoom) return toast('Сначала выберите комнату.', 'warn');
  if (!state._room) return toast('Сигналинг не подключён.', 'bad');

  // lk18: Guard against multiple invocations — if a call is already active,
  // ignore the click. This prevents "multiple call attempts on single click".
  if (state._callActive || state._callingPeer) {
    console.log('[startCall] already calling/active — ignoring');
    toast('Звонок уже активен. Отмените текущий звонок сначала.', 'warn');
    return;
  }

  // Disable the call button to prevent double-clicks
  const callBtn = $('#callBtn');
  if (callBtn) callBtn.disabled = true;

  // Wait for peers to be discovered
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

  const targetPeerId = peerIds[0];

  // lk16: Mark call as active BEFORE any await. This ensures onPeerStream
  // doesn't block the callee's tracks when they arrive.
  state._callActive = true;

  // lk13: Capture camera for LOCAL PREVIEW only — do NOT publish yet.
  if (!state.localStream || !hasVideoTrack(state.localStream)) {
    toast('Включение камеры…', 'info');
    await ensureLocalMedia(true, false).catch(async (e) => {
      toast(`${e.message} Пробую только микрофон.`, 'warn');
      return ensureLocalMedia(false, false);
    }).catch(() => {});
  }
  // Make sure we're not publishing (in case camera was on from a previous call)
  try { await LK.unpublishAll(); } catch (e) { console.warn('[startCall] unpublish:', e.message); }

  state._callingPeer = targetPeerId;

  // lk13: Send ring via LiveKit data channel (instant) AND via db.json (fallback).
  // lk18: Send ring via LiveKit data channel, RETRY 3 times (0s, 3s, 6s).
  // The data channel ring may be lost on mobile (unreliable). Retrying
  // increases the chance of delivery. Combined with the db.json fallback
  // below, the callee should see the incoming call within seconds.
  if (state._sendRing) {
    const ringData = { displayName: state.user.displayName || state.user.username };
    state._sendRing(ringData);
    console.log('[startCall] ring #1 sent via data channel');
    // Retry at 3s and 6s (only if still calling)
    setTimeout(() => {
      if (state._callingPeer && state._sendRing) {
        state._sendRing(ringData);
        console.log('[startCall] ring #2 sent via data channel');
      }
    }, 3000);
    setTimeout(() => {
      if (state._callingPeer && state._sendRing) {
        state._sendRing(ringData);
        console.log('[startCall] ring #3 sent via data channel');
      }
    }, 6000);
  }

  // Also write a pendingCall to db.json as fallback.
  // lk14: Resolve callee userId from _db.users directly (not from _peerInfo).
  // _peerInfo depends on the onHello message arriving before startCall,
  // which is a race condition. For a family app, the callee is simply
  // "the other user in _db.users that's not me".
  try {
    await ensureDb();
    // Try _peerInfo first (has the exact match)
    const peerInfo = state._peerInfo?.get(targetPeerId) || {};
    let calleeId = peerInfo.userId || null;
    let calleeName = peerInfo.displayName || _peerNames.get(targetPeerId) || '';

    // Fallback: look up any other user in _db.users
    if (!calleeId) {
      const otherUsers = (_db.users || []).filter((u) => u.id !== state.user.id && !u.disabled);
      if (otherUsers.length > 0) {
        calleeId = otherUsers[0].id;
        if (!calleeName) calleeName = otherUsers[0].displayName || otherUsers[0].username;
        console.log('[startCall] resolved callee from _db.users:', calleeName, calleeId);
      }
    }

    if (calleeId) {
      const callId = randomId('call_');
      const now = new Date().toISOString();
      const pendingCall = {
        id: callId,
        callerId: state.user.id,
        callerName: state.user.displayName || state.user.username,
        calleeId: calleeId,
        calleeName: calleeName || 'Гость',
        roomCode: state.currentRoom.code,
        roomId: state.currentRoom.id,
        status: 'pending',
        source: 'in-room',
        createdAt: now,
        updatedAt: now
      };
      if (!_db.pendingCalls) _db.pendingCalls = [];
      _db.pendingCalls = _db.pendingCalls.filter((c) => !(c.callerId === state.user.id && c.status === 'pending'));
      _db.pendingCalls.unshift(pendingCall);
      await saveDb(_db);
      state._pendingCallId = callId;
      console.log('[startCall] pendingCall written to db.json, callId:', callId, 'callee:', calleeName);
    } else {
      console.warn('[startCall] could not resolve callee userId even from _db.users');
    }
  } catch (e) {
    console.warn('[startCall] db.json fallback failed:', e.message);
  }

  // Show "calling..." state on the call stage
  _setCallingState(true);
  toast(`Звонок отправлен. Ожидание ответа…`, 'ok');

  // lk14: After 8s, if still calling, show a hint to the caller
  setTimeout(() => {
    if (state._callingPeer) {
      toast('Если собеседник не видит звонок — попросите его обновить страницу (Ctrl+Shift+R)', 'info');
    }
  }, 8000);

  // Auto-cancel after 60s if no answer
  if (state._callTimeout) clearTimeout(state._callTimeout);
  state._callTimeout = setTimeout(() => {
    if (state._callingPeer) {
      state._callingPeer = null;
      state._callActive = false;  // lk16
      _setCallingState(false);
      if (state.localStream) {
        state.localStream.getTracks().forEach((t) => { try { t.stop(); } catch {} });
        state.localStream = null;
      }
      attachLocalStream(null);
      updateMediaControls();
      // Mark the pendingCall as expired
      if (state._pendingCallId) {
        _markPendingCallExpired(state._pendingCallId);
        state._pendingCallId = null;
      }
      toast('Нет ответа. Звонок отменён.', 'warn');
    }
  }, 60000);
}

// Helper: mark a pendingCall as expired in db.json
async function _markPendingCallExpired(callId) {
  try {
    await ensureDb();
    const call = (_db.pendingCalls || []).find((c) => c.id === callId);
    if (call && call.status === 'pending') {
      call.status = 'expired';
      call.updatedAt = new Date().toISOString();
      await saveDb(_db);
    }
  } catch (e) { console.warn('_markPendingCallExpired:', e.message); }
}

// Helper: mark a pendingCall as accepted in db.json
async function _markPendingCallAccepted(callId) {
  try {
    await ensureDb();
    const call = (_db.pendingCalls || []).find((c) => c.id === callId);
    if (call && call.status === 'pending') {
      call.status = 'accepted';
      call.updatedAt = new Date().toISOString();
      await saveDb(_db);
    }
  } catch (e) { console.warn('_markPendingCallAccepted:', e.message); }
}

// Helper: mark a pendingCall as declined in db.json
async function _markPendingCallDeclined(callId) {
  try {
    await ensureDb();
    const call = (_db.pendingCalls || []).find((c) => c.id === callId);
    if (call && call.status === 'pending') {
      call.status = 'declined';
      call.updatedAt = new Date().toISOString();
      await saveDb(_db);
    }
  } catch (e) { console.warn('_markPendingCallDeclined:', e.message); }
}

// Show/hide the "calling..." overlay on the call stage
function _setCallingState(calling) {
  const subline = $('#callSubline');
  if (calling) {
    if (subline) subline.textContent = 'Звоню… ожидание ответа';
  } else {
    const room = state.currentRoom;
    if (subline && room) {
      subline.textContent = `Комната ${room.code} готова. Откройте камеры и нажмите «Позвонить».`;
    }
  }
  // lk18: Re-enable the call button when calling state ends
  const callBtn = $('#callBtn');
  if (callBtn && !calling) callBtn.disabled = false;
}

function hangup(notify = true) {
  if (notify) trysteroBroadcast({ kind: 'hangup' });
  // Stop call recording if active
  if (state._recordingCall) {
    try { stopRecording(); } catch (e) { console.warn('[hangup] stopRecording:', e.message); }
  }
  if (document.fullscreenElement) { document.exitFullscreen?.().catch(() => {}); }
  else if (document.webkitFullscreenElement) { document.webkitExitFullscreen?.(); }
  _stopStreams.clear();
  state.remoteStreams.clear();
  $('#remoteVideo').srcObject = null;
  $('#callStage')?.classList.remove('ui-hidden');
  // lk11: Unpublish tracks + stop camera on hangup (stay in room for presence)
  try { LK.unpublishAll(); } catch (e) { console.warn('[hangup] unpublish:', e.message); }
  if (state.localStream) {
    state.localStream.getTracks().forEach((t) => { try { t.stop(); } catch {} });
    state.localStream = null;
  }
  attachLocalStream(null);
  updateMediaControls();
  state._callingPeer = null;
  state._callActive = false;  // lk16: call no longer active
  if (state._callTimeout) { clearTimeout(state._callTimeout); state._callTimeout = null; }
  _setCallingState(false);
  setStatus($('#peerStatus'), 'WebRTC: нет соединения', 'warn');
  $('#pcState').textContent = 'PC: нет данных';
  $('#iceState').textContent = 'ICE: нет данных';
  updateConnectionIndicator();
  updateCallRecordButton();
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
  // No stream yet — start audio only (preview, don't publish)
  if (!state.localStream || !hasAudioTrack(state.localStream)) {
    try { await ensureLocalMedia(false, false); } catch (e) { toast(e.message, 'bad'); return; }
    state.micMuted = false;
    updateMediaControls();
    updateCallGuide();
    toast('Микрофон включён ✓ (предпросмотр)', 'ok');
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
// - If no video stream: turn camera ON (preview only — does NOT publish to remote)
// - If camera ON: turn camera OFF (disable video track, keep audio)
// - If camera OFF: turn camera ON (re-enable video track)
async function toggleCamera() {
  // No video stream yet — start camera + mic (preview only, don't publish)
  if (!state.localStream || !hasVideoTrack(state.localStream)) {
    try { await ensureLocalMedia(true, false); } catch (e) { toast(e.message, 'bad'); return; }
    state.camOff = false;
    updateMediaControls();
    updateCallGuide();
    toast('Камера включена ✓ (предпросмотр. Нажмите «Позвонить» чтобы начать звонок)', 'ok');
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
  $('#modeCallBtn')?.classList.toggle('active', mode === 'call');
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
    // If this is a call recording, show a different message (no in-mail buttons to highlight)
    if (state._recordingCall) {
      guide.innerHTML = '<div class="guide-narration done">● Идёт запись звонка. Нажмите «Стоп» на экране звонка чтобы завершить.</div>';
      return;
    }
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
  } else if (mode === 'video') {
    narration = 'Видео режим. Нажмите «Записать» ↓';
    highlightBtn = '#startRecordBtn';
  } else if (mode === 'call') {
    const hasCall = (state.remoteStreams && state.remoteStreams.size > 0);
    narration = hasCall
      ? 'Запись звонка. Будет записано удалённое видео + звук. Нажмите «Записать» ↓'
      : 'Нет активного звонка. Сначала позвоните, затем выберите этот режим.';
    highlightBtn = hasCall ? '#startRecordBtn' : '';
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

    // ----------------------------------------------------------------
    // v8: three recording modes.
    //   audio — local mic only
    //   video — local camera + mic
    //   call  — REMOTE video + audio from the active LiveKit call
    //
    // For audio/video we reuse state.localStream (cloned tracks) when
    // available so we don't trigger a second getUserMedia (which kills
    // the call's video on mobile single-tenant cameras).
    // For 'call' mode we use the remote stream from state.remoteStreams.
    // ----------------------------------------------------------------
    let stream = null;
    let reusedCallStream = false;
    let recordKind = mode; // 'audio' | 'video' | 'video' (call is recorded as video)

    if (mode === 'call') {
      // Record the remote call — combine all remote streams into one
      const remoteStreams = Array.from(state.remoteStreams.values());
      if (remoteStreams.length === 0) {
        return toast('Нет активного звонка для записи. Сначала позвоните кому-нибудь.', 'warn');
      }
      stream = new MediaStream();
      // Pick the FIRST video track (typical 1:1 call) and ALL audio tracks
      let gotVideo = false;
      for (const rs of remoteStreams) {
        for (const t of rs.getTracks()) {
          if (t.kind === 'video' && !gotVideo) {
            stream.addTrack(t.clone());
            gotVideo = true;
          } else if (t.kind === 'audio') {
            stream.addTrack(t.clone());
          }
        }
      }
      if (!stream.getTracks().length) {
        return toast('Удалённый поток пуст. Попробуйте ещё раз.', 'warn');
      }
      reusedCallStream = true;
      recordKind = gotVideo ? 'video' : 'audio';
      console.log(`[recording] call mode: ${stream.getTracks().length} tracks (video: ${gotVideo})`);
    } else if (state.localStream) {
      const hasVid = hasVideoTrack(state.localStream);
      const hasAud = hasAudioTrack(state.localStream);
      const needVid = (mode === 'video');
      if (needVid && hasVid && hasAud) {
        stream = new MediaStream();
        state.localStream.getTracks().forEach((t) => stream.addTrack(t.clone()));
        reusedCallStream = true;
        console.log('[recording] reusing call stream tracks (cloned)');
      } else if (!needVid && hasAud) {
        stream = new MediaStream([state.localStream.getAudioTracks()[0].clone()]);
        reusedCallStream = true;
        console.log('[recording] reusing call audio track (cloned)');
      }
    }

    if (!stream) {
      toast(`Запрос доступа к ${mode === 'video' ? 'камере и микрофону' : 'микрофону'}…`, 'info');
      stream = await getUserMediaCompat(mode === 'video'
        ? { video: { facingMode: 'user', width: { ideal: 1920, min: 640 }, height: { ideal: 1080, min: 480 }, frameRate: { ideal: 30 } }, audio: true }
        : { audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true }, video: false });
    }

    state.recordChunks = [];
    const mime = (recordKind === 'video')
      ? pickMime(['video/webm;codecs=vp9,opus', 'video/webm;codecs=vp8,opus', 'video/webm', 'video/mp4'])
      : pickMime(['audio/webm;codecs=opus', 'audio/webm', 'audio/ogg;codecs=opus']);
    state.recorder = new MediaRecorder(stream, mime ? { mimeType: mime } : undefined);
    state.recorder.ondataavailable = (e) => { if (e.data && e.data.size) state.recordChunks.push(e.data); };
    state.recorder.onstop = async () => {
      const blob = new Blob(state.recordChunks, { type: state.recorder.mimeType || (recordKind === 'video' ? 'video/webm' : 'audio/webm') });
      // Stop the recording stream's tracks.
      // If we reused call stream tracks, these are CLONES — stopping them
      // is safe and does NOT affect the call's video.
      stream.getTracks().forEach((t) => { try { t.stop(); } catch {} });
      const note = $('#mailNote').value.trim();
      const name = `${mode}-mail-${Date.now()}.webm`;
      toast('Сохранение в GitHub…', 'info');
      await saveMediaBlob(blob, 'mail', note, name, recordKind);
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
    if (recordKind === 'video') {
      $('#mailEmpty')?.classList.add('hidden');
      $('#recordPreview').classList.remove('hidden');
      $('#recordPreview').srcObject = stream;
      $('#recordPreview').muted = true; // avoid feedback
    } else {
      // Keep the guide visible during audio recording (it shows the "stop" narration)
      $('#mailEmpty')?.classList.remove('hidden');
    }
    updateMailGuide();
    const modeLabel = mode === 'call' ? 'звонок' : (recordKind === 'video' ? 'видео' : 'аудио');
    toast(`Запись начата (${modeLabel})${reusedCallStream ? ' (звонок активен)' : ''} ✓`, 'ok');
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
  // Clear call-recording state and UI if this was a call recording
  if (state._recordingCall) {
    state._recordingCall = false;
    _stopCallRecIndicator();
    updateCallRecordButton();
  }
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
  if (!state.user) return;
  await ensureDb();
  state.users = _db.users || [];
  renderUsers();
}
function renderUsers() {
  const box = $('#usersList');
  const isAdmin = state.user?.role === 'admin';
  if (!state.users.length) { box.className = 'list empty'; box.textContent = 'Нет пользователей.'; return; }
  box.className = 'list';
  box.innerHTML = state.users.map((u) => {
    const isSelf = (u.id === state.user.id);
    const meta = isAdmin
      ? `${escapeHtml(u.username)} · ${u.role}${u.disabled ? ' · отключён' : ''}${u.lastLoginAt ? ' · вход ' + fmtTime(u.lastLoginAt) : ''}`
      : (isSelf ? 'это вы' : 'пользователь');
    const callBtn = isSelf ? '' : `<button class="small icon-action primary call-user" data-id="${u.id}" data-tip="Позвонить" title="Позвонить" aria-label="Позвонить"><span data-icon="phone"></span></button>`;
    const adminActions = !isAdmin ? '' : `
      <div class="user-actions">
        <button class="small icon-action edit-user" data-id="${u.id}" data-tip="Имя/роль" title="Имя/роль" aria-label="Имя/роль"><span data-icon="file-lines"></span></button>
        ${!isSelf ? `<button class="small icon-action danger delete-user" data-id="${u.id}" data-tip="Удалить" title="Удалить" aria-label="Удалить"><span data-icon="trash"></span></button>` : ''}
      </div>`;
    const adminPassRow = !isAdmin ? '' : `
      <div class="user-password-row">
        <input class="user-pass-input" data-id="${u.id}" type="password" placeholder="Новый пароль для ${escapeHtml(u.username)}" autocomplete="new-password" />
        <button class="small icon-action primary change-pass" data-id="${u.id}" data-tip="Сменить пароль" title="Сменить пароль" aria-label="Сменить пароль"><span data-icon="key"></span></button>
      </div>`;
    return `
    <div class="user-item" data-id="${u.id}">
      <div class="user-row">
        <div>
          <strong>${escapeHtml(u.displayName || u.username)}${isSelf ? ' (вы)' : ''}</strong>
          <div class="meta">${meta}</div>
        </div>
        ${callBtn}
      </div>
      ${adminPassRow}
      ${adminActions}
    </div>`;
  }).join('');
  renderIcons(box);
  box.querySelectorAll('.call-user').forEach((b) => b.onclick = () => callUser(b.dataset.id));
  if (isAdmin) {
    box.querySelectorAll('.change-pass').forEach((b) => b.onclick = () => changeUserPassword(b.dataset.id));
    box.querySelectorAll('.edit-user').forEach((b) => b.onclick = () => editUser(b.dataset.id));
    box.querySelectorAll('.delete-user').forEach((b) => b.onclick = () => deleteUser(b.dataset.id));
  }
  // Update the card title based on role
  const cardTitle = $('#usersCardTitle');
  const heading = $('#peopleHeading');
  if (cardTitle) cardTitle.textContent = isAdmin ? 'Пользователи' : 'Контакты';
  if (heading) heading.textContent = isAdmin ? 'Админ' : 'Контакты';
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
    users: [], rooms: [], messages: [], media: [], events: [], pendingCalls: []
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

/* ============================================================
 * Cross-room calls (v7) — call any logged-in user via db.json
 *
 * Flow:
 *   1. Caller clicks "Позвонить" next to a user in the People tab.
 *   2. Caller creates a private room (code = CALL_<random>),
 *      joins it (LiveKit), and writes a pendingCall record to db.json.
 *   3. All clients poll db.json every 10s. When the callee's client
 *      sees a pendingCall addressed to them with status 'pending',
 *      it shows an incoming-call dialog.
 *   4. Callee accepts  → joins the same room, updates status to 'accepted'.
 *      Callee declines → updates status to 'declined'.
 *   5. Caller's client sees the status change:
 *      'accepted' → close waiting dialog, stay in room (call active).
 *      'declined' → close waiting dialog, leave room, toast.
 *   6. Stale pendingCalls (older than 5 minutes) are auto-cleaned.
 * ============================================================ */

const PENDING_CALL_TTL_MS = 5 * 60 * 1000; // 5 minutes

function _genCallCode() {
  // 6-char base32 code, prefixed to avoid collision with regular room codes
  const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  let s = '';
  for (let i = 0; i < 6; i++) s += alphabet[Math.floor(Math.random() * alphabet.length)];
  return `CALL_${s}`;
}

async function callUser(targetUserId) {
  if (!state.user) return;
  if (targetUserId === state.user.id) return toast('Нельзя позвонить себе.', 'warn');
  await ensureDb();

  const target = (_db.users || []).find((u) => u.id === targetUserId);
  if (!target) return toast('Пользователь не найден.', 'bad');
  if (target.disabled) return toast('Пользователь отключён.', 'warn');

  // Don't allow a second outgoing call while one is pending
  if ((_db.pendingCalls || []).some((c) => c.callerId === state.user.id && c.status === 'pending')) {
    return toast('У вас уже есть активный звонок. Сначала отмените его.', 'warn');
  }

  const code = _genCallCode();
  const callId = randomId('call_');
  const now = new Date().toISOString();

  // Create the private room locally + join it via LiveKit
  const room = {
    id: randomId('room_'),
    code,
    title: `Звонок: ${state.user.displayName || state.user.username} → ${target.displayName || target.username}`,
    ownerId: state.user.id,
    guestUserIds: [target.id],
    active: true,
    inviteToken: randomToken(),
    isPublic: false, // private — only show to caller + callee
    createdAt: now,
    updatedAt: now,
    lastJoinAt: now,
    kind: 'direct'
  };
  _db.rooms.unshift(room);
  if (!state.rooms.some((r) => r.id === room.id)) state.rooms.unshift(room);

  // Write pendingCall record so the callee sees the incoming call
  const pendingCall = {
    id: callId,
    callerId: state.user.id,
    callerName: state.user.displayName || state.user.username,
    calleeId: target.id,
    calleeName: target.displayName || target.username,
    roomCode: code,
    roomId: room.id,
    status: 'pending',
    createdAt: now,
    updatedAt: now
  };
  if (!_db.pendingCalls) _db.pendingCalls = [];
  _db.pendingCalls.unshift(pendingCall);
  await saveDb(_db);

  // Switch to calls tab + join the room
  tab('calls');
  await selectRoom(room.id, room.inviteToken);
  // Auto-enable camera + mic for the call
  try { await ensureLocalMedia(true); } catch (e) { console.warn('[callUser] camera init failed:', e.message); }

  // Show "calling…" waiting dialog
  _showOutgoingCallDialog(pendingCall);
  toast(`Звоню: ${target.displayName || target.username}…`, 'info');
  _playSound(800, 300, 'ring');
}

function _showOutgoingCallDialog(call) {
  _closeOutgoingCallDialog();
  const dialog = document.createElement('div');
  dialog.id = 'outgoingCallDialog';
  dialog.style.cssText = 'position:fixed;top:50%;left:50%;transform:translate(-50%,-50%);background:rgba(17,24,39,0.98);backdrop-filter:blur(40px);border:1px solid var(--glass-border-strong);border-radius:24px;padding:28px;text-align:center;z-index:300;box-shadow:var(--shadow-lg);min-width:280px';
  dialog.innerHTML = `
    <div style="width:64px;height:64px;border-radius:50%;margin:0 auto 16px;display:grid;place-items:center;font-size:24px;font-weight:800;background:var(--accent-grad);color:white;animation:avatarFloat 2s ease-in-out infinite">📞</div>
    <div style="font-size:18px;font-weight:700;margin-bottom:4px">Звоню…</div>
    <div style="font-size:14px;color:var(--text-muted);margin-bottom:20px">${escapeHtml(call.calleeName)}</div>
    <div id="outgoingCallTimer" style="font-size:13px;color:var(--text-muted);margin-bottom:16px;font-variant-numeric:tabular-nums">00:00</div>
    <button id="cancelOutgoingCallBtn" style="min-height:48px;padding:0 24px;border-radius:14px;background:var(--danger-grad);color:white;border:none;font-weight:700;cursor:pointer">Отменить</button>`;
  document.body.appendChild(dialog);
  document.getElementById('cancelOutgoingCallBtn').onclick = () => cancelPendingCall(call.id);
  // Timer
  const startedAt = Date.now();
  dialog._timer = setInterval(() => {
    const el = document.getElementById('outgoingCallTimer');
    if (!el) return;
    const s = Math.floor((Date.now() - startedAt) / 1000);
    el.textContent = `${String(Math.floor(s / 60)).padStart(2, '0')}:${String(s % 60).padStart(2, '0')}`;
  }, 500);
  // Auto-cancel after 60s of no answer
  dialog._timeout = setTimeout(() => {
    if (document.getElementById('outgoingCallDialog')) cancelPendingCall(call.id, 'no answer');
  }, 60000);
}

function _closeOutgoingCallDialog() {
  const d = document.getElementById('outgoingCallDialog');
  if (d) {
    if (d._timer) clearInterval(d._timer);
    if (d._timeout) clearTimeout(d._timeout);
    d.remove();
  }
}

async function cancelPendingCall(callId, reason = 'cancelled') {
  await ensureDb();
  const call = (_db.pendingCalls || []).find((c) => c.id === callId);
  if (!call) { _closeOutgoingCallDialog(); return; }
  if (call.status !== 'pending') { _closeOutgoingCallDialog(); return; }
  call.status = 'cancelled';
  call.updatedAt = new Date().toISOString();
  await saveDb(_db);
  _closeOutgoingCallDialog();
  // Leave the room we created for this call
  if (state.currentRoom?.code === call.roomCode) {
    await leaveRoom();
  }
  toast(reason === 'no answer' ? 'Нет ответа. Звонок отменён.' : 'Звонок отменён.', 'warn');
}

async function acceptPendingCall(callId) {
  // lk16: Mark call as active BEFORE any await. This ensures onPeerStream
  // doesn't block the caller's tracks when they arrive (which can happen
  // before ensureLocalMedia completes).
  state._callActive = true;
  await ensureDb();
  const call = (_db.pendingCalls || []).find((c) => c.id === callId);
  if (!call) return;
  if (call.status !== 'pending') return;
  call.status = 'accepted';
  call.updatedAt = new Date().toISOString();
  await saveDb(_db);
  _closeIncomingCallDialog();
  _stopIncomingRing();

  // lk13: For in-room calls, we're already in the same room.
  // Just capture + publish tracks + send ringAccept via data channel.
  if (call.source === 'in-room' && state.currentRoom && state.currentRoom.code === call.roomCode) {
    console.log('[acceptPendingCall] in-room call — already in room, publishing tracks');
    // Send ringAccept via LiveKit data channel (instant, so caller publishes immediately)
    if (state._sendRingAccept) {
      // Find the caller's peerId from _peerInfo
      let callerPeerId = null;
      if (state._peerInfo) {
        for (const [pid, info] of state._peerInfo.entries()) {
          if (info.userId === call.callerId) { callerPeerId = pid; break; }
        }
      }
      state._sendRingAccept({}, callerPeerId);
      console.log('[acceptPendingCall] ringAccept sent via data channel to peer:', callerPeerId);
    }
    // Capture + publish camera
    try {
      await ensureLocalMedia(true, true);  // publish=true
      toast('Видео подключено ✓', 'ok');
    } catch (e) {
      console.warn('[acceptPendingCall] camera init failed:', e.message);
      try { await ensureLocalMedia(false, true); } catch (e2) {}
    }
    return;
  }

  // Cross-room call: need to join the caller's room
  let room = (_db.rooms || []).find((r) => r.code === call.roomCode);
  if (!room) {
    room = {
      id: call.roomId || randomId('room_'),
      code: call.roomCode,
      title: `Звонок: ${call.callerName} → ${call.calleeName}`,
      ownerId: call.callerId,
      guestUserIds: [call.calleeId],
      active: true,
      inviteToken: randomToken(),
      isPublic: false,
      createdAt: call.createdAt,
      updatedAt: new Date().toISOString(),
      lastJoinAt: new Date().toISOString(),
      kind: 'direct'
    };
    _db.rooms.unshift(room);
    await saveDb(_db);
  }
  if (!state.rooms.some((r) => r.id === room.id)) state.rooms.unshift(room);
  tab('calls');
  await selectRoom(room.id, room.inviteToken);
  try { await ensureLocalMedia(true); } catch (e) { console.warn('[acceptPendingCall] camera init failed:', e.message); }
  toast(`Подключение к звонку с ${call.callerName}…`, 'info');
}

async function declinePendingCall(callId) {
  await ensureDb();
  const call = (_db.pendingCalls || []).find((c) => c.id === callId);
  if (!call) return;
  if (call.status !== 'pending') return;
  call.status = 'declined';
  call.updatedAt = new Date().toISOString();
  await saveDb(_db);
  _closeIncomingCallDialog();
  _stopIncomingRing();

  // For in-room calls, also send ringDecline via data channel (instant)
  if (call.source === 'in-room' && state._sendRingDecline) {
    let callerPeerId = null;
    if (state._peerInfo) {
      for (const [pid, info] of state._peerInfo.entries()) {
        if (info.userId === call.callerId) { callerPeerId = pid; break; }
      }
    }
    state._sendRingDecline({}, callerPeerId);
  }
  toast('Звонок отклонён.', 'warn');
}

function _closeIncomingCallDialog() {
  const d = document.getElementById('incomingCallDialog');
  if (d) d.remove();
}

// Set of call IDs we've already shown an incoming-call dialog for,
// to avoid re-prompting on every db.json poll.
const _shownIncomingCallIds = new Set();
// Call ID we're currently ringing for (sound loop)
let _incomingRingTimer = null;

function monitorPendingCalls() {
  if (!state.user) return;
  if (!_db) return;
  const calls = _db.pendingCalls || [];
  const now = Date.now();

  // Auto-clean stale calls (older than TTL) — anyone can clean
  let cleaned = false;
  for (const c of calls) {
    const age = now - new Date(c.createdAt).getTime();
    if (c.status === 'pending' && age > PENDING_CALL_TTL_MS) {
      c.status = 'expired';
      c.updatedAt = new Date().toISOString();
      cleaned = true;
    }
  }
  if (cleaned) {
    _db.pendingCalls = calls.filter((c) => c.status !== 'expired' && (now - new Date(c.createdAt).getTime() < 24 * 60 * 60 * 1000));
    saveDb(_db).catch(() => {});
  }

  // Look for incoming calls addressed to me
  const incoming = calls.find((c) => c.calleeId === state.user.id && c.status === 'pending');
  if (incoming && !_shownIncomingCallIds.has(incoming.id)) {
    _shownIncomingCallIds.add(incoming.id);
    _showIncomingCallFromDb(incoming);
  } else if (!incoming) {
    // No active incoming call — stop ringing + close dialog
    _stopIncomingRing();
    _closeIncomingCallDialog();
  }

  // Look for outgoing calls I placed — react to status changes
  // This handles BOTH in-room and cross-room calls.
  const outgoing = calls.find((c) => c.callerId === state.user.id && (c.status === 'pending' || c.status === 'accepted' || c.status === 'declined'));
  if (outgoing && outgoing.status === 'accepted') {
    // Callee accepted via db.json (or data channel accept already marked it)
    if (state._callingPeer) {
      // Still in calling state — publish tracks now
      state._callingPeer = null;
      if (state._callTimeout) { clearTimeout(state._callTimeout); state._callTimeout = null; }
      _setCallingState(false);
      if (state.localStream && state._room && state._room.publishLocalStream) {
        state._room.publishLocalStream(state.localStream).catch((e) => {
          console.warn('[monitorPendingCalls] publish failed:', e.message);
        });
      }
      toast(`${outgoing.calleeName} принял звонок ✓`, 'ok');
    }
    state._pendingCallId = null;
  } else if (outgoing && outgoing.status === 'declined') {
    if (state._callingPeer) {
      state._callingPeer = null;
      state._callActive = false;  // lk16
      if (state._callTimeout) { clearTimeout(state._callTimeout); state._callTimeout = null; }
      _setCallingState(false);
      if (state.localStream) {
        state.localStream.getTracks().forEach((t) => { try { t.stop(); } catch {} });
        state.localStream = null;
      }
      attachLocalStream(null);
      updateMediaControls();
      try { LK.unpublishAll(); } catch (e) { console.warn('[monitorPendingCalls] unpublish:', e.message); }
      toast(`${outgoing.calleeName} отклонил звонок.`, 'warn');
    }
    // For cross-room calls, leave the room we created
    if (outgoing.source !== 'in-room' && state.currentRoom?.code === outgoing.roomCode) {
      leaveRoom().catch(() => {});
    }
    state._pendingCallId = null;
  }
}

function _showIncomingCallFromDb(call) {
  _closeIncomingCallDialog();
  const dialog = document.createElement('div');
  dialog.id = 'incomingCallDialog';
  dialog.style.cssText = 'position:fixed;top:50%;left:50%;transform:translate(-50%,-50%);background:rgba(17,24,39,0.98);backdrop-filter:blur(40px);border:1px solid var(--glass-border-strong);border-radius:24px;padding:28px;text-align:center;z-index:300;box-shadow:var(--shadow-lg);min-width:280px';
  dialog.innerHTML = `
    <div style="width:64px;height:64px;border-radius:50%;margin:0 auto 16px;display:grid;place-items:center;font-size:24px;font-weight:800;background:var(--accent-grad);color:white;animation:avatarFloat 2s ease-in-out infinite">📞</div>
    <div style="font-size:18px;font-weight:700;margin-bottom:4px">Входящий звонок</div>
    <div style="font-size:14px;color:var(--text-muted);margin-bottom:20px">${escapeHtml(call.callerName)} звонит вам</div>
    <div style="display:flex;gap:10px;justify-content:center">
      <button id="declineDbCallBtn" style="min-height:48px;padding:0 24px;border-radius:14px;background:var(--danger-grad);color:white;border:none;font-weight:700;cursor:pointer">Отклонить</button>
      <button id="acceptDbCallBtn" style="min-height:48px;padding:0 24px;border-radius:14px;background:var(--success-grad);color:#021307;border:none;font-weight:700;cursor:pointer">Принять</button>
    </div>`;
  document.body.appendChild(dialog);
  document.getElementById('acceptDbCallBtn').onclick = () => acceptPendingCall(call.id);
  document.getElementById('declineDbCallBtn').onclick = () => declinePendingCall(call.id);
  // Play ring sound every 2s until answered/declined
  _startIncomingRing();
  // Auto-decline after 60s
  dialog._timeout = setTimeout(() => {
    if (document.getElementById('incomingCallDialog')) declinePendingCall(call.id);
  }, 60000);
}

function _startIncomingRing() {
  _stopIncomingRing();
  _playSound(800, 300, 'ring');
  _incomingRingTimer = setInterval(() => {
    if (!document.getElementById('incomingCallDialog')) {
      _stopIncomingRing();
      return;
    }
    _playSound(800, 300, 'ring');
  }, 2000);
}

function _stopIncomingRing() {
  if (_incomingRingTimer) { clearInterval(_incomingRingTimer); _incomingRingTimer = null; }
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
  // lk19: Video transform controls
  bindClick('#vidZoomIn', _vidZoomIn);
  bindClick('#vidZoomOut', _vidZoomOut);
  bindClick('#vidRotate', _vidRotate);
  bindClick('#vidFit', _vidFit);
  bindClick('#vidReset', _vidReset);

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
  // lk19: Click on remote video toggles UI (but only if it wasn't a drag)
  // The drag-pan handler in _setupVideoDragPan handles mousedown/touchstart.
  // A click (no movement) falls through here and toggles UI.
  $('#remoteVideo')?.addEventListener('click', (e) => {
    // If we just finished dragging, don't toggle UI
    if (e.currentTarget._lk19JustDragged) { e.currentTarget._lk19JustDragged = false; return; }
    e.stopPropagation();
    $('#callStage')?.classList.toggle('ui-hidden');
    window.scrollTo(0, 0);
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
  // Call-recording toggle — only visible during an active call (see updateCallRecordButton)
  bindClick('#recordCallBtn', toggleCallRecording);
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
  // Show version in UI + console so users can verify they're on the latest
  const vs = $('#versionStatus');
  if (vs) vs.textContent = `v: ${APP_VERSION}`;
  console.log(`[Семейная связь] version ${APP_VERSION}`);
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
  // lk18: Poll every 5s (was 10s) for faster call notification.
  // The db.json fallback ring needs to reach the callee quickly.
  GH.startPolling(5000);
  GH.onDbChange((newDb) => {
    _db = newDb;
    if (state.user) {
      try { refreshRooms(); } catch {}
      try { refreshMessages(); } catch {}
      try { refreshMail(); } catch {}
      try { refreshFiles(); } catch {}
      try { refreshUsers(); } catch {}
      try { monitorPendingCalls(); } catch (e) { console.warn('monitorPendingCalls:', e); }
    }
  });
  // Periodic health check (rate limit display)
  setInterval(checkHealth, 60000);
  // Leave Trystero room on page close
  window.addEventListener('beforeunload', () => {
    if (state._room) { try { LK.leave(); } catch {} }
  });
  window.addEventListener('pagehide', () => {
    if (state._room) { try { LK.leave(); } catch {} }
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
  // Browser notification
  if ('Notification' in window && Notification.permission === 'granted') {
    try {
      const notif = new Notification(title, {
        body, icon: icon || 'icon.svg',
        badge: 'icon.svg', tag: title,
        requireInteraction: true, silent: false
      });
      notif.onclick = () => { window.focus(); notif.close(); };
    } catch {}
  }
  // Teams webhook
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

function _requestNotifPermission() {
  if ('Notification' in window && Notification.permission === 'default') {
    Notification.requestPermission();
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
