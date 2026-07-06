#!/usr/bin/env python3
"""
RoboFrame native kiosk — SDL2-based frontend for memory-constrained boards
(Pi 3 et al.) where Chromium is unaffordable.

Implements the RoboFrame WebSocket protocol from the kiosk side (see
docs/protocol.md). One process per logical display; pairs with node-display
running alongside it on the same host (this process renders pixels; that
process drives backlight, PIR, brightness).

Protocol summary as implemented here:
  - Connect to ws://host:port/rpc/ws?token=<ACCESS_TOKEN>.
  - On open: slideshowConfig { deviceId, interval, width, height, ratio,
    convert, bright }, then visibility { deviceId, visible: true }, then
    getDisplayState { target: deviceId }.
  - On every `playback` frame whose `current` is an image: fetch via HTTP
    /get (server-resized, lowmem JPEG), blit fullscreen, then send
    imageReady { id }.
  - On every `playback` frame whose `current.ext` is a video (mp4/webm):
    stream it straight from /get into a fullscreen mpv process (no decode
    in-process, no blob cache), then send imageReady { id, durationMs } so
    the server sizes the dwell to the clip. A clip that fits the interval
    loops; a longer one plays once and holds its last frame until the
    server advances (mirrors the web kiosk's <video> loop rule). The
    `vcodec` config asks /get for an H.264 <=1080p transcode and `hwdec`
    hands decode to the SoC (Pi VideoCore does H.264 only) — on a
    cache-miss the transcode streams live, so durationMs may come back 0
    and the dwell falls back to the interval for that first play.
  - Prefetch first `upcoming` image in the background (bounded to 1 to keep
    decoded-blob RAM low on Pi 3). Videos are never prefetched.
  - On `displayState { state: off, target: <us> }`: blank to black, pause
    fetching, tear down any playing video. On `on`: resume by re-applying
    the last playback frame.
  - On `refresh`: re-exec self (matches kiosk page-reload semantics).
  - Effect frames render out-of-band, on top of the slideshow: playVideo /
    playAudio spawn mpv, showText paints a pygame overlay, and the matching
    stop/dismiss frames tear them down. A screen-covering effect (playVideo,
    showText) pauses the slideshow video, which resumes when the effect
    clears.

Runtime dependency: mpv on PATH for any video/audio playback. Without it,
video posts report ready (so the channel isn't wedged) but show black.

What this client deliberately does NOT do:
  - Run its own dwell timer (server owns cadence).
  - Wake-advance on visibility changes (see "Visibility never resets the
    timer" in docs/protocol.md).
  - Filter against a local blocklist (server-only).
  - Carry a 5+ image prefetch buffer (Pi 3 OOMs).
"""

import io
import json
import logging
import os
import queue
import shutil
import signal
import socket
import subprocess
import sys
import tempfile
import threading
import time
import urllib.parse
from pathlib import Path

# mpv's fullscreen window takes focus whenever a video plays; SDL's default
# for focus-lost FULLSCREEN windows is to iconify, and nothing ever restores
# an iconified kiosk window — every photo after the first video would paint
# into an unmapped window (physical screen: black). Must be set before
# pygame.display.init().
os.environ.setdefault("SDL_VIDEO_MINIMIZE_ON_FOCUS_LOSS", "0")

import pygame
import requests
import websocket
from PIL import Image

log = logging.getLogger("kiosk")

KIOSK_SESSION_ID = "main"
SESSION = requests.Session()


# ---------- config ---------------------------------------------------------

def _walk_for_config():
    if env := os.environ.get("ROBOFRAME_CONFIG"):
        p = Path(env).resolve()
        return p if p.exists() else None
    here = Path.cwd().resolve()
    for _ in range(6):
        cand = here / "roboframe.config.json"
        if cand.exists():
            return cand
        if here.parent == here:
            break
        here = here.parent
    return None


def load_config():
    """Mirror packages/shared resolution: env > roboframe.config.json > default."""
    raw = {}
    path = _walk_for_config()
    if path:
        try:
            raw = json.loads(path.read_text())
        except Exception as e:
            log.warning("Failed to read %s: %s", path, e)
    kiosk = raw.get("kiosk", {}) or {}
    display = raw.get("display", {}) or {}

    def pick(env_name, *fallbacks):
        v = os.environ.get(env_name)
        if v is not None and v != "":
            return v
        for f in fallbacks:
            if f not in (None, ""):
                return f
        return None

    ws_url = pick("WS_URL", kiosk.get("wsUrl"), display.get("wsUrl"),
                  "ws://localhost:3123/rpc/ws")
    access_token = pick("ACCESS_TOKEN", raw.get("accessToken"), "")
    device_id = pick("DEVICE_ID", raw.get("deviceId"), "screen1")
    interval = int(pick("INTERVAL", kiosk.get("interval"), 15000))
    bright = str(pick("BRIGHT", kiosk.get("bright"), "0")).lower() in ("1", "true", "yes", "on")
    lowmem = str(pick("LOWMEM", kiosk.get("lowmem"), "1")).lower() in ("1", "true", "yes", "on")
    # Video delivery/decode tuning. `vcodec` asks /get for a hardware-
    # decodable transcode ("h264"; empty string = raw file, the server also
    # falls back to raw when it has no ffmpeg). `hwdec` is passed to mpv
    # --hwdec; on a Pi under X11 "v4l2m2m-copy" is the reliable choice
    # ("no" = software decode).
    vcodec = pick("VCODEC", kiosk.get("vcodec"), "h264") or ""
    if vcodec.lower() in ("0", "no", "none", "off"):
        vcodec = ""
    hwdec = pick("HWDEC", kiosk.get("hwdec"), "no")
    mod_tags = kiosk.get("modTags") or []
    if env_tags := os.environ.get("MOD_TAGS"):
        mod_tags = [t.strip() for t in env_tags.split(",") if t.strip()]

    if not access_token:
        log.error("ACCESS_TOKEN is required (top-level accessToken in "
                  "roboframe.config.json or ACCESS_TOKEN env var)")
        sys.exit(1)

    http_base = ws_url.replace("ws://", "http://").replace("wss://", "https://")
    if "/rpc/ws" in http_base:
        http_base = http_base.split("/rpc/ws", 1)[0]

    return {
        "ws_url": ws_url,
        "http_base": http_base,
        "access_token": access_token,
        "device_id": device_id,
        "interval": interval,
        "bright": bright,
        "lowmem": lowmem,
        "vcodec": vcodec,
        "hwdec": hwdec,
        "mod_tags": mod_tags,
    }


# ---------- networking -----------------------------------------------------

