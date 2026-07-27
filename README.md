# Семейная связь — static GitHub Pages edition

A private family video-call, chat, audio/video mail, file storage, and admin
app — re-architected from the original Node.js + Socket.io + Express package
into a **pure static site** that runs entirely in the browser on GitHub Pages.

Public URL: <https://insightanalyticsca.github.io/call/>

## What's inside

```
index.html              Login lander + mobile app shell (5 sections)
styles.css              Mobile-first dark UI (preserved from original)
app.js                  All logic — auth, rooms, WebRTC, chat, mail, files, admin
service-worker.js       PWA offline shell (same-origin cache)
manifest.webmanifest    PWA manifest (installable)
icon.svg                App icon
.nojekyll               Disables Jekyll on GitHub Pages
```

## How it works (no backend)

| Feature              | Implementation                                                                 |
|----------------------|--------------------------------------------------------------------------------|
| Auth                 | PBKDF2 (Web Crypto API) + `localStorage`. Default `admin/admin`, `guest/guest` |
| Sessions             | 14-day persistent session in `localStorage` + mirror in `sessionStorage`       |
| Rooms                | `localStorage` + invite URL `?room=CODE&invite=TOKEN`                          |
| WebRTC signaling     | **PeerJS** free public broker (`0.peerjs.com`) — no server required            |
| Video calls          | Full-mesh WebRTC via PeerJS media connections                                  |
| Chat                 | `localStorage` history + PeerJS data-channel gossip sync                       |
| Audio/video mail     | `MediaRecorder` → Blob → **IndexedDB**                                         |
| File uploads         | File input → Blob → **IndexedDB**                                              |
| Preview / download   | Object URLs created from IndexedDB Blobs                                       |
| Admin (user mgmt)    | `localStorage` user records; admin can create/edit/delete users & passwords    |

## Architecture notes

- The **first user to join a room** registers a deterministic PeerJS ID
  (`iac-call-v1-room-<CODE>`) and becomes the room "host". They accept incoming
  data + media connections from anyone joining with that code.
- **Subsequent users** connect to the host, request the presence list, then
  establish direct peer-to-peer connections with everyone in the room
  (full mesh — fine for the typical 2–4 person family call).
- If the host leaves, the remaining peer automatically retries the host ID
  and becomes the new host.
- Chat messages are gossiped across the data-channel mesh and stored locally
  in each browser. Late joiners request history from the host.
- Uploaded files and recorded messages live in **IndexedDB** on the device
  that created them. They are NOT synced to other devices (no server).
  They remain available across sessions on the same browser.

## Defaults

- `admin` / `admin` — full admin (can manage users)
- `guest` / `guest` — guest role

Change these in the **Админ** tab after first login.

## Limitations vs. the original Node.js app

- Files and recordings are per-device (no server sync). To share a file with
  another device, download it and send it via the room's chat or another
  channel.
- FFmpeg MP4 transcoding is not available (no server). MOV/MPG/MPEG files
  play directly via the browser's native player; if the browser can't decode
  them, download the original.
- WebRTC depends on the free public PeerJS broker. For better reliability
  in production, deploy your own PeerJS server and update `app.js`.

## Local development

Just open `index.html` over HTTPS or via `localhost` — no build step.

```bash
# Optional: serve locally with Python
python3 -m http.server 8080
# Visit http://localhost:8080/
```

Camera/microphone require a secure context (HTTPS or localhost).
