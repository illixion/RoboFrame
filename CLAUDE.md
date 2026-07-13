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
- `native-kiosk/` — Python 3 + pygame + Pillow SDL2 frontend. Chromium
  replacement for Pi 3 / 1 GB-class boards on X11 + Openbox. Same WS
  protocol as the browser kiosk, single-session (`sessionId: "main"`),
  server-side image resize via `/get?width=&height=&lowmem=1` so the Pi
  never decodes a full-res JPEG. Pairs with node-display on the same host:
  node-display owns backlight/PIR, native-kiosk owns pixels.
  Keyboard/keypad input is read straight from `/dev/input` (evdev) and
  the devices are `EVIOCGRAB`'d — X11 keyboard focus is deliberately
  bypassed because an mpv video window (even embedded via `--wid`) can
  take input focus and otherwise swallow every shortcut for the whole
  clip. Needs the kiosk user in the `input` group; `grabKeyboard: false`
  (or no evdev, e.g. macOS) falls back to the pygame/X-focus path. Video
  embeds via `--wid` purely for correct rendering/stacking, not input.
- `gpio-agent/` — Python 3 daemon that bridges Pi hardware to the rest
  of the stack: PIR motion sensor → HTTP POST to node-display's
  `/pir/motion` + `/pir/clear` (port 8765), 4x4 matrix keypad → uinput
  keystrokes consumed by the kiosk's keyboard shortcuts (see
  [`public/modules/ui.js`](public/modules/ui.js) and the matching block
  in [`native-kiosk/kiosk.py`](native-kiosk/kiosk.py)), and an optional
  SSD1306 128x64 I2C OLED clock gated on PIR. Runs as root for
  `/dev/gpiomem` and uinput access; reads its own JSON config from
  `/opt/gpio-agent/config.json` (not merged into `roboframe.config.json`
  because the schema is hardware-specific and deployment is
  independent).
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
  waits for the *first* visible session's `imageReady { id }` before
  starting the dwell timer (first-ready wins, so a slow or leaving
  co-tenant on the same deviceId can't wedge it). Hidden sessions are
  auto-ready (all-hidden → promotes immediately). A per-channel
  readiness-timeout fallback (`server.slideshow.readyTimeoutMs`, default
  15 s, `0` disables) promotes the frame anyway if no visible session
  reports within the budget — the recovery path for a client that stays
  on the socket but stops reporting (frozen render loop). It's
  per-channel, so it keys on deviceId; the all-hidden short-circuit
  covers sessions that *reported* themselves hidden. After 3 consecutive
  timeouts with zero reports the channel stalls (parks on the frame, no
  blind advances / deck bumps / prefetch) — the steady state for a
  display that's off but never reported visibility:false, e.g. right
  after a server restart wiped the in-memory visibility map. Any sign of
  life (accepted imageReady, visibility report, re-register, user action
  on the channel) clears the streak and resumes. With the timeout
  disabled the channel parks on the frame immediately until a report
  arrives.
- **Visibility = pause/resume, not reset.** A `visibility {deviceId, false}`
  pauses the dwell countdown using a wall-clock deadline; `true`
  resumes the *remaining* time. A wake never bumps the deadline. Web
  kiosk's old `wakeAdvance` was deleted for this reason.
- **`displaySync` is a merge.** The claimer's channel broadcasts to
  every WS regardless of `deviceId`; other channels' timers pause until
  release. All sessions on the driver channel are equal — the claimer
  ws disconnecting does not release the merge; the driver channel
  parks (timers stopped) and keeps the claim. Only an explicit
  `displaySync {enabled:false}` or process shutdown releases it. Anyone can
  `requestNext` / `block` / `setModTags` — no primary gate; the server
  is the only emitter of `playback` so there's no echo loop.
- **Channels are parked, not evicted.** When the last session on a
  channel disconnects the channel is kept for the lifetime of the
  server process — queue, cursor, mod tags, interval, currentId, and
  merge claim are all preserved. All timers (dwell, readiness,
  prefetch, idle-refill) stop while parked so no work runs for an
  unattended channel. A reconnecting client (visionOS sleep/wake,
  kiosk reboot, network blip, days-later return) rebinds to the
  surviving channel and resumes from the same image without replaying
  `slideshowConfig`. A held merge claim is only released by an
  explicit `displaySync {enabled:false}` from some session on the
  driver channel, or by `close()` at process shutdown.
- **Server-side blocklist.** Blocked posts are filtered out server-side
  on every path that selects images: the orchestrator drops them from
  each channel's queue and advances any channel that was just showing
  one, and the `/random` HTTP route excludes them in SQL so a blocked
  post is never picked. Both read the same `blockedIds`/`blockedTags`
  from `data.json`. Don't add client-side defensive filtering.
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
- **Tag queries run off materialized match sets.** One temp table of
  matching ids per distinct WHERE (`imagemirror/lib/searchQuery.js`),
  shared by concurrent callers, LRU-evicted. Don't add per-page caching
  or `clearCache()` calls on routine state changes — set membership only
  depends on the read-only file DB; ordering reads `random_ranks` live.
- **Query-time tag expansion is gated on `posts_tags`.** When the library
  ships the inverted index, tag terms expand through
  `tag_aliases`/`tag_implications` (aliases + transitive implication
  antecedents, `imagemirror/lib/tagExpansion.js`) — required for
  unflattened libraries, and the index is what makes wide expansions
  cheap. Without `posts_tags`, expansion stays identity and matching is
  literal against the `posts.tags` arrays: on a flattened library the
  closure is already baked into every row, and expanding there would
  re-select the same posts through a pathologically wide array scan
  (measured 40s vs 4s). Don't decouple the two signals.
- **`/get` outputs JPEG, not WebP.** VideoCore on Pi-class hardware has
  hardware JPEG decode (via MMAL) but no WebP path — software-decoding
  WebP at 1080p saturates the ARM cores and freezes the kiosk. The
  `convert` path emits JPEG q95 with a black flatten (covers alpha
  PNGs); `lowmem=1` re-encodes non-JXL sources too. Don't reintroduce
  WebP output without a Pi 3 reproducibility check.
- **`bright` is direct RGB multiply, not alpha.** The old alpha-modulation
  path was equivalent (alpha-over-black ≡ RGB×α) but JPEG-incompatible.
  `applyDimAndConvertToJpeg` uses `.linear(dim, 0)`. No contrast bump —
  it was clipping highlights on already-bright photos.
- **Night light is a kiosk-side schedule.** `?nightlightstart=HH:MM&
  nightlightend=HH:MM` on the kiosk URL toggles `bright` on/off at the
  boundaries via [`public/modules/nightlight.js`](public/modules/nightlight.js).
  Boundary fires `slideshow.invalidateMediaCache()` because the media
  cache is keyed by `post.id`, not URL — without invalidation the
  stale-bright blob would be served on the next playback tick.

## Style conventions in this repo

- Node tests use `node:test` directly — no jest, no mocha.
- Frontend is plain ES modules; no bundler.
- Comments explain *why*, not *what*. Several modules carry a top-of-file
  block describing the protocol they implement; if you change the
  protocol, update that block as well as `docs/protocol.md`.
- `'use strict'` on every server-side `.js` file.
- Skip transitional language in code comments, write them as if it always worked that way. The Git history is the source of truth for how things evolved.
- After tests pass for a change, create a commit without waiting to be
  asked. Write commit subjects in the imperative mood ("Add X", "Fix Y",
  "Drop Z"), matching the existing `git log` style — no trailing
  period, no past tense, no "this commit…" preamble.

## Privacy

- Avoid reading user's configuration or data from the DuckDB to preserve data privacy, you are allowed to check schemas and metadata, but never real user data. This applies to all data storage written by this project, including the `data.json` file.
- Any code that adds calls to external services is expressly forbidden without a clear opt-in from the user. This includes analytics, error reporting, or any third-party API calls. If you want to add such a feature, it must be behind a configuration flag that is disabled by default, and the user must explicitly enable it with a clear understanding of what data is being shared and with whom.