class Connection:
    """Single-socket WebSocket client, runs recv loop on its own thread.

    `send` is thread-safe (websocket-client serializes sends internally for
    text frames; we also hold a lock to be safe across reconnects).
    """

    def __init__(self, cfg, on_message):
        self.cfg = cfg
        self.on_message = on_message
        self._ws = None
        self._lock = threading.Lock()
        self._halted = False
        self._connected = threading.Event()
        self._thread = threading.Thread(target=self._run, daemon=True)

    def start(self):
        self._thread.start()

    def stop(self):
        self._halted = True
        with self._lock:
            if self._ws:
                try:
                    self._ws.close()
                except Exception:
                    pass

    def send(self, obj):
        with self._lock:
            if not self._ws:
                return
            try:
                self._ws.send(json.dumps(obj))
            except Exception as e:
                log.warning("send failed: %s", e)

    def _run(self):
        attempt = 0
        while not self._halted:
            url = (self.cfg["ws_url"]
                   + ("&" if "?" in self.cfg["ws_url"] else "?")
                   + "token=" + urllib.parse.quote(self.cfg["access_token"]))
            try:
                log.info("connecting to %s", self.cfg["ws_url"])
                ws = websocket.WebSocket()
                ws.connect(url, timeout=10)
                # connect uses a 10s timeout; the recv loop must block
                # indefinitely so we don't false-positive on quiet periods
                # between playback frames.
                ws.settimeout(None)
                with self._lock:
                    self._ws = ws
                attempt = 0
                self._connected.set()
                self.on_message({"action": "_open"})
                while not self._halted:
                    frame = ws.recv()
                    if not frame:
                        break
                    try:
                        msg = json.loads(frame)
                    except Exception as e:
                        log.warning("bad frame: %s", e)
                        continue
                    self.on_message(msg)
            except websocket.WebSocketBadStatusException as e:
                # 401/403 from the upgrade — most often a token mismatch.
                log.error("ws upgrade rejected: %s", e)
                if "401" in str(e) or "403" in str(e):
                    log.error("token rejected — halting reconnect loop")
                    self._halted = True
                    break
            except Exception as e:
                log.warning("ws error: %s", e)
            finally:
                with self._lock:
                    self._ws = None
                self._connected.clear()
                self.on_message({"action": "_close"})
            if self._halted:
                break
            attempt += 1
            delay = min(0.5 * attempt, 5.0)
            log.info("reconnecting in %.1fs", delay)
            time.sleep(delay)


# ---------- image fetch ----------------------------------------------------

class Fetcher:
    """Bounded background image fetcher.

    Stores at most two decoded surfaces (current + one prefetch) — Pi 3 with
    1 GB RAM can't afford more. Decoding happens on the fetch thread and the
    result is handed to the main thread as a pre-scaled `pygame.Surface` so
    the render path has zero decode cost.
    """

    def __init__(self, cfg, screen_size):
        self.cfg = cfg
        self.screen_size = screen_size
        self.cache = {}                 # id -> pygame.Surface
        self.cache_lock = threading.Lock()
        self.in_flight = set()
        self.in_flight_lock = threading.Lock()
        self.q = queue.Queue()
        self.ready_q = queue.Queue()    # (id, surface_or_None)
        self.thread = threading.Thread(target=self._loop, daemon=True)
        self.thread.start()

    def request(self, post):
        if not post or not post.get("id"):
            return
        pid = post["id"]
        with self.cache_lock:
            if pid in self.cache:
                return
        with self.in_flight_lock:
            if pid in self.in_flight:
                return
            self.in_flight.add(pid)
        self.q.put(post)

    def get(self, pid):
        with self.cache_lock:
            return self.cache.get(pid)

    def keep_only(self, keep_ids):
        with self.cache_lock:
            for k in list(self.cache.keys()):
                if k not in keep_ids:
                    del self.cache[k]

    def _build_url(self, post):
        w, h = self.screen_size
        params = {
            "id": str(post["id"]),
            "convert": "1",
            "width": str(w),
            "height": str(h),
            "token": self.cfg["access_token"],
            # Tags the request so /history can group this display's images.
            "deviceId": self.cfg["device_id"],
        }
        if self.cfg["lowmem"]:
            params["lowmem"] = "1"
        if self.cfg["bright"]:
            params["bright"] = "1"
        return f"{self.cfg['http_base']}/get?{urllib.parse.urlencode(params)}"

    def _loop(self):
        while True:
            post = self.q.get()
            pid = post["id"]
            surf = None
            try:
                url = self._build_url(post)
                r = SESSION.get(url, timeout=20)
                r.raise_for_status()
                img = Image.open(io.BytesIO(r.content))
                img.load()
                # The server's /get uses `fit: inside, withoutEnlargement:
                # true`, so it returns the source unchanged when it's
                # already smaller than the requested box. Fit-inside the
                # screen ourselves — upscale small images, downscale large.
                sw, sh = self.screen_size
                scale = min(sw / img.width, sh / img.height)
                if scale != 1.0:
                    new_size = (max(1, int(img.width * scale)),
                                max(1, int(img.height * scale)))
                    img = img.resize(new_size, Image.LANCZOS)
                if img.mode != "RGB":
                    img = img.convert("RGB")
                surf = pygame.image.fromstring(img.tobytes(), img.size, "RGB")
            except Exception as e:
                log.warning("fetch %s failed: %s", pid, e)
            finally:
                with self.in_flight_lock:
                    self.in_flight.discard(pid)
            if surf is not None:
                with self.cache_lock:
                    self.cache[pid] = surf
            self.ready_q.put((pid, surf))


# ---------- kiosk ----------------------------------------------------------

