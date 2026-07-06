# RoboFrame

A modular digital photo frame system. Browser kiosks pull images from a local DuckDB-indexed library, optionally synchronise across devices, and integrate with Home Assistant.

## Quick start (5 minutes)

```bash
git clone https://github.com/illixion/roboframe.git
cd roboframe
npm install --workspaces

# 1. Build a posts.duckdb from any folder of images.
node packages/cli/src/index.mjs bootstrap ~/Pictures --output ./posts.duckdb

# 2. Start the server (image API + WebSocket broker + optional HA bridge in one process).
RPC_TOKEN=$(openssl rand -hex 16) DUCKDB_PATH=./posts.duckdb IMAGE_DB_PATH=~/Pictures npm start
```

Open `http://localhost:3123/index.html` in a browser. That's it — one origin,
one process, serves the page, the API, and the WebSocket.

## Architecture

There is **one server process**. It runs from the `imagemirror/` workspace
(historical name; absorbs everything formerly split across `rpcserver/`):
- serves the kiosk frontend (`public/index.html`, `sobel.js`, `auth-overlay.{js,css}`),
- serves the image API (`/search`, `/random`, `/get`, `/save`, `/history`, `/addtohistory`),
- runs the WebSocket broker on `/rpc/ws` and HTTP RPC routes (`/rpc/send`, `/rpc/deviceDC`, `/rpc/tags.json`),
- optionally bridges to Home Assistant — auto-enabled when both `HA_URL` and `HA_TOKEN` are set.

`node-display` is a separate on-device daemon (per kiosk) that connects to
the server's WebSocket to drive backlight / brightness based on what the
server pushes.

### nginx — root deployment

One block, one upstream:

```nginx
location / {
    proxy_pass http://127.0.0.1:3123;
    proxy_http_version 1.1;
    proxy_set_header Upgrade $http_upgrade;
    proxy_set_header Connection "upgrade";
    proxy_set_header Host $host;
    proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
    proxy_set_header X-Forwarded-Proto $scheme;
    add_header Cache-Control "no-cache, no-store, must-revalidate";
    add_header Pragma "no-cache";
    add_header Expires 0;
    # WebSocket connections are long-lived; bump nginx's defaults.
    proxy_read_timeout 3600s;
    proxy_send_timeout 3600s;
    proxy_connect_timeout 3600s;
}
```

### nginx — mounting under a sub-path

Serve the kiosk at, e.g., `/mywallpaperpage/` while another app owns `/`.
The kiosk auto-detects its base path from `location.pathname`, so API calls
(`/mywallpaperpage/search`) and the WebSocket (`/mywallpaperpage/rpc/ws`)
both use the prefix without any URL parameters. nginx just needs one
location with the prefix stripped on the way through:

```nginx
location /mywallpaperpage/ {
    proxy_pass http://127.0.0.1:3123/;     # trailing slash strips /mywallpaperpage
    proxy_http_version 1.1;
    proxy_set_header Upgrade $http_upgrade;
    proxy_set_header Connection "upgrade";
    proxy_set_header Host $host;
    proxy_set_header X-Real-IP $remote_addr;
    proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
    proxy_set_header X-Forwarded-Proto $scheme;
    add_header Cache-Control "no-cache, no-store, must-revalidate";
    add_header Pragma "no-cache";
    add_header Expires 0;
    # WebSocket connections are long-lived; bump nginx's defaults.
    proxy_read_timeout 3600s;
    proxy_send_timeout 3600s;
    proxy_connect_timeout 3600s;
}
```

For dev / split deployments where the kiosk is on a different host than the
backend, the page accepts URL params:

- `?endpoint=https://my-backend` — overrides the API base for `/search`, `/get`, `/save`, `/addtohistory`, and (derived) `/rpc/ws`.
- `?wsurl=wss://...` — overrides the WebSocket URL only.

Without those params, everything is same-origin and relative.

## Components

| Component | Port | Purpose |
|---|---|---|
| `imagemirror` (the server) | 3123 | One process. Serves the kiosk, the image API (`/search`, `/random`, `/get`, `/save`, `/history`, `/addtohistory`), the WebSocket broker (`/rpc/ws`) and HTTP RPC routes (`/rpc/send`, `/rpc/deviceDC`, `/rpc/tags.json`), and the optional Home Assistant bridge (auto-enabled when `HA_URL` + `HA_TOKEN` are set). Reads `posts.duckdb` read-only. |
| `node-display` | — | On-device daemon (per kiosk). Turns the display on/off and adjusts brightness based on WebSocket messages, PIR motion, ambient light. macOS / Raspberry Pi (DDC/CI) / generic Linux. |
| `public/index.html` | — | Slideshow frontend, served by the server. Configurable via URL params. |
| `packages/cli` | — | `roboframe-cli bootstrap` (build a DB) and `roboframe-cli doctor` (validate one). |

