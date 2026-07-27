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
  { urls: 'stun:global.stun.twilio.com:3478' }
];

/* ---------- IndexedDB (media storage) ---------- */
const DB_NAME = 'call-static';
const DB_VERSION = 1;
const MEDIA_STORE = 'media';
let _dbPromise = null;
function db() {
  if (_dbPromise) return _dbPromise;
  _dbPromise = new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = (e) => {
      const idb = e.target.result;
      if (!idb.objectStoreNames.contains(MEDIA_STORE)) {
        const store = idb.createObjectStore(MEDIA_STORE, { keyPath: 'id' });
        store.createIndex('by_type', 'type', { unique: false });
        store.createIndex('by_createdAt', 'createdAt', { unique: false });
      }
    };
    req.onsuccess = (e) => resolve(e.target.result);
    req.onerror = () => reject(req.error);
  });
  return _dbPromise;
}
async function idbPut(record) { const d = await db(); return new Promise((res, rej) => { const tx = d.transaction(MEDIA_STORE, 'readwrite'); tx.objectStore(MEDIA_STORE).put(record); tx.oncomplete = () => res(); tx.onerror = () => rej(tx.error); }); }
async function idbGet(id) { const d = await db(); return new Promise((res, rej) => { const tx = d.transaction(MEDIA_STORE, 'readonly'); const r = tx.objectStore(MEDIA_STORE).get(id); r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error); }); }
async function idbAll() { const d = await db(); return new Promise((res, rej) => { const tx = d.transaction(MEDIA_STORE, 'readonly'); const r = tx.objectStore(MEDIA_STORE).getAll(); r.onsuccess = () => res(r.result || []); r.onerror = () => rej(r.error); }); }
async function idbByType(type) { const d = await db(); return new Promise((res, rej) => { const tx = d.transaction(MEDIA_STORE, 'readonly'); const idx = tx.objectStore(MEDIA_STORE).index('by_type'); const r = idx.getAll(type); r.onsuccess = () => res(r.result || []); r.onerror = () => rej(r.error); }); }
async function idbDelete(id) { const d = await db(); return new Promise((res, rej) => { const tx = d.transaction(MEDIA_STORE, 'readwrite'); tx.objectStore(MEDIA_STORE).delete(id); tx.oncomplete = () => res(); tx.onerror = () => rej(tx.error); }); }
async function idbClear() { const d = await db(); return new Promise((res, rej) => { const tx = d.transaction(MEDIA_STORE, 'readwrite'); tx.objectStore(MEDIA_STORE).clear(); tx.oncomplete = () => res(); tx.onerror = () => rej(tx.error); }); }

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
 * localStorage persistence layer (DB shape mirrors the original)
 * ============================================================ */
const LS_KEY = 'call-static-db-v1';
const SESSION_KEY = 'call-static-session-v1';

