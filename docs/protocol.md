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
  and arrives in each `playback` frame's `currentList`.
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
`visibility`, `getDisplayState`, `ping`, `report*`, `rpcsend`) ignore
`sessionId`.

A session is created the first time the server sees `slideshowConfig`
for a `(ws, sessionId)` pair. Closing the underlying ws drops every
session attached to it; sending `sessionEnd { sessionId }` drops just
that one without disturbing the others.

### Channel grace window

When the last session on a channel disconnects (or is `sessionEnd`-ed)
the channel is *not* deleted immediately — its queue, cursor, mod tags,
interval, currentId, and any held merge claim linger for 2 minutes. A
reconnecting client (typical sleep/wake on a visionOS window) is rebound
to the surviving channel automatically when its `slideshowConfig` lands.
Cadence is paused for the duration; if no session rejoins by 2 min the
channel is fully evicted and any held merge claim is released.

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
  "ratio": "16:9",
  "width": 1920,
  "height": 1080,
  "bright": false,
  "convert": false,
  "lowmem": false,
  "modTags": ["rating:s", "-blood"]
}}
```

- `interval` is dwell time in ms (clamped to 2000–3600000).
- `modTags` is optional; when present, the orchestrator's first refill
  query already includes them — without that the initial query is
  discarded a few ms later when a separate `setModTags` arrives.
- `bright`, `convert`, `lowmem`, `width`, `height` are the variant
  fingerprint the server uses for background pre-conversion of upcoming
  images. They must match the corresponding `/get?…` query parameters
  this session will use, otherwise the prefetched bytes will be the
  wrong variant and every cycle pays the conversion cost on the hot
  path. Omitting `lowmem` is treated as `false` (back-compat with
  pre-prefetch clients).

### `imageReady` (required for slideshow sessions, session-scoped)
Tell the server the channel's current image is fully on screen.

```json
{ "sessionId": "win1", "action": "imageReady", "payload": { "id": 4181569 } }
```

The orchestrator's readiness barrier waits for every visible session
on the channel to report before starting the dwell timer. **If your
client doesn't send this, the channel rides the 10 s bad-network
fallback every cycle**, making the effective server cycle ~10 s longer
than the configured interval. Symptom: every-other server frame
triggers a cache miss / placeholder on the client side. Send it
exactly once per successful transition (matching the broadcast `current.id`).

### `visibility`
Report whether this `deviceId` is visible (page in foreground, screen
backlight on, etc.).

```json
{ "action": "visibility", "payload": { "deviceId": "screen1", "visible": false } }
```

Visibility is keyed on `deviceId`, not on the reporting socket — so
node-display's PIR loop can drive a kiosk's channel even though the
kiosk page is the one rendering. `false` pauses the channel's dwell
timer using a wall-clock deadline; `true` resumes the *remaining* time
(or advances immediately if the deadline already passed). Never bumps
the deadline — see *Visibility never resets the timer* below.

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
disconnecting does *not* release the merge — it only releases when the
driver channel is fully evicted (after the grace window).

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
commands and effect actions (`playVideo`, `showText`, `playAudio`,
`refresh`) still bypass it. The complementary inbound action is
`setSuppress { target, state }` — sent by the broker when HA writes the
switch's command topic.

### `getDisplayState`, `ping`
Diagnostics. `getDisplayState { target: "<deviceId>" }` echoes the
last `displayState` plus per-deviceId visibility; `ping` → `pong`.

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
    { "id": 4237092, "ext": "jpg" }
  ]
}}
```

- `deviceId` is the channel this frame belongs to. While merged, every
  client receives the driver's `deviceId` here regardless of their own.
- `mergeDriver` is the deviceId of the active displaySync claimer, or
  `null` when no merge is active.
- `current` / `next` / `upcoming` are id+ext only — fetch with
  `GET /get?id=<id>&convert=&bright=&width=&height=&lowmem=`. Server
  returns JPEG (q95) on the `convert` path and APNG for animated PNG
  posts; `lowmem=1` re-encodes non-JXL sources to JPEG q85 for kiosks
  without WebP hardware decode.
- A new `current.id` is your cue to start loading. Send `imageReady`
  when the transition completes.

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
commands and effect actions (`playVideo`, `showText`, `playAudio`,
`refresh`) still wake the panel — the switch only gates ambient wake.

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
| `showText`   | `text`, `bgColorHex`, `imageUrl`                |
| `dismissText`| —                                               |
| `playAudio`  | `url`                                           |
| `stopAudio`  | —                                               |
| `setWebcam`  | `target`, `state`                               |
| `mjpgstreaming` | (kiosk-internal; ignore on third-party clients) |
| `refresh`    | — (kiosk reloads the page)                      |
| `pong`       | reply to `ping`                                 |

## Critical flows

### The playback cycle (and the readiness barrier)

For each image:

1. Server picks the next post and broadcasts a `playback` frame with the
   new `current.id`. Channel state is *loading*.
2. Every visible session on the channel begins fetching/decoding/transitioning.
3. As each session finishes, it sends `imageReady { id: <current.id> }`.
4. When every session has reported (or 10 s passes — bad-network fallback),
   the channel transitions to *displaying* and starts the dwell timer
   (`interval` ms).
5. On dwell expiry, server advances the queue and goes back to step 1.

**Why this matters for client implementers:** if your client doesn't
send `imageReady`, the channel always rides the 10 s timeout. The
visible symptom is that the effective interval is `interval + 10 s`,
which drifts the server's broadcasts behind any client running its
own local timer at the configured `interval` — every other cycle
the local timer fires before the server's, the client drains its
prefetch queue, and shows a placeholder until the server catches up.
Send `imageReady` exactly once per successful transition, with the
exact `id` from the most recent `playback.current`.

Hidden sessions (visibility=false on their deviceId) are auto-considered
ready, so a dark display never stalls the barrier.

### Visibility never resets the timer

Visibility flips pause/resume the dwell timer using a wall-clock deadline
that survives suspend/resume cycles. A wake never bumps the deadline.
This means: if you walk out of a room and back in within the interval,
the same image is still showing with the rest of its dwell. If you walk
back in *after* the interval, the channel already advanced — you see the
current image at whatever point it's at.

**Don't** implement client-side wake-advance ("I just woke up, request
next"). That's the bug this rule was added to prevent: leaving and
re-entering a room would refresh the timer indefinitely, and
double-wakes (server-side wake-advance + client-side wake-advance)
caused too-fast advances. The server already knows whether the dwell
expired; trust it.

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
- [ ] On open, send `visibility { deviceId, visible: true }` (and update on background/foreground).
- [ ] Handle `tagLists` (arrives unsolicited on connect). Read the active list index from each `playback`'s `currentList`.
- [ ] On every `playback` frame, render `current` and prefetch `upcoming`.
- [ ] After each successful transition, send `imageReady { id }` with the same id you just rendered.
- [ ] **Don't** wake-advance locally on visibility changes.
- [ ] **Don't** drive your own dwell timer that races the server's.
- [ ] Reconnect with backoff on disconnect; halt on close code 1008 (auth failure).
