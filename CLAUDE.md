# RoboFrame — Claude notes

A modular digital photo frame. Browser kiosks (and Spatialstash visionOS
windows) pull images from a local DuckDB-indexed library, sync across
devices through a central WebSocket broker, and integrate with Home
Assistant. One Node server process; one workspace per concern.

User-facing docs live in [README.md](README.md). This file is for
Claude — repo orientation, how-to-run, and the few rules that aren't
obvious from the code.

Spatialstash is a separate app that implements the same protocol in Swift, it is located in the parent folder of this repo, make sure to keep it up-to-date with any protocol changes.

## Layout

- `imagemirror/` — the server (Express + WebSocket on `/rpc/ws`, MQTT
  bridge, optional HA WebSocket). Single process, port 3123. Reads
  `posts.duckdb` read-only.
  - `lib/orchestrator.js` — per-deviceId channels, readiness barrier,
    displaySync merge, dwell timer pause/resume.
  - `lib/broker.js` — WebSocket auth, action dispatch, file watcher
    on `data.json`, plumbs orchestrator + MQTT bridge.
  - `lib/mqtt-bridge.js` — HA MQTT discovery (light, motion, ALS,
    webcam) + inbound RPC topic.
  - `lib/searchQuery.js` + `lib/parseQuery.js` — DuckDB query layer.
  - `index.js` — Express routes (`/get`, `/save`, `/history`,
    `/addtohistory`, `/rpc/send`, `/rpc/deviceDC`, `/rpc/tags.json`).
- `public/modules/` — kiosk frontend (vanilla ES modules). `slideshow.js`
  applies `playback` frames; `ws-client.js` is the dispatcher;
  `visibility.js` gates the local render layer (does not advance).
- `node-display/` — on-device daemon. WebSocket → backlight / brightness
  / PIR motion / webcam stream. Backends in `platforms/` (macOS,
  Raspberry Pi DDC/CI, generic Linux sysfs).
- `packages/cli/` — `roboframe-cli bootstrap | doctor` to build /
  validate `posts.duckdb`.
- `packages/shared/` — config loader (env > file > default).

## Run / test

```bash
npm install --workspaces
RPC_TOKEN=$(openssl rand -hex 16) ACCESS_TOKEN=$(openssl rand -hex 16) \
  DUCKDB_PATH=./posts.duckdb IMAGE_DB_PATH=~/Pictures npm start

cd imagemirror && npm test    # node:test, no extra runner
```

The CLI is the only writer to the DuckDB. The server opens it read-only.

## The protocol doc — keep it current

The WebSocket protocol is the public contract for every client (web kiosk,
Spatialstash, node-display, third-party). It lives in
[docs/protocol.md](docs/protocol.md).

**When you change anything in [`imagemirror/lib/broker.js`](imagemirror/lib/broker.js)
or [`imagemirror/lib/orchestrator.js`](imagemirror/lib/orchestrator.js)
that affects the wire protocol — adding/removing/renaming actions,
changing payload fields, changing semantics of an existing action —
update `docs/protocol.md` in the same commit.** A drifted protocol doc
is what put a "warning icon every other cycle" bug into Spatialstash;
the fix had to ship in two repos. Treat the doc as part of the public
API surface.

The shipped clients are the second source of truth. If they need
updates to track a server change, ship those too:
- Web kiosk: [`public/modules/ws-client.js`](public/modules/ws-client.js)
  + the action-specific module.
- Spatialstash: `~/Projects/Spatialstash/SpatialStash/SpatialStash/Services/RemoteWebSocketClient.swift`
  + `Views/Remote/RemoteViewerModel.swift`.
- node-display: [`node-display/server.js`](node-display/server.js).

## Orchestrator model (one-screen summary)

- **Channel per `deviceId`.** Sessions joining via `slideshowConfig`
  share a channel iff their `deviceId` matches. Different ids = independent
  queues / intervals / mod tags.
- **Readiness barrier.** After each `playback` broadcast the channel
  waits for every visible session's `imageReady { id }` before starting
  the dwell timer. 10 s fallback if a client wedges. Hidden sessions
  are auto-ready.
- **Visibility = pause/resume, not reset.** A `visibility {deviceId, false}`
  pauses the dwell countdown using a wall-clock deadline; `true`
  resumes the *remaining* time. A wake never bumps the deadline. Web
  kiosk's old `wakeAdvance` was deleted for this reason.
- **`displaySync` is a merge.** The claimer's channel broadcasts to
  every WS regardless of `deviceId`; other channels' timers pause until
  release. Driver disconnect auto-releases. Anyone can `requestNext` /
  `block` / `setModTags` — no primary gate; the server is the only
  emitter of `playback` so there's no echo loop.
- **Server-side blocklist.** The orchestrator filters blocked posts
  out of every channel's queue and advances any channel that was just
  showing one. Don't add client-side defensive filtering.
- **node-display is not a session.** It never sends `slideshowConfig`,
  so it never appears in any channel's `sessions`. It still drives
  per-deviceId visibility via `visibility {deviceId, ...}` — the broker
  calls `orchestrator.notifyVisibility(deviceId, visible)` keyed on
  the payload's deviceId, not on the reporting socket.

Tests for the above live in
[`imagemirror/test/orchestrator.test.js`](imagemirror/test/orchestrator.test.js).
The `dwellDeadline` regression test (visibility off → on must not bump
the deadline) is the canary for the wake-advance class of bug.

## Other gotchas

- **`data.json` is hand-editable + file-watched.** `imagemirror/data.json`
  holds `blockedIds`, `blockedTags`, `tagLists`. The broker's writes
  go through a read-modify-write to avoid clobbering a concurrent
  hand-edit; the watcher rebroadcasts the affected slice on change.
  Don't add an in-memory cache.
- **Two token tiers.** `accessToken` (kiosk tier) ≠ `rpcToken`
  (privileged tier). They must differ. `rpcsend` over WebSocket and
  HTTP `/rpc/send` both require the rpc tier.
- **MQTT bridge auto-disables.** Empty `mqtt.url` makes every method
  on `createMqttBridge` a no-op — the rest of the broker doesn't
  feature-detect.
- **HA WebSocket forwarder is read-only.** It only echoes `state_changed`
  events for entities listed in `HA_FILTER_ENTITIES`. All control flow
  goes through MQTT discovery.
- **One DuckDB writer.** `packages/cli` is the only writer. The server
  opens read-only; future schema migrations ship as `packages/cli/sql/*.sql`.

## Style conventions in this repo

- Node tests use `node:test` directly — no jest, no mocha.
- Frontend is plain ES modules; no bundler.
- Comments explain *why*, not *what*. Several modules carry a top-of-file
  block describing the protocol they implement; if you change the
  protocol, update that block as well as `docs/protocol.md`.
- `'use strict'` on every server-side `.js` file.
- Skip transitional language in code comments, write them as if it always worked that way. The Git history is the source of truth for how things evolved.
