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

  // Pending-events buffer: if trackSubscribed fires before app.js sets
  // the _onPeerStream callback, we buffer the event here. When the
  // callback is later set (via the onPeerStream setter), we flush.
  let _pendingStreams = [];   // [{stream, peerSid}]
  let _pendingJoins = [];     // [peerSid]
  let _pendingLeaves = [];    // [peerSid]

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
        if (_onPeerJoin) {
          _onPeerJoin(p.sid);
        } else {
          console.log('[lk] buffering participantConnected (no callback yet)');
          _pendingJoins.push(p.sid);
        }
      });

      _room.on('participantDisconnected', (p) => {
        console.log('[lk] participant left:', p.identity);
        _peers.delete(p.sid);
        if (_onPeerLeave) {
          _onPeerLeave(p.sid);
        } else {
          _pendingLeaves.push(p.sid);
        }
      });

      _room.on('trackSubscribed', (track, pub, p) => {
        console.log('[lk] track subscribed:', track?.kind, 'from:', p?.identity);
        try {
          const mediaTrack = track?.mediaStreamTrack || track;
          if (mediaTrack) {
            const stream = new MediaStream([mediaTrack]);
            if (_onPeerStream) {
              _onPeerStream(stream, p.sid);
            } else {
              // Buffer — app.js hasn't set the callback yet (it does so
              // after joinRoom returns, but trackSubscribed may fire
              // during the await connect()).
              console.log('[lk] buffering trackSubscribed (no callback yet)');
              _pendingStreams.push({ stream, peerSid: p.sid });
            }
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

      // NOTE: We do NOT call setCameraEnabled / setMicrophoneEnabled here.
      // The caller (app.js joinPeerRoom) is responsible for calling
      // ensureLocalMedia(true) to capture the camera ONCE, then
      // LK.publishLocalStream(state.localStream) to publish those tracks.
      //
      // Why: on iOS Safari and many Android browsers the camera is a
      // single-tenant resource. If LiveKit's setCameraEnabled captures the
      // camera and we then call getUserMedia again for the local preview,
      // one of the captures fails silently — and LiveKit's published track
      // ends up dead. The remote participant sees a black square.
      //
      // By publishing our own MediaStreamTrack via publishTrack(), LiveKit
      // uses the SAME source as the local preview. No double capture.

      // Backup manual scan for existing participants — catches any edge cases
      // where the SDK already had tracks subscribed before we registered handlers.
      // Also buffers if callbacks aren't set yet.
      try {
        const remoteParts = _room.remoteParticipants;
        if (remoteParts) {
          for (const [sid, p] of remoteParts.entries()) {
            if (!_peers.has(sid)) {
              console.log('[lk] existing participant (scan):', p.identity);
              _peers.set(sid, p.identity || p.name || 'Гость');
              if (_onPeerJoin) _onPeerJoin(sid);
              else _pendingJoins.push(sid);
            }
            for (const pub of p.trackPublications.values()) {
              try {
                if (pub.track && pub.track.mediaStreamTrack) {
                  const stream = new MediaStream([pub.track.mediaStreamTrack]);
                  if (_onPeerStream) _onPeerStream(stream, sid);
                  else _pendingStreams.push({ stream, peerSid: sid });
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

    // Publish tracks from an existing MediaStream to the LiveKit room.
    // This is the SINGLE source of truth for local camera/mic — no
    // double getUserMedia, no camera conflict on mobile.
    // Idempotent: re-publishing the same track is a no-op.
    async publishLocalStream(stream) {
      if (!_room || !_localParticipant) {
        console.warn('[lk] publishLocalStream: no room/localParticipant');
        return;
      }
      if (!stream) {
        console.warn('[lk] publishLocalStream: no stream');
        return;
      }

      // Track which MediaStreamTracks we've already published (by track.id)
      // so re-calling this is safe.
      if (!_localParticipant._lkPublishedTracks) {
        _localParticipant._lkPublishedTracks = new Set();
      }
      const published = _localParticipant._lkPublishedTracks;

      for (const track of stream.getTracks()) {
        if (published.has(track.id)) continue;
        try {
          const opts = track.kind === 'video'
            ? {
                // HD video encoding
                videoCodec: 'vp8',
                videoEncoding: {
                  maxBitrate: 2_500_000,    // 2.5 Mbps — good for 1080p
                  maxFramerate: 30,
                  priority: 'high',
                },
                simulcast: false,           // 1:1 calls don't need simulcast
                dynacast: true,             // adapt bitrate to subscriber
              }
            : track.kind === 'audio'
              ? {
                  audioCodec: 'opus',
                  audioEncoding: {
                    maxBitrate: 32_000,     // 32 kbps opus voice
                  },
                  dtx: true,
                }
              : undefined;

          const pub = await _localParticipant.publishTrack(track, opts);
          published.add(track.id);
          console.log('[lk] published', track.kind, 'track:', pub?.trackSid || track.id);
        } catch (e) {
          console.warn('[lk] publish', track.kind, 'failed:', e.message);
        }
      }
    },

    // Unpublish all tracks we previously published. Called on hangup.
    async unpublishAll() {
      if (!_localParticipant) return;
      const published = _localParticipant._lkPublishedTracks;
      if (!published) return;
      for (const pub of _localParticipant.trackPublications.values()) {
        try {
          if (pub.track) await _localParticipant.unpublishTrack(pub.track);
        } catch (e) { console.warn('[lk] unpublish failed:', e.message); }
      }
      published.clear();
    },

    async leave() {
      if (_room) {
        try { await _room.disconnect(); } catch {}
        _room = null;
        _localParticipant = null;
      }
      _peers.clear();
      _dataHandlerBound = false;
      _pendingStreams = [];
      _pendingJoins = [];
      _pendingLeaves = [];
    },

    setLocalStream(stream) {
      // Backwards-compat: when app.js calls setLocalStream, publish the tracks.
      // This is async but we don't wait — caller doesn't expect a promise here.
      this.publishLocalStream(stream).catch((e) => {
        console.warn('[lk] setLocalStream publish failed:', e.message);
      });
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

    set onPeerJoin(fn) {
      _onPeerJoin = fn;
      // Flush buffered joins
      if (_pendingJoins.length > 0) {
        console.log('[lk] flushing', _pendingJoins.length, 'buffered participantConnected events');
        const to = _pendingJoins;
        _pendingJoins = [];
        for (const sid of to) { try { fn(sid); } catch (e) { console.warn('[lk] flush join:', e.message); } }
      }
    },
    set onPeerLeave(fn) {
      _onPeerLeave = fn;
      if (_pendingLeaves.length > 0) {
        const to = _pendingLeaves;
        _pendingLeaves = [];
        for (const sid of to) { try { fn(sid); } catch (e) { console.warn('[lk] flush leave:', e.message); } }
      }
    },
    set onPeerStream(fn) {
      _onPeerStream = fn;
      // Flush buffered streams
      if (_pendingStreams.length > 0) {
        console.log('[lk] flushing', _pendingStreams.length, 'buffered trackSubscribed events');
        const to = _pendingStreams;
        _pendingStreams = [];
        for (const { stream, peerSid } of to) { try { fn(stream, peerSid); } catch (e) { console.warn('[lk] flush stream:', e.message); } }
      }
    },

    // Backwards-compat no-op — data handler is now bound inside joinRoom.
    _setupDataHandler() {
      if (_room) _bindDataHandler(_room);
    }
  };
})();