## The bootstrap CLI

`packages/cli/src/index.mjs bootstrap` walks a directory, probes each image (via `sharp`) and video (via `ffprobe` if available), and writes a `posts.duckdb` matching the schema imagemirror expects.

```
roboframe-cli bootstrap <imageDir> [options]

  --output ./posts.duckdb    target DB path
  --tags-from-folders        derive tags from ancestor folder names (default: on)
  --tags-from-sidecar        read <stem>.tags.json sidecars (default: off)
  --include-videos           probe videos via ffprobe (default: on if ffprobe present)
  --extensions <csv>         file extensions to include
  --start-id <n>             first _id to assign (default: 1)
  --batch-size <n>           rows per INSERT batch (default: 500)
  --resume                   skip files already present in the DB
  --dry-run                  print summary, don't write
```

Folder structure → tags. Given `~/Pictures/landscape/sunset/IMG_0001.jpg`, the post gets tags `["landscape", "sunset", "_imported"]`. Numeric folder names (`0/`, `1/`, ...) are skipped because they're chunk subfolders, not meaningful tags. Videos additionally get `_videos`.

Sidecars are optional and disabled by default. If enabled, `IMG_0001.tags.json` next to an image gets merged in:

```json
{ "tags": ["beach", "vacation"], "rating": "s", "score": 50 }
```

After bootstrapping, validate with:

```bash
node packages/cli/src/index.mjs doctor --db ./posts.duckdb
```

The CLI is the **only** writer to the DB; imagemirror opens it read-only. Future schema changes ship as additional `packages/cli/sql/*.sql` files.

## DuckDB schema

The CLI creates two tables:

```sql
posts(_id INTEGER PRIMARY KEY, tags VARCHAR[], file_ext VARCHAR,
      score INTEGER, fav_count INTEGER, rating VARCHAR,
      image_width INTEGER, image_height INTEGER, ratio DOUBLE,
      duration DOUBLE, change_seq INTEGER, parent_id INTEGER)
posts_paths(_id INTEGER, path VARCHAR)
```

If you already have a database from another source, it just needs to expose those columns. imagemirror's full schema dependencies are `_id, tags, file_ext, score, fav_count, rating, image_width, image_height, ratio, duration, change_seq, parent_id` on `posts`, plus `_id, path` on `posts_paths`.

## Configuration

All three services read from a single `roboframe.config.json` at the repo
root. Copy the example to start:

```bash
cp roboframe.config.example.json roboframe.config.json
$EDITOR roboframe.config.json
```

The file is gitignored. Environment variables override anything in it (so
existing systemd units with `Environment=PORT=...` keep working as-is).
Resolution order: **env var → config file → built-in default**.

The loader walks up from the working directory looking for the file, or you
can point it explicitly via `ROBOFRAME_CONFIG=/path/to/file`.

The keys below show the env-var name and the corresponding nested path in
the config file (e.g. `IMAGE_DB_PATH` ↔ `imagemirror.imageDbPath`).

### Server (`server.*`)
The merged Node server: image API + WebSocket broker + optional Home Assistant bridge, all in one process on one port.

