# swift-kiosk

The Swift frontend for Pi-class RoboFrame displays, and the successor to
[`native-kiosk`](../native-kiosk) (Python + pygame). It runs the same protocol
client and slideshow engine as Hypnos's remote viewer and the NativeClient
app (RAVESDK's `RAVERoboFrame` and `RAVESlideshowCore`), so every Swift
frontend joins, reports and follows the server the same way.

**Status:** headless. It connects, joins its channel, follows `playback`,
loads each still from `/get` (screen-sized JPEG) and reports `imageReady`,
handles `displayState`, effects and `refresh`, but draws nothing yet. The
renderer (an SDL3 window, OpenGL ES 2 crossfades on the Pi 3's VideoCore IV,
libmpv for video) is the next step.

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
- `Sources/roboframe-kiosk/` — the executable.

## Build and test

On a Mac, for development:

```bash
swift build && swift test
```

For Linux, in the arm64 Swift image (the Pi is aarch64). Colima only shares
your home directory, so copy the checkout and its sibling packages (RAVESDK,
DebugTrace, vergence) under `~` first, then:

```bash
docker run --rm -v ~/src:/w -w /w/RoboFrame/swift-kiosk swift:6.2.4-noble \
  swift build -c release --static-swift-stdlib
```

`--static-swift-stdlib` links the Swift runtime and Foundation into the
binary. What's left is dynamic: libcurl, libstdc++, libgcc_s and glibc,
all already on the Pi's Debian 13.

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

## Linux gotchas

- **WebSockets need libcurl ≥ 8.11** (`curl --version` lists `ws wss`). The
  Ubuntu 24.04 Swift image ships 8.5, which fails with "unsupported URL", so
  run the binary in Debian 13 (8.14), as on the Pi, rather than in the build
  image.
- FoundationNetworking's handshake sends `Connection: keep-alive`, which Node
  answers as a plain GET (404). RAVENet's transport sets `Connection:
  Upgrade` itself on Linux.
