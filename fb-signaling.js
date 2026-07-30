'use strict';

/* ============================================================
 * fb-signaling.js — Firebase Realtime Database signaling (v2)
 *
 * Fixes:
 *   - Heartbeat + stale peer cleanup (no more ghost peers on reconnect)
 *   - Proper WebRTC: perfect negotiation, auto-answer, ICE trickle
 *   - Signal cleanup (delete after processing)
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
  let _peers = new Map();      // peerId -> {displayName, pc, makingOffer, ignoreOffer}
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
    try {
      await fetch(`${DB_URL}${path}.json`, { method: 'DELETE' });
      return true;
    } catch { return false; }
  }

  // Create RTCPeerConnection with perfect negotiation
  function _createPC(remotePeerId) {
    const pc = new RTCPeerConnection({ iceServers: ICE_SERVERS });

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
      if (_onPeerStream && e.streams[0]) {
        _onPeerStream(e.streams[0], remotePeerId);
      }
    };

    pc.onconnectionstatechange = () => {
      if (pc.connectionState === 'failed' || pc.connectionState === 'closed') {
        if (_onPeerLeave) _onPeerLeave(remotePeerId);
      }
    };

    return pc;
  }

  // Send a signal to a specific peer
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

  // Process incoming signal
  async function _processSignal(fromPeerId, signalType, signalData) {
    if (!signalData) return;

    // For message-type signals (ring, chat, hello, etc.), forward to handler
    if (signalType === 'ring' || signalType === 'ringAccept' || signalType === 'ringDecline' ||
        signalType === 'chat' || signalType === 'hello') {
      const handler = _handlers[signalType];
      if (handler) handler(signalData.data, fromPeerId);
      // Delete the signal after processing
      await _fbDelete(`/rooms/${_roomId}/signals/${_selfId}/${fromPeerId}/${signalType}`);
      return;
    }

    // For WebRTC signals, we need a peer connection
    let peer = _peers.get(fromPeerId);
    if (!peer) {
      peer = { pc: null, displayName: 'Гость', makingOffer: false, ignoreOffer: false };
      _peers.set(fromPeerId, peer);
    }

    if (signalType === 'offer') {
      const offer = JSON.parse(signalData.sdp);
      if (peer.makingOffer) {
        // Glare: both sides made offers. Lower peer ID wins.
        if (_selfId < fromPeerId) {
          console.log('[fb] glare — keeping our offer, ignoring theirs');
          await _fbDelete(`/rooms/${_roomId}/signals/${_selfId}/${fromPeerId}/offer`);
          return;
        }
      }
      if (!peer.pc) peer.pc = _createPC(fromPeerId);
      console.log('[fb] received offer from', fromPeerId.slice(0, 12));
      await peer.pc.setRemoteDescription(offer);
      const answer = await peer.pc.createAnswer();
      await peer.pc.setLocalDescription(answer);
      await _sendSignal(fromPeerId, { type: 'answer', sdp: JSON.stringify(answer), from: _selfId });
      console.log('[fb] answer sent to', fromPeerId.slice(0, 12));
      // Delete the offer signal
      await _fbDelete(`/rooms/${_roomId}/signals/${_selfId}/${fromPeerId}/offer`);
    } else if (signalType === 'answer') {
      if (peer.pc) {
        console.log('[fb] received answer from', fromPeerId.slice(0, 12), 'state=' + peer.pc.signalingState);
        try { await peer.pc.setRemoteDescription(JSON.parse(signalData.sdp)); } catch(e) { console.warn('[fb] setRemoteDescription failed', e); }
      }
      await _fbDelete(`/rooms/${_roomId}/signals/${_selfId}/${fromPeerId}/answer`);
    } else if (signalType === 'hangup') {
      if (peer.pc) { try { peer.pc.close(); } catch {} }
      _peers.delete(fromPeerId);
      if (_onPeerLeave) _onPeerLeave(fromPeerId);
      await _fbDelete(`/rooms/${_roomId}/signals/${_selfId}/${fromPeerId}`);
    }
  }

  // Poll for signals addressed to us
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
              const sigKey = fromPeerId + ':candidates:' + key;
              if (_processedSignals.has(sigKey)) continue;
              _processedSignals.add(sigKey);
              // Process ICE candidate
              let peer = _peers.get(fromPeerId);
              if (!peer) {
                peer = { pc: null, displayName: 'Гость', makingOffer: false, ignoreOffer: false };
                _peers.set(fromPeerId, peer);
              }
              if (!peer.pc) peer.pc = _createPC(fromPeerId);
              try { await peer.pc.addIceCandidate(JSON.parse(candidate.candidate)); } catch {}
              // Delete this candidate
              await _fbDelete(`/rooms/${_roomId}/signals/${_selfId}/${fromPeerId}/candidates/${key}`);
            }
          }
        } else {
          const sigKey = fromPeerId + ':' + sigType + ':' + Date.now();
          await _processSignal(fromPeerId, sigType, sigData);
        }
      }
    }

    // Clean up processed signals set
    if (_processedSignals.size > 200) _processedSignals.clear();
  }

  // Start SSE listener for peer presence changes
  function _startSSE() {
    if (_sse) { _sse.close(); }
    _sse = new EventSource(`${DB_URL}/rooms/${_roomId}/peers.json`);
    _sse.addEventListener('put', async (e) => {
      const data = JSON.parse(e.data);
      const path = data.path;
      const parts = path.split('/').filter(Boolean);

      if (parts.length === 1 && parts[0] !== _selfId) {
        const peerId = parts[0];
        if (data.data) {
          // Peer added or updated
          if (!_peers.has(peerId)) {
            _peers.set(peerId, { pc: null, displayName: data.data.displayName || 'Гость', makingOffer: false, ignoreOffer: false });
            if (_onPeerJoin) _onPeerJoin(peerId);
            // Send hello
            await _sendSignal(peerId, { type: 'hello', data: { displayName: _displayName }, from: _selfId });
          } else {
            // Update display name
            const peer = _peers.get(peerId);
            peer.displayName = data.data.displayName || peer.displayName;
          }
        } else {
          // Peer removed
          if (_peers.has(peerId)) {
            const peer = _peers.get(peerId);
            if (peer.pc) { try { peer.pc.close(); } catch {} }
            _peers.delete(peerId);
            if (_onPeerLeave) _onPeerLeave(peerId);
          }
        }
      }
    });
    _sse.onerror = () => { /* SSE auto-reconnects */ };
  }

  // Heartbeat: update our lastSeen every 5s
  async function _heartbeat() {
    if (!_selfId || !_roomId) return;
    await _fbPut(`/rooms/${_roomId}/peers/${_selfId}/lastSeen`, Date.now());
  }

  // Cleanup: remove stale peers (lastSeen > 15s ago)
  async function _cleanupStalePeers() {
    if (!_roomId) return;
    const peers = await _fbGet(`/rooms/${_roomId}/peers`);
    const now = Date.now();
    const livePeerIds = new Set();
    
    // Check Firebase peers
    if (peers) {
      for (const [peerId, info] of Object.entries(peers)) {
        if (peerId === _selfId) { livePeerIds.add(peerId); continue; }
        const lastSeen = info.lastSeen || info.joinedAt || 0;
        if (now - lastSeen > 15000) {
          // Stale — delete from Firebase
          await _fbDelete(`/rooms/${_roomId}/peers/${peerId}`);
          await _fbDelete(`/rooms/${_roomId}/signals/${peerId}`);
        } else {
          livePeerIds.add(peerId);
        }
      }
    }
    
    // Clean local _peers: remove any peer not in livePeerIds
    for (const peerId of _peers.keys()) {
      if (!livePeerIds.has(peerId)) {
        const peer = _peers.get(peerId);
        if (peer.pc) { try { peer.pc.close(); } catch {} }
        _peers.delete(peerId);
        if (_onPeerLeave) _onPeerLeave(peerId);
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
      // Leave any existing room first
      if (_selfId) this.leave();
      await new Promise(r => setTimeout(r, 300));

      _selfId = _genId();
      _roomId = roomId;
      _displayName = userInfo.displayName || 'User';
      _peers.clear();
      _processedSignals.clear();

      // Write our peer entry with lastSeen
      await _fbPut(`/rooms/${_roomId}/peers/${_selfId}`, {
        displayName: _displayName,
        joinedAt: Date.now(),
        lastSeen: Date.now()
      });

      // Start SSE listener for peer presence
      _startSSE();

      // Poll for signals every 1s
      _pollTimer = setInterval(_pollSignals, 1000);

      // Heartbeat every 5s
      _heartbeatTimer = setInterval(_heartbeat, 5000);

      // Cleanup stale peers every 10s
      _cleanupTimer = setInterval(_cleanupStalePeers, 10000);

      // Get existing peers and send them hello
      const existing = await _fbGet(`/rooms/${_roomId}/peers`);
      if (existing) {
        const now = Date.now();
        for (const [peerId, info] of Object.entries(existing)) {
          if (peerId === _selfId) continue;
          // Skip stale peers
          const lastSeen = info.lastSeen || info.joinedAt || 0;
          if (now - lastSeen > 15000) {
            await _fbDelete(`/rooms/${_roomId}/peers/${peerId}`);
            continue;
          }
          if (!_peers.has(peerId)) {
            _peers.set(peerId, { pc: null, displayName: info.displayName || 'Гость', makingOffer: false, ignoreOffer: false });
            if (_onPeerJoin) _onPeerJoin(peerId);
            await _sendSignal(peerId, { type: 'hello', data: { displayName: _displayName }, from: _selfId });
          }
        }
      }

      return _selfId;
    },

    leave() {
      if (_pollTimer) { clearInterval(_pollTimer); _pollTimer = null; }
      if (_heartbeatTimer) { clearInterval(_heartbeatTimer); _heartbeatTimer = null; }
      if (_cleanupTimer) { clearInterval(_cleanupTimer); _cleanupTimer = null; }
      if (_sse) { _sse.close(); _sse = null; }
      // Close all peer connections
      for (const [id, peer] of _peers) {
        if (peer.pc) { try { peer.pc.close(); } catch {} }
      }
      // Delete our presence and signals
      if (_selfId && _roomId) {
        _fbDelete(`/rooms/${_roomId}/peers/${_selfId}`).catch(() => {});
        _fbDelete(`/rooms/${_roomId}/signals/${_selfId}`).catch(() => {});
      }
      _peers.clear();
      _processedSignals.clear();
      _selfId = null;
      _roomId = null;
    },

    setLocalStream(stream) {
      _localStream = stream;
      for (const [id, peer] of _peers) {
        if (peer.pc) {
          // Remove old tracks, add new
          peer.pc.getSenders().forEach(s => {
            if (s.track) {
              // Already has tracks, replace them
            }
          });
          stream.getTracks().forEach(t => {
            const sender = peer.pc.getSenders().find(s => s.track && s.track.kind === t.kind);
            if (sender) sender.replaceTrack(t);
            else peer.pc.addTrack(t, stream);
          });
        }
      }
    },

    async startCall(peerId) {
      let peer = _peers.get(peerId);
      if (!peer) {
        peer = { pc: null, displayName: 'Гость', makingOffer: false, ignoreOffer: false };
        _peers.set(peerId, peer);
      }
      if (!peer.pc) peer.pc = _createPC(peerId);
      if (peer.pc.signalingState !== 'stable') return; // already negotiating
      peer.makingOffer = true;
      try {
        const offer = await peer.pc.createOffer({ offerToReceiveAudio: true, offerToReceiveVideo: true });
        await peer.pc.setLocalDescription(offer);
        await _sendSignal(peerId, { type: 'offer', sdp: JSON.stringify(offer), from: _selfId });
        console.log('[fb] offer sent to', peerId.slice(0, 12));
      } catch (e) {
        console.warn('[fb] offer failed', e);
      }
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
        if (toPeerId) {
          _sendSignal(toPeerId, { type: name, data, from: _selfId });
        } else {
          _broadcastSignal({ type: name, data, from: _selfId });
        }
      };
      const onReceive = (handler) => { _handlers[name] = handler; };
      return [send, onReceive];
    },

    set onPeerJoin(fn) { _onPeerJoin = fn; },
    set onPeerLeave(fn) { _onPeerLeave = fn; },
    set onPeerStream(fn) { _onPeerStream = fn; },
  };
})();