| Env var | Config key | Default | Description |
|---|---|---|---|
| `PORT` | `server.port` | `3123` | Listen port (the single front-door port) |
| `SERVER_HOST` | `server.host` | `localhost` | Listen host. Keep `localhost` for local-only access, or set `0.0.0.0` to accept connections from other machines. |
| `RPC_TOKEN` | `server.rpcToken` | *(required)* | Privileged token. Required to call `rpcsend` over the WebSocket and the HTTP `/rpc/send` endpoint, both of which can broadcast arbitrary actions. |
| `ACCESS_TOKEN` | `accessToken` *(top-level)* | *(required)* | Read-mostly token shared by every consumer (kiosks, node-display, spatialstash). Required to connect to `/rpc/ws` (kiosk tier — broadcasts + kiosk-scoped actions, not `rpcsend`) and to call the image API routes (`/get`, `/save`, `/history`, `/addtohistory`, `/rpc/tags.json`) via `?token=` or the `X-RoboFrame-Token` header. Top-level so the same value can be copied to client configs. Must differ from `rpcToken`. |
| `DATA_PATH` | `server.dataPath` | `imagemirror/data.json` | Hand-editable JSON store: `blockedIds`, `blockedTags`, `tagLists`. Pre-created with empty arrays on first launch; file-watched. Tag-list edits rebroadcast to clients; blocklist edits apply server-side only (no client-visible frame). |
| `IMAGE_DB_PATH` | `server.imageDbPath` | `/Volumes/HDD/imagedb` | Folder where image files live |
| `IMAGE_MIRROR_PATH` | `server.imageMirrorPath` | `/Volumes/HDD/imagedb_mirror` | Fallback folder if a file is missing |
| `SAVE_PATH` | `server.savePath` | `/tmp` | Where `/save` copies files to |
| `DUCKDB_PATH` | `server.duckdbPath` | `posts.duckdb` | Path to the DuckDB file |
| `DUCKDB_THREADS` | `server.duckdbThreads` | `4` | Max cores per DuckDB query (`0` = all cores). Applied at startup, not hot-reloaded. |
| `DJXL_PATH` | `server.djxlPath` | `djxl` | Path to the JPEG-XL decoder |
| `HA_URL` | `server.ha.url` | *(none)* | Home Assistant WebSocket URL — sensor forwarding auto-enables when set with token |
| `HA_TOKEN` | `server.ha.token` | *(none)* | Home Assistant long-lived access token |
| `HA_FILTER_ENTITIES` | `server.ha.filterEntities` | *(none)* | Sensor entity_ids to forward to kiosks (CSV in env, array in JSON) |
| — | `server.mqtt.url` | *(none)* | MQTT broker URL (e.g. `mqtt://homeassistant.local:1883`). Empty = MQTT bridge disabled. |
| — | `server.mqtt.username` / `password` | *(none)* | MQTT credentials |
| — | `server.mqtt.discoveryPrefix` | `homeassistant` | HA MQTT-discovery topic prefix |
| — | `server.mqtt.topicPrefix` | `roboframe` | Per-device state/command topic prefix |
| `SLIDESHOW_RATIO_WINDOW` | `server.slideshow.ratioWindow` | `0.15` | ±tolerance the orchestrator expands a client's raw aspect ratio into when matching posts. Hot-reloaded. |
| `RANDOM_RANK_REFRESH_HOURS` | `server.slideshow.rankRefreshHours` | `24` | How often (in hours) the in-memory `random_ranks` table is rebuilt — reshuffling the random ordering and zeroing every post's view count so the slideshow keeps cycling fresh material. Set to `0` (or any non-positive value) to **disable** the periodic rebuild entirely; the ranks built at startup then persist until a manual `reshuffle`. Applied at startup (not hot-reloaded). |
| `SLIDESHOW_SHARED_TAGS` | `server.slideshow.sharedTags` | `false` | When `true`, the active tag-list index **and** the mod tags become one global selection shared by every channel regardless of `deviceId`: a `setTagList` / `setModTags` from any session reselects for all displays at once, and the per-channel state is bypassed. Distinct from `displaySync` (which merges *playback frames* but leaves each channel's query independent) — here only the *query selection* is shared, each channel still runs its own queue, interval, and cursor. Hot-reloaded. |
| `SLIDESHOW_READY_TIMEOUT_MS` | `server.slideshow.readyTimeoutMs` | `15000` | Readiness-barrier fallback budget (ms). If no visible session reports `imageReady` for a freshly-broadcast frame within this budget, the channel promotes the frame anyway and logs the unreporting session keys — recovering a client that stays connected but stops reporting (a frozen render loop, not a dead socket) without a manual *next* or reconnect. Per-channel (keys on `deviceId`). Set `0` to disable (park on the frame until a report arrives). Hot-reloaded; applies on the next loading phase. |

### Display daemon (`display.*`)
On-device daemon (per kiosk). Lives in `node-display/`.

| Env var | Config key | Default | Description |
|---|---|---|---|
| `WS_URL` | `display.wsUrl` | `ws://localhost:3123/rpc/ws` | Server WebSocket URL |
| `ACCESS_TOKEN` | `accessToken` *(top-level)* | *(required)* | Read-mostly access token; appended as `?token=` on connect. Must match the server's `ACCESS_TOKEN`. |
| `SCREEN_WATCHER_PATH` | `display.screenWatcherPath` | *(none)* | Optional macOS screensaver event script |
| `PIR_HTTP_PORT` | `display.pirHttp.port` | `8765` | Local HTTP listener for the on-device PIR agent (Linux/Pi) |
| `DIM_TO_OFF_SECONDS` | `display.dimToOffSeconds` | `120` | Pi only. Two-stage power-down: a `display off` first drops the DDC backlight (instant, panel black, HDMI link stays alive — wake is a single setvcp). After this many seconds of continued inactivity, escalates to `xset dpms force off` so the panel actually sleeps. `0` disables the dim stage and goes straight to DPMS off (the previous behaviour). `null` disables the escalation — the display stays in the dim stage indefinitely, wake is always fast but the panel is never fully powered down. |

## PIR motion (Linux / Raspberry Pi)

`node-display` runs a small HTTP listener on `127.0.0.1:8765` and turns the kiosk display on/off in response to two endpoints. This is the integration point for any GPIO-attached PIR sensor — bring your own agent.

```
POST /pir/motion    -> display on  + reports state to HA via MQTT
POST /pir/clear     -> display off + reports state to HA via MQTT
```

Body is optional; if present and JSON, an explicit `{"state":"motion"|"clear"}` overrides the URL-derived state. Listener is bound to localhost only.

## Webcam / camera streaming (Linux / Raspberry Pi)

`node-display` can expose the frame's camera as an MJPEG stream for an
NVR / Scrypted / HomeKit Secure Video / VLC / browser to consume. The
kiosks themselves never display it — this turns the device into a camera
source, toggleable from Home Assistant. It is **off by default and needs
setup**; it is not plug-and-play.

**Prerequisites (not installed by `npm install`):**

- `sudo apt install v4l-utils` — capture shells out to `v4l2-ctl`. Without
  it the stream fails to start (ENOENT).
- `sudo apt install alsa-utils` — only if you enable audio; the mic path
  shells out to `arecord`.
- **Linux only.** Guarded by the platform check, so the macOS daemon build
  ignores webcam config entirely.
- **A USB UVC webcam that outputs MJPG.** Capture requests the V4L2 `MJPG`
  pixelformat directly (no transcode). A Raspberry Pi CSI camera module
  (libcamera) does not present an MJPG V4L2 node the same way and is not a
  drop-in — use a USB webcam, or bridge the CSI camera to a V4L2 MJPG node
  yourself. Run `v4l2-ctl -d /dev/video0 --list-formats` to confirm your
  device offers `MJPG`.

**Enable it** in `display.webcam` (see `roboframe.config.example.json`):

| Env var | Config key | Default | Description |
|---|---|---|---|
| — | `display.webcam.enabled` | `false` | Start the listener at boot. Leave `false` to keep it dark until the HA switch turns it on. |
| `WEBCAM_DEVICE` | `display.webcam.device` | `/dev/video0` | V4L2 device. Setting it (even to the default) instantiates the stream server so the HA switch works with `enabled: false`. |
| `WEBCAM_WIDTH` / `WEBCAM_HEIGHT` | `display.webcam.width` / `.height` | `1280` / `720` | Capture resolution (must be an MJPG mode the camera supports). |
| `WEBCAM_FRAMERATE` | `display.webcam.framerate` | `30` | Capture framerate. |
| `WEBCAM_PORT` | `display.webcam.port` | `8082` | HTTP listen port, bound `0.0.0.0`. |
| — | `display.webcam.tokens` | `[]` | Config-only. When non-empty, every media endpoint requires a matching `?token=` or `Authorization: Bearer`. `/health` stays open. |
| — | `display.webcam.controls` | `{}` | Config-only. `v4l2-ctl --set-ctrl` pairs reapplied on each capture (re)start, in listed order (put dependent controls last). Common UVC fixes: `power_line_frequency=1` (50 Hz) / `2` (60 Hz) anti-flicker, `exposure_dynamic_framerate=0` to stop fps dropping in dim light. `v4l2-ctl -d <device> --list-ctrls` shows what your camera supports. |
| — | `display.webcam.audio.enabled` | `false` | Enable the `/audio.pcm` mic feed (needs `alsa-utils`). While off, `/audio.pcm` returns 404. |
| `WEBCAM_AUDIO_DEVICE` | `display.webcam.audio.device` | `hw:1,0` | ALSA capture device. Use the stable by-id form from `arecord -L` (e.g. `hw:CARD=U0x46d0x825,DEV=0`), **not** a numeric `hw:N,0` — card indices shift across reboots as USB/HDMI probe order changes. |
| `WEBCAM_AUDIO_RATE` / `WEBCAM_AUDIO_CHANNELS` | `display.webcam.audio.rate` / `.channels` | `16000` / `1` | Mic PCM format (`S16_LE`). |

**Endpoints** (on `http://<pi>:<port>/`):

```
GET /stream.mjpg    multipart/x-mixed-replace MJPEG (Scrypted, HKSV, VLC, browsers)
GET /snapshot.jpg   one frame, then close
GET /audio.pcm      raw S16_LE PCM from the mic (if configured); mux A/V in the consumer
GET /pir/state      {"motion":bool} snapshot of PIR presence (if PIR is wired)
GET /pir/events     text/event-stream of motion/clear — mirror PIR onto an NVR motion sensor
GET /health         liveness, always unauthenticated
```

Capture is reference-counted: the `v4l2-ctl` / `arecord` processes only run
while a client is attached, so an idle stream burns no CPU or USB bandwidth.
Home Assistant gets an auto-discovered switch
(`roboframe/switch/<deviceId>/webcam/set`) that starts/stops the listener at
runtime. For off-LAN access, front the port with tailscale-serve (or similar)
and set `tokens` so the exposed endpoint isn't open.

## Local data store

The broker keeps three pieces of per-install state in a single JSON file at `imagemirror/data.json` (override via `DATA_PATH` env / `server.dataPath` config):

```json
{
  "blockedIds": [],
  "blockedTags": [],
  "tagLists": []
}
```

- `blockedIds` — array of post IDs the orchestrator filters out of every channel's queue. Mutated by the broker when a `block` action arrives; safe to add/remove entries by hand. Server-only — clients never see this list.
- `blockedTags` — array of tag strings to filter out. Hand-edited; same server-only treatment.
- `tagLists` — the named groups your kiosk cycles through. Canonical shape is array-of-arrays of strings (`[["robot","solo"], ["dragon","rating:s"]]`); the broker also accepts the looser space-separated form (`["robot solo", "dragon rating:s"]`).

The file is created with empty arrays on first launch if missing, so a fresh install starts up cleanly without manual setup.

The broker watches the file. Any external edit to `tagLists` re-broadcasts a `tagLists` frame. Edits to `blockedIds` / `blockedTags` apply server-side only — the orchestrator drops the newly blocked posts from every channel's queue and advances any channel that was just showing one, but no `blocked` frame is sent to clients. No reload, no nginx cache.

On WebSocket connect, every client receives two initial frames: `tagLists`, `currentTagList`. For non-WebSocket clients the catalog is available at `GET /rpc/tags.json`.

## Frontend (kiosk) URL parameters

| Param | Description |
|---|---|
| `endpoint` | Backend base URL. Default: same origin (no prefix). Useful for split deployments. |
| `homeendpoint` | Home Assistant URL for an iframe overlay |
| `wsurl` | WebSocket URL override. Default: derived from `endpoint`, or same-origin `/rpc/ws`. |
| `ws` | Device ID for WebSocket identification — required to receive `playback` and `displayState` |
| `delay` | Initial slideshow interval, seconds (default 15). The orchestrator can override this at runtime. |
| `noclock` | Boolean (0/1). Hides the clock and date overlay and repositions the corner buttons. |
| `nosensors` | Boolean (0/1). Hides the sensor readout overlay. |
| `lowmem` | Boolean (0/1). Collapses the slideshow prefetch window to next-image-only and forces `/get` to re-encode non-JXL sources to JPEG q85. Required for Pi-class kiosks — WebP/PNG software decode at 1080p saturates the ARM cores. |
| `nightlightstart`, `nightlightend` | `HH:MM` clock window (24h, kiosk local time). While inside the window the kiosk auto-enables `bright` mode. Cross-midnight (e.g. `22:00`–`06:00`) is supported. Either missing or equal disables the schedule. |
| `static`, `ratio`, `convert`, `bright`, `nobutton`, `nobg` | Boolean flags (0/1). `bright` ambient-dims the image at the server (used for night-light or any always-dim deployment); a manual `bright=1` is OR-ed with the night-light schedule. |
| `width`, `height` | Screen dimensions used when fetching `/get` |
| `top-offset` | CSS top padding (notch / overscan) |
| `list` | Initial tag list index |

## API reference

### imagemirror

`GET /get?id=&convert=&bright=&width=&height=&lowmem=&wallpaper=&vcodec=&deviceId=&record=`
Returns the binary image. For video posts, `vcodec=h264` serves an H.264 ≤1080p fragmented-MP4 variant for kiosks that only hardware-decode H.264 (Pi-class): the first request streams ffmpeg's output live while tee'ing it into a disk cache (`server.video.cachePath`, default `imagemirror/video_cache/`, LRU-pruned to `server.video.cacheMaxBytes`), and replays stream the cached file with Range support. Sources that are already H.264 ≤1080p are served raw, as is everything when ffmpeg is absent (`server.video.ffmpegPath` to point at a non-PATH build; encoder auto-picks `h264_videotoolbox` over `libx264`). `deviceId` tags the request for `/history`'s per-display grouping (omitted → `others`); `record=0` suppresses the history entry entirely (used by the `/history` page's own thumbnail fetches and by clients that record via `/addtohistory`). `convert=1` decodes JXL via `djxl` and re-encodes to JPEG q95 with a black background flatten. `bright=1` ambient-dims the result for low-light viewing (RGB multiply by 0.32 / 0.20 depending on average image brightness). `lowmem=1` re-encodes non-JXL sources to JPEG q85 so kiosks without WebP/PNG hardware decode (Pi 3 etc.) don't saturate their ARM cores. `wallpaper=1` composes the image onto a virtual canvas of exactly `width`×`height` (so the output always matches the target device's resolution). When the image's aspect is close to the canvas (a cover-crop would discard ≤15% of its longer side) it's cover-cropped and centered, filling edge to edge with no bars. When the mismatch is larger it's fit whole and the leftover gap — top/bottom for an image wider than the canvas, left/right for one taller — is filled: a solid-coloured image edge extends its colour across the gap on that side (so flat bars/backgrounds continue seamlessly), and any remaining gap gets a blurred copy of the image. A wider-than-canvas image on a portrait phone is biased down into the notification area so the clock area stays calm; otherwise it's centered. Built for setting a device wallpaper / lock screen from any aspect on any display. Animated PNGs always come back as APNG.

