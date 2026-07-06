# WebRTC streaming spike

Throwaway proof-of-concept for **rendering GPU-heavy effect pages on the Mac
backend and streaming them as hardware H.264 to the Pi kiosk** — because the Pi
4's V3D GPU can't run these shaders at 60 fps, but it HW-decodes H.264 trivially.

This validates the pipeline before wiring it into `imagemirror`. The production
version makes the signaling relay an `rtcSignal` action in
`imagemirror/lib/broker.js` (see "Production plan" below).

## Files

- `signal.js` — minimal Node signaling relay (`ws`) + static file server on
  :9000. Relays `publish`/`subscribe`/`offer`/`answer`/`ice` JSON between one
  producer and N consumers, keyed by `streamId`. **Never touches media frames.**
- `producer.html` — loads an effect in a same-origin iframe, captures its canvas
  with `captureStream(60)`, and is the WebRTC sending peer. HUD shows encoder
  telemetry.
- `consumer.html` — subscribing peer; attaches the track to a `<video>`. HUD
  shows decode res/fps/kbps/drops.
- `trippy.html`, `crt.html` — the effect pages under test.

## Run

```bash
cd spike/webrtc && node signal.js     # http+ws on :9000
# Producer (on the Mac, with a real GPU):
open -na "Google Chrome" --args --user-data-dir=/tmp/chrome-producer \
  --force-device-scale-factor=1 \
  "http://localhost:9000/producer.html?effect=crt.html&stream=scene&kbps=20000"
# Consumer (on the Pi kiosk, or another Mac tab):
#   http://<mac-lan-ip>:9000/consumer.html?stream=scene
```

Producer query params: `effect`, `stream`, `fps` (default 60), `kbps` (max
bitrate, default 20000), `down` (force `scaleResolutionDownBy`).

## Findings (the whole point of the spike)

End-to-end works. **Two settings dominate cost and quality:**

| | Naive default | Tuned |
|---|---|---|
| Resolution | 3840×2160 (Retina dpr=2 canvas) | **1920×1080** |
| Codec | VP8 (WebRTC default, **software**) | **H.264 (VideoToolbox HW)** |
| Bitrate | ~2.5 Mbps → bad artifacts on noise | 15–20 Mbps → clean |
| Framerate | 24 fps, `qlimit: cpu` | 60 fps, `qlimit: none` |
| Producer encode CPU | software, pegged | ~14% (HW); ~42% with HW disabled (A/B) |

- **Resolution is the silent killer.** A Retina (dpr=2) Mac sizes the effect
  canvas to 4K; `captureStream` grabs the full backing store. 4K is 4× the
  pixels the Pi needs AND pushes VideoToolbox past its limit so it falls back to
  a CPU-bound software path. `--force-device-scale-factor=1` renders the effect
  natively at 1080p and fixes both. (The Pi also only decoded the 4K stream at
  ~26 fps; at 1080p it does 60 easily.)
- **VideoToolbox HW H.264 is engaged at 1080p**, proven by A/B: launching the
  producer with `--disable-accelerated-video-encode` tripled the encoder
  process CPU. **`encoderImplementation` is blank for VideoToolbox in Chrome's
  getStats — don't trust it; use `qualityLimitationReason: none` + CPU as the
  tell.**
- **VideoToolbox has limited concurrent HW encode sessions.** One renderer =
  one encode session, shared across all subscribers (the publish/subscribe model
  already does this — all consumers pull the same encoded stream). Do NOT spin
  one encoder per Pi.
- **LAN-only:** `iceServers: []`, host candidates connect directly. No STUN/TURN.

## Production plan (next sprint)

**Layer 1 — generic signaling:** `rtcSignal` action in `broker.js`
(`{streamId, kind, from, to, data}`), relaying between rpc-tier producers and
access-tier consumers. Update `docs/protocol.md` + Spatialstash (can ignore it
initially) + `public/modules/ws-client.js`.

**Layer 2 — renderer service** behind `server.features.webrtcStreaming` (off by
default): imagemirror supervises a headless-GPU Chromium that loads the effect,
publishes a named stream, answers subscriber offers. The remote-desktop feature
is a *second* producer kind behind its own flag
(`server.features.remoteDesktop`) — same signaling primitive, screen-capture
source instead of an effect page.

**Layer 3 — kiosk consumer:** a `playScene {streamId}` / `stopScene` out-of-band
action mirroring the existing `playVideo` (so scenes don't perturb the
orchestrator queue). Renders a `<video srcObject>` in the existing layer DOM;
fires the existing `imageReady` readiness signal on the video's first
`loadeddata`. `visibility.js` already gates it.

### Renderer (producer) Chrome flags — the critical ones

```
--force-device-scale-factor=1   # render 1080p, NOT Retina 4K — the #1 fix
--use-angle=metal               # (Mac) GPU backend for the shader
# leave HW encode ENABLED (do not pass --disable-accelerated-video-encode)
```

Plus the producer JS (already in `producer.html`): `setCodecPreferences` → H.264,
`track.contentHint='detail'`, sender encodings `maxBitrate≈20 Mbps`,
`maxFramerate=60`, `degradationPreference='maintain-resolution'`,
`scaleResolutionDownBy` safety net.

### Consumer (Pi kiosk) Chrome flags — already in `/usr/local/bin/start-kiosk`

The shipped kiosk already enables HW decode; the relevant flags for a WebRTC
`<video>` consumer are:

```
--ignore-gpu-blocklist
--enable-gpu-rasterization
--enable-zero-copy
--enable-native-gpu-memory-buffers
--enable-accelerated-video-decode   # H.264 HW decode via VideoCore — key
--disable-software-rasterizer
--autoplay-policy=no-user-gesture-required   # let <video> autoplay muted
--use-angle=gles
```

No consumer-side changes needed for HW decode — the kiosk profile is already
configured for it.
```
