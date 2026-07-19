# psp-kiosk — RoboFrame client for the Sony PSP

Native homebrew slideshow client that turns a PSP into a RoboFrame
display. Fetches server-resized JPEGs (and low-res animated GIFs — the
`lowmem=1` variant imagemirror builds for animated posts) from
imagemirror over WiFi, renders double-buffered at vsync with alpha
crossfades, and overlays a clock from the PSP's RTC. Videos are skipped
(real kiosks play those); other unsupported formats trigger an
immediate re-pick rather than an error.

## How it works

- A background thread asks `/random?json=1` for a post id (retrying past
  video posts), then downloads `/get?id=…&width=480&height=272&lowmem=1`
  — the same server-side-resize path native-kiosk uses, so the PSP never
  decodes anything bigger than its 480×272 screen. Downloads land in
  imagemirror's `/history` under `device_id`.
- JPEG decode is libjpeg-turbo into one of two 512×512 textures; the GU
  crossfades between them. The render loop never blocks on the network,
  so the clock keeps ticking during downloads over 802.11b.
- Errors (WiFi loss, server down, HTTP failures) show as a status line
  and retry every 5 s — it self-heals like a photo frame should.

## Controls

| Button | Action |
| --- | --- |
| D-pad right | next image (steps forward through history first) |
| D-pad left | previous image (local history, up to 64 back) |
| X | save the current post (`/save`) |
| O | block the current post (`/block`) — press twice to confirm; advances and drops it from history |
| TRIANGLE | tag-list picker (UP/DOWN cycle incl. auto, X apply, O cancel) — feeds `/random?list=N` |
| START | pause/resume the dwell timer |
| SELECT | toggle the clock overlay |
| HOME | exit |

Save and block are the kiosk-tier HTTP routes, so the access token in
`config.txt` is all they need. History replays request `record=0` so
browsing back doesn't spam `/history`.

## Build

Needs the [pspdev SDK](https://github.com/pspdev/pspdev/releases)
(prebuilt archives exist for macOS arm64/x86_64 and Linux; extract to
`~/pspdev`):

```sh
export PSPDEV=~/pspdev PATH=$PSPDEV/bin:$PATH
make
```

Produces `EBOOT.PBP`.

## Configure

Copy `config.example.txt` to `config.txt` next to the EBOOT and fill in
`host`, `port`, `token` (imagemirror's `accessToken`). imagemirror must
be bound to a LAN-reachable address (`SERVER_HOST=0.0.0.0` or a LAN IP —
the default is localhost) — the PSP speaks plain HTTP only, so keep it
on a trusted network.

`wifi_profile` selects the PSP's saved infrastructure connection
(Settings → Network Settings; the first entry is 1). Remember the PSP
radio is 802.11b with WEP or WPA-PSK/TKIP only — no WPA2/AES — so it
needs a legacy-compatible SSID.

## Run in PPSSPP (development)

PPSSPP ≥ 1.19 (inet sockets), with networking enabled
(`ppsspp.ini` → `[Network] EnableWlan = True`):

```sh
PPSSPPSDL EBOOT.PBP
```

Two emulator quirks, both already handled:

- PPSSPP's VFS rejects intraFont's `sceIoOpen` on `flash0:`, so the app
  falls back to `ltn0.pgf` next to the EBOOT. Copy PPSSPP's substitute
  once: `cp <PPSSPP assets>/flash0/font/ltn0.pgf .` (real hardware uses
  the firmware font and needs no file).
- PPSSPP's inet sockets are effectively non-blocking; the HTTP client
  select()s and retries on EAGAIN, which is also correct on hardware.

## Run on a real PSP

Any PSP with custom firmware (ARK-4 etc.). Copy the folder to the
memory stick and add the config:

```
ms0:/PSP/GAME/pspkiosk/EBOOT.PBP
ms0:/PSP/GAME/pspkiosk/config.txt
```

Launch from the XMB Game menu.

## Gotchas for future work

- intraFont re-enables GU_DEPTH_TEST after every print; the frame loop
  disables it each frame or everything else drawn is culled (the depth
  buffer is never cleared).
- The GE reads textures around the CPU cache: `sceKernelDcacheWritebackRange`
  after decode and `sceGuTexFlush` after `sceGuTexImage` are both required.
- `PSP_O_RDONLY` socket timeouts: PSP's `SO_RCVTIMEO` takes a u32 in
  microseconds, not a `struct timeval`.
