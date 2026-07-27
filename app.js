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
async function updateConnectionIndicator() {
  const badge = $('#connQuality');
  if (!badge) return;
  const peers = state.dataConnections?.size || 0;
  const calls = state.peerConnections?.size || 0;
  const hasPeer = !!state.peer;
  const hasRoom = !!state.currentRoom;
  // Also count known peers from db.json (more accurate)
  let dbPeerCount = 0;
  try {
    if (_db && hasRoom) {
      const room = _db.rooms.find((r) => r.code === state.currentRoom?.code);
      if (room?.peers) {
        const now = Date.now();
        dbPeerCount = room.peers.filter((p) => {
          if (p.peerId === state.peerId) return false;
          return (now - new Date(p.lastSeen || p.joinedAt).getTime()) < 90000;
        }).length;
      }
    }
  } catch {}

  if (!hasRoom) {
    badge.className = 'conn-badge idle';
    badge.innerHTML = '<span class="conn-dot"></span><span>Нет комнаты</span>';
  } else if (!hasPeer) {
    badge.className = 'conn-badge connecting';
    badge.innerHTML = '<span class="conn-dot pulse"></span><span>Подключение…</span>';
  } else if (peers === 0 && dbPeerCount === 0) {
    badge.className = 'conn-badge waiting';
    badge.innerHTML = '<span class="conn-dot pulse"></span><span>Ожидание участников…</span>';
  } else if (calls > 0) {
    badge.className = 'conn-badge live';
    badge.innerHTML = '<span class="conn-dot live"></span><span>В эфире · ' + Math.max(peers, dbPeerCount) + ' участн.</span>';
  } else {
    badge.className = 'conn-badge ready';
    badge.innerHTML = '<span class="conn-dot"></span><span>' + Math.max(peers, dbPeerCount) + ' участн. в комнате</span>';
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

/* ---------- Session ---------- */
function setSession(user) {
  const token = randomToken();
  const session = { token, userId: user.id, username: user.username, displayName: user.displayName, role: user.role, createdAt: new Date().toISOString() };
  sessionStorage.setItem(SESSION_KEY, JSON.stringify(session));
  // Also persist a 14-day login in localStorage so refreshes keep you logged in
  const longSession = { ...session, expiresAt: new Date(Date.now() + 14 * 86400 * 1000).toISOString() };
  localStorage.setItem(SESSION_KEY + '-long', JSON.stringify(longSession));
}
function getSession() {
  try {
    const s = sessionStorage.getItem(SESSION_KEY);
    if (s) return JSON.parse(s);
    const l = localStorage.getItem(SESSION_KEY + '-long');
    if (l) {
      const ls = JSON.parse(l);
      if (ls.expiresAt && new Date(ls.expiresAt) > new Date()) {
        sessionStorage.setItem(SESSION_KEY, JSON.stringify(ls));
        return ls;
      }
    }
  } catch {}
  return null;
}
function clearSession() {
  sessionStorage.removeItem(SESSION_KEY);
  localStorage.removeItem(SESSION_KEY + '-long');
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
function logout() {
  clearSession();
  state.user = null;
  disconnectPeer();
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
  // Lazy-render stats when the stats tab is opened
  if (name === 'stats') { refreshStats().catch(() => {}); }
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
    state.health = { ok: false, storageWritable: false, ffmpegAvailable: false, maxUploadMb: 100 };
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
  if (!state.rooms.length) { box.className = 'list empty'; box.textContent = 'Нет комнат.'; return; }
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
}
async function createRoom() {
  const title = $('#roomTitle').value.trim() || 'Семейный звонок';
  await ensureDb();
  let code;
  for (let tries = 0; tries < 8; tries++) { code = randomCode(); if (!_db.rooms.some((r) => r.code === code)) break; }
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
function leaveRoom() {
  hangup(false);
  disconnectPeer();
  state.currentRoom = null;
  state.currentInviteToken = null;
  $('#currentRoomTitle').textContent = 'Комната не выбрана';
  $('#currentRoomCode').textContent = '-';
  if ($('#currentRoomTitleMirror')) $('#currentRoomTitleMirror').textContent = 'Комната не выбрана';
  if ($('#currentRoomCodeMirror')) $('#currentRoomCodeMirror').textContent = '-';
  if ($('#callSubline')) $('#callSubline').textContent = 'Выберите комнату или откройте invite‑ссылку.';
  $('#inviteLink').value = '';
  $('#presenceBox').textContent = 'Участники: -';
  renderRooms();
  updateConnectionIndicator();
}
function maybeOpenRoomChooser(joinedFromInvite = false) {
  if (!state.user || joinedFromInvite) return;
  if (!state.currentRoom) {
    tab('calls');
    toast('Откройте комнаты кнопкой вверху слева.', 'info');
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
  const others = Array.from(state.dataConnections.values()).map((c) => c._displayName || c.metadata?.displayName || c.metadata?.username || 'Гость');
  const all = [me, ...others];
  $('#presenceBox').textContent = `Участники: ${all.join(', ') || '-'}`;
}

/* ============================================================
 * PeerJS — WebRTC signaling & data channel (replaces Socket.io)
 *
 * Strategy:
 *   - The room itself has a deterministic peer ID: PEER_ID_PREFIX + "room-" + code
 *   - The FIRST user to join the room registers that ID and becomes the "host"
 *   - Subsequent users register random IDs and connect to the host ID
 *   - Host relays presence: when a new peer connects, host tells all existing
 *     peers about the new peer, and tells the new peer about everyone
 *   - Each pair of peers establishes its own MediaConnection (full mesh)
 *
 * For 1-to-1 family calls, the host-join model is enough on its own.
 * ============================================================ */
/* ============================================================
 * PeerJS — GitHub-discovery architecture (v3, reliable)
 *
 * Each client:
 *   1. Creates a peer with a RANDOM ID (no host election, no deterministic IDs)
 *   2. On room join: writes {peerId, displayName, joinedAt} to db.json room.peers[]
 *   3. Polls db.json every 10s (existing poll) → discovers new peers in room.peers[]
 *   4. For each new peer: opens a data connection (full mesh)
 *   5. On leave/logout: removes own peerId from room.peers[]
 *   6. Media calls use the SAME peer → remote side always recognizes the caller
 *
 * This is more reliable than deterministic host IDs because:
 *   - No dependency on a specific PeerJS ID being available
 *   - No host election / failover complexity
 *   - Works even if peers come and go
 *   - Uses existing GitHub polling infrastructure for discovery
 * ============================================================ */
function waitForPeerJS(timeoutMs = 8000) {
  return new Promise((resolve, reject) => {
    const start = Date.now();
    (function check() {
      if (typeof Peer !== 'undefined' && typeof Peer === 'function') return resolve();
      if (Date.now() - start > timeoutMs) return reject(new Error('PeerJS library not loaded'));
      setTimeout(check, 60);
    })();
  });
}

let _peerReady = false;
async function ensurePeerJS() {
  if (_peerReady) return true;
  await waitForPeerJS().catch(() => {});
  _peerReady = (typeof Peer !== 'undefined');
  return _peerReady;
}

// Create a peer with a random ID
async function createMyPeer() {
  if (state.peer) return; // already have one
  await ensurePeerJS();
  if (!_peerReady) {
    setStatus($('#socketStatus'), 'Сигналинг: PeerJS не загружен', 'bad');
    return;
  }
  try {
    const peer = new Peer({ debug: 1, config: { iceServers: ICE_SERVERS } }); // random ID, with TURN servers for NAT traversal
    state.peer = peer;
    peer.on('open', (id) => {
      state.peerId = id;
      setStatus($('#socketStatus'), 'Сигналинг: подключён ✓', 'ok');
      updateConnectionIndicator();
      // Register self in db.json room.peers
      registerMyPeerInRoom().catch(() => {});
    });
    peer.on('connection', (conn) => onDataConnectionIncoming(conn));
    peer.on('call', (call) => onMediaCallIncoming(call));
    peer.on('error', (err) => {
      console.warn('[peer] error', err);
      const t = err?.type || 'error';
      if (t === 'peer-unavailable') {
        // Expected when a stale peer ID is in db.json — ignore
        // The discovery poll will not re-attempt this peer
      } else if (t === 'network' || t === 'server-error' || t === 'socket-error' || t === 'socket-closed') {
        setStatus($('#socketStatus'), `Сигналинг: ошибка сети (${t}), переподключение…`, 'bad');
        updateConnectionIndicator();
        setTimeout(() => { try { peer.reconnect(); } catch {} }, 2000);
      } else if (t === 'unavailable-id') {
        // Random ID collision — extremely rare, just retry
        setStatus($('#socketStatus'), 'Сигналинг: коллизия ID, повтор…', 'warn');
        try { peer.destroy(); } catch {}
        state.peer = null;
        state.peerId = null;
        setTimeout(() => createMyPeer(), 500);
      } else {
        setStatus($('#socketStatus'), `Сигналинг: ${err.message || t}`, 'bad');
        updateConnectionIndicator();
      }
    });
    peer.on('disconnected', () => {
      setStatus($('#socketStatus'), 'Сигналинг: отключён, переподключение…', 'warn');
      updateConnectionIndicator();
      try { peer.reconnect(); } catch {}
    });
  } catch (e) {
    setStatus($('#socketStatus'), `Сигналинг: ${e.message}`, 'bad');
  }
}

// Register my peer ID in the room's peer list (in db.json)
async function registerMyPeerInRoom() {
  if (!state.currentRoom || !state.peerId) return;
  await ensureDb();
  const room = _db.rooms.find((r) => r.code === state.currentRoom.code);
  if (!room) return;
  if (!room.peers) room.peers = [];
  // Remove any stale entry of mine (same peerId or same userId)
  room.peers = room.peers.filter((p) => p.peerId !== state.peerId && p.userId !== state.user.id);
  // Add my fresh entry
  room.peers.push({
    peerId: state.peerId,
    userId: state.user.id,
    displayName: state.user.displayName || state.user.username,
    username: state.user.username,
    joinedAt: new Date().toISOString(),
    lastSeen: new Date().toISOString()
  });
  await saveDb(_db);
}

// Remove my peer ID from the room's peer list
async function unregisterMyPeerFromRoom() {
  if (!state.currentRoom || !state.peerId) return;
  try {
    await ensureDb();
    const room = _db.rooms.find((r) => r.code === state.currentRoom.code);
    if (!room || !room.peers) return;
    const before = room.peers.length;
    room.peers = room.peers.filter((p) => p.peerId !== state.peerId);
    if (room.peers.length !== before) await saveDb(_db);
  } catch (e) { console.warn('unregister peer failed', e); }
}

// Update my lastSeen timestamp (called periodically)
async function touchMyPeerInRoom() {
  if (!state.currentRoom || !state.peerId) return;
  try {
    await ensureDb();
    const room = _db.rooms.find((r) => r.code === state.currentRoom.code);
    if (!room || !room.peers) return;
    const me = room.peers.find((p) => p.peerId === state.peerId);
    if (me && (Date.now() - new Date(me.lastSeen).getTime()) > 30000) {
      me.lastSeen = new Date().toISOString();
      await saveDb(_db);
    }
  } catch (e) { /* silent */ }
}

// Called when db.json poll detects changes — discover new peers in the room
async function discoverPeersFromDb() {
  if (!state.currentRoom || !state.peerId || !state.peer) return;
  // PeerJS uses .open (boolean) and .destroyed — NOT .connected
  if (state.peer.destroyed || !state.peer.open) return;
  await ensureDb();
  const room = _db.rooms.find((r) => r.code === state.currentRoom.code);
  if (!room || !room.peers) return;
  // Filter out stale peers (lastSeen > 90s ago)
  const now = Date.now();
  const livePeers = room.peers.filter((p) => {
    if (p.peerId === state.peerId) return false; // skip self
    const age = now - new Date(p.lastSeen || p.joinedAt).getTime();
    return age < 90000; // 90 seconds
  });
  // Connect to any peer we're not already connected to
  for (const p of livePeers) {
    if (state.dataConnections.has(p.peerId)) continue; // already connected
    if (state._connectingTo && state._connectingTo.has(p.peerId)) continue; // already attempting
    connectToPeer(p.peerId, p.displayName);
  }
  // Update presence with all known peers (even if not yet connected)
  renderPresenceFromDb(livePeers);
}

// Render presence using db.json peer list (more accurate than data-connections-only)
function renderPresenceFromDb(livePeers) {
  const me = state.user?.displayName || state.user?.username || 'Я';
  const others = (livePeers || []).map((p) => p.displayName || 'Гость');
  const all = [me, ...others];
  $('#presenceBox').textContent = `Участники: ${all.join(', ') || '-'}`;
  // Update connection badge if we have peers but no data connections yet
  updateConnectionIndicator();
}

// Connect to a specific peer via data connection
function connectToPeer(remotePeerId, displayName) {
  if (!state.peer || !state.peerId || !remotePeerId) return;
  if (remotePeerId === state.peerId) return;
  if (state.dataConnections.has(remotePeerId)) return;
  if (!state._connectingTo) state._connectingTo = new Set();
  if (state._connectingTo.has(remotePeerId)) return;
  state._connectingTo.add(remotePeerId);

  const conn = state.peer.connect(remotePeerId, {
    reliable: true,
    metadata: {
      displayName: state.user.displayName || state.user.username,
      username: state.user.username,
      role: state.user.role,
      peerId: state.peerId
    }
  });
  conn._displayName = displayName || 'Гость';
  let openTimeout = setTimeout(() => {
    // If connection doesn't open in 8s, give up
    state._connectingTo?.delete(remotePeerId);
    try { conn.close(); } catch {}
  }, 8000);
  conn.on('open', () => {
    clearTimeout(openTimeout);
    state._connectingTo.delete(remotePeerId);
    state.dataConnections.set(remotePeerId, conn);
    setStatus($('#socketStatus'), 'Сигналинг: подключён к комнате ✓', 'ok');
    updateConnectionIndicator();
    renderPresence();
    // Send hello so remote learns my name
    try { conn.send({ kind: 'hello', from: state.peerId, displayName: state.user?.displayName || state.user?.username, username: state.user?.username, role: state.user?.role }); } catch {}
    // Request chat history
    try { conn.send({ kind: 'messages-request', from: state.peerId }); } catch {}
  });
  conn.on('data', (data) => onDataMessage(data, conn));
  conn.on('close', () => {
    clearTimeout(openTimeout);
    state._connectingTo.delete(remotePeerId);
    state.dataConnections.delete(remotePeerId);
    const call = state.peerConnections.get(remotePeerId);
    if (call) { try { call.close(); } catch {} state.peerConnections.delete(remotePeerId); }
    state.remoteStreams.delete(remotePeerId);
    renderPresence();
    updateRemoteVideo();
    updateConnectionIndicator();
  });
  conn.on('error', (e) => {
    clearTimeout(openTimeout);
    state._connectingTo.delete(remotePeerId);
    console.warn('[peer-connect] error', e);
    // Remove from dataConnections if it was there
    state.dataConnections.delete(remotePeerId);
    renderPresence();
    updateConnectionIndicator();
  });
}

function disconnectPeer() {
  // Unregister from db.json first (best-effort)
  unregisterMyPeerFromRoom().catch(() => {});
  if (state.peer) { try { state.peer.destroy(); } catch {} }
  state.peer = null;
  state.peerId = null;
  state.peerConnections.clear();
  state.dataConnections.clear();
  state.remoteStreams.clear();
  state.isRoomHost = false;
  if (state._connectingTo) state._connectingTo.clear();
  setStatus($('#socketStatus'), 'Сигналинг: не подключён', 'warn');
  updateConnectionIndicator();
}

/* ---------- Join a room ---------- */
async function joinPeerRoom(room) {
  await ensurePeerJS();
  if (!_peerReady) {
    setStatus($('#socketStatus'), 'Сигналинг: PeerJS не загружен', 'bad');
    return;
  }
  // Tear down any existing peer + connections (but keep the same peer if already created)
  teardownMesh();
  state.currentRoom = room;
  state.currentRoomCode = room.code;
  // Create peer if not exists, then register in room
  if (!state.peer) {
    await createMyPeer();
    // Wait for peer 'open' event (state.peerId will be set)
    for (let i = 0; i < 50 && !state.peerId; i++) await new Promise((r) => setTimeout(r, 100));
  }
  await registerMyPeerInRoom();
  // Immediately try to discover existing peers
  discoverPeersFromDb();
}

function teardownMesh() {
  for (const call of state.peerConnections.values()) { try { call.close(); } catch {} }
  for (const conn of state.dataConnections.values()) { try { conn.close(); } catch {} }
  state.peerConnections.clear();
  state.dataConnections.clear();
  state.remoteStreams.clear();
  if (state._connectingTo) state._connectingTo.clear();
  // Note: we do NOT destroy state.peer here — it's reused across rooms
  $('#remoteVideo').srcObject = null;
  updateRemoteVideo();
}

/* ---------- Incoming data connections (host or peer) ---------- */
function onDataConnectionIncoming(conn) {
  // Capture the remote peer's display name from connection metadata
  const remoteName = conn.metadata?.displayName || conn.metadata?.username || 'Гость';
  conn.on('open', () => {
    state.dataConnections.set(conn.peer, conn);
    // Store display name on the connection for renderPresence
    conn._displayName = remoteName;
    // Send a hello so the other side learns my display name too
    try { conn.send({ kind: 'hello', from: state.peerId, displayName: state.user?.displayName || state.user?.username, username: state.user?.username, role: state.user?.role }); } catch {}
    renderPresence();
    updateConnectionIndicator();
  });
  conn.on('data', (data) => onDataMessage(data, conn));
  conn.on('close', () => {
    state.dataConnections.delete(conn.peer);
    const call = state.peerConnections.get(conn.peer);
    if (call) { try { call.close(); } catch {} state.peerConnections.delete(conn.peer); }
    state.remoteStreams.delete(conn.peer);
    renderPresence();
    updateRemoteVideo();
    updateConnectionIndicator();
  });
  conn.on('error', (e) => console.warn('[conn-in] error', e));
}

/* ---------- Incoming media calls ---------- */
function onMediaCallIncoming(call) {
  // Ensure we have local media to answer with
  ensureLocalMedia(true).catch(async (e) => {
    toast(`${e.message} Пробую только микрофон.`, 'warn');
    return ensureLocalMedia(false);
  }).then(() => {
    if (!state.localStream) { try { call.close(); } catch {}; return; }
    call.answer(state.localStream);
    attachCallHandlers(call);
  });
}

function attachCallHandlers(call) {
  state.peerConnections.set(call.peer, call);
  call.on('stream', (remoteStream) => {
    state.remoteStreams.set(call.peer, remoteStream);
    updateRemoteVideo();
    setStatus($('#peerStatus'), 'WebRTC: connected', 'ok');
    $('#pcState').textContent = `PC: connected (${state.remoteStreams.size})`;
    $('#iceState').textContent = `ICE: connected`;
  });
  call.on('close', () => {
    state.peerConnections.delete(call.peer);
    state.remoteStreams.delete(call.peer);
    updateRemoteVideo();
    if (state.peerConnections.size === 0) {
      setStatus($('#peerStatus'), 'WebRTC: нет соединения', 'warn');
      $('#pcState').textContent = 'PC: нет данных';
      $('#iceState').textContent = 'ICE: нет данных';
    }
  });
  call.on('error', (e) => {
    console.warn('[call] error', e);
    toast(`WebRTC: ${e.message || e.type || 'error'}`, 'bad');
  });
}

function updateRemoteVideo() {
  // Pick the first available remote stream to render in the main video element
  const streams = Array.from(state.remoteStreams.values());
  if (streams.length === 0) {
    $('#remoteVideo').srcObject = null;
    return;
  }
  // If only one peer, show them full-screen
  if (streams.length === 1) {
    $('#remoteVideo').srcObject = streams[0];
    return;
  }
  // For multi-party, mix into a single MediaStream (browsers handle multiple tracks)
  const mixed = new MediaStream();
  for (const s of streams) s.getTracks().forEach((t) => mixed.addTrack(t));
  $('#remoteVideo').srcObject = mixed;
}

/* ---------- Data channel messages ---------- */
function onDataMessage(data, conn) {
  if (!data || typeof data !== 'object') return;
  switch (data.kind) {
    case 'hello': {
      onHelloMessage(data, conn);
      break;
    }
    // presence-request / presence-list / peer-announce are no longer used —
    // peer discovery is now done via GitHub db.json polling (discoverPeersFromDb)
    case 'chat-message': {
      // Incoming chat message from a peer
      (async () => {
        await ensureDb();
        // Deduplicate by id
        if (_db.messages.some((m) => m.id === data.message.id)) return;
        _db.messages.push(data.message);
        await saveDb(_db);
        refreshMessages();
      })();
      // Relay to other peers (full-mesh gossip)
      gossipMessage({ kind: 'chat-message', message: data.message }, conn.peer);
      break;
    }
    case 'messages-request': {
      // Peer wants our chat history for this room
      (async () => {
        await ensureDb();
        const roomMessages = _db.messages.filter((m) => m.roomCode === state.currentRoom?.code);
        try { conn.send({ kind: 'messages-history', messages: roomMessages, from: state.peerId }); } catch {}
      })();
      break;
    }
    case 'messages-history': {
      if (Array.isArray(data.messages)) {
        (async () => {
          await ensureDb();
          let added = 0;
          for (const m of data.messages) {
            if (!_db.messages.some((x) => x.id === m.id)) { _db.messages.push(m); added++; }
          }
          if (added) { await saveDb(_db); refreshMessages(); }
        })();
      }
      break;
    }
    case 'hangup': {
      const call = state.peerConnections.get(conn.peer);
      if (call) { try { call.close(); } catch {} state.peerConnections.delete(conn.peer); }
      state.remoteStreams.delete(conn.peer);
      updateRemoteVideo();
      toast('Собеседник завершил звонок.');
      break;
    }
    default:
      console.debug('[data] unknown', data);
  }
}

function gossipMessage(payload, exceptPeerId = null) {
  for (const [pid, c] of state.dataConnections.entries()) {
    if (pid === exceptPeerId) continue;
    try { c.send(payload); } catch {}
  }
}

// Hello handler: peer just connected, learn their display name
function onHelloMessage(data, conn) {
  if (data.displayName) {
    conn._displayName = data.displayName;
    renderPresence();
  }
}

/* ============================================================
 * Local media & call controls
 * ============================================================ */
function updateMediaControls() {
  const hasStream = !!state.localStream;
  const hasVideo = hasVideoTrack(state.localStream);
  $('#muteBtn').disabled = !hasStream || !hasAudioTrack(state.localStream);
  $('#cameraBtn').disabled = !hasStream;
  $('#cameraBtn').innerHTML = `${icon('video')}<span>${hasVideo ? (state.camOff ? 'Включить видео' : 'Видео') : 'Добавить камеру'}</span>`;
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
    ? { video: { facingMode: 'user', width: { ideal: 960 }, height: { ideal: 540 } }, audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true } }
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
  if (!state.peer) return toast('Сигналинг не подключён.', 'bad');
  // Try to discover peers first (in case poll hasn't fired yet)
  await discoverPeersFromDb();
  if (state.dataConnections.size === 0) {
    await ensureDb();
    const room = _db.rooms.find((r) => r.code === state.currentRoom.code);
    const livePeers = (room?.peers || []).filter((p) => {
      if (p.peerId === state.peerId) return false;
      const age = Date.now() - new Date(p.lastSeen || p.joinedAt).getTime();
      return age < 90000;
    });
    if (livePeers.length === 0) {
      return toast('В комнате нет других участников. Поделитесь ссылкой-приглашением.', 'warn');
    }
    for (const p of livePeers) {
      if (!state.dataConnections.has(p.peerId)) connectToPeer(p.peerId, p.displayName);
    }
    for (let i = 0; i < 25 && state.dataConnections.size === 0; i++) {
      await new Promise((r) => setTimeout(r, 200));
    }
    if (state.dataConnections.size === 0) {
      return toast('Не удалось подключиться. Нажмите кнопку обновления в меню комнат и попробуйте снова.', 'warn');
    }
  }
  await ensureLocalMedia(true).catch(async (e) => {
    toast(`${e.message} Пробую только микрофон.`, 'warn');
    return ensureLocalMedia(false);
  });
  if (!state.localStream) return toast('Нет доступа к камере/микрофону.', 'bad');
  // Call every connected peer, with retry
  let initiated = 0;
  for (const pid of state.dataConnections.keys()) {
    if (state.peerConnections.has(pid)) continue;
    let success = false;
    for (let attempt = 0; attempt < 3 && !success; attempt++) {
      try {
        const call = state.peer.call(pid, state.localStream, { metadata: { displayName: state.user.displayName || state.user.username } });
        attachCallHandlers(call);
        success = true;
        initiated++;
      } catch (e) {
        console.warn(`[call] attempt ${attempt + 1} failed`, e);
        if (attempt < 2) await new Promise((r) => setTimeout(r, 1000));
      }
    }
    if (!success) toast(`Не удалось дозвониться до участника. Попробуйте ещё раз.`, 'bad');
  }
  if (initiated) {
    toast('Звонок отправлен. Ожидание ответа…', 'ok');
    // Check if call actually connected within 10s
    setTimeout(() => {
      if (state.peerConnections.size > 0 && state.remoteStreams.size === 0) {
        toast('Соединение не установлено. Проверьте, что оба устройства в одной комнате.', 'warn');
      }
    }, 10000);
  }
}

function hangup(notify = true) {
  if (notify) {
    gossipMessage({ kind: 'hangup', from: state.peerId });
  }
  for (const call of state.peerConnections.values()) { try { call.close(); } catch {} }
  state.peerConnections.clear();
  state.remoteStreams.clear();
  $('#remoteVideo').srcObject = null;
  setStatus($('#peerStatus'), 'WebRTC: нет соединения', 'warn');
  $('#pcState').textContent = 'PC: нет данных';
  $('#iceState').textContent = 'ICE: нет данных';
}

function resetCall() {
  hangup(false);
  if (state.localStream) state.localStream.getTracks().forEach((t) => t.stop());
  state.localStream = null;
  attachLocalStream(null);
  updateMediaControls();
}

function toggleMute() {
  if (!state.localStream) return;
  state.micMuted = !state.micMuted;
  state.localStream.getAudioTracks().forEach((t) => t.enabled = !state.micMuted);
  $('#muteBtn').textContent = state.micMuted ? 'Включить микрофон' : 'Микрофон';
}
async function toggleCamera() {
  if (!state.localStream || !hasVideoTrack(state.localStream)) {
    try { await ensureLocalMedia(true); } catch (e) { toast(e.message, 'bad'); }
    return;
  }
  state.camOff = !state.camOff;
  state.localStream.getVideoTracks().forEach((t) => t.enabled = !state.camOff);
  updateMediaControls();
}
async function checkConnection() {
  const bits = [];
  bits.push(`API ${state.health?.ok ? 'ok' : '?'}`);
  bits.push(`peer ${state.peer ? 'ok' : 'off'}`);
  bits.push(`room ${state.currentRoom ? state.currentRoom.code : 'none'}`);
  bits.push(`host ${state.isRoomHost ? 'да' : 'нет'}`);
  bits.push(`peers ${state.dataConnections.size}`);
  bits.push(`media ${state.localStream ? 'ok' : 'not started'}`);
  bits.push(`calls ${state.peerConnections.size}`);
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
  gossipMessage({ kind: 'chat-message', message: msg });
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
  const target = document.querySelector(`input[name="recordMode"][value="${CSS.escape(mode)}"]`);
  if (!target) return;
  target.checked = true;
  $$('.record-mode-btn').forEach((btn) => btn.classList.toggle('active', btn.dataset.mode === mode));
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
    const mode = document.querySelector('input[name="recordMode"]:checked').value;
    if (!window.MediaRecorder) throw new Error('Этот браузер не поддерживает MediaRecorder.');
    const stream = await getUserMediaCompat(mode === 'video'
      ? { video: { facingMode: 'user', width: { ideal: 960 }, height: { ideal: 540 } }, audio: true }
      : { audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true }, video: false });
    state.recordChunks = [];
    const mime = mode === 'video' ? pickMime(['video/webm;codecs=vp9,opus', 'video/webm', 'video/mp4']) : pickMime(['audio/webm;codecs=opus', 'audio/webm', 'audio/ogg;codecs=opus']);
    state.recorder = new MediaRecorder(stream, mime ? { mimeType: mime } : undefined);
    state.recorder.ondataavailable = (e) => { if (e.data && e.data.size) state.recordChunks.push(e.data); };
    state.recorder.onstop = async () => {
      const blob = new Blob(state.recordChunks, { type: state.recorder.mimeType || (mode === 'video' ? 'video/webm' : 'audio/webm') });
      stream.getTracks().forEach((t) => t.stop());
      const note = $('#mailNote').value.trim();
      const name = `${mode}-mail-${Date.now()}.${mode === 'video' ? 'webm' : 'webm'}`;
      await saveMediaBlob(blob, 'mail', note, name, mode);
      $('#recordPreview').classList.add('hidden');
      $('#mailNote').value = '';
      await refreshMail();
    };
    state.recorder.start(1000);
    state.recordStartedAt = Date.now();
    $('#startRecordBtn').disabled = true;
    $('#stopRecordBtn').disabled = false;
    $('#recordPreview').classList.toggle('hidden', mode !== 'video');
    if (mode === 'video') $('#recordPreview').srcObject = stream;
    startRecordTimer();
  } catch (e) { toast(`Запись: ${e.message}`, 'bad'); }
}
function stopRecording() {
  if (state.recorder && state.recorder.state !== 'inactive') state.recorder.stop();
  $('#startRecordBtn').disabled = false;
  $('#stopRecordBtn').disabled = true;
  stopRecordTimer();
}

/* ============================================================
 * Files / media storage in GitHub repo (call-data)
 *   - File blob -> files/<media_id> (base64 via Contents API)
 *   - Metadata  -> db.json media array
 * ============================================================ */
function kindForFile(file) {
  const t = (file.type || '').toLowerCase();
  const n = (file.name || '').toLowerCase();
  if (t.startsWith('video/')) return 'video';
  if (t.startsWith('audio/')) return 'audio';
  if (t.startsWith('image/')) return 'image';
  if (t === 'application/pdf' || n.endsWith('.pdf')) return 'pdf';
  if (t.startsWith('text/') || /\.(txt|md|log|csv|json|js|html|css|xml|yml|yaml)$/.test(n)) return 'text';
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
  toast(`Загрузка ${originalName}…`, 'info');
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
    if (file.size > 100 * 1024 * 1024) { toast(`${file.name}: больше 100 MB. GitHub не позволит.`, 'bad'); continue; }
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
  renderMediaList($('#mailList'), items);
}
async function refreshFiles() {
  if (!state.user) return;
  await ensureDb();
  const items = _db.media.filter((m) => m.type === 'file' && !m.deletedAt).sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  renderMediaList($('#filesList'), items);
}
function kindIcon(kind) { return { video: 'file-video', audio: 'file-audio', image: 'file-image', pdf: 'file-pdf', text: 'file-lines', other: 'file' }[kind] || 'file'; }
function downloadStats(m) {
  const count = Number(m.downloadCount || 0);
  if (!count) return 'Downloads: 0';
  const who = m.lastDownloadedByName || 'user';
  const when = m.lastDownloadedAt ? fmtTime(m.lastDownloadedAt) : '';
  return `Downloads: ${count} · last ${who}${when ? ' · ' + when : ''}`;
}
function renderMediaList(box, items) {
  if (!items.length) { box.className = 'media-list empty'; box.textContent = 'Пока пусто.'; return; }
  box.className = 'media-list';
  // Render with a placeholder for the file URL; lazily fetch on click/preview
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
      <div class="media-placeholder" data-id="${m.id}"><span class="meta">Нажмите «Открыть» для просмотра</span></div>
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
}
// Inline player is now async-loaded into the placeholder div
async function inlinePlayerInto(m, holder) {
  if (!holder) return;
  holder.innerHTML = '<span class="meta">Загрузка…</span>';
  try {
    const url = await GH.getFileUrl(m.id, m.mime);
    if (!url) { holder.innerHTML = '<span class="meta warn-text">Файл не найден.</span>'; return; }
    m._url = url;
    if (m.kind === 'audio') holder.innerHTML = `<div class="media-player"><audio controls src="${url}"></audio></div>`;
    else if (m.kind === 'video') holder.innerHTML = `<div class="media-player"><video controls playsinline src="${url}"></video></div>`;
    else if (m.kind === 'image') holder.innerHTML = `<div class="media-player"><img src="${url}" alt="${escapeHtml(m.originalName)}" loading="lazy" style="max-width:100%;border-radius:14px"></div>`;
    else if (m.kind === 'pdf') holder.innerHTML = `<div class="media-player"><iframe src="${url}"></iframe></div>`;
    else holder.innerHTML = '';
  } catch (e) { holder.innerHTML = `<span class="meta warn-text">Ошибка: ${escapeHtml(e.message)}</span>`; }
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
    if (m.kind === 'video') body.innerHTML = `<video controls autoplay playsinline src="${url}"></video>`;
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
  // Soft-delete metadata, attempt blob deletion (may fail if file already gone)
  rec.deletedAt = new Date().toISOString();
  await saveDb(_db);
  try { await GH.deleteFile(id, `delete ${rec.originalName}`); } catch (e) { console.warn('blob delete failed', e); }
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
  disconnectPeer();
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
      if (file.size > 100 * 1024 * 1024) { toast(`${file.name}: больше 100 MB.`, 'bad'); continue; }
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
  $('#callStage')?.addEventListener('click', (e) => {
    if (e.target.closest('button') || e.target.closest('.bottom-drawer') || e.target.closest('.menu-drawer')) return;
    $('#callStage')?.classList.toggle('ui-hidden');
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
  bindClick('#startVideoBtn', () => ensureLocalMedia(true).catch((e) => toast(e.message, 'bad')));
  bindClick('#startAudioBtn', () => ensureLocalMedia(false).catch((e) => toast(e.message, 'bad')));
  bindClick('#callBtn', () => startCall().catch((e) => toast(e.message, 'bad')));
  bindClick('#hangupBtn', () => hangup(true));
  bindClick('#muteBtn', toggleMute);
  bindClick('#cameraBtn', () => toggleCamera().catch((e) => toast(e.message, 'bad')));
  bindClick('#checkConnectionBtn', checkConnection);
  bindClick('#refreshPeersBtn', async () => {
    toast('Поиск участников…', 'info');
    await discoverPeersFromDb();
    await touchMyPeerInRoom();
    await updateConnectionIndicator();
    const n = state.dataConnections.size;
    toast(n ? `Подключено к ${n} участникам.` : 'Участники не найдены. Подождите или поделитесь ссылкой.', n ? 'ok' : 'warn');
  });
  bindClick('#sendChatBtn', sendMessage);
  bindClick('#refreshChatBtn', refreshMessages);
  $('#chatInput')?.addEventListener('keydown', (e) => { if (e.ctrlKey && e.key === 'Enter') sendMessage(); });
  bindClick('#startRecordBtn', startRecording);
  bindClick('#stopRecordBtn', stopRecording);
  $$('.record-mode-btn').forEach((btn) => {
    btn.addEventListener('click', () => { setRecordMode(btn.dataset.mode); showTipFor(btn); });
  });
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
  $('#loginUser')?.addEventListener('keydown', (e) => { if (e.key === 'Enter') $('#loginPass')?.focus(); });
  $('#loginPass')?.addEventListener('keydown', (e) => { if (e.key === 'Enter') login(); });

  // Drag-and-drop file upload
  setupDragAndDrop();
}

async function init() {
  renderIcons(document);
  bind();
  enforceSingleActivePanel('calls');
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
  // Start polling GitHub for db.json changes every 10s (chat / rooms / files / peer discovery)
  GH.startPolling(10000);
  GH.onDbChange((newDb) => {
    // Update local cache + re-render relevant UI
    _db = newDb;
    if (state.user) {
      try { refreshRooms(); } catch {}
      try { refreshMessages(); } catch {}
      try { refreshMail(); } catch {}
      try { refreshFiles(); } catch {}
      try { if (state.user.role === 'admin') refreshUsers(); } catch {}
      // Discover new peers in the room (GitHub-based peer discovery)
      try { discoverPeersFromDb(); } catch (e) { console.warn('discoverPeers', e); }
    }
  });
  // Periodic health check (rate limit display)
  setInterval(checkHealth, 60000);
  // Keep my peer entry fresh in db.json every 30s (so others don't filter me out as stale)
  setInterval(() => { touchMyPeerInRoom().catch(() => {}); }, 30000);
  // Unregister my peer on page close / navigate away
  window.addEventListener('beforeunload', () => {
    // Use sendBeacon-style best-effort: fire and forget
    unregisterMyPeerFromRoom().catch(() => {});
  });
  window.addEventListener('pagehide', () => {
    unregisterMyPeerFromRoom().catch(() => {});
  });
  // Show invite hint on login screen if there's a room in URL
  const params = new URLSearchParams(location.search);
  if (params.get('room')) {
    $('#inviteLoginHint')?.classList.remove('hidden');
  }
}

init().catch((e) => toast(e.message, 'bad'));
