# swift-kiosk

The Swift frontend for Pi-class RoboFrame displays, and the successor to
[`native-kiosk`](../native-kiosk) (Python + pygame). It runs the same protocol
client and slideshow engine as Hypnos's remote viewer and the NativeClient
app (RAVESDK's `RAVERoboFrame` and `RAVESlideshowCore`), so every Swift
frontend joins, reports and follows the server the same way.

**Status:** runs on the Pi 3 as a full frontend, tested against a throwaway
server; not yet the kiosk's default. It joins its channel, follows
`playback`, crossfades photos and videos fullscreen (SDL2 + OpenGL ES 2 on
the VideoCore IV, video through libmpv), draws the clock, date, sensors and
toasts, shows `showText` alerts and `playVideo`/`playScene`/`playAudio`
effects, follows `displayState`, and takes the keypad's keys. Not done yet:
`←` (previous post), toast thumbnails after a save, and an install/deploy
path.

## Layout

- `Sources/KioskCore/` — no windowing, so it builds and tests anywhere:
  - `KioskConfig` reads native-kiosk's config: the top-level `accessToken`
    and `deviceId`, and the `kiosk` block (`wsUrl`, `interval`, `bright`,
    `lowmem`, `modTags`, `vcodec`, `videoMaxHeight`, `ratioFilter`,
    `wallpaper`, `maxMediaBytes`, plus `transitionMs`). Environment variables
    override it under native-kiosk's names (`WS_URL`, `ACCESS_TOKEN`,
    `DEVICE_ID`, `INTERVAL`, …); `SCREEN_SIZE=1920x1080` sets the frame size
    until a renderer reports the real one.
  - `KioskSession` is one display: session `main` on a `RoboFrameConnection`,
    driving the engine in server-driven mode with a 1-deep prefetch.
  - `KioskMediaProvider` builds the `/get` URLs and loads stills.
  - `KioskOverlay` / `KioskKeys` are the overlay's text and the keypad's
    shortcuts, the same as native-kiosk's.
- `Sources/KioskRenderer/` — Linux only: the SDL2 window and GLES2
  compositor, SDL_image/SDL_ttf for photos and text, the libmpv player.
- `Sources/roboframe-kiosk/` — the executable. `HEADLESS=1` runs without a
  window; `WINDOWED=1` opens one instead of taking the screen.

## Build and test

On a Mac, for development:

```bash
swift build && swift test
```

For Linux, in an arm64 image with the Swift toolchain and the renderer's
headers (the Pi is aarch64). `docker/build.Dockerfile` is that image.
Colima only shares your home directory, so copy the checkout and its sibling
packages (RAVESDK, DebugTrace, vergence) under `~` first, then:

```bash
docker build -t roboframe-kiosk-build -f docker/build.Dockerfile docker
docker run --rm -v ~/src:/w -w /w/RoboFrame/swift-kiosk roboframe-kiosk-build \
  swift build -c release --static-swift-stdlib
```

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
while debugging at the device.

To try it beside a live kiosk without joining that kiosk's channel, give it
its own `DEVICE_ID`. A new deviceId gets its own Home Assistant device
through MQTT discovery, and the entries are retained, so use a throwaway
server for experiments (`roboframe-cli bootstrap` over a few test files, MQTT
unset).

## On the Pi

On the Pi 3 it uses about 5% CPU on photos and 270 MB of RAM. Two things
about the board shape the renderer:

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
