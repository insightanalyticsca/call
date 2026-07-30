# Семейная связь — static GitHub Pages edition with synced storage

A private family video-call, chat, audio/video mail, file storage, and admin
app — runs entirely in the browser on GitHub Pages, with **synced storage**
across all devices via a separate private GitHub repo.

- **App URL**: <https://insightanalyticsca.github.io/call/>
- **App repo** (public): <https://github.com/insightanalyticsca/call>
- **Data repo** (private): <https://github.com/insightanalyticsca/call-data>

## Architecture (one place: GitHub)

```
┌─────────────────────────────────────────┐    ┌─────────────────────────────┐
│  Browser (any device)                   │    │  GitHub                     │
│                                         │    │                             │
│  index.html / app.js / gh-store.js      │    │  ┌─ insightanalyticsca/call │
│         │                               │    │  │   (public, hosts app)    │
│         │  PAT-authenticated fetch()     │───►│  │   served by Pages       │
│         │                               │    │  │                          │
│         ▼                               │    │  └─ insightanalyticsca/    │
│  gh-store.js                            │    │      call-data (private)   │
│    • getDb / updateDb  (db.json)        │◄──►│      ├─ db.json            │
│    • putFile / getFile (files/<id>)     │    │      │   users, rooms,     │
│    • poll every 10s                     │    │      │   messages, media   │
│                                         │    │      └─ files/<media_id>   │
│  PeerJS broker (0.peerjs.com)           │    │          base64 blobs      │
│    • WebRTC video signaling             │    │                             │
│    • data-channel chat gossip           │    └─────────────────────────────┘
└─────────────────────────────────────────┘
```

## Files in this repo

```
index.html              Login lander + mobile app shell
styles.css              Mobile-first dark UI (preserved from original)
app.js                  All logic — auth, rooms, WebRTC, chat, mail, files, admin
gh-store.js             GitHub Contents API wrapper (the new storage layer)
service-worker.js       PWA offline shell
manifest.webmanifest    PWA manifest
icon.svg                App icon
.nojekyll               Disables Jekyll on GitHub Pages
```

## How storage works

| What | Where | Synced across devices? |
|---|---|---|
| Users, rooms, chat, media metadata | `db.json` in `call-data` repo | ✅ Yes |
| Uploaded files, recorded mail | `files/<media_id>` in `call-data` repo (base64) | ✅ Yes |
| Session token | `localStorage` on each device | ❌ No (per-device login) |
| WebRTC video signaling | PeerJS public broker | Real-time |
| Chat instant push | PeerJS data channel | Real-time, plus 10s poll backup |

## Trade-offs

- **PAT is in client JS** — anyone using the site can extract it from devtools.
  Use a **fine-grained PAT scoped only to `call-data`** for safety.
  The classic `ghp_…` PAT embedded here has broader scope — rotate it after setup.
- **100 MB per-file hard limit** (GitHub's limit). Larger files are rejected with a toast.
- **Saves lag** — each chat message or file upload = a git commit (~1–3 s round-trip).
  For chat, PeerJS data channel gives instant push to peers who are online; the
  10-second poll picks up changes from offline devices.
- **5000 GitHub API req/hour** — fine for a family. Heavy use may hit the limit.
- **Rate limit display** — the `API: …` status pill shows remaining requests.

## Defaults

- `admin` / `admin` — full admin (can manage users)
- `guest` / `guest` — guest role

Change these in the **Админ** tab after first login.

## Local development

Just open `index.html` over HTTPS or via `localhost` — no build step.

```bash
python3 -m http.server 8080
# Visit http://localhost:8080/
```

Camera/microphone require a secure context (HTTPS or localhost).

## Rotation: switch to a fine-grained PAT (recommended)

1. Go to <https://github.com/settings/personal-access-tokens/new>
2. Resource owner: `insightanalyticsca`
3. Repository access: **Only select repositories** → `call-data`
4. Permissions → Repository permissions:
   - **Contents**: Read and write
   - (Everything else: No access)
5. Generate token, copy it
6. Edit `gh-store.js` → replace `token:` value
7. Commit & push to `call` repo
8. Revoke the old classic PAT at <https://github.com/settings/tokens>
