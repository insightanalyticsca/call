'use strict';

/* ============================================================
 * livekit.js — LiveKit SFU for video calls
 * Replaces fb-signaling.js WebRTC P2P + TURN entirely.
 * LiveKit handles signaling, NAT traversal, media relay.
 * No TURN needed — works on any network.
 *
 * v7 (lk7): CRITICAL FIX for asymmetric video.
 *   All event handlers (participantConnected, trackSubscribed,
 *   dataReceived, etc.) are now registered BEFORE room.connect().
 *   Previously they were registered AFTER connect() returned,
 *   which meant LiveKit fired trackSubscribed for existing
 *   participants DURING the await — and we missed those events.
 *   The result: A sees B but B doesn't see A.
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
  let _dataHandlerBound = false;

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

  // Single data-received dispatcher. Bound once per room.
  function _bindDataHandler(room) {
    if (!room || room._lkDataBound) return;
    room._lkDataBound = true;
    room.on('dataReceived', (payload, participant, kind, topic) => {
      try {
        const msg = JSON.parse(new TextDecoder().decode(payload));
        const handler = _handlers[msg.kind];
        if (handler) handler(msg.data, participant?.sid);
      } catch (e) { /* ignore malformed */ }
    });
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
      _dataHandlerBound = false;

      // Create token
      const participantName = userInfo.displayName || userInfo.username || 'User';
      const token = await _createToken(roomId, participantName);

      // Create the Room instance — do NOT connect yet.
      _room = new Room({ adaptiveStream: true, dynacast: true });

      // ============================================================
      // CRITICAL: register ALL event handlers BEFORE connect().
      // LiveKit fires `trackSubscribed` for already-published tracks
      // during the connect() await. If we register after, we miss them
      // and end up with asymmetric video (A sees B, B doesn't see A).
      // ============================================================
      _room.on('participantConnected', (p) => {
        console.log('[lk] participant joined:', p.identity);
        _peers.set(p.sid, p.identity || p.name || 'Гость');
        if (_onPeerJoin) _onPeerJoin(p.sid);
      });

      _room.on('participantDisconnected', (p) => {
        console.log('[lk] participant left:', p.identity);
        _peers.delete(p.sid);
        if (_onPeerLeave) _onPeerLeave(p.sid);
      });

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
        console.log('[lk] track unsubscribed:', track?.kind, 'from:', p?.identity);
        // Do NOT fire onPeerLeave here — only fire when the participant
        // actually disconnects. A track can be unsubscribed while the
        // participant is still in the room (e.g. they muted video).
      });

      _room.on('trackSubscriptionFailed', (track, pub, p, reason) => {
        console.warn('[lk] track subscription failed:', pub?.trackSid, 'from:', p?.identity, 'reason:', reason);
      });

      _room.on('trackPublished', (pub, p) => {
        // A remote participant published a new track. LiveKit will auto-subscribe
        // (adaptiveStream) and fire `trackSubscribed` shortly after — no action here.
        console.log('[lk] track published:', pub?.trackSid, 'kind:', pub?.kind, 'from:', p?.identity);
      });

      // Bind the data-received dispatcher once.
      _bindDataHandler(_room);
      _dataHandlerBound = true;

      // Now connect — existing participants' tracks will fire trackSubscribed,
      // and our handler will catch them.
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

      // Backup manual scan for existing participants — catches any edge cases
      // where the SDK already had tracks subscribed before we registered handlers
      // (shouldn't happen now, but kept as a safety net).
      try {
        const remoteParts = _room.remoteParticipants;
        if (remoteParts) {
          for (const [sid, p] of remoteParts.entries()) {
            if (!_peers.has(sid)) {
              console.log('[lk] existing participant (scan):', p.identity);
              _peers.set(sid, p.identity || p.name || 'Гость');
              if (_onPeerJoin) _onPeerJoin(sid);
            }
            for (const pub of p.trackPublications.values()) {
              try {
                if (pub.track && pub.track.mediaStreamTrack) {
                  const stream = new MediaStream([pub.track.mediaStreamTrack]);
                  if (_onPeerStream) _onPeerStream(stream, sid);
                }
              } catch (e) {
                console.warn('[lk] scan track error:', e.message);
              }
            }
          }
        }
      } catch (e) {
        console.warn('[lk] existing-participant scan failed:', e.message);
      }

      return _localParticipant?.sid;
    },

    async leave() {
      if (_room) {
        try { await _room.disconnect(); } catch {}
        _room = null;
        _localParticipant = null;
      }
      _peers.clear();
      _dataHandlerBound = false;
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

      // Ensure the data dispatcher is bound (idempotent — safe to call multiple times).
      // In v7 the dispatcher is bound in joinRoom before connect, but makeAction may
      // be called for rooms created later, so this is a safety net.
      if (_room) _bindDataHandler(_room);

      return [send, onReceive];
    },

    set onPeerJoin(fn) { _onPeerJoin = fn; },
    set onPeerLeave(fn) { _onPeerLeave = fn; },
    set onPeerStream(fn) { _onPeerStream = fn; },

    // Backwards-compat no-op — data handler is now bound inside joinRoom.
    _setupDataHandler() {
      if (_room) _bindDataHandler(_room);
    }
  };
})();