function loadDb() {
  try { return JSON.parse(localStorage.getItem(LS_KEY)) || null; }
  catch { return null; }
}
function saveDb(db) {
  db.updatedAt = new Date().toISOString();
  localStorage.setItem(LS_KEY, JSON.stringify(db));
}
function ensureDb() {
  let d = loadDb();
  if (!d) {
    d = {
      version: 1,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      settings: { title: 'Семейная связь', inviteBasePath: APP_URL('/') },
      users: [],
      rooms: [],
      messages: [],
      events: []
    };
    saveDb(d);
  }
  return d;
}
async function seedDefaultUsers() {
  const d = ensureDb();
  if (!d.users.some((u) => u.username === 'admin')) {
    const salt = newSalt();
    const hash = await hashPassword('admin', salt);
    d.users.push({
      id: randomId('usr_'),
      username: 'admin',
      displayName: 'Администратор',
      role: 'admin',
      salt, hash,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      disabled: false
    });
  }
  if (!d.users.some((u) => u.username === 'guest')) {
    const salt = newSalt();
    const hash = await hashPassword('guest', salt);
    d.users.push({
      id: randomId('usr_'),
      username: 'guest',
      displayName: 'Гость семьи',
      role: 'guest',
      salt, hash,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      disabled: false
    });
  }
  saveDb(d);
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
  const d = ensureDb();
  const u = d.users.find((x) => x.username === username && !x.disabled);
  if (!u) { toast('Пользователь не найден.', 'bad'); return; }
  const ok = await verifyPassword(password, u.salt, u.hash);
  if (!ok) { toast('Неверный пароль.', 'bad'); return; }
  u.lastLoginAt = new Date().toISOString();
  saveDb(d);
  state.user = { id: u.id, username: u.username, displayName: u.displayName, role: u.role };
  setSession(state.user);
  requireLoginUi();
  toast('Вход выполнен.', 'ok');
  await refreshAll();
  connectPeer();
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
  // Verify user still exists
  const d = ensureDb();
  const u = d.users.find((x) => x.id === s.userId && !x.disabled);
  if (!u) { clearSession(); state.user = null; requireLoginUi(); return; }
  state.user = { id: u.id, username: u.username, displayName: u.displayName, role: u.role };
  requireLoginUi();
  connectPeer();
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
function tab(name) { $$('.tab').forEach((b) => b.classList.toggle('active', b.dataset.tab === name)); $$('.tab-panel').forEach((p) => p.classList.toggle('active', p.id === name)); closeDrawers(); }

/* ============================================================
 * Health check (static — always ok unless storage unavailable)
 * ============================================================ */
async function checkHealth() {
  try {
    // Verify localStorage & IndexedDB are writable
    const testKey = '__call_health_test__';
    localStorage.setItem(testKey, '1'); localStorage.removeItem(testKey);
    state.health = { ok: true, storageWritable: true, ffmpegAvailable: false, maxUploadMb: 2048 };
    setStatus($('#apiStatus'), `API: ok · storage ok · FFmpeg нет · upload ${state.health.maxUploadMb}MB`, 'ok');
    $('#uploadLimit').textContent = `до ${state.health.maxUploadMb} MB`;
  } catch (e) {
    setStatus($('#apiStatus'), `API: ошибка · ${e.message}`, 'bad');
  }
}

/* ============================================================
 * Rooms (localStorage)
 * ============================================================ */
async function refreshAll() {
  if (!state.user) return;
  await Promise.allSettled([refreshRooms(), refreshMessages(), refreshMail(), refreshFiles(), refreshUsers()]);
}
async function refreshRooms() {
  if (!state.user) return;
  const d = ensureDb();
  state.rooms = d.rooms.filter((r) => r.ownerId === state.user.id || r.guestUserIds?.includes(state.user.id) || r.isPublic);
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
  const d = ensureDb();
  // Ensure code is unique
  let code;
  for (let tries = 0; tries < 8; tries++) { code = randomCode(); if (!d.rooms.some((r) => r.code === code)) break; }
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
  d.rooms.unshift(room);
  saveDb(d);
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
  const d = ensureDb();
  let room = d.rooms.find((r) => r.code.toUpperCase() === code.toUpperCase());
  if (!room) {
    // Create a "stub" room representing one we joined via code
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
    d.rooms.unshift(room);
    saveDb(d);
  }
  if (!state.rooms.some((x) => x.id === room.id)) state.rooms.unshift(room);
  state.currentInviteToken = inviteToken || room.inviteToken;
  await selectRoom(room.id, state.currentInviteToken);
  closeDrawers();
  toast('Вы вошли в комнату.', 'ok');
}
async function deleteRoom(id) {
  if (!confirm('Удалить комнату? Активный звонок в ней закончится.')) return;
  const d = ensureDb();
  d.rooms = d.rooms.filter((r) => r.id !== id);
  saveDb(d);
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
  const d = ensureDb();
  let room = d.rooms.find((r) => r.code.toUpperCase() === code.toUpperCase());
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
    d.rooms.unshift(room);
    saveDb(d);
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

async function connectPeer() {
  if (!state.user) return;
  if (state.peer) return; // already connected at the global identity
  await waitForPeerJS().catch((e) => toast(e.message, 'bad'));
  if (typeof Peer === 'undefined') {
    setStatus($('#socketStatus'), 'Сигналинг: PeerJS не загружен', 'bad');
    return;
  }
  // Global identity (NOT joined to any specific room yet). We use a random ID
  // so multiple tabs / devices on the same account don't collide.
  try {
    const peer = new Peer({ debug: 1 });
    state.peer = peer;
    peer.on('open', (id) => {
      state.peerId = id;
      setStatus($('#socketStatus'), 'Сигналинг: подключён', 'ok');
      // If user was mid-join when peer opened, finish it now
      if (state.pendingJoin) {
        const { code, inviteToken } = state.pendingJoin;
        state.pendingJoin = null;
        joinPeerRoom({ code, inviteToken, id: state.pendingJoinId, title: state.pendingJoinTitle });
      }
    });
    peer.on('error', (err) => {
      console.warn('[peer] error', err);
      const t = err?.type || 'error';
      if (t === 'unavailable-id') {
        // ID taken — try again with a fresh random ID (host collision)
        setStatus($('#socketStatus'), 'Сигналинг: ID занят, пробую снова…', 'warn');
        if (state.peer === peer) { try { peer.destroy(); } catch {} state.peer = null; setTimeout(() => connectPeer(), 400); }
      } else if (t === 'network' || t === 'server-error' || t === 'socket-error' || t === 'socket-closed') {
        setStatus($('#socketStatus'), `Сигналинг: ошибка сети (${t})`, 'bad');
      } else if (t === 'peer-unavailable') {
        // Handled at call-site
        setStatus($('#socketStatus'), `Сигналинг: удалённый пир недоступен`, 'warn');
      } else {
        setStatus($('#socketStatus'), `Сигналинг: ${err.message || t}`, 'bad');
      }
    });
    peer.on('disconnected', () => {
      setStatus($('#socketStatus'), 'Сигналинг: отключён, переподключаю…', 'warn');
      try { peer.reconnect(); } catch {}
    });
    peer.on('connection', (conn) => onDataConnectionIncoming(conn));
    peer.on('call', (call) => onMediaCallIncoming(call));
  } catch (e) {
    setStatus($('#socketStatus'), `Сигналинг: ${e.message}`, 'bad');
  }
}

function disconnectPeer() {
  if (state.peer) { try { state.peer.destroy(); } catch {} }
  state.peer = null;
  state.peerId = null;
  state.peerConnections.clear();
  state.dataConnections.clear();
  state.remoteStreams.clear();
  setStatus($('#socketStatus'), 'Сигналинг: не подключён', 'warn');
}

/* ---------- Join a room (register deterministic host ID if available) ---------- */
async function joinPeerRoom(room) {
  if (!state.peer) { state.pendingJoin = { code: room.code, inviteToken: state.currentInviteToken }; state.pendingJoinId = room.id; state.pendingJoinTitle = room.title; setStatus($('#socketStatus'), 'Сигналинг: ждём подключение для входа в комнату', 'warn'); return; }
  if (!state.peerId) { state.pendingJoin = { code: room.code, inviteToken: state.currentInviteToken }; state.pendingJoinId = room.id; state.pendingJoinTitle = room.title; return; }

  // Tear down any prior room mesh
  teardownMesh();

  const hostId = ROOM_PEER_ID(room.code);
  state.currentRoom = room;
  state.currentRoomCode = room.code;

  // Try to register as the host first. If that ID is taken, become a client
  // and connect to the existing host.
  try {
    const probe = new Peer(hostId, { debug: 1 });
    state.roomPeer = probe;
    probe.on('open', () => {
      state.isRoomHost = true;
      toast(`Вы хост комнаты ${room.code}.`, 'ok');
      renderPresence();
      // Listen for incoming connections on this host peer
      probe.on('connection', (conn) => onDataConnectionIncoming(conn));
      probe.on('call', (call) => onMediaCallIncoming(call));
    });
    let idTakenHandled = false;
    probe.on('error', (err) => {
      if (err?.type === 'unavailable-id') {
        // Host already exists — destroy probe and become a client connecting to host.
        // This is normal flow, not a real error, so we suppress the console noise.
        if (idTakenHandled) return;
        idTakenHandled = true;
        try { probe.destroy(); } catch {}
        state.roomPeer = null;
        state.isRoomHost = false;
        becomeClient(room);
      } else {
        console.warn('[roomPeer] error', err);
      }
    });
  } catch (e) {
    state.isRoomHost = false;
    becomeClient(room);
  }
}

function becomeClient(room) {
  const hostId = ROOM_PEER_ID(room.code);
  toast(`Подключаемся к хосту ${room.code}…`, 'info');
  // Open a data connection to host
  const conn = state.peer.connect(hostId, {
    reliable: true,
    metadata: {
      displayName: state.user.displayName || state.user.username,
      username: state.user.username,
      role: state.user.role,
      peerId: state.peerId
    }
  });
  conn.on('open', () => {
    state.dataConnections.set(hostId, conn);
    toast('Подключено к хосту комнаты.', 'ok');
    renderPresence();
    // Ask host for the current peer list (presence sync)
    conn.send({ kind: 'presence-request', from: state.peerId, displayName: state.user.displayName || state.user.username });
    // Re-broadcast current room state (chat history) request
    conn.send({ kind: 'messages-request', from: state.peerId });
  });
  conn.on('data', (data) => onDataMessage(data, conn));
  conn.on('close', () => {
    state.dataConnections.delete(hostId);
    toast('Хост покинул комнату.', 'warn');
    renderPresence();
    // Try to become the new host
    if (state.currentRoom) {
      setTimeout(() => {
        if (state.dataConnections.size === 0 && state.currentRoom) {
          toast('Пробую стать новым хостом…', 'info');
          joinPeerRoom(state.currentRoom);
        }
      }, 600);
    }
  });
  conn.on('error', (e) => console.warn('[conn] error', e));
}

function teardownMesh() {
  for (const call of state.peerConnections.values()) { try { call.close(); } catch {} }
  for (const conn of state.dataConnections.values()) { try { conn.close(); } catch {} }
  state.peerConnections.clear();
  state.dataConnections.clear();
  state.remoteStreams.clear();
  if (state.roomPeer) { try { state.roomPeer.destroy(); } catch {} state.roomPeer = null; }
  state.isRoomHost = false;
  $('#remoteVideo').srcObject = null;
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
    // If I'm the host, broadcast updated presence to everyone
    if (state.isRoomHost) broadcastPresence();
  });
  conn.on('data', (data) => onDataMessage(data, conn));
  conn.on('close', () => {
    state.dataConnections.delete(conn.peer);
    const call = state.peerConnections.get(conn.peer);
    if (call) { try { call.close(); } catch {} state.peerConnections.delete(conn.peer); }
    state.remoteStreams.delete(conn.peer);
    renderPresence();
    if (state.isRoomHost) broadcastPresence();
    updateRemoteVideo();
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
    case 'presence-request': {
      // Sender wants to know who's in the room
      // Reply with current peers I know about (including displayNames)
      const peers = Array.from(state.dataConnections.entries())
        .filter(([id]) => id !== data.from && id !== conn.peer)
        .map(([id, c]) => ({ peerId: id, displayName: c._displayName || c.metadata?.displayName || 'Гость' }));
      // Include myself in the response so the requester learns my name
      peers.unshift({ peerId: state.peerId, displayName: state.user?.displayName || state.user?.username });
      // If I'm the host, also include my room peer identity
      if (state.isRoomHost && state.roomPeer?.id) {
        peers.unshift({ peerId: state.roomPeer.id, displayName: state.user?.displayName || state.user?.username, isHost: true });
      }
      conn.send({ kind: 'presence-list', peers, from: state.peerId });
      // If I'm the host, also tell everyone else about this new peer
      if (state.isRoomHost) {
        for (const [pid, c] of state.dataConnections.entries()) {
          if (pid === conn.peer) continue;
          try { c.send({ kind: 'peer-announce', peerId: data.from, displayName: data.displayName }); } catch {}
        }
      }
      break;
    }
    case 'presence-list': {
      // Host told me about other peers — connect to each
      if (Array.isArray(data.peers)) {
        for (const p of data.peers) {
          const pid = typeof p === 'string' ? p : p.peerId;
          const pname = typeof p === 'string' ? null : p.displayName;
          if (!pid || pid === state.peerId || state.dataConnections.has(pid)) continue;
          // Connect to this peer
          const c = state.peer.connect(pid, { reliable: true, metadata: { displayName: state.user.displayName || state.user.username, username: state.user.username, role: state.user.role, peerId: state.peerId } });
          if (pname) c._displayName = pname;
          c.on('open', () => { state.dataConnections.set(pid, c); renderPresence(); });
          c.on('data', (d) => onDataMessage(d, c));
          c.on('close', () => { state.dataConnections.delete(pid); renderPresence(); });
          c.on('error', (e) => console.warn('[peer-connect] error', e));
        }
      }
      break;
    }
    case 'peer-announce': {
      // Host told me a new peer joined — connect to them
      if (data.peerId && data.peerId !== state.peerId && !state.dataConnections.has(data.peerId)) {
        const c = state.peer.connect(data.peerId, { reliable: true, metadata: { displayName: state.user.displayName || state.user.username, username: state.user.username, role: state.user.role, peerId: state.peerId } });
        c.on('open', () => { state.dataConnections.set(data.peerId, c); renderPresence(); });
        c.on('data', (d) => onDataMessage(d, c));
        c.on('close', () => { state.dataConnections.delete(data.peerId); renderPresence(); });
        c.on('error', (e) => console.warn('[peer-announce-connect] error', e));
      }
      break;
    }
    case 'chat-message': {
      // Incoming chat message from a peer
      const d = ensureDb();
      // Deduplicate by id
      if (d.messages.some((m) => m.id === data.message.id)) break;
      d.messages.push(data.message);
      saveDb(d);
      refreshMessages();
      // Relay to other peers (full-mesh gossip)
      gossipMessage({ kind: 'chat-message', message: data.message }, conn.peer);
      break;
    }
    case 'messages-request': {
      // Peer wants our chat history for this room
      const d = ensureDb();
      const roomMessages = d.messages.filter((m) => m.roomCode === state.currentRoom?.code);
      // Send in chunks to avoid message size limits
      try { conn.send({ kind: 'messages-history', messages: roomMessages, from: state.peerId }); } catch {}
      break;
    }
    case 'messages-history': {
      if (Array.isArray(data.messages)) {
        const d = ensureDb();
        let added = 0;
        for (const m of data.messages) {
          if (!d.messages.some((x) => x.id === m.id)) { d.messages.push(m); added++; }
        }
        if (added) { saveDb(d); refreshMessages(); }
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
function broadcastPresence() {
  if (!state.isRoomHost) return;
  const peers = Array.from(state.dataConnections.keys());
  for (const [pid, c] of state.dataConnections.entries()) {
    try { c.send({ kind: 'presence-list', peers: peers.filter((p) => p !== pid), from: state.peerId }); } catch {}
  }
  renderPresence();
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
  if (state.dataConnections.size === 0) return toast('В комнате пока нет других участников. Подождите гостя или поделитесь ссылкой.', 'warn');
  await ensureLocalMedia(true).catch(async (e) => {
    toast(`${e.message} Пробую только микрофон.`, 'warn');
    return ensureLocalMedia(false);
  });
  if (!state.localStream) return toast('Нет локального медиа.', 'bad');
  // Call every connected peer
  let initiated = 0;
  for (const pid of state.dataConnections.keys()) {
    if (state.peerConnections.has(pid)) continue;
    try {
      const call = state.peer.call(pid, state.localStream, { metadata: { displayName: state.user.displayName || state.user.username } });
      attachCallHandlers(call);
      initiated++;
    } catch (e) {
      toast(`Звонок: ${e.message}`, 'bad');
    }
  }
  toast(initiated ? `Звонок инициализирован (${initiated}).` : 'Не удалось позвонить.', initiated ? 'ok' : 'warn');
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
 * Chat (localStorage + PeerJS gossip)
 * ============================================================ */
async function refreshMessages() {
  if (!state.user) return;
  const d = ensureDb();
  const all = d.messages.filter((m) => !m.roomCode || m.roomCode === state.currentRoom?.code || !state.currentRoom);
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
  const d = ensureDb();
  d.messages.push(msg);
  saveDb(d);
  $('#chatInput').value = '';
  await refreshMessages();
  // Gossip to peers
  gossipMessage({ kind: 'chat-message', message: msg });
}
async function editMessage(id) {
  const d = ensureDb();
  const m = d.messages.find((x) => x.id === id);
  if (!m) return;
  const text = prompt('Изменить сообщение:', m.text);
  if (text === null) return;
  m.text = text;
  m.updatedAt = new Date().toISOString();
  saveDb(d);
  await refreshMessages();
}
async function deleteMessage(id) {
  if (!confirm('Удалить сообщение?')) return;
  const d = ensureDb();
  d.messages = d.messages.filter((x) => x.id !== id);
  saveDb(d);
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
 * Files / media storage in IndexedDB
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
    lastDownloadedAt: null,
    blob
  };
  await idbPut(record);
  toast('Сохранено локально.', 'ok');
}
async function uploadFiles() {
  const files = Array.from($('#fileInput').files || []);
  if (!files.length) return toast('Выберите файл.', 'warn');
  const note = $('#fileNote').value.trim();
  for (const file of files) {
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
  try { const items = await idbByType('mail'); renderMediaList($('#mailList'), items.sort((a, b) => b.createdAt.localeCompare(a.createdAt))); }
  catch (e) { toast(`Mail: ${e.message}`, 'bad'); }
}
async function refreshFiles() {
  if (!state.user) return;
  try { const items = await idbByType('file'); renderMediaList($('#filesList'), items.sort((a, b) => b.createdAt.localeCompare(a.createdAt))); }
  catch (e) { toast(`Файлы: ${e.message}`, 'bad'); }
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
  // Create object URLs for each item (cached on the record)
  box.innerHTML = items.map((m) => {
    if (!m._url) m._url = URL.createObjectURL(m.blob);
    return `
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
      ${inlinePlayer(m)}
      <div class="media-actions">
        <button class="small icon-action preview-media" data-id="${m.id}" title="Открыть" aria-label="Открыть"><span data-icon="eye"></span></button>
        <a class="button small icon-action" href="${m._url}" download="${escapeHtml(m.originalName)}" data-id="${m.id}" title="Скачать оригинал" aria-label="Скачать оригинал"><span data-icon="download"></span></a>
        <button class="small icon-action danger delete-media" data-id="${m.id}" title="Удалить" aria-label="Удалить"><span data-icon="trash"></span></button>
      </div>
    </div>`;
  }).join('');
  renderIcons(box);
  // Track downloads
  box.querySelectorAll('a[download]').forEach((a) => a.onclick = async () => {
    const rec = items.find((x) => x.id === a.dataset.id);
    if (rec) { rec.downloadCount = (rec.downloadCount || 0) + 1; rec.lastDownloadedByName = state.user?.displayName || state.user?.username; rec.lastDownloadedAt = new Date().toISOString(); await idbPut(rec); }
  });
  box.querySelectorAll('.preview-media').forEach((b) => b.onclick = () => openPreview(items.find((m) => m.id === b.dataset.id)));
  box.querySelectorAll('.delete-media').forEach((b) => b.onclick = () => deleteMedia(b.dataset.id));
}
function inlinePlayer(m) {
  if (!m._url) m._url = URL.createObjectURL(m.blob);
  if (m.kind === 'audio') return `<div class="media-player"><audio controls src="${m._url}"></audio></div>`;
  if (m.kind === 'video') return `<div class="media-player"><video controls playsinline src="${m._url}"></video></div>`;
  if (m.kind === 'image') return `<div class="media-player"><img src="${m._url}" alt="${escapeHtml(m.originalName)}" loading="lazy" style="max-width:100%;border-radius:14px"></div>`;
  if (m.kind === 'pdf') return `<div class="media-player"><iframe src="${m._url}"></iframe></div>`;
  return '';
}
async function openPreview(m) {
  if (!m) return;
  if (!m._url) m._url = URL.createObjectURL(m.blob);
  $('#previewTitle').textContent = m.originalName;
  $('#previewDownload').href = m._url;
  $('#previewDownload').setAttribute('download', m.originalName);
  const body = $('#previewBody');
  body.innerHTML = '';
  if (m.kind === 'video') body.innerHTML = `<video controls autoplay playsinline src="${m._url}"></video>`;
  else if (m.kind === 'audio') body.innerHTML = `<audio controls autoplay src="${m._url}"></audio>`;
  else if (m.kind === 'image') body.innerHTML = `<img src="${m._url}" alt="${escapeHtml(m.originalName)}" />`;
  else if (m.kind === 'pdf') body.innerHTML = `<iframe src="${m._url}"></iframe>`;
  else if (m.kind === 'text') {
    try { const txt = await m.blob.text(); body.innerHTML = `<pre>${escapeHtml(txt.slice(0, 200000))}</pre>`; }
    catch { body.textContent = 'Не удалось прочитать текст.'; }
  } else {
    body.innerHTML = `<p>Этот формат лучше скачать оригиналом.</p>`;
  }
  $('#previewDialog').showModal();
}
async function deleteMedia(id) {
  if (!confirm('Удалить запись из приложения?')) return;
  await idbDelete(id);
  await refreshMail();
  await refreshFiles();
  toast('Удалено.', 'ok');
}

/* ============================================================
 * Admin: user management (localStorage)
 * ============================================================ */
async function refreshUsers() {
  if (!state.user || state.user.role !== 'admin') return;
  const d = ensureDb();
  state.users = d.users;
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
  const d = ensureDb();
  const u = d.users.find((x) => x.id === id);
  if (!u) return;
  u.salt = newSalt();
  u.hash = await hashPassword(password, u.salt);
  u.updatedAt = new Date().toISOString();
  saveDb(d);
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
  const d = ensureDb();
  if (d.users.some((u) => u.username === username)) return toast('Логин уже занят.', 'bad');
  const salt = newSalt();
  const hash = await hashPassword(password, salt);
  d.users.push({
    id: randomId('usr_'),
    username, displayName: displayName || username, role,
    salt, hash,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    disabled: false
  });
  saveDb(d);
  $('#newUserName').value = $('#newDisplayName').value = $('#newPassword').value = '';
  await refreshUsers();
  toast('Пользователь добавлен.', 'ok');
}
async function editUser(id) {
  const d = ensureDb();
  const u = d.users.find((x) => x.id === id);
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
  saveDb(d);
  await refreshUsers();
  toast('Пользователь обновлён.', 'ok');
}
async function deleteUser(id) {
  if (!confirm('Удалить пользователя?')) return;
  const d = ensureDb();
  d.users = d.users.filter((u) => u.id !== id);
  saveDb(d);
  await refreshUsers();
  toast('Пользователь удалён.', 'ok');
}

async function resetAllData() {
  if (!confirm('Удалить ВСЕ локальные данные (пользователи, комнаты, сообщения, файлы)?')) return;
  if (!confirm('Точно? Это действие необратимо.')) return;
  localStorage.removeItem(LS_KEY);
  sessionStorage.removeItem(SESSION_KEY);
  localStorage.removeItem(SESSION_KEY + '-long');
  await idbClear();
  await seedDefaultUsers();
  state.user = null;
  state.rooms = [];
  state.currentRoom = null;
  disconnectPeer();
  resetCall();
  requireLoginUi();
  await refreshAll();
  toast('Локальные данные сброшены.', 'ok');
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
  bindClick('#addUserBtn', addUser);
  bindClick('#refreshUsersBtn', refreshUsers);
  bindClick('#resetAllBtn', resetAllData);
  bindClick('#closePreviewBtn', () => $('#previewDialog')?.close());
  $('#previewDialog')?.addEventListener('click', (e) => {
    // Close when clicking outside the content
    if (e.target === $('#previewDialog')) $('#previewDialog').close();
  });
  window.addEventListener('beforeinstallprompt', (e) => { e.preventDefault(); state.installPrompt = e; $('#installBtn')?.classList.remove('hidden'); });
  bindClick('#installBtn', async () => { if (state.installPrompt) await state.installPrompt.prompt(); });
  // Keyboard: Enter on login fields triggers login
  $('#loginUser')?.addEventListener('keydown', (e) => { if (e.key === 'Enter') $('#loginPass')?.focus(); });
  $('#loginPass')?.addEventListener('keydown', (e) => { if (e.key === 'Enter') login(); });
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
  setInterval(checkHealth, 60000);
  // Show invite hint on login screen if there's a room in URL
  const params = new URLSearchParams(location.search);
  if (params.get('room')) {
    $('#inviteLoginHint')?.classList.remove('hidden');
  }
}

init().catch((e) => toast(e.message, 'bad'));
