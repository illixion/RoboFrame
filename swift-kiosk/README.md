# swift-kiosk

The Swift frontend for Pi-class RoboFrame displays, and the successor to
[`native-kiosk`](../native-kiosk) (Python + pygame). It runs the same protocol
client and slideshow engine as Hypnos's remote viewer and the NativeClient
app (RAVESDK's `RAVERoboFrame` and `RAVESlideshowCore`), so every Swift
frontend joins, reports and follows the server the same way.

**Status:** the Pi 3 kiosk's frontend (kiosk-pi3), with native-kiosk as
its fallback. It joins its channel, follows `playback`, crossfades photos
and videos fullscreen (SDL2 + OpenGL ES 2 on the VideoCore IV, video through
libmpv), draws the clock, date, sensors and toasts, shows `showText` alerts
and `playVideo`/`playScene`/`playAudio` effects, follows `displayState` and
`setBrightness`, and takes the keypad's keys.

What it does beyond native-kiosk, and mostly beyond the web kiosk:

- **Ken Burns:** each photo zooms slowly towards its busiest part over its
  dwell, as the web kiosk does (1x to 1.3x, eased, about the centre of the
  3x3 cell with the most Sobel edges).
- **Blurred bars:** a letterboxed photo sits on a blurred, darkened copy of
  itself instead of black. Or fill the screen instead (`fit: cover`).
- **Previews:** saving and blocking confirm with a thumbnail of the post.
  Both act on the post that was on screen when the key was pressed, for 1.5 s
  after an automatic advance: the keypad sends a key on release, and saving
  is a hold.
- **A settings menu** at the frame (below), saved across restarts.
- **On-screen status:** offline for more than 10 s, a refused token, a tag
  query that matches nothing.
- Overlay boxes with rounded corners, toasts that fade and slide in, a
  brightness control for the photo alone, and a night light.

## Keys

The same as native-kiosk and the web kiosk; gpio-agent's keypad types them.
`→` next, `←` previous (held for one interval; this display only, the
server isn't told), space save, `b` block, `s` then a digit for a tag list,
`d` display sync, `p` hide the photo (the clock stays), `t` reshuffle,
ctrl+r reload, Esc quit. A digit on its own sets the photo's brightness
(`1` 10 % … `9` 90 %, `0` full), like the web kiosk's dimmer.

`m` or Enter opens the **settings menu** (on the keypad, hold C; see
gpio-agent's `config.example.json`). The keypad has no up or down, so the
digits around 5 work as a d-pad:

| Key | In the menu |
|---|---|
| ↑ ↓, or 2 8 | move |
| ← →, or 4 6 (and the keypad's ← →) | change the value |
| Enter, space or 5 | toggle, or run an action |
| Esc, `m`, `p` or 0 | close (it also closes itself after 30 s) |

It covers the dwell, crossfade, Ken Burns, fit, the bars' fill, brightness,
the `bright` variant, the night light, each overlay item, the tag list and
display sync, plus reshuffle, restart, and a reset back to the config.

## Layout

- `Sources/KioskCore/` — no windowing, so it builds and tests anywhere:
  - `KioskConfig` reads native-kiosk's config: the top-level `accessToken`
    and `deviceId`, and the `kiosk` block (`wsUrl`, `interval`, `bright`,
    `lowmem`, `modTags`, `vcodec`, `videoMaxHeight`, `ratioFilter`,
    `wallpaper`, `maxMediaBytes`, plus `transitionMs`, and the look:
    `kenBurns`, `fit` (`contain` or `cover`), `blurBackground`,
    `brightness` (10-100), `clock`, `clockSeconds`, `date`, `sensors`,
    `nightLightStart`/`nightLightEnd` (`HH:MM`)). Environment variables
    override it under native-kiosk's names (`WS_URL`, `ACCESS_TOKEN`,
    `DEVICE_ID`, `INTERVAL`, …; the new keys as `KEN_BURNS`, `FIT`, …);
    `SCREEN_SIZE=1920x1080` sets the frame size until a renderer reports
    the real one.
  - The settings menu saves what it changes to a settings file of its own
    (`KIOSK_SETTINGS`, default `~/.config/roboframe-kiosk/settings.json`;
    on the Pi `run-kiosk` points it at `/opt/swift-kiosk/state/`), under the
    same key names. It wins over the environment and the config file,
    because those are the launcher's and fixed, and only holds keys the menu
    touched. Its reset deletes the file.
  - `KioskSession` is one display: session `main` on a `RoboFrameConnection`,
    driving the engine in server-driven mode with a 1-deep prefetch.
  - `KioskMediaProvider` builds the `/get` URLs and loads stills.
  - `KioskOverlay` / `KioskKeys` are the overlay's text and the keypad's
    shortcuts, the same as native-kiosk's; `KioskMenu` the settings menu,
    `KioskSettings` its file and the night light, `KioskKenBurns` the zoom
    and its focus.
- `Sources/KioskRenderer/` — Linux only: the SDL2 window and GLES2
  compositor, SDL_image/SDL_ttf for photos and text, the libmpv player.
- `Sources/roboframe-kiosk/` — the executable. `HEADLESS=1` runs without a
  window; `WINDOWED=1` opens one instead of taking the screen.

## Build and test

On a Mac, for development:

```bash
swift build && swift test
```

For the Pi (Linux, aarch64), in Docker:

```bash
scripts/build-linux.sh        # → dist/roboframe-kiosk
```

It builds `docker/build.Dockerfile` (the Swift toolchain plus the renderer's
headers) the first time, copies this package and its sibling checkouts
(RAVESDK, DebugTrace, vergence) under `~/Library/Caches` (Colima only shares
the home directory), and keeps the build there, so later builds are
incremental.

`--static-swift-stdlib` links the Swift runtime and Foundation into the
binary (56 MB stripped). What's left is dynamic: SDL2, SDL2_ttf, SDL2_image,
libmpv, GLESv2, libcurl, libstdc++ and glibc. The Pi's Debian 13 has all of
them but libmpv, which is one package (`libmpv2`, the same version as its
`mpv`); install it offline with `overlayroot-chroot dpkg -i`.

`docker/run.Dockerfile` is a Pi-like Debian 13 runtime with Mesa's software
GLES2 and Xvfb, for trying the renderer without the Pi. Screenshots of a
playing video taken with `import` there can come out black; the GL output
itself is fine.

## Running

```bash
ROBOFRAME_CONFIG=/opt/RoboFrame/roboframe.config.json ./roboframe-kiosk
```

Logs go to stderr (the journal), with every value that isn't public
withheld. `RAVE_LOG_PRIVATE=1` shows private values, such as error details,
while debugging at the device, and `RAVE_LOG_DEBUG=1` adds debug lines (every
frame the socket sends and receives).

To try it beside a live kiosk without joining that kiosk's channel, give it
its own `DEVICE_ID`. A new deviceId gets its own Home Assistant device
through MQTT discovery, and the entries are retained, so use a throwaway
server for experiments (`roboframe-cli bootstrap` over a few test files, MQTT
unset).

## On the Pi

```bash
scripts/build-linux.sh && scripts/deploy-pi.sh root@kiosk-pi3 --restart
```

`deploy-pi.sh` copies the binary and `pi/run-kiosk` to `/opt/swift-kiosk`
(on the SD card's real filesystem, so it survives overlayroot), refuses a
binary the Pi lacks a library for, and with `--restart` restarts the X
session onto it. A running kiosk keeps its old binary until then.

`run-kiosk` is the session's frontend: the Swift kiosk, logging to the
journal as `roboframe-kiosk`, and native-kiosk for the rest of the session if
it dies (a crash, a missing library), so a bad build can't leave getty
restarting X every few seconds. Stopping it on purpose (SIGTERM, Esc) ends
the session and getty starts a fresh one. `touch /opt/swift-kiosk/disabled`
goes back to native-kiosk.

Once per Pi:

- `libmpv2`, the one library the Pi's Debian 13 lacks (the same version as
  its `mpv`), installed offline: `overlayroot-chroot dpkg -i libmpv2_*.deb`.
- The launcher's last line (`/usr/local/bin/start-kiosk`, which `.xinitrc`
  execs) becomes `exec env ROBOFRAME_CONFIG=… /opt/swift-kiosk/run-kiosk`,
  in the overlay and in the lower layer (`/media/root-ro/…`).

It uses about 5% CPU on photos, 15–55% during a hardware-decoded video,
and 140 MB of RAM, flat. Two things about the board shape the renderer:

- **GPU memory is the kernel's CMA pool** (256 MB), shared by X, the
  compositor, every GL texture and the hardware video decoder, which needs
  megabytes of it contiguous. X, picom and the rest of the session leave
  about 100–130 MB of it. So the large surfaces are allocated once and
  reused: two screen-sized photo textures and up to three 720p video
  targets. Photos waiting for their turn sit decoded in ordinary RAM. The
  V4L2 decoder is held to 8 decoded and 4 input buffers instead of 20 and 16.
- **The keypad needs no evdev grab.** native-kiosk grabs the input devices
  because its mpv window could take X focus. Here video is drawn inside the
  kiosk's own window, so the keys reach it like any other X input.

## Linux gotchas

- **`wss://` needs libcurl ≥ 8.11** (`curl --version` lists `ws wss`), since
  it goes through FoundationNetworking. The Ubuntu 24.04 Swift image ships
  8.5, which fails with "unsupported URL"; Debian 13 (8.14) and the Pi are
  fine. `ws://` doesn't touch libcurl.
- FoundationNetworking's handshake sends `Connection: keep-alive`, which Node
  answers as a plain GET (404). RAVENet's transport sets `Connection:
  Upgrade` itself on Linux.
- **FoundationNetworking's WebSocket task spins** its dispatch threads while
  a socket is open (most of a core when idle). RAVENet connects `ws://` URLs
  on Linux with its own POSIX client instead; `wss://` still uses the task.
- **`dispatchMain()` exits the main thread on Linux** and hands the main
  queue to a worker, which breaks the GL context and the X connection (both
  belong to the thread that made them). The executable runs
  `RunLoop.main.run()` instead.
