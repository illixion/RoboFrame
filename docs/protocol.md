# RoboFrame WebSocket protocol

The orchestrator drives playback for every connected display. This doc is
the reference for anyone writing a client (browser kiosk, Spatialstash
window, hardware controller, debugger). The contract has a few
non-obvious rules — the *Critical flows* section calls them out
explicitly so a fresh implementation doesn't land in the same traps the
existing clients already navigated.

The shipped clients are the canonical implementations: web kiosk
([`public/modules/`](../public/modules/)), Spatialstash
([`SpatialStash/SpatialStash/Services/RemoteWebSocketClient.swift`](https://github.com/illixion/Spatialstash/blob/main/SpatialStash/SpatialStash/Services/RemoteWebSocketClient.swift)),
node-display
([`node-display/server.js`](../node-display/server.js)), and the native
SDL2 kiosk ([`native-kiosk/kiosk.py`](../native-kiosk/kiosk.py)) for
memory-constrained boards (Pi 3 et al.). When this doc and the code
disagree, the code wins — please open a PR to fix the doc.

## Connecting

- URL: `wss://<host>/rpc/ws?token=<TOKEN>`
- Token tiers (server-side):
  - `accessToken` — kiosk tier. Allowed: every action below except `rpcsend`.
  - `rpcToken` — privileged tier. Adds `rpcsend` (broadcast arbitrary frames).
- Wrong / missing token → server closes with code **1008** (policy violation). Don't keep reconnecting; surface the error.
- On open, the server pushes one unsolicited frame: `tagLists` — the
  catalog of preset tag lists. The active list *index* is per-channel
  and arrives in each `playback` frame's `currentList` — unless the
  server has shared-tag mode enabled, in which case it is one global
  selection (see [`setTagList`](#settaglist-session-scoped)).
- Frames after that arrive as state changes happen.
- The blocklist is server-only — clients never see it on the wire and
  shouldn't carry one. See [`block`](#block) below.

The server is the single source of truth. Clients don't echo state back —
they emit *requests* (advance, set, claim) and *reports* (visibility,
imageReady, sensor) only.

## Channels and sessions

A **session** is one logical slideshow audience addressed by a `sessionId`
on a WebSocket connection. Each WS can carry many sessions — this is how
a single Spatialstash app instance multiplexes ten remote-viewer windows
over one TCP/TLS path. Each session calls `slideshowConfig` independently
to join the **channel** for its `deviceId`. Two sessions on the same
`deviceId` (whether on one ws or across many) share one channel and
lockstep on the same image. Different `deviceId`s get independent
channels with independent queues, intervals, and tag lists.

Channel-wide params are not per-session: `interval`, `modTags`, and the
active tag list are last-writer-wins across the sessions sharing a
channel, and `ratio` is resolved to a single constraint — the channel
adopts the advert whose aspect is closest to square (1.0) and expands
it into the query window. So on a channel mixing orientations (a
landscape window and a portrait one, say) the most-square advertiser
wins rather than the ranges being intersected into nothing. Per-session
params that *do* stay independent are the
render-only ones the server applies when serving each session's image
(`width`, `height`, `bright`, `convert`).

A WebSocket that *never* sends `slideshowConfig` (e.g., node-display) has
no sessions — it can still send `visibility`, `reportDisplay`, etc. to
drive hardware state, but it isn't expected to render images and is
ignored by playback timing.

### Session ids

Every session-scoped action (the ones that route through the orchestrator
— `slideshowConfig`, `setModTags`, `setTagList`, `requestNext`, `reshuffle`,
`imageReady`, `displaySync`, plus the optional `sessionEnd`) carries a
top-level `sessionId` string that names the session within the
connection:

```json
{ "sessionId": "win1", "action": "...", "payload": { ... } }
```

Single-session clients (web kiosk, node-display) use a constant id like
`"main"`. The id only needs to be unique *within* a connection; the
server scopes it under the ws. Connection-wide actions (`block`,
`visibility`, `present`, `getDisplayState`, `ping`, `report*`, `rpcsend`)
ignore `sessionId`.

A session is created the first time the server sees `slideshowConfig`
for a `(ws, sessionId)` pair. Closing the underlying ws drops every
session attached to it; sending `sessionEnd { sessionId }` drops just
that one without disturbing the others.

### Parked channels

When the last session on a channel disconnects (or is `sessionEnd`-ed)
the channel is *not* deleted — it is *parked* for the lifetime of the
server process. Its queue, cursor, mod tags, interval, currentId, and
any held merge claim are preserved verbatim, and every timer (dwell,
prefetch, idle-refill) stops so no work runs for an unattended channel.
A reconnecting client (visionOS sleep/wake, kiosk reboot, a network
blip, or a return days later) is rebound to the surviving channel
automatically when its `slideshowConfig` lands, resuming from the same
image without replaying any state. There is no eviction timer: a parked
channel and its merge claim survive until an explicit
`displaySync {enabled:false}` from some session on the driver channel,
or process shutdown (`close()`).

## Client → server messages

Every message is `{ "sessionId"?: "<id>", "action": "<name>", "payload": { ... } }`.
Unknown actions are logged and dropped. `sessionId` is required on
session-scoped actions (see [Session ids](#session-ids) above).

### `slideshowConfig` (required, session-scoped)
Joins this session to the channel for `deviceId`. Send on every
(re)connect — the server uses it as the session-create signal.

```json
{ "sessionId": "win1", "action": "slideshowConfig", "payload": {
  "deviceId": "screen1",
  "interval": 15000,
  "ratio": 1.778,
  "width": 1920,
  "height": 1080,
  "bright": false,
  "convert": false,
  "lowmem": false,
  "gif": false,
  "modTags": ["rating:s", "-blood"]
}}
```

- `interval` is dwell time in ms (clamped to 2000–3600000).
- `modTags` is optional; when present, the orchestrator's first refill
  query already includes them — without that the initial query is
  discarded a few ms later when a separate `setModTags` arrives.
- `ratio` is optional and is the display's raw aspect (width/height) as
  a number, e.g. `1.778` for 16:9. The server owns the tolerance: it
  expands the value into a `ratio:lo..hi` query clause with a ±15%
  window (so `1.778` becomes `ratio:1.51..2.04`) and picks posts that
  suit the panel. The window is configurable via
  `server.slideshow.ratioWindow` in `roboframe.config.json` (hot-reloaded
  — no restart needed; env override `SLIDESHOW_RATIO_WINDOW`). A legacy `"lo..hi"` range *string* (and a numeric
  string like `"1.778"`) is still accepted for back-compat — the range
  form is used verbatim without re-expansion. When multiple sessions
  share a channel the server keeps the single advert whose aspect is
  closest to square (1.0) rather than intersecting them, so a channel
  mixing a landscape and a portrait window still gets a usable filter
  instead of none. Re-send `slideshowConfig` with a new `ratio` to
  trigger a queue refill (e.g. after a window resize).
- `bright`, `convert`, `lowmem`, `gif`, `width`, `height` are the variant
  fingerprint the server uses for background pre-conversion of upcoming
  images. They must match the corresponding `/get?…` query parameters
  this session will use, otherwise the prefetched bytes will be the
  wrong variant and every cycle pays the conversion cost on the hot
  path. All are optional: omitting `lowmem`/`gif`/`convert`/`bright` is
  treated as `false`, and omitting `width`/`height` means no server-side
  downscale (source resolution) — a client that fetches at native
  resolution shouldn't send them at all.
- `gif` opts a decoder-poor client (the PSP kiosk) back into animated
  **GIF**. Under `convert`/`lowmem`, animated posts are delivered as mp4
  (see the `/get` notes below); a client that can't decode mp4 and can't
  tell a post is animated before fetching sends `gif:true` on every
  request, and the server returns GIF for animated posts / JPEG for
  stills, transparently.

### `imageReady` (required for slideshow sessions, session-scoped)
Tell the server the channel's current image is fully on screen.

```json
{ "sessionId": "win1", "action": "imageReady", "payload": { "id": 4181569 } }
```

For a video, include the clip length in milliseconds so the server can
size the dwell to the playback:

```json
{ "sessionId": "win1", "action": "imageReady", "payload": { "id": 4181569, "durationMs": 22000 } }
```

`durationMs` is optional and only meaningful for video. The dwell for the
image is `max(interval, durationMs)`: a clip shorter than the interval
loops until the interval elapses (set `video.loop = true`), a clip longer
than the interval delays the advance until it has played through once
(set `video.loop = false` so it doesn't restart just before the advance).
Images omit it and dwell for the plain interval.

The first accepted `imageReady` for a new id also **credits the post's
view** (`display_count`) — the server counts a view on confirmed render,
not on broadcast. See [View counting](#view-counting).

The server also seeds the dwell from the video's **indexed** duration,
delivered in the playback frame as `current.durationMs` (see the
`playback` frame below). The effective dwell is the max of the indexed
duration and every `durationMs` a session reports. A client should prefer
`current.durationMs` over demuxing the stream: a live-transcoded clip
(`vcodec=h264` on a cache miss) arrives as a fragmented MP4 with no
duration in its header, so a player querying its own demuxer sees 0 and
would advance mid-clip. Reporting `durationMs` back is still useful for a
library that indexed 0, or for a cached replay whose true length the
player can read.

The orchestrator's readiness barrier starts the dwell timer as soon as
the **first** present session on the channel reports for the current
image — first-ready wins, not all-ready. When several clients share a
`deviceId` (e.g. a web kiosk and Spatialstash), the slowest doesn't gate
the channel and a client leaving mid-barrier can't wedge it. Send it
once per successful transition (matching the broadcast `current.id`). A
channel whose sessions are all absent (each reported `present {false}`)
has nothing to wait for and advances on its own.

The barrier has a **readiness-timeout fallback** (`server.slideshow.readyTimeoutMs`,
default 15 s; `0` disables). If no present session reports within the
budget the channel promotes the frame anyway and starts the dwell. This
recovers a client that stays on the socket but stops reporting — a
frozen render loop, which a dead-socket check would never catch —
without a manual *next* or a reconnect. The timeout is **per-channel, so
it keys on `deviceId`**: one wedged display (or one of the distinct
`deviceId`s a single connection multiplexes) is promoted on its own
without disturbing co-tenant channels. A late `imageReady` arriving
after the fallback fired is harmless — it's dropped because the channel
is no longer `loading`.

The fallback degrades rather than loops: after **3 consecutive timeouts
with zero reports** the channel *stalls* — it parks on the current frame
(barrier still armed, no timers) instead of advancing blind through
broadcasts, deck bumps, and prefetch conversions nobody will display.
This is the steady state for a display that's powered off but never
reported `present {false}` (presence state is in-memory, so it
resets on a server restart). Any sign of life resumes the channel and
clears the streak: an accepted `imageReady`, a `present` report for
the device (reporting `false` triggers the single dark advance described
under [`present`](#present)), a session (re)registering, or any user
action on the channel (`requestNext`, `setModTags`, `setTagList`,
`reshuffle`, `displaySync`). With the fallback disabled (`0`) a channel
where no present session ever reports stays on the current frame and
never advances; the server won't advance blind into work no client can
display.

### `visibility`
Report whether a **person is physically present at** this `deviceId` —
real occupancy, not window/tab state.

```json
{ "action": "visibility", "payload": { "deviceId": "screen1", "visible": false } }
```

Visibility is **home-location telemetry only** — it drives the HA
`binary_sensor.roboframe_<deviceId>_motion` and nothing else. It does
**not** pause the slideshow or toggle `displayState`; those are
[`present`](#present)'s job. Keyed on `deviceId`, OR-aggregated across
every socket reporting it.

Only a client whose window-state genuinely tracks a person reports it:
- **node-display** — its PIR motion loop (`/pir/motion`, `/pir/clear`).
- **Spatialstash on Vision Pro** — the headset *is* the person, so its
  scenePhase (one pinned window per room) is a legitimate occupancy
  signal; it reports `visibility` alongside `present`.

A **fixed web display does NOT report `visibility` from tab visibility** —
a hidden/foregrounded tab says nothing about who's in the room. Its
occupancy comes from a co-located PIR sharing the `deviceId`; tab state
drives only [`present`](#present).

> **Back-compat:** a `deviceId` that has *never* sent a `present` report
> still has its slideshow driven by `visibility` (legacy clients that
> only speak visibility keep working). The moment any client reports
> `present` for that `deviceId`, visibility stops touching its channel —
> so co-tenants sharing a `deviceId` should migrate to `present` together.

### `present`
Report whether a display on this `deviceId` is **live and showing the
slideshow** — the signal that actually drives playback.

```json
{ "action": "present", "payload": { "deviceId": "screen1", "present": false } }
```

Keyed on `deviceId` and OR-aggregated across sockets exactly like
visibility, so **more than one display on one `deviceId`** works: the
slideshow runs normally as long as *any* source is present. Only clients
that actually *render* the slideshow send it (web frontend, native-kiosk,
Spatialstash). A **service client** like node-display — which drives the
physical panel and reports PIR but never renders (never sends
`slideshowConfig`) — sends `visibility`/`reportDisplay` but **not**
`present`; the renderer sharing its `deviceId` derives `present` from the
panel `displayState` node-display broadcasts.

When the aggregate flips to **false** (every display absent) the channel
performs **exactly one** *dark advance* — it moves to a fresh post and
parks. The dark step is silent: no `playback` broadcast, no
`display_count` bump, no prefetch (nothing is rendering). When a source
returns (aggregate → **true**) that fresh post is committed through the
normal load/dwell cycle — delivered and dwelled from when it is actually
shown, and **counted only once a present screen confirms it rendered**
(see [view counting](#view-counting)). Net effect: whoever returns sees a
**new** image with no stale hold and no old→new crossfade, and the server,
not the client, chose it (no client-side wake-advance). The advance is
bounded to a single step, so a dark channel never cycles blind.

**Departure is detected server-side, not just by the client's report.**
A suspended client (notably visionOS on background) can't reliably send
`present:false` before the OS freezes its socket, and the half-open socket
may linger. So the broker also runs a **liveness heartbeat**: it pings
every client each interval and terminates one that misses a full interval
of pongs (~5–10s), which fires the normal disconnect path — dropping that
socket's presence and dark-advancing/parking the channel. A returning
client reconnects and gets the parked-fresh post replayed on
(re)`slideshowConfig`. The client should still send `present:false` eagerly
on background as the fast path; the heartbeat is the backstop.

### `requestNext` (session-scoped)
Advance the current channel one step. Any session on the channel may call it.

```json
{ "sessionId": "win1", "action": "requestNext" }
```

While `displaySync` is active the merge driver's channel advances and
every connected display sees the same new image.

### `reshuffle` (session-scoped)
Wipe the queue and redraw a fresh page from the search backend.

```json
{ "sessionId": "win1", "action": "reshuffle" }
```

### `setModTags` (session-scoped)
Update mod tags for this channel (last-write-wins among same-channel
sessions). Triggers a clear+refill.

```json
{ "sessionId": "win1", "action": "setModTags",
  "payload": { "tags": ["rating:s", "-blood"] } }
```

When the server's `server.slideshow.sharedTags` option is enabled, mod
tags are a single global selection: this action reselects for **every**
channel at once and each one clears+refills. See `setTagList` below for
the full description of shared-tag mode.

### `sessionEnd` (session-scoped, optional)
Tear down one logical session without closing the underlying ws. Useful
when a multiplexing client closes one of N viewer windows but keeps the
others open. Closing the ws drops every session anyway, so single-session
clients don't need this.

```json
{ "sessionId": "win1", "action": "sessionEnd" }
```

### `setTagList` (session-scoped)
Switch the active tag-list catalog index for the sender's channel. Each
`deviceId` carries its own selection — setting list 1 on `kioskA` does
not change `kioskB`. The server clears the channel's queue and refills
against the new list; the new `currentList` is delivered via the next
`playback` frame for that channel. While `displaySync` is active, only
sessions on the driver channel can change the list; audience channels
ignore the action.

```json
{ "sessionId": "win1", "action": "setTagList", "payload": { "listNumber": 1 } }
```

**Shared-tag mode.** When the server is started with
`server.slideshow.sharedTags` (env `SLIDESHOW_SHARED_TAGS`) enabled, the
active list index *and* the mod tags stop being per-channel: they become
one global selection every channel shares regardless of `deviceId`. A
`setTagList` / `setModTags` from any session reselects for all displays
at once, and each channel clears+refills so they converge on the same
query. The per-channel selection is bypassed entirely. This is **not**
`displaySync`: `displaySync` merges the *playback frames* (every display
shows the same image in lockstep) while leaving each channel's query
independent; shared-tag mode shares only the *query selection* — each
channel still runs its own queue, interval, cursor, and readiness
barrier, so displays show different images drawn from the same tag set.
The option is hot-reloadable. The `displaySync` driver-channel guard
still applies: while a merge is active, only driver-channel sessions can
change the shared selection.

### `block`
Add a post id to the persistent blocklist.

```json
{ "action": "block", "payload": { "id": 4181569 } }
```

The orchestrator drops the post from every channel's queue and advances
any channel currently displaying it (you'll see a normal `playback`
frame as a result; there is no separate `blocked` echo). Blocklists
live in `imagemirror/data.json` and are server-only — clients never
receive them on the wire. Hand-editing the file has the same effect.

### `displaySync` (session-scoped)
Claim or release the merge driver role for the sender's channel.

```json
{ "sessionId": "win1", "action": "displaySync", "payload": { "enabled": true } }
```

`enabled: true` makes the sender's channel the merge driver: every
other channel is paused, and the driver's channel broadcasts to every
connected display regardless of `deviceId`. The merged readiness
barrier waits on every visible session across all channels.
`enabled: false` releases the merge — each channel resumes its own
cadence and re-broadcasts to its own audience. All sessions on the
driver channel are equals (any can release), and the original claimer
disconnecting does *not* release the merge — the driver channel parks
with the claim held. It is released only by an explicit
`displaySync {enabled:false}` or process shutdown.

### `reportDisplay`, `reportSensor`, `reportWebcam`, `reportSuppress`
Hardware-state reports from node-display (or any controller) into the
broker → MQTT bridge. Not part of the slideshow loop.

```json
{ "action": "reportDisplay", "payload": {
  "deviceId": "screen1", "state": "on", "brightness": 200
}}
```

`reportDisplay` is also rebroadcast to every other client as a
`displayState { target, state }` frame so peer clients sharing the
same `deviceId` (e.g. a browser kiosk on a Pi alongside node-display)
converge on what the panel is actually doing — including PIR-driven
wakes after an HA-driven `displayState: off`.

```json
{ "action": "reportSensor", "payload": {
  "deviceId": "screen1", "sensor": "als", "value": 42.0
}}
```

```json
{ "action": "reportWebcam", "payload": { "deviceId": "screen1", "state": "on" } }
```

```json
{ "action": "reportSuppress", "payload": { "deviceId": "screen1", "state": "on" } }
```

`reportSuppress` mirrors the local wake-suppressor switch into a HA
`switch.roboframe_<deviceId>_suppress` entity. While engaged, PIR motion
won't wake the panel and the panel is held off; explicit `displayState`
commands and effect actions (`playVideo`, `playScene`, `showText`,
`playAudio`, `refresh`) still bypass it. The complementary inbound action is
`setSuppress { target, state }` — sent by the broker when HA writes the
switch's command topic.

### `reportMetrics`, `reportLog` (connection-wide, optional)
Device telemetry for diagnostics — emitted by Spatialstash when its Console
developer toggle is on (quasi-dev-mode), not by default. Both are
connection-wide (no `sessionId`) and the broker appends them to an
append-only `imagemirror/telemetry.jsonl` (rotated at ~5 MB to a single `.1`
backup). They are **not** part of the slideshow loop and never rebroadcast.

`reportMetrics` is a periodic process-wide sample (~every 7 s while a viewer
is connected). It exists to catch the memory ramp that precedes an
out-of-memory jetsam *during live playback* — post-mortem device logs only
show the app already trimmed/suspended.

```json
{ "action": "reportMetrics", "payload": {
  "deviceId": "vision1",
  "app": "spatialstash",
  "footprintMB": 1840,
  "availableMB": 920,
  "gpuMB": 1420,
  "photoWindows": 2,
  "slideshowWindows": 3,
  "gpuHigh": false,
  "ts": 1700000000000
}}
```

- `footprintMB` — `task_vm_info.phys_footprint` (what jetsam judges).
- `availableMB` — `os_proc_available_memory()` (headroom to the per-process limit).
- `gpuMB` — Metal `currentAllocatedSize` (GPU-private textures).
- `gpuHigh` — whether the client's oversized-decode / server-convert heuristic
  considers the device pressured.
- `ts` — client wall-clock (ms since epoch); the broker also stamps `recvTs`.

`reportLog` is an event-driven line (memory warnings, working-set trims,
oversized-decode guard hits). The broker appends it and echoes it to stdout.
The web kiosk also emits it for uncaught JS errors / unhandled promise
rejections (`domain: "js" | "promise" | "resource"`, `app: "roboframe-web"`),
rate-limited and deduped per page load — so a headless kiosk's frontend
crashes are visible without a console attached.

```json
{ "action": "reportLog", "payload": {
  "deviceId": "vision1",
  "app": "spatialstash",
  "level": "warning",
  "domain": "memory",
  "message": "Memory warning — trimmed 3 slideshow window(s), 2 photo window(s)",
  "ts": 1700000000000
}}
```

### `getDisplayState`, `ping`
Diagnostics. `getDisplayState { target: "<deviceId>" }` echoes the
cached `displayState` frame for that device (its `state`, including a
PIR/HA-driven `off`), or nothing if none is cached. It does not report
page-visibility — that is a separate concept carried by the `visibility`
action. `ping` → `pong`.

### `rpcsend` (rpc tier only)
Privileged broadcast — server forwards `payload.action` / `payload.payload`
verbatim to every connected client. Requires `rpcToken` both as the
WebSocket query token and as a `token` field on the message itself.

```json
{ "action": "rpcsend", "token": "<RPC_TOKEN>",
  "payload": { "action": "showText", "payload": { "text": "Doorbell" } } }
```

## Server → client messages

### `playback`
The channel's playback state. Pushed on every advance, displaySync claim,
mod-tag change, tag-list change, or visibility-driven resume. The only
server-pushed frame that's session-scoped — `sessionIds` carries every
session on the receiving ws that this frame is destined for. One frame
can therefore satisfy N sessions when multiple windows on one device
share a connection (e.g. all 10 windows in a room → one playback frame
with `sessionIds: ["win1", ..., "win10"]`).

```json
{ "action": "playback", "sessionIds": ["win1"], "payload": {
  "deviceId": "screen1",
  "mergeDriver": null,
  "interval": 15000,
  "currentList": 0,
  "modTags": ["rating:s"],
  "current":  { "id": 4181569, "ext": "jpg" },
  "next":     { "id": 4516954, "ext": "png" },
  "upcoming": [
    { "id": 4516954, "ext": "png" },
    { "id": 1042171, "ext": "png" },
    { "id": 4239038, "ext": "jpg" },
    { "id": 2192588, "ext": "webm", "durationMs": 122000 }
  ]
}}
```

- `deviceId` is the channel this frame belongs to. While merged, every
  client receives the driver's `deviceId` here regardless of their own.
- `mergeDriver` is the deviceId of the active displaySync claimer, or
  `null` when no merge is active.
- `current` / `next` / `upcoming` are id+ext only — fetch with
  `GET /get?id=<id>&convert=&bright=&width=&height=&lowmem=`. Server
  returns JPEG (q95) on the `convert` path; `lowmem=1` re-encodes
  non-JXL sources to JPEG q85 for kiosks without WebP hardware decode.
  `width`/`height` are optional: omit them (or `0`) to receive the source
  resolution; supply them to fit-inside-downscale. Clients SHOULD also
  pass `&deviceId=<their deviceId>` so the server's `/history` page can
  group the request under their display; omitting it files it under `others`.
- **Animated posts** (animated JXL / APNG) are content-negotiated by the
  same query params, and the response `Content-Type` is authoritative —
  the post's `ext` stays `jxl`, so clients must key rendering off the
  fetched MIME type, not the ext:
  - `convert=1` or `lowmem=1` → **`video/mp4`** (H.264), a short looping
    720p30 clip — the same encode budget as the video posts. Render it
    through a looping `<video>` (or mpv) exactly like a video post.
  - `vcodec=h264` → **`video/mp4`** (H.264) at the source resolution and
    frame rate (cap with `vmaxh`/`vmaxfps`; `0` = no cap). For clients
    that render H.264 as an animated image (Spatialstash's `<img>`).
  - `gif=1` → **`image/gif`** (256-color, per-frame timing preserved).
    The opt-out for clients that can't decode mp4 (PSP kiosk).
  - none of the above → **`image/webp`** (animated).
  Any of the mp4 paths fall back to WebP/GIF when the server has no
  usable H.264 encoder. A single fetch either way, so a client can pass
  its preferred flag on every request without knowing in advance whether
  a post is animated.
- `ext` can also be `mp4` or `webm` — those entries are videos, and they
  carry `durationMs` (the indexed clip length; absent when the library
  indexed 0). `/get` streams them straight from disk (`convert`,
  `bright`, `lowmem`, `width`, `height` are ignored) with
  `Accept-Ranges: bytes` and single-range support; `vcodec=h264`
  requests a hardware-decodable H.264 variant, capped by `vmaxh`/`vmaxfps`
  (height/fps; default 1080/30, `0` = source resolution / frame rate).
  Encoded via VideoToolbox when available, else libx264 `-preset ultrafast`.
  Clients
  should render with `<video autoplay muted playsInline>` pointed at the
  `/get` URL directly — do **not** fetch-to-blob and reuse, the clip
  may be ~100 MB and is likely to be cut off mid-loop by the next
  playback tick. Fire `imageReady` on `loadeddata` (first frame
  decoded), the same barrier as images. Use `current.durationMs` to set
  `loop` (shorter than the interval → loop; longer → play once) and
  report it back in `imageReady` — see `imageReady` above; the server
  already seeds the dwell from it, so a long clip plays through even if a
  client never reports.
- A new `current.id` is your cue to start loading. Send `imageReady`
  when the transition completes.
- Clients MUST pause video playback when the display is off
  (`displayState: off`, the page is hidden, or the platform equivalent
  — e.g. Spatialstash's `scenePhase` going to `.background`) and
  SHOULD release the media session entirely (`<video>` removed from
  the DOM, AVPlayer torn down) so single-source platforms like
  visionOS aren't pinned by a paused-but-attached video.

### `tagLists`
The catalog of preset tag lists, pushed on connect and rebroadcast when
the on-disk `data.json` changes. Shape:

```json
{ "action": "tagLists", "payload": [["robot","solo"], ["dragon","rating:s"]] }
```

Accepts both array-of-arrays (canonical) and array-of-strings
(space-separated) on the wire — the broker normalizes.

The active *index* into this catalog is per-channel and not broadcast
as a separate frame; it arrives in every `playback` payload as
`currentList`. See [`setTagList`](#settaglist-session-scoped).

There is no `blocked` frame. Block lists are server-only and clients
never receive them.

### `displayState` / `setBrightness` / `setSuppress`
Driven by inbound HA MQTT writes (or `rpcsend`). `target` is the kiosk's
`deviceId` — clients ignore frames not addressed to them.

```json
{ "action": "displayState", "payload": { "target": "screen1", "state": "off" } }
{ "action": "setBrightness", "payload": { "target": "screen1", "brightness": 64 } }
{ "action": "setSuppress", "payload": { "target": "screen1", "state": "on" } }
```

`setSuppress` engages the kiosk's local wake-suppressor. While on, PIR
motion is ignored and the panel is held off. Explicit `displayState`
commands and effect actions (`playVideo`, `playScene`, `showText`,
`playAudio`, `refresh`) still wake the panel — the switch only gates
ambient wake.

How a client honors `displayState: off` is platform-specific, but every
slideshow client should report `visibility { deviceId, false }` while
held off so the server parks the channel instead of riding the
readiness-timeout fallback. The web kiosk blanks its render layer (the
panel itself goes dark); Spatialstash keeps the current image rendered
and decoded — there's no physical panel to power down — so the PIR/HA
wake that follows (`displayState: on` → report `visibility true`)
resumes the same frame with no pop-in. While held off, do not send
`imageReady` — a hidden session is outside the readiness barrier and
reporting would drive the channel forward for a display nobody sees.
Ignore frames whose `state` field is missing entirely (treating a
state-less frame as "on" would re-enable a panel PIR had turned off).

### `displayDisconnect`
Broadcast when a WebSocket that previously claimed a `deviceId` (via
`slideshowConfig`, `visibility`, `reportDisplay`, `reportSensor`, or
`reportWebcam`) closes and was still the most recent reporter for that
id. Lets peer clients drop stale entries they accumulated from
`displayState` frames.

```json
{ "action": "displayDisconnect", "payload": { "target": "screen1" } }
```

The server retains its cached `displayState` and visibility for that
`deviceId` past the disconnect. When a client claiming the same id
(re)connects, the cached `displayState` is replayed to it after the
connect-time settle window — so panel state changes that arrive while
no client is connected (e.g. via HA MQTT or `rpcsend`) are not lost.
The cache is overwritten by the next report from the reconnected
client.

### `update`
Forwarded HA sensor reading (filtered by `HA_FILTER_ENTITIES`).

```json
{ "action": "update", "payload": {
  "entity": "sensor.outdoor_temperature",
  "state": "12.4",
  "attributes": { "unit_of_measurement": "°C", "friendly_name": "Outdoor temp" }
}}
```

### `searchEmpty`
Channel-scoped notification fired when a refill returns zero rows for a
non-empty tag query — typically a typo'd `setModTags` or an unsatisfiable
combination. Clients can surface this to logs / UI; the slideshow remains
paused on its current image.

```json
{ "action": "searchEmpty", "payload": { "query": "cats rare:tag" } }
```

### Effect frames
Broadcast to every client via `rpcsend` or MQTT RPC; render or ignore as
fits. Payload field names are stable.

| Action       | Payload fields                                  |
|--------------|-------------------------------------------------|
| `playVideo`  | `url`                                           |
| `stopVideo`  | —                                               |
| `playScene`  | `streamId`, `rtsp`, `whep`                      |
| `stopScene`  | —                                               |
| `showText`   | `text`, `bgColorHex`, `imageUrl`                |
| `dismissText`| —                                               |
| `playAudio`  | `url`                                           |
| `stopAudio`  | —                                               |
| `setWebcam`  | `target`, `state`                               |
| `mjpgstreaming` | (kiosk-internal; ignore on third-party clients) |
| `refresh`    | — (kiosk reloads the page)                      |
| `pong`       | reply to `ping`                                 |

`playScene` shows a **live** stream — a server-rendered animation page
published into mediamtx (see the scenes section in the README). The
payload carries one URL per transport and each client picks what it can
consume: the native kiosk plays `rtsp` in mpv (hardware H.264 decode),
the web kiosk subscribes to `whep` over WebRTC. Any credentials travel
as query parameters inside those URLs; `streamId` is informational.
Clients without a matching transport — or that don't implement the
action at all (Spatialstash may ignore it) — drop the frame silently.
A scene occupies the same screen tier as `playVideo`: starting either
tears the other down, and both pre-empt a playing slideshow video,
which resumes when the effect clears. The stream ending on its own
(producer stopped) is equivalent to `stopScene`. A `stopScene` never
tears down a `playVideo`.

```json
{ "action": "playScene", "payload": {
  "streamId": "aquarium",
  "rtsp": "rtsp://kiosk:secret@server:8554/aquarium",
  "whep": "http://server:8889/aquarium/whep?user=kiosk&pass=secret"
}}
```

## Critical flows

### The playback cycle (and the readiness barrier)

For each image:

1. Server picks the next post and broadcasts a `playback` frame with the
   new `current.id`. Channel state is *loading*.
2. Every visible session on the channel begins fetching/decoding/transitioning.
3. As each session finishes, it sends `imageReady { id: <current.id> }`.
4. The **first** visible session to report flips the channel to
   *displaying* and starts the dwell timer (`interval` ms) — first-ready
   wins, the rest don't gate it. If *no* visible session reports within
   `readyTimeoutMs` (default 15 s), the channel promotes anyway; after 3
   such cycles in a row it stalls on the current frame until some session
   shows a sign of life (see the readiness-timeout fallback above).
5. On dwell expiry, server advances the queue and goes back to step 1.

**Why this matters for client implementers:** the readiness timeout is a
recovery backstop, not the normal path. A healthy client reports within
a few hundred ms and the channel advances on that report. If your client
stops sending `imageReady` while staying connected — a frozen render
loop, a wedged decode — the channel rides the timeout for three cycles
(effective interval `interval + readyTimeoutMs`) and then stalls until
your client reports again; the stall is logged once naming the device.
Send `imageReady` exactly once per successful transition, with the exact
`id` from the most recent `playback.current`. If your client knows its
display is off, report `visibility {false}` instead of going silent —
that's the supported dark-display mode and keeps the channel advancing
on wall-clock time.

Hidden sessions (visibility=false on their deviceId) are auto-considered
ready, so a dark display never stalls the barrier.

### Presence drives freshness; the client never wake-advances

`present` flips control the slideshow. When every display on a `deviceId`
goes absent the server does **one** dark advance and parks; when a display
returns, that fresh post is committed and dwelled from when it's shown.
So walk out and back in and you see a **new** image — the server chose and
advanced it, silently, while you were away.

**Don't** implement client-side wake-advance ("I just woke up, request
next"). That's still forbidden — freshness-on-return is delivered entirely
by the server-side dark advance above, not by the client requesting `next`
on a visibility/presence change. Double-wakes (server dark-advance +
client `requestNext`) would skip too fast. The server already handled it;
trust it. (`visibility` is telemetry only and never advances anything.)

### View counting

A post's `display_count` (which feeds the least-seen deck ordering) is
credited **once a present screen confirms it rendered** — i.e. on the
first accepted [`imageReady`](#imageready-required-for-slideshow-sessions-session-scoped)
for a channel's current id, not when the server broadcasts the frame.
This means a post is never counted just because the server *chose* it:
a dark-advanced post no one saw, a frame broadcast to an all-absent
channel, and a readiness-**timeout** promotion (screens expected but none
acked within `SLIDESHOW_READY_TIMEOUT_MS`) all go uncounted. Counting is
deduped per showing (one count per channel per id; a recurring id counts
again as a genuine new view). Practical consequence: a client that never
sends `imageReady` never contributes views — every real client is
required to send it (see the checklist), so this only drops genuinely
unconfirmed displays.

### displaySync is a merge, not a primary gate

`displaySync { enabled: true }` doesn't designate "the one client who
can advance" — *every* client can always `requestNext`, `setModTags`,
`block`, etc. on its own channel. The merge claim does one thing:
collapses every channel into the driver's channel for the duration
of the claim, so every connected display mirrors the driver's image.
When the driver disconnects, the merge auto-releases.

There is no echo loop — clients only emit requests/reports, never
`playback` frames. So a follower advancing on its own (via `block` or
manual `requestNext`) is processed by the server, broadcast back to
the channel, and rendered by everyone exactly once.

### Blocklist is server-side and invisible to clients

The blocklist is *not* part of the wire protocol. When the broker
receives `block { id }` (or detects a hand-edit to
`imagemirror/data.json`), it filters the new id from every channel's
queue and advances any channel currently displaying it — clients see
the effect via the resulting `playback` frame, nothing else. There is
no `blocked` frame on the wire and no `getBlocked` query.

Implications for clients:
- Don't carry a local `blockedPosts` / `blockedTags` set in remote
  mode; you'd never populate it from anywhere.
- Don't filter `playback.current` against any local blocklist — by
  the time the server broadcasts a post id, it's intentional.
- After sending `block { id }` for the currently-displayed post, the
  server's advance is your visual feedback. Don't follow up with a
  client-side `requestNext` — that would double-skip.

### `deviceId` discipline

Pick a stable `deviceId` per logical display and use it consistently
across every session targeting that display. The orchestrator joins on
exact-string match — `"screen1"` and `"screen-1"` are different
channels. Browser kiosks read the value from the `?ws=` URL parameter;
node-display and Spatialstash pull it from their config.

For multi-window setups (e.g., two Spatialstash windows on the same
display), use the same `deviceId` so they share a channel; for windows
on different displays, use distinct `deviceId`s.

## Quick checklist for a new client

- [ ] Connect with `?token=<ACCESS_TOKEN>` (or `RPC_TOKEN` if you need `rpcsend`).
- [ ] On open, send `slideshowConfig { deviceId, interval, modTags?, ... }`. Re-send on every reconnect.
- [ ] On open, send `present { deviceId, present: true }` — the slideshow-control signal — and update it on background/foreground. (Send `visibility` too if you want to drive the HA motion sensor / home-location tracking.)
- [ ] Handle `tagLists` (arrives unsolicited on connect). Read the active list index from each `playback`'s `currentList`.
- [ ] On every `playback` frame, render `current` and prefetch `upcoming`.
- [ ] After each successful transition, send `imageReady { id }` with the same id you just rendered.
- [ ] **Don't** wake-advance locally on visibility/presence changes (the server's dark advance already refreshes on return).
- [ ] **Don't** drive your own dwell timer that races the server's.
- [ ] Reconnect with backoff on disconnect; halt on close code 1008 (auth failure).