`GET /save?id=`
Copies the file to `SAVE_PATH`, resolving its location from the post's `posts_paths` entry (with the `IMAGE_MIRROR_PATH` fallback). The saved file keeps the source's real extension. **Local-only**: 404 if not on disk. No third-party fetches, ever.

`GET /history?lowmem=`
HTML page rendering recent image requests **grouped by display**. Each display's most recent 10 images load up front; the rest sit behind a per-display *Show N more* button that fetches their thumbnails only when expanded, so the page doesn't fire every `/get` at once. A display is identified by the `deviceId` its kiosk attaches to `/get`; requests without one (iOS Shortcuts via `/random`, ad-hoc `/get`) group under `others`. Thumbnails load via `/get` from the browser; `lowmem=1` propagates into the in-page `/get` URLs for Pi-class kiosks viewing their own history.

`GET /addtohistory?id=&deviceId=`
Records a post ID in the rolling history without fetching its bytes. Optional `deviceId` files it under that display; omitted → `others`.

`GET /post?id=` *(debug)*
Returns the full DuckDB row for a post (joined with `posts_paths.path`) as JSON. Token-gated. Exposed on the web kiosk as `await getPost(id)` in devtools.

`GET /count?q=` *(debug)*
Returns `{ q, count }` — the total number of posts matching `q` using the same parser as `/search`. Token-gated. Exposed on the web kiosk as `await countPosts(q)` in devtools.