class Kiosk:
    def __init__(self, cfg):
        self.cfg = cfg
        # Selective init: skip the audio/mixer subsystems — we don't play
        # sound on the kiosk, and Pi 3's ALSA HDMI sink with no consumer
        # spams "snd_pcm_recover underrun" into stderr at ~10 Hz.
        pygame.display.init()
        pygame.font.init()
        pygame.mouse.set_visible(False)
        info = pygame.display.Info()
        self.size = (info.current_w, info.current_h)
        flags = pygame.FULLSCREEN | pygame.NOFRAME
        self.screen = pygame.display.set_mode(self.size, flags)
        pygame.display.set_caption("RoboFrame")
        self.screen.fill((0, 0, 0))
        pygame.display.flip()

        self.fetcher = Fetcher(cfg, self.size)
        self.conn = Connection(cfg, self._on_ws)
        self.frame_q = queue.Queue()     # inbound from ws thread

        # Overlay layer (pygame mirror of public/modules/toast.js,
        # public/modules/sensors.js, and the clock block in
        # public/modules/ui.js). `base_surface` is the last image blit; the
        # compositor draws base + clock + date + sensors + toasts each tick
        # whenever anything in the overlay layer changes.
        text_font = self._find_font([
            "/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf",
            "/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf",
        ])
        self.clock_font = pygame.font.Font(text_font, 48) if text_font \
            else pygame.font.Font(None, 56)
        self.sensor_font = pygame.font.Font(text_font, 26) if text_font \
            else pygame.font.Font(None, 32)
        self.toast_font = pygame.font.Font(text_font, 22) if text_font \
            else pygame.font.Font(None, 28)
        # Color-emoji font for sensor icons. SDL_ttf 2.20+ (shipped with
        # SDL2 2.30+) renders bitmap-strike CBDT fonts; on older systems
        # the .render() call may produce empty surfaces, in which case we
        # silently fall back to ASCII prefixes.
        emoji_path = self._find_font([
            "/usr/share/fonts/truetype/noto/NotoColorEmoji.ttf",
        ])
        self.emoji_font = None
        if emoji_path:
            try:
                self.emoji_font = pygame.font.Font(emoji_path, 26)
            except Exception as e:
                log.warning("emoji font init failed: %s", e)
        self.toasts = []                 # list of (text_surface, expires_ts)
        self.toasts_lock = threading.Lock()
        self.sensors = {}                # entity -> {name, value, stale}
        self.sensors_lock = threading.Lock()
        self.base_surface = None
        self._overlay_dirty = False
        self._last_clock_str = ""        # forces recomposite when the
                                         # displayed minute/second changes

        # Effect overlays (mirror of public/modules/effects.js). These take
        # precedence over the photo: while any is active, photo blitting and
        # the clock/sensors overlays are suppressed so the screen is wholly
        # the effect's. mpv is spawned out-of-process for video/audio because
        # software-decoding 1080p on Pi 3 in-process would never make it.
        self.video_proc = None
        self.audio_proc = None
        self.text_overlay = None         # dict {bg, image_surf, text_surf} or None
        self.effect_lock = threading.Lock()
        self._mpv_ok = None              # shutil.which("mpv"), resolved once

        # Slideshow video: a `playback.current` whose ext is mp4/webm plays
        # in its own fullscreen mpv (base layer, same tier as a photo — not
        # an effect). `slideshow_video` is {proc, id, ipc_path, gen} or None;
        # `gen` fences the async duration/imageReady worker against a newer
        # clip that superseded it.
        self.slideshow_video = None
        self._slideshow_gen = 0

        self.last_playback = None        # last full playback payload
        self.interval = cfg["interval"]  # dwell (ms); tracks playback.interval
        self.current_id = None           # what's actually on screen
        # `save_id` is what the SPACE key acts on. It lags `current_id` by
        # 1.5s so a user pressing save just as an image switches still
        # targets the post they were looking at — mirrors the web kiosk's
        # state.currentPost being set ~1s after crossfade start
        # (slideshow.js finishLoad setTimeout).
        self.save_id = None
        self._save_id_timer = None
        self.server_off = False          # server displayState=off
        self.force_off = False           # local 'p'-key toggle (panel off)
        self.is_primary_sync = False     # local displaySync claim state
        self.tag_lists_count = 0         # learned from tagLists frame
        self.awaiting_taglist = False    # 's' then digit: pick a tag list
        self.connected = False

    # -- WS handlers (run on ws thread, push to main via queue) -------------

    def _on_ws(self, msg):
        self.frame_q.put(msg)

    def _send_slideshow_config(self):
        w, h = self.size
        # Advertise the raw aspect ratio (width/height); the server expands it
        # into its ratio:lo..hi query window. A "W:H" string never matched the
        # server's numeric parser and was silently ignored.
        ratio = round(w / h, 4) if h else None
        self.conn.send({
            "sessionId": KIOSK_SESSION_ID,
            "action": "slideshowConfig",
            "payload": {
                "deviceId": self.cfg["device_id"],
                "interval": self.cfg["interval"],
                "ratio": ratio,
                "width": w,
                "height": h,
                "bright": self.cfg["bright"],
                "convert": True,
                "lowmem": bool(self.cfg.get("lowmem", False)),
                "modTags": self.cfg["mod_tags"],
            },
        })

    def _send_visibility(self, visible):
        self.conn.send({
            "action": "visibility",
            "payload": {"deviceId": self.cfg["device_id"], "visible": visible},
        })

    def _send_image_ready(self, pid, duration_ms=None):
        payload = {"id": pid}
        # durationMs is video-only; the server dwells for max(interval,
        # durationMs) so a clip longer than the interval plays through.
        if duration_ms and duration_ms > 0:
            payload["durationMs"] = int(duration_ms)
        self.conn.send({
            "sessionId": KIOSK_SESSION_ID,
            "action": "imageReady",
            "payload": payload,
        })

    # -- main-thread frame dispatch -----------------------------------------

    def _process_ws(self, msg):
        action = msg.get("action")
        if action == "_open":
            log.info("ws open")
            self.connected = True
            self._send_slideshow_config()
            self._send_visibility(not self._is_off())
            self.conn.send({"action": "getDisplayState",
                            "payload": {"target": self.cfg["device_id"]}})
            return
        if action == "_close":
            log.info("ws close")
            self.connected = False
            return
        if action == "playback":
            self._apply_playback(msg.get("payload") or {})
        elif action == "displayState":
            p = msg.get("payload") or {}
            # Only act on frames that carry a panel `state`. A state-less
            # displayState (e.g. a stray visibility echo) must not toggle the
            # panel — treating a missing state as "on" would re-enable a
            # display PIR had turned off.
            if p.get("target") == self.cfg["device_id"] and "state" in p:
                off = p.get("state") == "off" or p.get("state") is False
                self._set_server_off(off)
        elif action == "refresh":
            log.info("refresh — re-exec")
            os.execv(sys.executable, [sys.executable, *sys.argv])
        elif action == "tagLists":
            p = msg.get("payload")
            if isinstance(p, list):
                self.tag_lists_count = len(p)
        elif action == "update":
            self._on_sensor_update(msg.get("payload") or {})
        elif action == "playVideo":
            url = (msg.get("payload") or {}).get("url")
            if url:
                self._play_video(url)
        elif action == "stopVideo":
            self._stop_video()
        elif action == "playAudio":
            url = (msg.get("payload") or {}).get("url")
            if url:
                self._play_audio(url)
        elif action == "stopAudio":
            self._stop_audio()
        elif action == "showText":
            p = msg.get("payload") or {}
            self._show_text(p.get("text", ""), p.get("bgColorHex") or "#000000",
                            p.get("imageUrl") or "")
        elif action == "dismissText":
            self._dismiss_text()
        elif action in ("displayDisconnect",
                        "setBrightness", "setSuppress",
                        "setWebcam", "mjpgstreaming", "pong"):
            # Driven by node-display or not applicable to a render-only client.
            pass

    def _apply_playback(self, payload):
        if not payload:
            return
        self.last_playback = payload
        iv = payload.get("interval")
        if isinstance(iv, (int, float)) and iv > 0:
            self.interval = iv
        cur = payload.get("current") or {}
        upcoming = payload.get("upcoming") or ([payload["next"]] if payload.get("next") else [])
        up0 = upcoming[0] if upcoming else None

        cur_video = self._is_video(cur)

        # Bounded keep set for the image fetcher: images only. Videos stream
        # from /get straight into mpv and are never decoded into the cache.
        keep = set()
        if cur.get("id") and not cur_video:
            keep.add(cur["id"])
        if up0 and up0.get("id") and not self._is_video(up0):
            keep.add(up0["id"])
        self.fetcher.keep_only(keep)

        if self._is_off():
            self._stop_slideshow_video()
            return  # don't pull binaries while the panel is dark

        if cur_video:
            self._play_slideshow_video(cur)
        else:
            # A photo (or nothing) is current — tear down any playing video
            # so mpv stops covering the framebuffer, then fetch the image.
            self._stop_slideshow_video()
            if cur.get("id"):
                self.fetcher.request(cur)

        # Prefetch the next image only; videos aren't prefetched (a ~100MB
        # clip pulled just to be cut off mid-loop is pure waste).
        if up0 and up0.get("id") and not self._is_video(up0):
            self.fetcher.request(up0)

    # -- toasts -------------------------------------------------------------

    TOAST_DURATION = 3.0
    TOAST_MAX = 5

    def toast(self, text):
        """Queue a 3-second banner. Safe to call from any thread."""
        log.info("toast: %s", text)
        try:
            surf = self.toast_font.render(text, True, (255, 255, 255))
        except Exception as e:
            log.warning("toast render failed: %s", e)
            return
        with self.toasts_lock:
            self.toasts.append((surf, time.monotonic() + self.TOAST_DURATION))
            if len(self.toasts) > self.TOAST_MAX:
                self.toasts = self.toasts[-self.TOAST_MAX:]
            self._overlay_dirty = True

    # -- sensors (Home Assistant `update` frames) ---------------------------

    # Word → emoji substitution applied to friendly_name. Mirrors
    # public/modules/sensors.js so the same HA sensor renders identically
    # on both clients. The mixed-font compositor paints these glyphs via
    # NotoColorEmoji.
    SENSOR_EMOJI = {
        "Temperature": "🌡️",
        "Humidity": "💧",
        "Atmospheric pressure": "🌬️",
    }

    def _on_sensor_update(self, payload):
        entity = payload.get("entity")
        attrs = payload.get("attributes") or {}
        name = attrs.get("friendly_name")
        if not entity or not name:
            return
        unit = attrs.get("unit_of_measurement") or ""
        state = payload.get("state")
        stale = state == "unavailable" or unit == "unavailable"
        display_name = name
        for k, v in self.SENSOR_EMOJI.items():
            display_name = display_name.replace(k, v)
        with self.sensors_lock:
            prev = self.sensors.get(entity, {})
            if stale:
                last = prev.get("value") or "N/A"
                self.sensors[entity] = {"name": display_name, "value": last,
                                        "sort": name, "stale": True}
            else:
                self.sensors[entity] = {"name": display_name,
                                        "value": f"{state}{unit}",
                                        "sort": name, "stale": False}
        self._overlay_dirty = True

    # -- mixed-font (text + color emoji) rendering --------------------------

    @staticmethod
    def _find_font(candidates):
        for p in candidates:
            if os.path.exists(p):
                return p
        return None

    @staticmethod
    def _is_emoji(cp):
        # Coarse but covers the standard sensor symbols (🌡️ 💧 🌬️ ❗, etc.):
        # all Misc Symbols & Dingbats, plus the Supplementary Multilingual
        # Plane emoji blocks. VS-16 and ZWJ are treated as part of the
        # surrounding emoji cluster.
        return (
            (0x2600 <= cp <= 0x27BF)
            or (0x1F000 <= cp <= 0x1FAFF)
            or cp == 0xFE0F
            or cp == 0x200D
        )

    def _render_mixed(self, text, font, color):
        """Render `text` with `font`, switching to emoji_font for emoji
        codepoints. Returns a single horizontal surface.
        """
        if not text:
            return font.render("", True, color)
        # Split into runs of consecutive same-kind characters.
        runs = []
        cur, cur_emoji = [], None
        for ch in text:
            is_e = self._is_emoji(ord(ch))
            if cur_emoji is None or is_e == cur_emoji:
                cur.append(ch)
                cur_emoji = is_e
            else:
                runs.append((''.join(cur), cur_emoji))
                cur, cur_emoji = [ch], is_e
        if cur:
            runs.append((''.join(cur), cur_emoji))

        line_h = font.get_linesize()
        rendered = []
        for s, is_e in runs:
            use_font = self.emoji_font if (is_e and self.emoji_font) else font
            try:
                surf = use_font.render(s, True, color)
            except Exception:
                surf = font.render(s, True, color)
            # NotoColorEmoji renders at its native strike size (~109px) on
            # some SDL_ttf builds — scale to match the text line height.
            if is_e and self.emoji_font and surf.get_height() > line_h * 1.4:
                scale = line_h / surf.get_height()
                surf = pygame.transform.smoothscale(
                    surf, (max(1, int(surf.get_width() * scale)), line_h)
                )
            rendered.append(surf)

        total_w = sum(s.get_width() for s in rendered)
        total_h = max(s.get_height() for s in rendered) if rendered else line_h
        out = pygame.Surface((max(1, total_w), max(1, total_h)), pygame.SRCALPHA)
        x = 0
        for s in rendered:
            # vertical-center each run on the line
            y = (total_h - s.get_height()) // 2
            out.blit(s, (x, y))
            x += s.get_width()
        return out

    # -- compositor ---------------------------------------------------------

    def _draw_box(self, lines, anchor):
        """Render lines into a translucent black rounded box and blit at the
        given screen anchor. `anchor` is one of bl, br, tr, tl with a margin.
        """
        if not lines:
            return None
        pad_x, pad_y, gap, margin = 14, 10, 4, 30
        widths = [s.get_width() for s in lines]
        heights = [s.get_height() for s in lines]
        box_w = max(widths) + 2 * pad_x
        box_h = sum(heights) + (len(lines) - 1) * gap + 2 * pad_y
        bg = pygame.Surface((box_w, box_h), pygame.SRCALPHA)
        # roughly matches rgba(0,0,0,0.7) from the web kiosk
        bg.fill((0, 0, 0, 178))
        sw, sh = self.size
        if anchor == "bl":
            x, y = margin, sh - box_h - margin
        elif anchor == "br":
            x, y = sw - box_w - margin, sh - box_h - margin
        elif anchor == "tr":
            x, y = sw - box_w - margin, margin
        else:  # tl
            x, y = margin, margin
        self.screen.blit(bg, (x, y))
        cy = y + pad_y
        for surf, w in zip(lines, widths):
            # right-align inside the box for tr anchor (matches sensors CSS)
            if anchor == "tr":
                cx = x + box_w - pad_x - w
            else:
                cx = x + pad_x
            self.screen.blit(surf, (cx, cy))
            cy += surf.get_height() + gap
        return (x, y, box_w, box_h)

    # -- effects: video / audio / text --------------------------------------

    def _effect_active(self):
        """True iff a video or text effect is occupying the screen.
        Audio plays in the background and doesn't suppress photo rendering.
        """
        return self.video_proc is not None or self.text_overlay is not None

    def _video_on_screen(self):
        """True iff a live mpv window (effect or slideshow) owns the
        framebuffer, so the pygame compositor must not fight it for the
        screen. A slideshow entry with `proc is None` (mpv missing) doesn't
        cover anything, so the compositor still paints black + clock. A
        Popen handle outlives its process, so poll() — a crashed mpv must
        not park the compositor on a frozen frame until the next playback.
        """
        if self.video_proc is not None:
            return True
        sv = self.slideshow_video
        proc = sv.get("proc") if sv else None
        return proc is not None and proc.poll() is None

    def _have_mpv(self):
        if self._mpv_ok is None:
            self._mpv_ok = shutil.which("mpv") is not None
        return self._mpv_ok

    @staticmethod
    def _is_video(post):
        return bool(post) and str(post.get("ext") or "").lower() in ("mp4", "webm")

    # -- slideshow video (a `playback.current` that's mp4/webm) -------------

    def _build_video_url(self, post):
        # /get streams videos straight from disk with Range support; convert/
        # width/height/lowmem are ignored server-side for video, so omit them.
        # `vcodec` asks for the hardware-decodable H.264 variant (the server
        # transcodes on demand and falls back to raw when it can't).
        params = {
            "id": str(post["id"]),
            "token": self.cfg["access_token"],
            "deviceId": self.cfg["device_id"],
        }
        if self.cfg["vcodec"]:
            params["vcodec"] = self.cfg["vcodec"]
        return f"{self.cfg['http_base']}/get?{urllib.parse.urlencode(params)}"

    def _spawn_mpv_slideshow(self, url, ipc_path):
        # Muted (like the web kiosk's <video muted>), no OSC/input, terminal-
        # quiet. --loop-file=inf loops from the start so a short clip repeats
        # with no gap; the worker flips it to `no` once it learns the clip is
        # longer than the dwell. --keep-open=yes holds the last frame instead
        # of exiting so a played-once clip stays on screen until we advance.
        # --input-ipc-server exposes a socket for the duration query.
        cmd = [
            "mpv", "--fs", "--no-osc", "--no-input-default-bindings",
            "--no-input-terminal", "--no-terminal", "--really-quiet",
            "--no-audio", "--keep-open=yes", "--loop-file=inf",
            *self._mpv_hwdec_args(),
            f"--input-ipc-server={ipc_path}", url,
        ]
        return subprocess.Popen(cmd, stdin=subprocess.DEVNULL,
                                stdout=subprocess.DEVNULL,
                                stderr=subprocess.DEVNULL)

    def _mpv_hwdec_args(self):
        # mpv falls back to software decode on its own if the requested
        # hwdec fails to initialize, so passing a wrong value degrades
        # gracefully rather than breaking playback.
        hw = (self.cfg.get("hwdec") or "").strip()
        return [f"--hwdec={hw}"] if hw and hw.lower() != "no" else []

    def _play_slideshow_video(self, post):
        pid = post.get("id")
        if not pid:
            return
        if self.slideshow_video and self.slideshow_video.get("id") == pid:
            return  # already showing this clip
        if self._effect_active():
            # An effect owns the screen; don't spawn mpv behind/over it.
            # _maybe_restore_video_base re-applies from last_playback once
            # the effect clears.
            return
        self._stop_slideshow_video()
        self._slideshow_gen += 1
        gen = self._slideshow_gen
        self.current_id = pid
        self.base_surface = None
        self._roll_save_id(pid)

        if not self._have_mpv():
            log.warning("mpv not installed — slideshow video %s can't play", pid)
            # Record it so _maybe_restore_video_base doesn't respawn every
            # tick, and report ready so the channel advances instead of
            # riding the readiness timeout on a frame we can't render.
            self.slideshow_video = {"proc": None, "id": pid,
                                    "ipc_path": None, "gen": gen}
            if self.connected:
                self._send_image_ready(pid)
            return

        url = self._build_video_url(post)
        ipc_path = os.path.join(tempfile.gettempdir(),
                                f"roboframe-mpv-{os.getpid()}-{gen}.sock")
        try:
            os.unlink(ipc_path)
        except OSError:
            pass
        proc = self._spawn_mpv_slideshow(url, ipc_path)
        self.slideshow_video = {"proc": proc, "id": pid,
                                "ipc_path": ipc_path, "gen": gen}
        log.info("slideshow video %s", pid)
        threading.Thread(target=self._slideshow_video_worker,
                         args=(proc, ipc_path, pid, gen), daemon=True).start()

    def _stop_slideshow_video(self):
        sv = self.slideshow_video
        self.slideshow_video = None
        if not sv:
            return
        proc = sv.get("proc")
        if proc is not None:
            try:
                proc.terminate()
                try:
                    proc.wait(timeout=2)
                except subprocess.TimeoutExpired:
                    proc.kill()
            except Exception:
                pass
        if sv.get("ipc_path"):
            try:
                os.unlink(sv["ipc_path"])
            except OSError:
                pass
        if self.current_id == sv.get("id"):
            self.current_id = None

    def _slideshow_video_worker(self, proc, ipc_path, pid, gen):
        """Off-thread: learn the clip length over mpv's IPC socket, set the
        loop policy, then report imageReady{id, durationMs}. Fenced on `gen`
        so a superseded clip's late report can't fire.
        """
        duration_ms = 0
        try:
            sock = self._mpv_connect(ipc_path, proc, timeout=5)
            if sock is not None:
                try:
                    dur = self._mpv_get_duration(sock, timeout=5)
                    if dur and dur > 0:
                        duration_ms = int(round(dur * 1000))
                    # Play a clip longer than the dwell exactly once (then
                    # hold its last frame via keep-open); shorter clips keep
                    # looping. Looping a long clip would flash its opening
                    # frame just before the advance.
                    if duration_ms and duration_ms > self.interval:
                        self._mpv_command(sock, ["set_property", "loop-file", "no"])
                finally:
                    sock.close()
        except Exception as e:
            log.warning("mpv ipc failed for %s: %s", pid, e)
        # Only report if this clip is still the current one.
        sv = self.slideshow_video
        if sv and sv.get("gen") == gen and self.connected and not self._is_off():
            self._send_image_ready(pid, duration_ms)

    # -- mpv JSON IPC (unix socket) -----------------------------------------

    @staticmethod
    def _mpv_connect(ipc_path, proc, timeout):
        deadline = time.monotonic() + timeout
        while time.monotonic() < deadline:
            if proc.poll() is not None:
                return None  # mpv exited before the socket came up
            try:
                s = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
                s.settimeout(2)
                s.connect(ipc_path)
                return s
            except (FileNotFoundError, ConnectionRefusedError, OSError):
                time.sleep(0.1)
        return None

    @staticmethod
    def _mpv_command(sock, command):
        """Send one command and return its reply dict (the line carrying an
        `error` field), skipping the async `event` lines mpv interleaves.
        """
        sock.sendall((json.dumps({"command": command}) + "\n").encode())
        buf = b""
        deadline = time.monotonic() + 2
        while time.monotonic() < deadline:
            try:
                chunk = sock.recv(4096)
            except socket.timeout:
                break
            if not chunk:
                break
            buf += chunk
            while b"\n" in buf:
                line, buf = buf.split(b"\n", 1)
                if not line.strip():
                    continue
                try:
                    obj = json.loads(line)
                except ValueError:
                    continue
                if "error" in obj:  # command reply (events lack `error`)
                    return obj
        return None

    def _mpv_get_duration(self, sock, timeout):
        # `duration` is unknown until mpv has demuxed the file, so poll.
        deadline = time.monotonic() + timeout
        while time.monotonic() < deadline:
            reply = self._mpv_command(sock, ["get_property", "duration"])
            if reply and reply.get("error") == "success":
                d = reply.get("data")
                if isinstance(d, (int, float)) and d > 0:
                    return float(d)
            time.sleep(0.2)
        return 0

    def _maybe_restore_video_base(self):
        """Re-spawn the slideshow video when a screen-covering effect that
        pre-empted it clears. Idempotent and cheap — runs each main-loop
        tick. No-op unless the current playback frame is a video that isn't
        already playing.
        """
        if self._effect_active() or self._is_off():
            return
        cur = (self.last_playback or {}).get("current") or {}
        if not self._is_video(cur):
            return
        if self.slideshow_video and self.slideshow_video.get("id") == cur.get("id"):
            return
        self._play_slideshow_video(cur)

    def _spawn_mpv_video(self, url):
        # mpv flags chosen for kiosk use: fullscreen, no on-screen controls,
        # no input handling (we don't want spurious key presses to crash
        # playback), terminal-quiet so journal logs don't drown in spam.
        # --keep-open=no makes mpv exit when the clip ends so we can detect it.
        cmd = [
            "mpv", "--fs", "--no-osc", "--no-input-default-bindings",
            "--no-input-terminal", "--no-terminal", "--really-quiet",
            "--keep-open=no", "--loop-file=no",
            *self._mpv_hwdec_args(), url,
        ]
        return subprocess.Popen(cmd, stdin=subprocess.DEVNULL,
                                stdout=subprocess.DEVNULL,
                                stderr=subprocess.DEVNULL)

    def _spawn_mpv_audio(self, url):
        # 30s cap mirrors public/modules/effects.js (visionOS SystemSound
        # parity). --no-video keeps mpv off the screen.
        cmd = [
            "mpv", "--no-video", "--no-input-default-bindings",
            "--no-input-terminal", "--no-terminal", "--really-quiet",
            "--keep-open=no", "--length=30", url,
        ]
        return subprocess.Popen(cmd, stdin=subprocess.DEVNULL,
                                stdout=subprocess.DEVNULL,
                                stderr=subprocess.DEVNULL)

    def _watch_proc(self, attr_name):
        """Background thread: wait for the named subprocess, then null it
        and mark the overlay dirty so the run loop knows to recomposite
        (photo path resumes once `_effect_active` flips back to False).
        """
        proc = getattr(self, attr_name)
        if proc is None:
            return
        proc.wait()
        with self.effect_lock:
            if getattr(self, attr_name) is proc:
                setattr(self, attr_name, None)
        self._overlay_dirty = True
        log.info("%s ended", attr_name)

    def _play_video(self, url):
        log.info("playVideo %s", url)
        self._stop_video()
        # An effect video pre-empts a slideshow video (both are fullscreen
        # mpv — running two 1080p decoders would OOM a Pi 3). It's re-applied
        # from last_playback once the effect clears.
        self._stop_slideshow_video()
        try:
            with self.effect_lock:
                self.video_proc = self._spawn_mpv_video(url)
        except FileNotFoundError:
            log.warning("mpv not installed — playVideo dropped")
            return
        threading.Thread(target=self._watch_proc,
                         args=("video_proc",), daemon=True).start()
        self._overlay_dirty = True

    def _stop_video(self):
        with self.effect_lock:
            p = self.video_proc
            self.video_proc = None
        if p is not None:
            log.info("stopVideo")
            try:
                p.terminate()
                try:
                    p.wait(timeout=2)
                except subprocess.TimeoutExpired:
                    p.kill()
            except Exception:
                pass
        self._overlay_dirty = True

    def _play_audio(self, url):
        log.info("playAudio %s", url)
        self._stop_audio()
        try:
            with self.effect_lock:
                self.audio_proc = self._spawn_mpv_audio(url)
        except FileNotFoundError:
            log.warning("mpv not installed — playAudio dropped")
            return
        threading.Thread(target=self._watch_proc,
                         args=("audio_proc",), daemon=True).start()

    def _stop_audio(self):
        with self.effect_lock:
            p = self.audio_proc
            self.audio_proc = None
        if p is not None:
            log.info("stopAudio")
            try:
                p.terminate()
                try:
                    p.wait(timeout=2)
                except subprocess.TimeoutExpired:
                    p.kill()
            except Exception:
                pass

    def _show_text(self, text, bg_hex, image_url):
        log.info("showText %r bg=%s img=%s", text[:40], bg_hex, bool(image_url))
        # The text overlay is painted with pygame, which sits *behind* a
        # fullscreen mpv window — so a playing slideshow video would hide it.
        # Tear it down; it resumes when the text is dismissed.
        self._stop_slideshow_video()
        bg = self._parse_hex(bg_hex)
        sw, sh = self.size

        image_surf = None
        if image_url:
            if not image_url.startswith(("http://", "https://")):
                # Resolve relative URLs (e.g. "/get?id=...") against the
                # broker; the server's HTTP endpoints are served from the
                # same host:port as the WebSocket.
                sep = "" if image_url.startswith("/") else "/"
                image_url = f"{self.cfg['http_base']}{sep}{image_url}"
                # If the URL is one of our own /get / /save endpoints add
                # the access token so the server's auth gate accepts it.
                if "/get" in image_url or "/save" in image_url:
                    image_url += ("&" if "?" in image_url else "?") + \
                        "token=" + urllib.parse.quote(self.cfg["access_token"])
            try:
                r = SESSION.get(image_url, timeout=15)
                r.raise_for_status()
                img = Image.open(io.BytesIO(r.content))
                img.load()
                # CSS gives the image max-width: 25% of screen, no height
                # cap. Keep aspect, fit within that box.
                box_w = sw // 4
                box_h = sh // 2
                if img.width > box_w or img.height > box_h:
                    img.thumbnail((box_w, box_h), Image.LANCZOS)
                if img.mode != "RGB":
                    img = img.convert("RGBA")
                    mode = "RGBA"
                else:
                    mode = "RGB"
                image_surf = pygame.image.fromstring(img.tobytes(), img.size, mode)
            except Exception as e:
                log.warning("showText image fetch failed: %s", e)

        # Auto-size font so the (single-line) text spans most of the screen
        # while still fitting horizontally and vertically. Binary search.
        text_surf = None
        if text:
            text_font_path = self._find_font([
                "/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf",
                "/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf",
            ])
            avail_h = sh - 40
            if image_surf is not None:
                avail_h -= image_surf.get_height() + 20
            avail_w = sw - 40
            lo, hi = 8, max(8, avail_h)
            best = None
            for _ in range(20):
                mid = (lo + hi) // 2
                font = pygame.font.Font(text_font_path, mid)
                w, h = font.size(text)
                if w <= avail_w and h <= avail_h:
                    best = (mid, w, h)
                    lo = mid + 1
                else:
                    hi = mid - 1
                if hi < lo:
                    break
            if best is None:
                # text doesn't fit at minimum size; render anyway
                font = pygame.font.Font(text_font_path, 8)
            else:
                font = pygame.font.Font(text_font_path, best[0])
            text_surf = self._render_mixed(text, font, (255, 255, 255))

        self.text_overlay = {"bg": bg, "image": image_surf, "text": text_surf}
        self._overlay_dirty = True

    def _dismiss_text(self):
        if self.text_overlay is not None:
            log.info("dismissText")
            self.text_overlay = None
            self._overlay_dirty = True

    @staticmethod
    def _parse_hex(s):
        s = (s or "#000000").lstrip("#")
        if len(s) == 3:
            s = "".join(c * 2 for c in s)
        try:
            return (int(s[0:2], 16), int(s[2:4], 16), int(s[4:6], 16))
        except ValueError:
            return (0, 0, 0)

    def _draw_text_overlay(self):
        ov = self.text_overlay
        if ov is None:
            return
        self.screen.fill(ov["bg"])
        sw, sh = self.size
        items = []
        if ov["image"] is not None:
            items.append(ov["image"])
        if ov["text"] is not None:
            items.append(ov["text"])
        if not items:
            return
        gap = 20
        total_h = sum(s.get_height() for s in items) + gap * (len(items) - 1)
        y = (sh - total_h) // 2
        for surf in items:
            x = (sw - surf.get_width()) // 2
            self.screen.blit(surf, (x, y))
            y += surf.get_height() + gap

    def _composite_overlay(self):
        """Re-blit base + clock/date/sensors/toasts onto screen.

        Returns True if anything in the overlay layer is still animating
        (toasts) so the run loop should keep ticking compositor work.
        """
        now_mono = time.monotonic()
        with self.toasts_lock:
            self.toasts = [(s, t) for (s, t) in self.toasts if t > now_mono]
            active_toasts = list(self.toasts)

        # 0. Effect overlay takes precedence over the photo. Video is
        # drawn by mpv directly (we leave the framebuffer untouched and
        # let mpv's fullscreen window cover us) — this covers both the
        # playVideo effect and a slideshow video; text/image overlay we
        # paint here.
        if self._video_on_screen():
            # Don't fight mpv for the framebuffer.
            return False
        if self.text_overlay is not None:
            self._draw_text_overlay()
            pygame.display.flip()
            return False

        # Server-driven panel-off (HA / displayState=off): the panel is
        # supposed to be dark, so overlays would leak light through any
        # DDC dim — short-circuit to a black frame.
        if self.server_off:
            self.screen.fill((0, 0, 0))
            pygame.display.flip()
            return False

        # 1. base image (or black). The local 'p'-key toggle (force_off)
        # only hides the photo; clock / date / sensors stay visible so the
        # frame still reads as a status surface.
        self.screen.fill((0, 0, 0))
        if not self.force_off and self.base_surface is not None:
            sw, sh = self.size
            iw, ih = self.base_surface.get_size()
            self.screen.blit(self.base_surface, ((sw - iw) // 2, (sh - ih) // 2))

        # 2. clock (bottom-left) + date (bottom-right)
        local = time.localtime()
        clock_str = time.strftime("%H:%M:%S", local)
        date_str = time.strftime("%a, %b %-d", local)
        self._last_clock_str = clock_str
        clock_surf = self.clock_font.render(clock_str, True, (222, 222, 222))
        date_surf = self.clock_font.render(date_str, True, (222, 222, 222))
        self._draw_box([clock_surf], "bl")
        self._draw_box([date_surf], "br")

        # 3. sensors (top-right), sorted by ascii-stripped friendly_name
        with self.sensors_lock:
            entries = sorted(self.sensors.values(),
                             key=lambda e: ''.join(c for c in e["sort"] if 32 <= ord(c) < 127))
        sensor_lines = []
        for e in entries:
            prefix = "❗ " if e["stale"] else ""
            text = f"{prefix}{e['name']}: {e['value']}"
            sensor_lines.append(self._render_mixed(text, self.sensor_font, (222, 222, 222)))
        self._draw_box(sensor_lines, "tr")

        # 4. toasts (top-right, on top of sensors — matches the web kiosk's
        # z-index stacking). Stagger downward from the top.
        margin, gap, pad_x, pad_y = 20, 6, 10, 6
        y = margin
        for surf, _ in active_toasts:
            w, h = surf.get_size()
            box_w = w + 2 * pad_x
            box_h = h + 2 * pad_y
            x = self.size[0] - box_w - margin
            bg = pygame.Surface((box_w, box_h), pygame.SRCALPHA)
            bg.fill((51, 51, 51, 230))
            self.screen.blit(bg, (x, y))
            self.screen.blit(surf, (x + pad_x, y + pad_y))
            y += box_h + gap

        pygame.display.flip()
        return bool(active_toasts)

    def _is_off(self):
        return self.server_off or self.force_off

    def _set_server_off(self, off):
        was_off = self._is_off()
        self.server_off = off
        log.info("server displayState=%s", "off" if off else "on")
        self._resolve_visibility(was_off)

    def _set_force_off(self, off):
        was_off = self._is_off()
        self.force_off = off
        log.info("local force_off=%s", off)
        self._resolve_visibility(was_off)

    def _resolve_visibility(self, was_off):
        is_off = self._is_off()
        if is_off == was_off:
            return
        if is_off:
            self._stop_slideshow_video()
            self.base_surface = None
            self.current_id = None
            # Repaint immediately so the transition is visually instant.
            # The compositor decides whether to draw overlays based on
            # which off-flavor (server vs force) is active.
            self._composite_overlay()
        else:
            if self.last_playback:
                self._apply_playback(self.last_playback)
        self._send_visibility(not is_off)

    def _drain_fetch_ready(self):
        """Promote any fetched surfaces and render if one matches `current`."""
        cur_id = ((self.last_playback or {}).get("current") or {}).get("id")
        rendered = False
        try:
            while True:
                pid, surf = self.fetcher.ready_q.get_nowait()
                # surface itself is already in the cache; ready_q is just a
                # wake-up signal for the main thread.
                if surf is None:
                    continue
                if pid == cur_id and pid != self.current_id and not self._is_off():
                    self._render(pid, surf)
                    rendered = True
        except queue.Empty:
            pass
        # On re-apply (e.g. wake) the surface may already be cached when we
        # got the playback frame — render proactively.
        if not rendered and cur_id and cur_id != self.current_id and not self._is_off():
            s = self.fetcher.get(cur_id)
            if s is not None:
                self._render(cur_id, s)

    SAVE_ID_LAG = 1.5  # seconds; see save_id docstring above.

    def _render(self, pid, surf):
        self.base_surface = surf
        self._composite_overlay()
        self.current_id = pid
        log.info("rendered %s", pid)
        if self.connected:
            self._send_image_ready(pid)
        self._roll_save_id(pid)

    def _roll_save_id(self, pid):
        """Advance the SPACE-key save target to `pid` after a grace window —
        until then SPACE still targets the previously-shown post (so a save
        pressed just as the post switches hits the one being looked at).
        Called for both images (on render) and videos (on playback start).
        """
        if self._save_id_timer is not None:
            self._save_id_timer.cancel()
        if self.save_id is None:
            # First post of the session: no preceding one to protect.
            self.save_id = pid
        else:
            t = threading.Timer(self.SAVE_ID_LAG, self._promote_save_id, args=(pid,))
            t.daemon = True
            self._save_id_timer = t
            t.start()

    def _promote_save_id(self, pid):
        self.save_id = pid

    # -- run loop -----------------------------------------------------------

    # -- keyboard shortcuts -------------------------------------------------
    # Matches the web kiosk's mapping in public/modules/ui.js so the
    # gpio-agent keypad (../gpio-agent/config.json) drives both clients
    # identically: B=block, S=tag list (then digit 0-9), D=displaySync,
    # P=panel off toggle, SPACE=save, T=reshuffle, RIGHT=next, Ctrl+R=refresh.
    def _on_key(self, ev):
        k = ev.key
        mods = ev.mod

        if self.awaiting_taglist:
            if pygame.K_0 <= k <= pygame.K_9:
                n = k - pygame.K_0
                if self.tag_lists_count and n < self.tag_lists_count:
                    self.conn.send({"sessionId": KIOSK_SESSION_ID,
                                    "action": "setTagList",
                                    "payload": {"listNumber": n}})
                    self.toast(f"Tag list {n}")
                else:
                    self.toast(f"Tag list {n} out of range (0-{max(0, self.tag_lists_count - 1)})")
            else:
                self.toast(f"Press 0-{max(0, self.tag_lists_count - 1)} for tag list")
            self.awaiting_taglist = False
            return

        if k == pygame.K_r and (mods & pygame.KMOD_CTRL):
            self.toast("Refreshing…")
            os.execv(sys.executable, [sys.executable, *sys.argv])
        elif k == pygame.K_b:
            if self.current_id:
                self.conn.send({"action": "block",
                                "payload": {"id": self.current_id}})
                self.toast(f"Blocked {self.current_id}")
        elif k == pygame.K_s:
            self.awaiting_taglist = True
            self.toast(f"Tag list (0-{max(0, self.tag_lists_count - 1)})?")
        elif k == pygame.K_d:
            self.is_primary_sync = not self.is_primary_sync
            self.conn.send({"sessionId": KIOSK_SESSION_ID,
                            "action": "displaySync",
                            "payload": {"enabled": self.is_primary_sync}})
            self.toast(f"Display Sync {'ON' if self.is_primary_sync else 'OFF'}")
        elif k == pygame.K_p:
            self._set_force_off(not self.force_off)
            self.toast(f"Image {'hidden' if self.force_off else 'shown'}")
        elif k == pygame.K_SPACE:
            pid = self.save_id
            if pid:
                self.toast(f"Saving {pid}")
                threading.Thread(target=self._save_remote,
                                 args=(pid,), daemon=True).start()
        elif k == pygame.K_t:
            self.conn.send({"sessionId": KIOSK_SESSION_ID, "action": "reshuffle"})
            self.toast("Reshuffling")
        elif k == pygame.K_RIGHT:
            self.conn.send({"sessionId": KIOSK_SESSION_ID, "action": "requestNext"})
            self.toast("Next")

    def _save_remote(self, pid):
        try:
            r = SESSION.get(f"{self.cfg['http_base']}/save",
                            params={"id": str(pid),
                                    "token": self.cfg["access_token"]},
                            timeout=15)
            text = (r.text or "").strip()[:120] or f"HTTP {r.status_code}"
            self.toast(text if r.ok else f"Save failed: {text}")
        except Exception as e:
            self.toast(f"Save error: {e}")

    def run(self):
        self.conn.start()
        clock = pygame.time.Clock()
        running = True
        # The clock overlay updates once per second; that's the natural
        # tick for the overlay layer when nothing else is dirty. Toasts
        # need ~30 Hz for the ~250 ms enter/exit feel; we run the loop at
        # 30 Hz unconditionally but skip flips when nothing changed.
        last_clock_tick = 0
        while running:
            for ev in pygame.event.get():
                if ev.type == pygame.QUIT:
                    running = False
                elif ev.type == pygame.KEYDOWN:
                    if ev.key == pygame.K_ESCAPE:
                        running = False
                    else:
                        self._on_key(ev)
            try:
                while True:
                    msg = self.frame_q.get_nowait()
                    self._process_ws(msg)
            except queue.Empty:
                pass
            self._drain_fetch_ready()
            # Resume a slideshow video that a now-cleared effect pre-empted.
            self._maybe_restore_video_base()

            # Decide whether to recomposite this tick:
            #   - toasts active → every frame (fade animation)
            #   - sensors/displayState changed → once
            #   - clock second rolled over → once
            now = int(time.time())
            clock_changed = (now != last_clock_tick)
            if self.toasts or self._overlay_dirty or clock_changed:
                last_clock_tick = now
                self._overlay_dirty = bool(self._composite_overlay())
            clock.tick(30)
        self._stop_slideshow_video()
        self._stop_video()
        self._stop_audio()
        self.conn.stop()
        pygame.quit()


def main():
    logging.basicConfig(
        level=os.environ.get("LOG_LEVEL", "INFO"),
        format="%(asctime)s %(levelname)s %(name)s %(message)s",
    )
    cfg = load_config()
    log.info("device_id=%s ws=%s", cfg["device_id"], cfg["ws_url"])
    # SDL2 video driver hint: under Openbox/X11 the default is fine; on
    # KMS-only setups set SDL_VIDEODRIVER=kmsdrm before launching.
    socket.setdefaulttimeout(20)
    def _sigterm(*_):
        raise KeyboardInterrupt
    signal.signal(signal.SIGTERM, _sigterm)
    try:
        Kiosk(cfg).run()
    except KeyboardInterrupt:
        log.info("interrupted")


if __name__ == "__main__":
    main()
