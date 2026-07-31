'use strict';

/* ============================================================
 * fb-signaling.js — Firebase Realtime Database signaling (v3)
 *
 * - Pending offers: offer stored but not processed until user accepts
 * - Both sides see video immediately on accept
 * - ICE keepalive: monitors connection, renegotiates on failure
 * ============================================================ */

const FB = (function () {
  const DB_URL = 'https://family-call-477c7-default-rtdb.asia-southeast1.firebasedatabase.app';
  const ICE_SERVERS = [
    { urls: 'stun:stun.l.google.com:19302' },
    { urls: 'stun:stun1.l.google.com:19302' },
    { urls: 'turn:openrelay.metered.ca:80', username: 'openrelay', credential: 'openrelay' },
    { urls: 'turn:openrelay.metered.ca:443', username: 'openrelay', credential: 'openrelay' },
    { urls: 'turn:openrelay.metered.ca:443?transport=tcp', username: 'openrelay', credential: 'openrelay' }
  ];

  let _selfId = null;
  let _roomId = null;
  let _sse = null;
  let _peers = new Map();
  let _localStream = null;
  let _displayName = 'User';
  let _onPeerJoin = null;
  let _onPeerLeave = null;
  let _onPeerStream = null;
  let _handlers = {};
  let _processedSignals = new Set();
  let _pollTimer = null;
  let _heartbeatTimer = null;
  let _cleanupTimer = null;
  let _iceCheckTimer = null;
  let _pendingOffers = new Map(); // peerId -> {offer, fromPeerId}

  function _genId() {
    return 'p_' + Math.random().toString(36).slice(2, 10) + Date.now().toString(36);
  }

  async function _fbPut(path, data) {
    try {
      const r = await fetch(`${DB_URL}${path}.json`, {
        method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(data)
      });
      return r.ok;
    } catch { return false; }
  }

  async function _fbGet(path) {
    try {
      const r = await fetch(`${DB_URL}${path}.json`);
      if (!r.ok) return null;
      return r.json();
    } catch { return null; }
  }

  async function _fbDelete(path) {
    try { await fetch(`${DB_URL}${path}.json`, { method: 'DELETE' }); return true; }
    catch { return false; }
  }

  function _createPC(remotePeerId) {
    const pc = new RTCPeerConnection({ iceServers: ICE_SERVERS });
    pc._lastIceCheck = Date.now();
    pc._iceFailCount = 0;

    if (_localStream) {
      _localStream.getTracks().forEach(t => pc.addTrack(t, _localStream));
    }

    pc.onicecandidate = async (e) => {
      if (e.candidate) {
        const key = `${Date.now()}_${Math.random().toString(36).slice(2, 6)}`;
        await _fbPut(
          `/rooms/${_roomId}/signals/${remotePeerId}/${_selfId}/candidates/${key}`,
          { type: 'candidate', candidate: JSON.stringify(e.candidate.toJSON()), from: _selfId }
        );
      }
    };

    pc.ontrack = (e) => {
      console.log('[fb] ontrack fired from', remotePeerId.slice(0, 12), 'streams=' + e.streams.length);
      if (_onPeerStream && e.streams[0]) {
        _onPeerStream(e.streams[0], remotePeerId);
      }
    };

    pc.oniceconnectionstatechange = () => {
      console.log('[fb] ICE state:', pc.iceConnectionState, 'for', remotePeerId.slice(0, 12));
      pc._lastIceCheck = Date.now();
      if (pc.iceConnectionState === 'failed') {
        pc._iceFailCount++;
        if (pc._iceFailCount <= 2) {
          console.log('[fb] ICE failed, restarting...');
          pc.restartIce();
        }
      } else if (pc.iceConnectionState === 'connected' || pc.iceConnectionState === 'completed') {
        pc._iceFailCount = 0;
      }
    };

    pc.onconnectionstatechange = () => {
      console.log('[fb] PC state:', pc.connectionState, 'for', remotePeerId.slice(0, 12));
      if (pc.connectionState === 'failed') {
        pc._iceFailCount++;
        if (pc._iceFailCount <= 2) {
          console.log('[fb] PC failed, attempting restart...');
          if (pc.signalingState === 'stable') {
            _renegotiate(remotePeerId);
          }
        }
      } else if (pc.connectionState === 'disconnected') {
        // Don't immediately close — wait for timeout
        console.log('[fb] PC disconnected, waiting...');
      }
    };

    return pc;
  }

  async function _sendSignal(toPeerId, signal) {
    if (signal.type === 'candidate') {
      const key = `${Date.now()}_${Math.random().toString(36).slice(2, 6)}`;
      await _fbPut(`/rooms/${_roomId}/signals/${toPeerId}/${_selfId}/candidates/${key}`, signal);
    } else {
      await _fbPut(`/rooms/${_roomId}/signals/${toPeerId}/${_selfId}/${signal.type}`, signal);
    }
  }

  async function _broadcastSignal(signal) {
    for (const peerId of _peers.keys()) {
      await _sendSignal(peerId, signal);
    }
  }

  // Renegotiate (send new offer)
  async function _renegotiate(peerId) {
    let peer = _peers.get(peerId);
    if (!peer || !peer.pc) return;
    if (peer.pc.signalingState !== 'stable') return;
    if (peer.makingOffer) return;
    peer.makingOffer = true;
    try {
      const offer = await peer.pc.createOffer({ offerToReceiveAudio: true, offerToReceiveVideo: true });
      await peer.pc.setLocalDescription(offer);
      await _sendSignal(peerId, { type: 'offer', sdp: JSON.stringify(offer), from: _selfId });
      console.log('[fb] renegotiate offer sent to', peerId.slice(0, 12));
    } catch (e) { console.warn('[fb] renegotiate failed', e); }
    peer.makingOffer = false;
  }

  // Process incoming offer — ANSWER it (we already have localStream set)
  async function _processOffer(fromPeerId, signalData) {
    let peer = _peers.get(fromPeerId);
    if (!peer) {
      peer = { pc: null, displayName: 'Гость', makingOffer: false };
      _peers.set(fromPeerId, peer);
    }

    const offer = JSON.parse(signalData.sdp);

    // Glare handling
    if (peer.makingOffer) {
      if (_selfId < fromPeerId) {
        console.log('[fb] glare — keeping our offer');
        await _fbDelete(`/rooms/${_roomId}/signals/${_selfId}/${fromPeerId}/offer`);
        return;
      }
    }

    if (!peer.pc) peer.pc = _createPC(fromPeerId);

    // Ensure our local tracks are on the PC
    if (_localStream) {
      const senders = peer.pc.getSenders();
      _localStream.getTracks().forEach(t => {
        const existing = senders.find(s => s.track && s.track.kind === t.kind);
        if (!existing) {
          peer.pc.addTrack(t, _localStream);
          console.log('[fb] added local track before answering');
        }
      });
    }

    console.log('[fb] processing offer from', fromPeerId.slice(0, 12));
    await peer.pc.setRemoteDescription(offer);
    const answer = await peer.pc.createAnswer();
    await peer.pc.setLocalDescription(answer);
    await _sendSignal(fromPeerId, { type: 'answer', sdp: JSON.stringify(answer), from: _selfId });
    console.log('[fb] answer sent to', fromPeerId.slice(0, 12), 'senders=' + peer.pc.getSenders().length);
    await _fbDelete(`/rooms/${_roomId}/signals/${_selfId}/${fromPeerId}/offer`);
  }

  // Process incoming signal
  async function _processSignal(fromPeerId, signalType, signalData) {
    if (!signalData) return;

    // Message-type signals
    if (signalType === 'ring' || signalType === 'ringAccept' || signalType === 'ringDecline' ||
        signalType === 'chat' || signalType === 'hello') {
      const handler = _handlers[signalType];
      if (handler) handler(signalData.data, fromPeerId);
      await _fbDelete(`/rooms/${_roomId}/signals/${_selfId}/${fromPeerId}/${signalType}`);
      return;
    }

    // Store offer as PENDING — don't process until user accepts the call
    if (signalType === 'offer') {
      console.log('[fb] offer received from', fromPeerId.slice(0, 12), '— storing as pending');
      _pendingOffers.set(fromPeerId, { signalData, fromPeerId });
      await _fbDelete(`/rooms/${_roomId}/signals/${_selfId}/${fromPeerId}/offer`);
      // Notify the app that we have a pending offer (for the ring dialog)
      const ringHandler = _handlers['ring'];
      if (ringHandler) ringHandler({ displayName: signalData.displayName || 'Участник' }, fromPeerId);
      return;
    }

    // WebRTC signals that need a PC
    let peer = _peers.get(fromPeerId);
    if (!peer) {
      peer = { pc: null, displayName: 'Гость', makingOffer: false };
      _peers.set(fromPeerId, peer);
    }

    if (signalType === 'answer') {
      if (peer.pc) {
        console.log('[fb] received answer from', fromPeerId.slice(0, 12));
        try { await peer.pc.setRemoteDescription(JSON.parse(signalData.sdp)); }
        catch(e) { console.warn('[fb] setRemoteDescription(answer) failed', e); }
      }
      await _fbDelete(`/rooms/${_roomId}/signals/${_selfId}/${fromPeerId}/answer`);
    } else if (signalType === 'hangup') {
      if (peer.pc) { try { peer.pc.close(); } catch {} }
      _peers.delete(fromPeerId);
      if (_onPeerLeave) _onPeerLeave(fromPeerId);
      await _fbDelete(`/rooms/${_roomId}/signals/${_selfId}/${fromPeerId}`);
    }
  }

  // Poll for signals
  async function _pollSignals() {
    if (!_selfId || !_roomId) return;
    const signals = await _fbGet(`/rooms/${_roomId}/signals/${_selfId}`);
    if (!signals) return;

    for (const [fromPeerId, signalTypes] of Object.entries(signals)) {
      if (fromPeerId === _selfId) continue;
      for (const [sigType, sigData] of Object.entries(signalTypes)) {
        if (sigType === 'candidates') {
          if (sigData) {
            for (const [key, candidate] of Object.entries(sigData)) {
              const sigKey = fromPeerId + ':cand:' + key;
              if (_processedSignals.has(sigKey)) continue;
              _processedSignals.add(sigKey);
              let peer = _peers.get(fromPeerId);
              if (!peer) {
                peer = { pc: null, displayName: 'Гость', makingOffer: false };
                _peers.set(fromPeerId, peer);
              }
              if (!peer.pc) peer.pc = _createPC(fromPeerId);
              try { await peer.pc.addIceCandidate(JSON.parse(candidate.candidate)); } catch {}
              await _fbDelete(`/rooms/${_roomId}/signals/${_selfId}/${fromPeerId}/candidates/${key}`);
            }
          }
        } else {
          await _processSignal(fromPeerId, sigType, sigData);
        }
      }
    }
    if (_processedSignals.size > 200) _processedSignals.clear();
  }

  // SSE for peer presence
  function _startSSE() {
    if (_sse) { _sse.close(); }
    _sse = new EventSource(`${DB_URL}/rooms/${_roomId}/peers.json`);
    _sse.addEventListener('put', async (e) => {
      const data = JSON.parse(e.data);
      const parts = data.path.split('/').filter(Boolean);
      if (parts.length === 1 && parts[0] !== _selfId) {
        const peerId = parts[0];
        if (data.data) {
          if (!_peers.has(peerId)) {
            _peers.set(peerId, { pc: null, displayName: data.data.displayName || 'Гость', makingOffer: false });
            if (_onPeerJoin) _onPeerJoin(peerId);
            await _sendSignal(peerId, { type: 'hello', data: { displayName: _displayName }, from: _selfId });
          } else {
            _peers.get(peerId).displayName = data.data.displayName || _peers.get(peerId).displayName;
          }
        } else {
          if (_peers.has(peerId)) {
            const peer = _peers.get(peerId);
            if (peer.pc) { try { peer.pc.close(); } catch {} }
            _peers.delete(peerId);
            _pendingOffers.delete(peerId);
            if (_onPeerLeave) _onPeerLeave(peerId);
          }
        }
      }
    });
    _sse.onerror = () => {};
  }

  async function _heartbeat() {
    if (!_selfId || !_roomId) return;
    await _fbPut(`/rooms/${_roomId}/peers/${_selfId}/lastSeen`, Date.now());
  }

  async function _cleanupStalePeers() {
    if (!_roomId) return;
    const peers = await _fbGet(`/rooms/${_roomId}/peers`);
    const now = Date.now();
    const livePeerIds = new Set();
    if (peers) {
      for (const [peerId, info] of Object.entries(peers)) {
        if (peerId === _selfId) { livePeerIds.add(peerId); continue; }
        const lastSeen = info.lastSeen || info.joinedAt || 0;
        if (now - lastSeen > 15000) {
          await _fbDelete(`/rooms/${_roomId}/peers/${peerId}`);
          await _fbDelete(`/rooms/${_roomId}/signals/${peerId}`);
        } else { livePeerIds.add(peerId); }
      }
    }
    for (const peerId of _peers.keys()) {
      if (!livePeerIds.has(peerId)) {
        const peer = _peers.get(peerId);
        if (peer.pc) { try { peer.pc.close(); } catch {} }
        _peers.delete(peerId);
        _pendingOffers.delete(peerId);
        if (_onPeerLeave) _onPeerLeave(peerId);
      }
    }
  }

  // ICE keepalive: check every 15s, renegotiate if failing
  function _checkIceHealth() {
    for (const [peerId, peer] of _peers) {
      if (!peer.pc) continue;
      const state = peer.pc.iceConnectionState;
      const age = Date.now() - (peer.pc._lastIceCheck || 0);
      if (state === 'failed' || (state === 'disconnected' && age > 15000)) {
        console.log('[fb] ICE unhealthy:', state, 'renegotiating', peerId.slice(0, 12));
        _renegotiate(peerId);
      }
    }
  }

  return {
    ICE_SERVERS,
    get selfId() { return _selfId; },
    getPeers: () => {
      const obj = {};
      for (const [id, p] of _peers) obj[id] = { displayName: p.displayName };
      return obj;
    },
    getPeerNames: () => {
      const m = new Map();
      for (const [id, p] of _peers) m.set(id, p.displayName);
      return m;
    },

    async joinRoom(roomId, userInfo) {
      if (_selfId) await this.leave();
      await new Promise(r => setTimeout(r, 300));
      _selfId = _genId();
      _roomId = roomId;
      _displayName = userInfo.displayName || 'User';
      _peers.clear();
      _processedSignals.clear();
      _pendingOffers.clear();

      await _fbPut(`/rooms/${_roomId}/peers/${_selfId}`, {
        displayName: _displayName, joinedAt: Date.now(), lastSeen: Date.now()
      });
      _startSSE();
      _pollTimer = setInterval(_pollSignals, 1000);
      _heartbeatTimer = setInterval(_heartbeat, 5000);
      _cleanupTimer = setInterval(_cleanupStalePeers, 10000);
      _iceCheckTimer = setInterval(_checkIceHealth, 15000);

      const existing = await _fbGet(`/rooms/${_roomId}/peers`);
      if (existing) {
        const now = Date.now();
        for (const [peerId, info] of Object.entries(existing)) {
          if (peerId === _selfId) continue;
          const lastSeen = info.lastSeen || info.joinedAt || 0;
          if (now - lastSeen > 15000) { await _fbDelete(`/rooms/${_roomId}/peers/${peerId}`); continue; }
          if (!_peers.has(peerId)) {
            _peers.set(peerId, { pc: null, displayName: info.displayName || 'Гость', makingOffer: false });
            if (_onPeerJoin) _onPeerJoin(peerId);
            await _sendSignal(peerId, { type: 'hello', data: { displayName: _displayName }, from: _selfId });
          }
        }
      }
      return _selfId;
    },

    async leave() {
      if (_pollTimer) { clearInterval(_pollTimer); _pollTimer = null; }
      if (_heartbeatTimer) { clearInterval(_heartbeatTimer); _heartbeatTimer = null; }
      if (_cleanupTimer) { clearInterval(_cleanupTimer); _cleanupTimer = null; }
      if (_iceCheckTimer) { clearInterval(_iceCheckTimer); _iceCheckTimer = null; }
      if (_sse) { _sse.close(); _sse = null; }
      for (const [id, peer] of _peers) {
        if (peer.pc) { try { peer.pc.close(); } catch {} }
      }
      const oldSelfId = _selfId;
      const oldRoomId = _roomId;
      if (oldSelfId && oldRoomId) {
        try {
          await Promise.all([
            _fbDelete(`/rooms/${oldRoomId}/peers/${oldSelfId}`),
            _fbDelete(`/rooms/${oldRoomId}/signals/${oldSelfId}`)
          ]);
        } catch {}
      }
      _peers.clear();
      _processedSignals.clear();
      _pendingOffers.clear();
      _selfId = null;
      _roomId = null;
    },

    setLocalStream(stream) {
      _localStream = stream;
    },

    // Called by app.js when user clicks "Accept" on incoming call
    // Sets local stream, then processes any pending offer
    async acceptCall(peerId) {
      console.log('[fb] acceptCall from', peerId?.slice(0, 12));
      // Ensure local stream is set
      if (!_localStream) {
        console.warn('[fb] acceptCall called but no localStream');
      }
      // Process pending offer if exists
      const pending = _pendingOffers.get(peerId);
      if (pending) {
        console.log('[fb] processing pending offer from', peerId.slice(0, 12));
        _pendingOffers.delete(peerId);
        await _processOffer(peerId, pending.signalData);
      } else {
        console.log('[fb] no pending offer, waiting for it to arrive...');
        // The offer might not have arrived yet. Wait up to 10s for it.
        for (let i = 0; i < 20; i++) {
          await new Promise(r => setTimeout(r, 500));
          const pending2 = _pendingOffers.get(peerId);
          if (pending2) {
            _pendingOffers.delete(peerId);
            await _processOffer(peerId, pending2.signalData);
            return;
          }
        }
        console.warn('[fb] no offer arrived after 10s');
      }
    },

    async startCall(peerId) {
      let peer = _peers.get(peerId);
      if (!peer) {
        peer = { pc: null, displayName: 'Гость', makingOffer: false };
        _peers.set(peerId, peer);
      }
      if (!peer.pc) peer.pc = _createPC(peerId);
      if (peer.pc.signalingState !== 'stable') return;
      peer.makingOffer = true;
      try {
        const offer = await peer.pc.createOffer({ offerToReceiveAudio: true, offerToReceiveVideo: true });
        await peer.pc.setLocalDescription(offer);
        await _sendSignal(peerId, { type: 'offer', sdp: JSON.stringify(offer), from: _selfId, displayName: _displayName });
        console.log('[fb] offer sent to', peerId.slice(0, 12));
      } catch (e) { console.warn('[fb] offer failed', e); }
      peer.makingOffer = false;
    },

    async sendStream(peerId, stream) {
      this.setLocalStream(stream);
      return this.startCall(peerId);
    },

    stopStream(peerId) {
      const peer = _peers.get(peerId);
      if (peer?.pc) { try { peer.pc.close(); } catch {} peer.pc = null; }
    },

    makeAction(name) {
      const send = (data, toPeerId) => {
        if (toPeerId) _sendSignal(toPeerId, { type: name, data, from: _selfId });
        else _broadcastSignal({ type: name, data, from: _selfId });
      };
      const onReceive = (handler) => { _handlers[name] = handler; };
      return [send, onReceive];
    },

    set onPeerJoin(fn) { _onPeerJoin = fn; },
    set onPeerLeave(fn) { _onPeerLeave = fn; },
    set onPeerStream(fn) { _onPeerStream = fn; },
  };
})();