`GET /custom_page`
Picks a random `.htm`/`.html` file from `CUSTOM_PAGES_PATH` (default `imagemirror/custom_pages/`, gitignored) and returns it inline with `Cache-Control: no-store`. The kiosk's **P** key toggles between photo slideshow and a fullscreen iframe pointing at this endpoint — each toggle-on cache-busts the URL so a new random page is served. 404 if the folder is missing or empty. Files are served straight from disk; any images/scripts/fonts they reference must be inlined or absolute. Token-gated.

`GET /search?q=&limit=` *(debug)*
Runs `q` through the same parser the slideshow orchestrator uses (`tag`, `-tag`, `score:`, `limit:N`, `order:`, etc.) and returns `{ results, nextCursor }` as JSON. `limit` defaults to 40 unless overridden by `?limit=` or `limit:N` inside `q`. Token-gated. Exposed on the web kiosk as `await searchPosts(q, limit)` in devtools. The slideshow itself still consumes posts via the `playback` WebSocket channel — this endpoint is for inspection only.

`GET /random?q=&list=&ratio=&order=&convert=&bright=&width=&height=&lowmem=&wallpaper=&json=`
Picks one matching post and serves it. Built for scheduled clients (e.g. an iOS Shortcut that sets a wallpaper). `q` is a query string (same syntax as `/search`); `list=N` joins the server-side tag list at index `N` (combined with `q` if both are given); `ratio=` is a bare aspect ratio (`width/height`) expanded into a `ratio:lo..hi` clause using the same `server.slideshow.ratioWindow` the kiosks use — except `wallpaper=1&ratio=1`, which instead returns the best-fitting post — closest to the canvas aspect (`width/height`) — out of a random least-seen chunk of the matching set (no hard window, ignores `ratioWindow`). So a `9:16`-class library favours its best fits for the device while still rotating through the whole set least-seen-first (a viewed post is only picked once no less-seen one is in the chunk), instead of looping the handful at the single closest ratio. `convert`/`bright`/`width`/`height`/`lowmem`/`wallpaper` pass through to the same variant pipeline as `/get` (so `wallpaper=1&width=&height=` returns a ready-to-set wallpaper at the device's resolution), and videos stream with Range support. `json=1` returns `{ id, ext }` instead of the bytes. 404 if nothing matches. Token-gated.

By default `/random` walks the shared `random_ranks` deck least-seen-first and bumps the picked post's view count, so repeated calls shuffle through the matching set *without replacement* (every post once before any repeats) — much better spread for a scheduled wallpaper than independent draws. This shares the deck with the slideshow, so a wallpaper pick also deprioritises that post on the frame until the next reshuffle (`rankRefreshHours`). Pass `order=random` for independent uniform draws *with* replacement instead, which ignores and doesn't touch the view counts. (Note: `/search?limit=1` is *not* a substitute for the deck mode — it returns the deck's current least-seen head without advancing it, so it yields the same post until the slideshow moves on.)

The server-side blocklist (`data.json`'s `blockedIds`/`blockedTags`) is applied in SQL in both modes so a blocked post is never picked — additive to any `-tag` exclusions in `q`, matching how the orchestrator filters its queue.

### Tag matching and the match-set cache

Every query path (slideshow refills, `/search`, `/count`, `/random`) resolves through one materialized id set per distinct query: the expensive tag filter runs once, and pages/picks then work off the cached set (concurrent callers of the same query share a single build — relevant for `sharedTags` fleets). Sets live for the server's lifetime, LRU-capped; `reshuffle` drops them all.

When the library ships a `posts_tags` inverted index (built by `roboframe-cli bootstrap`, or the archival ingest pipeline), tag terms probe it instead of scanning the `posts.tags` arrays, and — if `tag_aliases`/`tag_implications` tables are present — every tag term expands at query time: querying, excluding, or blocking a tag also covers its alias spellings and the full transitive closure of tags that imply it (querying `felid` matches posts tagged only `cat`). Libraries without `posts_tags` (flattened or folder-import) keep literal matching against the arrays.

### Server WebSocket `/rpc/ws`

The full client protocol — every action, every payload shape, the
playback / readiness / displaySync / visibility flows, and the gotchas
that bit the existing clients — lives in [docs/protocol.md](docs/protocol.md).
Read that before writing a new client.

WebSocket auth: connections to `/rpc/ws` must present `?token=<ACCESS_TOKEN>`
(access tier — broadcasts + kiosk actions) or `?token=<RPC_TOKEN>` (rpc
tier — adds `rpcsend`). Browser kiosks pass it via `?token=` on the page
URL; node-display reads `ACCESS_TOKEN` from env/config.

### Home Assistant MQTT entities

When `server.mqtt.url` is set, the broker connects to the configured MQTT broker and publishes retained discovery. Per kiosk it sees:

- `light.roboframe_<deviceId>_backlight` — on/off + brightness (0–255). HA writes flow back to the kiosk via the WebSocket `setBrightness` / `displayState` actions.
- `binary_sensor.roboframe_<deviceId>_motion` — driven by the kiosk's `visibility` action (web frontend / spatialstash) and the on-device PIR HTTP endpoints.
- `binary_sensor.roboframe_<deviceId>_connected` — `connectivity` class, ON whenever at least one WebSocket session has claimed this `deviceId` (browser kiosk, Spatialstash window, native kiosk, or node-display). Flips OFF on the last disconnect. Not retained — after a broker restart the state is `unknown` until a client (re)connects.
- **Connection device triggers** — for every `deviceId` the broker also publishes two MQTT device triggers, exposed in HA as `device` → `RoboFrame <id>` → trigger types `connected` and `disconnected`. These fire HA events directly on the connect/disconnect edge and are immune to the `unknown` / `unavailable` transitions that complicate state-based triggers. Prefer these for automations.
- `sensor.roboframe_<deviceId>_als` — ambient light reading, published when the kiosk reports one.
- `switch.roboframe_<deviceId>_suppress` — when ON, the kiosk's wake-suppressor is engaged: PIR motion will not wake the panel.

#### Automation: hand off suppress between two displays

When the kitchen frame is connected, suppress wake on the living-room frame, and vice versa:

Uses the MQTT-published device triggers — fire on the actual connect/disconnect edge, with no entity-state plumbing in between:

```yaml
automation:
  - alias: RoboFrame — hand off suppress when kitchen connects
    trigger:
      - platform: mqtt
        topic: roboframe/event/kitchen/connection
        payload: connected
    action:
      - service: switch.turn_on
        target:
          entity_id: switch.roboframe_livingroom_suppress
      - service: switch.turn_off
        target:
          entity_id: switch.roboframe_kitchen_suppress

  - alias: RoboFrame — hand off suppress when kitchen disconnects
    trigger:
      - platform: mqtt
        topic: roboframe/event/kitchen/connection
        payload: disconnected
    action:
      - service: switch.turn_off
        target:
          entity_id: switch.roboframe_livingroom_suppress
      - service: switch.turn_on
        target:
          entity_id: switch.roboframe_kitchen_suppress
```

The same triggers are also pickable from the UI: **Settings → Devices → RoboFrame kitchen → Add automation → Device → Connected / Disconnected**.

Server-wide:

- `button.roboframe_dismiss` — clears any active video / text / audio overlay on every connected kiosk. Press it from a dashboard or call `button.press` from an automation.

There is no manual entity setup in HA: a freshly-connected kiosk shows up on its own.

### MQTT RPC topic

`<topicPrefix>/rpc/cmd` (default `roboframe/rpc/cmd`) accepts arbitrary `{action, payload}` JSON; the broker rebroadcasts it to every connected client. This is the recommended path for HA-driven actions like `playVideo` and `showText` — fire-and-forget, no token, no HTTP.

```yaml
# Show a notification banner on every kiosk for 10 seconds.
service: mqtt.publish
data:
  topic: roboframe/rpc/cmd
  payload: >-
    {"action":"showText","payload":{"text":"Doorbell","bgColorHex":"#3344ff"}}
```

```yaml
# Dismiss any active overlay (equivalent to pressing the dismiss button).
service: button.press
target:
  entity_id: button.roboframe_dismiss
```

### Server HTTP RPC

`GET /rpc/send?action=&payload=&token=` — token-auth'd HTTP→WS bridge.
`GET /rpc/tags.json` — fallback for non-WebSocket clients.
`POST /rpc/deviceDC` — `navigator.sendBeacon` target for kiosk page-unload notifications.

## Tests

```bash
npm test
# 14 cases in imagemirror/test/parseQuery.test.js — query parser security/correctness.
```

## Deployment

A minimal systemd unit for the display daemon:

```ini
[Unit]
Description=RoboFrame Display Client
After=network.target

[Service]
Type=simple
User=pi
WorkingDirectory=/home/pi/roboframe/node-display
Environment=WS_URL=ws://your-server-host:3123/rpc/ws
ExecStart=/usr/bin/node server.js
Restart=always
RestartSec=3

[Install]
WantedBy=multi-user.target
```

The Pi build of `node-display` uses `ddcutil` for backlight brightness control via DDC/CI. The bus is auto-discovered via `ddcutil detect`; set `DDC_BUS` to override. If `ddcutil` is missing or the attached panel does not respond to DDC/CI, brightness control is disabled and the daemon falls back to DPMS-only on/off (a brightness of `0` powers the panel off, any non-zero value powers it on).

## License

MIT — see [LICENSE](LICENSE).
