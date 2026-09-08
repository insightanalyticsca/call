'use strict';

/* ============================================================
 * livekit.js — LiveKit SFU for video calls
 * Replaces fb-signaling.js WebRTC P2P + TURN entirely.
 * LiveKit handles signaling, NAT traversal, media relay.
 * No TURN needed — works on any network.
 * ============================================================ */

const LK = (function () {
  const LIVEKIT_URL = 'wss://familycall-9ulirdsp.livekit.cloud';
  const API_KEY = 'APILuQjqssCKXV9';
  const API_SECRET = 'Hrvx7m2jQdEn3EflokcZDVJDDBXmzRlFZjIGm4dAxYJ';

  let _room = null;
  let _localParticipant = null;
  let _onPeerStream = null;
  let _onPeerJoin = null;
  let _onPeerLeave = null;
  let _peers = new Map();
  let _handlers = {};

  // Generate a LiveKit access token
  // Uses the jose library to create a JWT
  async function _createToken(roomName, participantName) {
    // Import jose for JWT creation
    const jose = await import('https://cdn.jsdelivr.net/npm/jose@5/+esm');
    
    const payload = {
      iss: API_KEY,
      sub: participantName,
      aud: 'livekit',
      nbf: Math.floor(Date.now() / 1000),
      exp: Math.floor(Date.now() / 1000) + 3600, // 1 hour
      video: { roomJoin: true, room: roomName },
    };
    
    const secret = new TextEncoder().encode(API_SECRET);
    const token = await new jose.SignJWT(payload)
      .setProtectedHeader({ alg: 'HS256', typ: 'JWT' })
      .sign(secret);
    
    return token;
  }

  return {
    get selfId() { return _localParticipant?.sid || null; },

    getPeers() {
      const obj = {};
      for (const [id, p] of _peers) obj[id] = { displayName: p };
      return obj;
    },

    getPeerNames() {
      const m = new Map();
      for (const [id, p] of _peers) m.set(id, p);
      return m;
    },

    async joinRoom(roomId, userInfo) {
      // Load LiveKit SDK
      const lk = await import('https://cdn.jsdelivr.net/npm/livekit-client@2/+esm');
    const Room = lk.Room;
    const RoomEvent = lk.RoomEvent;
    const TrackEvent = lk.TrackEvent;
    // Store globally for makeAction
    window._lkRoomEvent = RoomEvent;
      
      // Leave existing room
      if (_room) { try { await _room.disconnect(); } catch {} }
      _peers.clear();

      // Create token
      const participantName = userInfo.displayName || userInfo.username || 'User';
      const token = await _createToken(roomId, participantName);

      // Connect to LiveKit room
      _room = new Room({ adaptiveStream: true, dynacast: true });
      await _room.connect(LIVEKIT_URL, token);
      _localParticipant = _room.localParticipant;

      console.log('[lk] connected to room:', roomId, 'as:', participantName);

      // Enable camera and mic
      try {
        await _room.localParticipant.setCameraEnabled(true);
        await _room.localParticipant.setMicrophoneEnabled(true);
        console.log('[lk] camera + mic enabled');
      } catch (e) {
        console.warn('[lk] camera/mic failed:', e.message);
      }

      // Handle existing remote participants
      // Handle existing remote participants
      const remoteParts = _room.remoteParticipants;
      if (remoteParts) {
        for (const [sid, p] of remoteParts.entries()) {
          console.log('[lk] existing participant:', p.identity);
          _peers.set(sid, p.identity || p.name || 'Гость');
          if (_onPeerJoin) _onPeerJoin(sid);
          // Check for existing tracks
          for (const pub of p.trackPublications.values()) {
            if (pub.track) {
              const stream = new MediaStream([pub.track.mediaStreamTrack]);
              if (_onPeerStream) _onPeerStream(stream, sid);
            }
          }
        }
      }

      // Handle new participants joining
      _room.on('participantConnected', (p) => {
        console.log('[lk] participant joined:', p.identity);
        _peers.set(p.sid, p.identity || p.name || 'Гость');
        if (_onPeerJoin) _onPeerJoin(p.sid);
      });

      // Handle participants leaving
      _room.on('participantDisconnected', (p) => {
        console.log('[lk] participant left:', p.identity);
        _peers.delete(p.sid);
        if (_onPeerLeave) _onPeerLeave(p.sid);
      });

      // Handle remote tracks being published
      _room.on('trackSubscribed', (track, pub, p) => {
        console.log('[lk] track subscribed:', track?.kind, 'from:', p?.identity);
        try {
          const mediaTrack = track?.mediaStreamTrack || track;
          if (mediaTrack) {
            const stream = new MediaStream([mediaTrack]);
            if (_onPeerStream) _onPeerStream(stream, p.sid);
          }
        } catch (e) { console.warn('[lk] track sub error:', e.message); }
      });

      _room.on('trackUnsubscribed', (track, pub, p) => {
        console.log('[lk] track unsubscribed from:', p.identity);
        if (_onPeerLeave) _onPeerLeave(p.sid);
      });

      return _localParticipant?.sid;
    },

    async leave() {
      if (_room) {
        try { await _room.disconnect(); } catch {}
        _room = null;
        _localParticipant = null;
      }
      _peers.clear();
    },

    setLocalStream(stream) {
      // LiveKit manages local tracks internally via setCameraEnabled/setMicrophoneEnabled
      // This is a no-op for compatibility
    },

    async startCall(peerId) {
      // In LiveKit, you don't "call" — you just join the room and publish tracks
      // The other participant auto-receives your tracks when they join
      // This is a no-op for compatibility
    },

    async acceptCall(peerId) {
      // No-op — tracks are auto-subscribed
    },

    stopStream(peerId) {
      // No-op — LiveKit manages subscriptions
    },

    makeAction(name) {
      // Simple in-memory messaging via LiveKit data channels
      const send = (data, toPeerId) => {
        if (_room && _localParticipant) {
          try {
            const encoded = new TextEncoder().encode(JSON.stringify({ kind: name, data }));
            if (toPeerId) {
              _localParticipant.publishData(encoded, { reliable: true, destinationIdentities: [toPeerId] });
            } else {
              _localParticipant.publishData(encoded, { reliable: true });
            }
          } catch (e) { console.warn('[lk] send failed:', e.message); }
        }
      };
      const onReceive = (handler) => { _handlers[name] = handler; };
      
      // Set up data handler if room exists
      if (_room) {
        _room.on('dataReceived', (payload, participant, kind, topic) => {
          try {
            const msg = JSON.parse(new TextDecoder().decode(payload));
            const handler = _handlers[msg.kind];
            if (handler) handler(msg.data, participant?.sid);
          } catch {}
        });
      }
      
      return [send, onReceive];
    },

    set onPeerJoin(fn) { _onPeerJoin = fn; },
    set onPeerLeave(fn) { _onPeerLeave = fn; },
    set onPeerStream(fn) { _onPeerStream = fn; },
    
    // Allow setting up data handler before room exists
    _setupDataHandler() {
      if (_room && _room._dataHandlerSet) return;
      if (_room) {
        _room._dataHandlerSet = true;
        _room.on('dataReceived', (payload, participant) => {
          try {
            const msg = JSON.parse(new TextDecoder().decode(payload));
            const handler = _handlers[msg.kind];
            if (handler) handler(msg.data, participant?.sid);
          } catch {}
        });
      }
    }
  };
})();
