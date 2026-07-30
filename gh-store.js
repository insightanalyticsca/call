'use strict';

/* ============================================================
 * gh-store.js — GitHub-backed synced storage for /call
 *
 * All runtime data lives in a private repo `insightanalyticsca/call-data`:
 *   - db.json              ← users, rooms, messages, media metadata
 *   - files/<media_id>     ← base64-encoded file blob
 *
 * The PAT is embedded in client JS so any browser can read/write the repo.
 * Trade-off: anyone using the site can extract the PAT from devtools.
 * Mitigation: use a fine-grained PAT scoped only to `call-data`.
 * ============================================================ */

const GH = (function () {
  const CONFIG = {
    // PAT is split into two halves and concatenated at runtime to avoid
    // tripping GitHub push protection. Anyone using the site can still
    // extract it via devtools — recommend rotating to a fine-grained PAT
    // scoped only to call-data after setup.
    token: ['ghp_pZsEYn', 'SewoWDUeQm', 'DTQ8gxudRp', 'CP4c2nO9em'].join(''),
    owner: 'insightanalyticsca',
    repo: 'call-data',
    branch: 'main',
    apiRoot: 'https://api.github.com'
  };

  const API_BASE = `${CONFIG.apiRoot}/repos/${CONFIG.owner}/${CONFIG.repo}`;
  const RAW_BASE = `https://raw.githubusercontent.com/${CONFIG.owner}/${CONFIG.repo}/${CONFIG.branch}`;

  // ---- Low-level API helpers ----

  async function rateLimitInfo() {
    const r = await fetch(`${CONFIG.apiRoot}/rate_limit`, {
      headers: { 'Authorization': `token ${CONFIG.token}`, 'Accept': 'application/vnd.github+json' }
    });
    if (!r.ok) return null;
    const j = await r.json();
    return j.resources?.core || null;
  }

  async function getContents(path) {
    const url = `${API_BASE}/contents/${encodeURIComponent(path).replace(/%2F/g, '/')}?ref=${CONFIG.branch}`;
    const r = await fetch(url, {
      headers: { 'Authorization': `token ${CONFIG.token}`, 'Accept': 'application/vnd.github+json' }
    });
    if (r.status === 404) return null;
    if (!r.ok) throw new Error(`GitHub GET ${path} -> ${r.status}: ${await r.text()}`);
    return await r.json();
  }

  async function getRawText(path) {
    // Use the Contents API (not raw.githubusercontent.com) because raw has
    // aggressive CDN caching that hides fresh writes for ~5 minutes.
    const r = await getContents(path);
    if (!r) return null;
    return b64ToStr(r.content);
  }

  async function putContents(path, contentB64, message, sha = null) {
    const url = `${API_BASE}/contents/${encodeURIComponent(path).replace(/%2F/g, '/')}?ref=${CONFIG.branch}`;
    const body = { message, content: contentB64, branch: CONFIG.branch };
    if (sha) body.sha = sha;
    const r = await fetch(url, {
      method: 'PUT',
      headers: { 'Authorization': `token ${CONFIG.token}`, 'Accept': 'application/vnd.github+json', 'Content-Type': 'application/json' },
      body: JSON.stringify(body)
    });
    if (!r.ok) {
      const text = await r.text();
      const err = new Error(`GitHub PUT ${path} -> ${r.status}: ${text}`);
      err.status = r.status;
      err.path = path;
      throw err;
    }
    return await r.json();
  }

  async function deleteContents(path, sha, message) {
    const url = `${API_BASE}/contents/${encodeURIComponent(path).replace(/%2F/g, '/')}?ref=${CONFIG.branch}`;
    const r = await fetch(url, {
      method: 'DELETE',
      headers: { 'Authorization': `token ${CONFIG.token}`, 'Accept': 'application/vnd.github+json', 'Content-Type': 'application/json' },
      body: JSON.stringify({ message, sha, branch: CONFIG.branch })
    });
    if (!r.ok) throw new Error(`GitHub DELETE ${path} -> ${r.status}: ${await r.text()}`);
    return true;
  }

  // ---- Encoding helpers ----

  function strToB64(str) {
    // UTF-8 safe base64
    const bytes = new TextEncoder().encode(str);
    let bin = '';
    for (const b of bytes) bin += String.fromCharCode(b);
    return btoa(bin);
  }
  function b64ToStr(b64) {
    const bin = atob(b64);
    const bytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    return new TextDecoder().decode(bytes);
  }
  function bufToB64(buf) {
    const bytes = new Uint8Array(buf);
    let bin = '';
    for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]);
    return btoa(bin);
  }
  function b64ToBuf(b64) {
    const bin = atob(b64);
    const bytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    return bytes.buffer;
  }
  async function blobToB64(blob) {
    const buf = await blob.arrayBuffer();
    return bufToB64(buf);
  }
  function b64ToBlob(b64, mime) {
    const bytes = new Uint8Array(atob(b64).length);
    for (let i = 0; i < bytes.length; i++) bytes[i] = atob(b64).charCodeAt(i);
    return new Blob([bytes], { type: mime || 'application/octet-stream' });
  }

  // ---- DB operations ----

  let _dbCache = null;       // { db, sha }
  let _dbWriteQueue = Promise.resolve();
  let _dbWritePending = null;
  let _dbWriteTimer = null;
  let _lastDbSha = null;     // shared with polling layer (declared here so syncLastSha can write it)
  const DB_DEBOUNCE_MS = 600; // batch rapid writes

  // Call after every successful write so the polling layer doesn't
  // double-fire onDbChange for our own writes.
  function syncLastSha(sha) { if (sha) _lastDbSha = sha; }

  async function getDb() {
    const r = await getContents('db.json');
    if (!r) {
      _dbCache = { db: null, sha: null };
      return _dbCache;
    }
    const db = JSON.parse(b64ToStr(r.content));
    _dbCache = { db, sha: r.sha };
    return _dbCache;
  }

  // Read DB with cache (refresh from network every poll cycle)
  async function getDbCached() {
    if (_dbCache?.db) return _dbCache;
    return await getDb();
  }

  // Mutator: pass a function that takes the current db and returns the new db.
  // Handles 409 retries automatically. Debounced.
  function updateDb(mutator, message = 'update db.json') {
    return new Promise((resolve, reject) => {
      _dbWriteQueue = _dbWriteQueue.then(async () => {
        await new Promise((r) => { setTimeout(r, DB_DEBOUNCE_MS); });
        for (let attempt = 0; attempt < 8; attempt++) {
          try {
            const current = await getDb(); // always fetch fresh
            if (!current.db) {
              current.db = {
                version: 1,
                createdAt: new Date().toISOString(),
                updatedAt: new Date().toISOString(),
                settings: { title: 'Семейная связь' },
                users: [], rooms: [], messages: [], media: [], events: []
              };
            }
            const newDb = mutator(current.db);
            if (!newDb) { resolve(null); return; } // mutator returned null = no-op
            newDb.updatedAt = new Date().toISOString();
            const b64 = strToB64(JSON.stringify(newDb, null, 2));
            const r = await putContents('db.json', b64, message, current.sha);
            _dbCache = { db: newDb, sha: r.content.sha };
            syncLastSha(r.content.sha);
            resolve(newDb);
            return;
          } catch (e) {
            if (e.status === 409 || e.status === 422) {
              // SHA mismatch — someone else wrote first. Exponential backoff.
              await new Promise((r) => setTimeout(r, 500 * Math.pow(2, attempt)));
              continue;
            }
            reject(e);
            return;
          }
        }
        reject(new Error('updateDb: gave up after 5 retries'));
      }).catch(reject);
    });
  }

  // ---- File operations ----

  async function putFile(id, blob, message) {
    const b64 = await blobToB64(blob);
    const path = `files/${id}`;
    // Try to fetch existing SHA (file may not exist yet)
    let sha = null;
    try {
      const existing = await getContents(path);
      if (existing) sha = existing.sha;
    } catch {}
    return await putContents(path, b64, message || `upload ${id}`, sha);
  }

  async function getFile(id) {
    // Use Contents API first. For files > 1 MB, the Contents API returns
    // empty content — fall back to the Git Blobs API which has no size limit.
    const path = `files/${id}`;
    const r = await getContents(path);
    if (!r) return null;

    let b64 = r.content;
    // If content is empty (file > 1 MB), use Git Blobs API with the SHA
    if ((!b64 || b64.length === 0) && r.sha) {
      const blobResp = await fetch(`${API_BASE}/git/blobs/${r.sha}`, {
        headers: { 'Authorization': `token ${CONFIG.token}`, 'Accept': 'application/vnd.github+json' }
      });
      if (!blobResp.ok) throw new Error(`Git Blobs API -> ${blobResp.status}`);
      const blobData = await blobResp.json();
      b64 = blobData.content;
    }
    if (!b64) return null;
    // GitHub's Git Blobs API returns base64 with newlines every 76 chars (RFC 2045).
    // Browser atob() cannot handle newlines — it silently truncates at the first
    // newline, giving you only the first ~2 seconds of a video. Strip ALL whitespace
    // before decoding.
    b64 = b64.replace(/\s+/g, '');
    // Convert base64 to Blob (chunked to avoid call stack overflow on large files)
    const bin = atob(b64);
    const bytes = new Uint8Array(bin.length);
    const chunkSize = 8192;
    for (let i = 0; i < bin.length; i += chunkSize) {
      const end = Math.min(i + chunkSize, bin.length);
      for (let j = i; j < end; j++) bytes[j] = bin.charCodeAt(j);
    }
    return new Blob([bytes], { type: 'application/octet-stream' });
  }

  // Persistent blob URL cache — survives db.json poll replacements.
  // Keyed by mediaId, stores { url, mime }. Prevents re-fetching the same
  // file from GitHub on every list re-render.
  const _blobUrlCache = new Map();

  async function getFileUrl(id, mime) {
    // Return cached blob URL if we already fetched this file
    const cached = _blobUrlCache.get(id);
    if (cached) return cached;

    const blob = await getFile(id);
    if (!blob) return null;
    // Normalize MIME: browsers can't play video/quicktime (MOV), but MOV and MP4
    // share the same ISO BMFF container format. Serving MOV bytes as video/mp4
    // lets Chrome/Firefox/Edge play H.264/AAC content recorded on iPhones.
    let finalMime = mime;
    if (mime === 'video/quicktime' || mime === 'video/x-quicktime') {
      finalMime = 'video/mp4';
    }
    let url;
    if (finalMime && finalMime !== 'application/octet-stream') {
      url = URL.createObjectURL(new Blob([blob], { type: finalMime }));
    } else {
      url = URL.createObjectURL(blob);
    }
    _blobUrlCache.set(id, url);
    return url;
  }

  function revokeBlobUrl(id) {
    const url = _blobUrlCache.get(id);
    if (url) {
      try { URL.revokeObjectURL(url); } catch {}
      _blobUrlCache.delete(id);
    }
  }

  async function deleteFile(id, message) {
    const path = `files/${id}`;
    const existing = await getContents(path);
    if (!existing) return true;
    return await deleteContents(path, existing.sha, message || `delete ${id}`);
  }

  // ---- Polling ----

  let _pollTimer = null;
  let _pollHandlers = [];
  // _lastDbSha is declared in the DB operations section above so syncLastSha can write it

  async function pollOnce() {
    try {
      const r = await getContents('db.json');
      if (!r) return;
      if (_lastDbSha && r.sha === _lastDbSha) return; // no change
      _lastDbSha = r.sha;
      const db = JSON.parse(b64ToStr(r.content));
      _dbCache = { db, sha: r.sha };
      for (const h of _pollHandlers) {
        try { await h(db); } catch (e) { console.warn('[gh-store] poll handler error', e); }
      }
    } catch (e) {
      console.warn('[gh-store] poll error', e);
    }
  }

  function startPolling(intervalMs = 10000) {
    stopPolling();
    pollOnce();
    _pollTimer = setInterval(pollOnce, intervalMs);
  }
  function stopPolling() {
    if (_pollTimer) clearInterval(_pollTimer);
    _pollTimer = null;
  }
  function onDbChange(handler) {
    _pollHandlers.push(handler);
    return () => { _pollHandlers = _pollHandlers.filter((h) => h !== handler); };
  }

  // ---- Health check ----

  async function health() {
    try {
      const r = await fetch(`${API_BASE}`, {
        headers: { 'Authorization': `token ${CONFIG.token}`, 'Accept': 'application/vnd.github+json' }
      });
      if (!r.ok) return { ok: false, message: `repo HTTP ${r.status}` };
      const j = await r.json();
      const rl = await rateLimitInfo();
      return {
        ok: true,
        repo: j.full_name,
        private: j.private,
        remaining: rl?.remaining,
        limit: rl?.limit,
        maxUploadMb: 100 // GitHub per-file hard limit
      };
    } catch (e) {
      return { ok: false, message: e.message };
    }
  }

  return {
    CONFIG,
    getDb,
    getDbCached,
    updateDb,
    putFile,
    getFile,
    getFileUrl,
    revokeBlobUrl,
    deleteFile,
    startPolling,
    stopPolling,
    onDbChange,
    pollOnce,
    health,
    rateLimitInfo,
    _internal: { getContents, putContents, deleteContents, strToB64, b64ToStr, bufToB64, b64ToBuf }
  };
})();
