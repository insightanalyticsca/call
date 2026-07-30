'use strict';

/* ============================================================
 * fb-signaling.js — Firebase Realtime Database signaling
 * 
 * Replaces Trystero. Uses Firebase REST API + SSE for peer discovery
 * and WebRTC RTCPeerConnection directly for media.
 * 
 * Flow:
 *   1. On room join: write our peer entry to /rooms/{roomId}/peers/{peerId}
 *   2. Listen via SSE for other peers joining/leaving
 *   3. Exchange SDP offers/answers via /rooms/{roomId}/signals/{toPeerId}
 *   4. Exchange ICE candidates via /rooms/{roomId}/signals/{toPeerId}
 *   5. On leave: delete our peer entry and signals
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
  let _peers = new Map();      // peerId -> {displayName, pc, stream, makingOffer}
  let _localStream = null;
  let _onPeerJoin = null;
  let _onPeerLeave = null;
  let _onPeerStream = null;
  let _onMessage = null;
  let _handlers = {};           // action -> {send, onReceive}
  let _polledSignals = new Set();

  function _genId() {
    return 'p_' + Math.random().toString(36).slice(2, 10) + Date.now().toString(36);
  }

  async function _fbPut(path, data) {
    const r = await fetch(`${DB_URL}${path}.json`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(data)
    });
    return r.ok;
  }

  async function _fbGet(path) {
    const r = await fetch(`${DB_URL}${path}.json`);
    if (!r.ok) return null;
    return r.json();
  }

  async function _fbDelete(path) {
    const r = await fetch(`${DB_URL}${path}.json`, { method: 'DELETE' });
    return r.ok;
  }

  // Create RTCPeerConnection for a specific peer
  function _createPC(remotePeerId) {
    const pc = new RTCPeerConnection({ iceServers: ICE_SERVERS });
    
    if (_localStream) {
      _localStream.getTracks().forEach(t => pc.addTrack(t, _localStream));
    }

    pc.onicecandidate = async (e) => {
      if (e.candidate) {
        await _fbPut(`/rooms/${_roomId}/signals/${remotePeerId}/${_selfId}/candidates/${Date.now()}`, {
          candidate: JSON.stringify(e.candidate.toJSON()),
          from: _selfId
        });
      }
    };

    pc.ontrack = (e) => {
      if (_onPeerStream) _onPeerStream(e.streams[0], remotePeerId);
    };

    pc.onconnectionstatechange = () => {
      if (pc.connectionState === 'disconnected' || pc.connectionState === 'failed') {
        if (_onPeerLeave) _onPeerLeave(remotePeerId);
      }
    };

    return pc;
  }

  // Process incoming signal
  async function _processSignal(fromPeerId, signal) {
    if (!signal || !signal.type) return;
    
    let peer = _peers.get(fromPeerId);
    if (!peer) {
      // New peer discovered via signal
      peer = { pc: null, displayName: 'Гость', makingOffer: false };
      _peers.set(fromPeerId, peer);
    }
    
    if (!peer.pc) peer.pc = _createPC(fromPeerId);

    if (signal.type === 'hello') {
      peer.displayName = signal.displayName || 'Гость';
      if (_onPeerJoin) _onPeerJoin(fromPeerId);
    } else if (signal.type === 'offer') {
      if (peer.makingOffer) return; // glare - both made offers, ignore
      await peer.pc.setRemoteDescription(JSON.parse(signal.sdp));
      const answer = await peer.pc.createAnswer();
      await peer.pc.setLocalDescription(answer);
      await _fbPut(`/rooms/${_roomId}/signals/${fromPeerId}/${_selfId}/answer`, {
        type: 'answer', sdp: JSON.stringify(answer), from: _selfId
      });
    } else if (signal.type === 'answer') {
      if (peer.pc.signalingState !== 'stable') {
        await peer.pc.setRemoteDescription(JSON.parse(signal.sdp));
      }
    } else if (signal.type === 'candidate') {
      try {
        await peer.pc.addIceCandidate(JSON.parse(signal.candidate));
      } catch (e) { /* ignore */ }
    } else if (signal.type === 'hangup') {
      if (peer.pc) { try { peer.pc.close(); } catch {} }
      _peers.delete(fromPeerId);
      if (_onPeerLeave) _onPeerLeave(fromPeerId);
    } else if (signal.type === 'ring' || signal.type === 'ringAccept' || signal.type === 'ringDecline') {
      // Forward to message handler for UI
      if (_onMessage) _onMessage({ kind: signal.type, data: signal.data }, fromPeerId);
    } else if (signal.type === 'chat' || signal.type === 'hello-msg') {
      if (_onMessage) _onMessage({ kind: signal.type, data: signal.data }, fromPeerId);
    }
  }

  // Poll for signals addressed to us
  async function _pollSignals() {
    const signals = await _fbGet(`/rooms/${_roomId}/signals/${_selfId}`);
    if (!signals) return;
    
    for (const [fromPeerId, signalTypes] of Object.entries(signals)) {
      // Process each signal type
      for (const [sigType, sigData] of Object.entries(signalTypes)) {
        if (sigType === 'candidates') {
          // Multiple ICE candidates
          if (sigData) {
            for (const [key, candidate] of Object.entries(sigData)) {
              if (_polledSignals.has(fromPeerId + ':' + sigType + ':' + key)) continue;
              _polledSignals.add(fromPeerId + ':' + sigType + ':' + key);
              await _processSignal(fromPeerId, candidate);
            }
          }
        } else {
          if (_polledSignals.has(fromPeerId + ':' + sigType)) continue;
          _polledSignals.add(fromPeerId + ':' + sigType);
          await _processSignal(fromPeerId, sigData);
        }
      }
    }
    
    // Clean up processed signals periodically
    if (_polledSignals.size > 100) {
      // Delete processed signals from Firebase
      await _fbDelete(`/rooms/${_roomId}/signals/${_selfId}`);
      _polledSignals.clear();
    }
  }

  // Start SSE listener for peer changes
  function _startSSE() {
    if (_sse) { _sse.close(); }
    _sse = new EventSource(`${DB_URL}/rooms/${_roomId}/peers.json`);
    _sse.addEventListener('put', async (e) => {
      const data = JSON.parse(e.data);
      const path = data.path;
      const parts = path.split('/').filter(Boolean);
      
      if (parts.length === 1 && parts[0] !== _selfId) {
        // New peer joined
        const peerId = parts[0];
        if (data.data && !_peers.has(peerId)) {
          const peer = { pc: null, displayName: data.data.displayName || 'Гость', makingOffer: false };
          _peers.set(peerId, peer);
          if (_onPeerJoin) _onPeerJoin(peerId);
          // Send hello to new peer
          await _sendSignal(peerId, { type: 'hello', data: { displayName: _displayName } });
        } else if (!data.data && _peers.has(peerId)) {
          // Peer left
          _peers.delete(peerId);
          if (_onPeerLeave) _onPeerLeave(peerId);
        }
      }
    });
    _sse.onerror = () => { /* will auto-reconnect */ };
  }

  let _displayName = 'User';

  // Send a signal to a specific peer
  async function _sendSignal(toPeerId, signal) {
    if (signal.type === 'candidates') {
      // ICE candidates go to a sub-path
      await _fbPut(`/rooms/${_roomId}/signals/${toPeerId}/${_selfId}/candidates/${Date.now()}_${Math.random().toString(36).slice(2,6)}`, signal);
    } else {
      await _fbPut(`/rooms/${_roomId}/signals/${toPeerId}/${_selfId}/${signal.type}`, signal);
    }
  }

  // Broadcast a signal to all known peers
  async function _broadcastSignal(signal) {
    for (const peerId of _peers.keys()) {
      await _sendSignal(peerId, signal);
    }
  }

  // Poll timer
  let _pollTimer = null;

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
      _selfId = _genId();
      _roomId = roomId;
      _displayName = userInfo.displayName || 'User';
      _peers.clear();
      _polledSignals.clear();

      // Write our peer entry
      await _fbPut(`/rooms/${_roomId}/peers/${_selfId}`, {
        displayName: _displayName,
        joinedAt: Date.now()
      });

      // Start SSE listener for peer presence
      _startSSE();

      // Poll for signals every 1 second
      _pollTimer = setInterval(_pollSignals, 1000);

      // Get existing peers and send them hello
      const existing = await _fbGet(`/rooms/${_roomId}/peers`);
      if (existing) {
        for (const [peerId, info] of Object.entries(existing)) {
          if (peerId !== _selfId && !_peers.has(peerId)) {
            _peers.set(peerId, { pc: null, displayName: info.displayName || 'Гость', makingOffer: false });
            if (_onPeerJoin) _onPeerJoin(peerId);
            await _sendSignal(peerId, { type: 'hello', data: { displayName: _displayName } });
          }
        }
      }

      return _selfId;
    },

    leave() {
      if (_pollTimer) { clearInterval(_pollTimer); _pollTimer = null; }
      if (_sse) { _sse.close(); _sse = null; }
      // Close all peer connections
      for (const [id, peer] of _peers) {
        if (peer.pc) { try { peer.pc.close(); } catch {} }
      }
      // Delete our presence
      if (_selfId && _roomId) {
        _fbDelete(`/rooms/${_roomId}/peers/${_selfId}`).catch(() => {});
        _fbDelete(`/rooms/${_roomId}/signals/${_selfId}`).catch(() => {});
      }
      _peers.clear();
      _selfId = null;
      _roomId = null;
    },

    setLocalStream(stream) {
      _localStream = stream;
      // Add tracks to existing PCs
      for (const [id, peer] of _peers) {
        if (peer.pc) {
          stream.getTracks().forEach(t => peer.pc.addTrack(t, stream));
        }
      }
    },

    async startCall(peerId) {
      let peer = _peers.get(peerId);
      if (!peer) {
        peer = { pc: null, displayName: 'Гость', makingOffer: false };
        _peers.set(peerId, peer);
      }
      if (!peer.pc) peer.pc = _createPC(peerId);
      peer.makingOffer = true;
      const offer = await peer.pc.createOffer();
      await peer.pc.setLocalDescription(offer);
      await _sendSignal(peerId, {
        type: 'offer', sdp: JSON.stringify(offer), from: _selfId
      });
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
      const onReceive = (handler) => {
        _handlers[name] = handler;
      };
      // Wire up to _onMessage
      _onMessage = (msg, fromPeerId) => {
        const handler = _handlers[msg.kind];
        if (handler) handler(msg.data, fromPeerId);
      };
      return [send, onReceive];
    },

    set onPeerJoin(fn) { _onPeerJoin = fn; },
    set onPeerLeave(fn) { _onPeerLeave = fn; },
    set onPeerStream(fn) { _onPeerStream = fn; },
  };
})();
