#!/usr/bin/env python3
"""GPIO agent: PIR -> Home Assistant webhook AND 4x4 matrix keypad -> uinput keystrokes.

Reads /opt/gpio-agent/config.json. Either subsystem can be disabled by setting
its "enabled" key to false.

key_map values may be:
  - null            : no action
  - "X"             : passthrough single key (digit, letter, or alias like SPACE)
  - "KEY_FOO"       : raw evdev ecode name
  - ["LCTRL","R"]   : passthrough chord (down all, up all on release; press emits
                      modifier-then-key, release emits in reverse)
  - {"tap": ..., "hold": ...} : tap on short press/release, hold action fires
                      once after `hold_ms` (default 500). When the hold action
                      fires, the tap is suppressed. Each side may itself be a
                      single key, a chord list, or null. Hold-aware keys are
                      emitted as a discrete press-and-release (no hold-and-release).
"""
import json
import logging
import os
import signal
import sys
import threading
import time
import urllib.error
import urllib.request
from pathlib import Path

from gpiozero import DigitalInputDevice, DigitalOutputDevice, MotionSensor
from evdev import UInput, ecodes as e

CONFIG = Path(os.environ.get("GPIO_AGENT_CONFIG", "/opt/gpio-agent/config.json"))
log = logging.getLogger("gpio-agent")


# ---- PIR -> webhook ---------------------------------------------------------
def _post(url: str, payload: dict, timeout: float) -> None:
    req = urllib.request.Request(
        url,
        data=json.dumps(payload).encode(),
        headers={"Content-Type": "application/json"},
        method="POST",
    )
    try:
        with urllib.request.urlopen(req, timeout=timeout) as resp:
            log.info("POST %s -> %s", url, resp.status)
    except urllib.error.HTTPError as ex:
        log.warning("POST %s -> HTTP %s", url, ex.code)
    except Exception as ex:
        log.error("POST %s failed: %s", url, ex)


def start_pir(cfg: dict, display=None):
    pin = int(cfg["gpio_pin"])
    motion_url = cfg["motion_url"]
    clear_url = cfg["clear_url"]
    timeout = float(cfg.get("http_timeout_sec", 10))
    pir = MotionSensor(pin, queue_len=5, sample_rate=10, threshold=0.5)

    def on_motion():
        if display is not None:
            display.set_active(True)
        _post(motion_url, {"state": "motion", "pin": pin}, timeout)

    def on_clear():
        if display is not None:
            display.set_active(False)
        _post(clear_url, {"state": "clear", "pin": pin}, timeout)

    pir.when_motion = on_motion
    pir.when_no_motion = on_clear
    if display is not None:
        display.set_active(bool(pir.motion_detected))
    log.info("pir watching GPIO%d, initial=%s", pin, "motion" if pir.motion_detected else "clear")
    return pir


# ---- key resolution ---------------------------------------------------------
_SYM_NAMES = {
    "SPACE": "KEY_SPACE",
    "ENTER": "KEY_ENTER",
    "RETURN": "KEY_ENTER",
    "TAB": "KEY_TAB",
    "ESC": "KEY_ESC",
    "BACKSPACE": "KEY_BACKSPACE",
    "DELETE": "KEY_DELETE",
    "DOT": "KEY_DOT",
    "COMMA": "KEY_COMMA",
    "MINUS": "KEY_MINUS",
    "LEFT": "KEY_LEFT",
    "RIGHT": "KEY_RIGHT",
    "UP": "KEY_UP",
    "DOWN": "KEY_DOWN",
    "LCTRL": "KEY_LEFTCTRL",
    "LEFTCTRL": "KEY_LEFTCTRL",
    "RCTRL": "KEY_RIGHTCTRL",
    "RIGHTCTRL": "KEY_RIGHTCTRL",
    "LSHIFT": "KEY_LEFTSHIFT",
    "LEFTSHIFT": "KEY_LEFTSHIFT",
    "RSHIFT": "KEY_RIGHTSHIFT",
    "RIGHTSHIFT": "KEY_RIGHTSHIFT",
    "LALT": "KEY_LEFTALT",
    "LEFTALT": "KEY_LEFTALT",
    "RALT": "KEY_RIGHTALT",
    "RIGHTALT": "KEY_RIGHTALT",
    "LMETA": "KEY_LEFTMETA",
    "LEFTMETA": "KEY_LEFTMETA",
    "SUPER": "KEY_LEFTMETA",
}


def _resolve_one(name: str):
    if not name:
        return None
    n = name.upper()
    if n in _SYM_NAMES:
        return getattr(e, _SYM_NAMES[n], None)
    if len(n) == 1 and (n.isdigit() or n.isalpha()):
        return getattr(e, f"KEY_{n}", None)
    if n.startswith("KEY_"):
        return getattr(e, n, None)
    return None


def _resolve_chord(spec):
    """Resolve a chord spec to a list of ecodes, or None."""
    if spec is None:
        return None
    if isinstance(spec, str):
        code = _resolve_one(spec)
        return [code] if code is not None else None
    if isinstance(spec, list):
        codes = [_resolve_one(s) for s in spec]
        return codes if all(c is not None for c in codes) else None
    return None


class KeyMapEntry:
    """A parsed key_map entry."""
    __slots__ = ("hold_aware", "passthrough", "tap", "hold")

    def __init__(self, spec):
        self.hold_aware = False
        self.passthrough = None
        self.tap = None
        self.hold = None
        if spec is None:
            return
        if isinstance(spec, dict) and ("tap" in spec or "hold" in spec):
            self.hold_aware = True
            self.tap = _resolve_chord(spec.get("tap"))
            self.hold = _resolve_chord(spec.get("hold"))
        else:
            self.passthrough = _resolve_chord(spec)

    def all_codes(self):
        codes = set()
        for c in (self.passthrough, self.tap, self.hold):
            if c:
                codes.update(c)
        return codes


# ---- 4x4 keypad -> uinput ---------------------------------------------------
class Keypad(threading.Thread):
    def __init__(self, cfg: dict):
        super().__init__(daemon=True, name="keypad")
        self.layout = cfg["layout"]
        self.row_pins = cfg["row_pins"]
        self.col_pins = cfg["col_pins"]
        self.debounce_ms = float(cfg.get("debounce_ms", 30))
        self.scan_ms = float(cfg.get("scan_interval_ms", 5))
        self.hold_ms = float(cfg.get("hold_ms", 500))
        self.diagnose = bool(cfg.get("diagnose", False))
        self._stop = threading.Event()

        self.entries = {char: KeyMapEntry(spec) for char, spec in cfg.get("key_map", {}).items()}

        self.rows = [DigitalOutputDevice(p, initial_value=True) for p in self.row_pins]
        self.cols = [DigitalInputDevice(p, pull_up=True) for p in self.col_pins]

        ev_keys = set()
        for ent in self.entries.values():
            ev_keys.update(ent.all_codes())
        if not ev_keys:
            ev_keys.add(e.KEY_RESERVED)
        self.ui = UInput({e.EV_KEY: list(ev_keys)}, name="pi-keypad", vendor=0x1209, product=0xBEEF)
        log.info("keypad uinput device created with %d distinct ecodes", len(ev_keys))

        self.state = {}        # (r,c) -> bool
        self.last_change = {}  # (r,c) -> monotonic
        self.press_time = {}   # (r,c) -> monotonic, only for hold-aware in down state
        self.hold_fired = {}   # (r,c) -> bool

    def stop(self):
        self._stop.set()

    # ---- uinput emission helpers ----
    def _emit_chord_state(self, codes, pressed):
        """Press all codes (in order) on press; release in reverse on release."""
        if not codes:
            return
        seq = codes if pressed else list(reversed(codes))
        try:
            for c in seq:
                self.ui.write(e.EV_KEY, c, 1 if pressed else 0)
            self.ui.syn()
        except Exception as ex:
            log.error("uinput state-emit failed: %s", ex)

    def _emit_tap(self, codes):
        """Discrete tap of a chord: press all in order, syn, release in reverse, syn."""
        if not codes:
            return
        try:
            for c in codes:
                self.ui.write(e.EV_KEY, c, 1)
            self.ui.syn()
            for c in reversed(codes):
                self.ui.write(e.EV_KEY, c, 0)
            self.ui.syn()
        except Exception as ex:
            log.error("uinput tap failed: %s", ex)

    # ---- state-change handling ----
    def _on_change(self, char, key, pressed):
        ent = self.entries.get(char)
        if self.diagnose:
            log.info("KEY %s %s%s", char, "down" if pressed else "up",
                     "" if ent else " (no mapping)")
        if ent is None:
            return
        if ent.hold_aware:
            if pressed:
                self.press_time[key] = time.monotonic()
                self.hold_fired[key] = False
            else:
                fired = self.hold_fired.pop(key, False)
                self.press_time.pop(key, None)
                if not fired and ent.tap:
                    self._emit_tap(ent.tap)
        else:
            self._emit_chord_state(ent.passthrough, pressed)

    def _check_holds(self, now):
        thresh = self.hold_ms / 1000.0
        for key, t0 in list(self.press_time.items()):
            if self.hold_fired.get(key, False):
                continue
            if now - t0 < thresh:
                continue
            ri, ci = key
            try:
                char = self.layout[ri][ci]
            except IndexError:
                continue
            ent = self.entries.get(char)
            if ent is None or not ent.hold_aware:
                continue
            self.hold_fired[key] = True
            if self.diagnose:
                log.info("KEY %s HOLD-FIRE", char)
            if ent.hold:
                self._emit_tap(ent.hold)

    # ---- scan loop ----
    def run(self):
        log.info("keypad scan starting rows=%s cols=%s hold_ms=%.0f",
                 self.row_pins, self.col_pins, self.hold_ms)
        for row in self.rows:
            row.on()
        debounce_s = self.debounce_ms / 1000.0
        scan_s = self.scan_ms / 1000.0
        try:
            while not self._stop.is_set():
                for ri, row in enumerate(self.rows):
                    row.off()
                    time.sleep(0.0005)  # settle
                    for ci, col in enumerate(self.cols):
                        pressed = (col.value == 1)
                        key = (ri, ci)
                        if pressed != self.state.get(key, False):
                            now = time.monotonic()
                            if now - self.last_change.get(key, 0) >= debounce_s:
                                self.state[key] = pressed
                                self.last_change[key] = now
                                try:
                                    char = self.layout[ri][ci]
                                except IndexError:
                                    char = "?"
                                self._on_change(char, key, pressed)
                    row.on()
                self._check_holds(time.monotonic())
                time.sleep(scan_s)
        finally:
            try:
                self.ui.close()
            except Exception:
                pass


# ---- SSD1306 OLED display ---------------------------------------------------
class Display(threading.Thread):
    """Render big HH:MM centered on a 128x64 SSD1306 I2C OLED."""

    def __init__(self, cfg: dict):
        super().__init__(name="display", daemon=True)
        self.i2c_port = int(cfg.get("i2c_port", 1))
        self.i2c_address = int(str(cfg.get("i2c_address", "0x3C")), 0)
        self.width = int(cfg.get("width", 128))
        self.height = int(cfg.get("height", 64))
        self.rotate = int(cfg.get("rotate", 0))  # 0/1/2/3 -> 0/90/180/270
        self.font_path = cfg.get("font_path", "/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf")
        self.font_size = int(cfg.get("font_size", 36))
        self.time_fmt = cfg.get("time_format", "%H:%M")
        self.contrast = int(cfg.get("contrast", 255))
        self.pir_gated = bool(cfg.get("pir_gated", True))
        self._stop = threading.Event()
        self._wake = threading.Event()
        self._active = True
        self._active_lock = threading.Lock()

    def stop(self):
        self._stop.set()
        self._wake.set()

    def set_active(self, active: bool):
        with self._active_lock:
            if active == self._active:
                return
            self._active = active
        log.info("display %s", "wake" if active else "sleep")
        self._wake.set()

    def run(self):
        # Lazy imports so a missing display package doesn't break PIR/keypad.
        from luma.core.interface.serial import i2c
        from luma.oled.device import ssd1306
        from PIL import Image, ImageDraw, ImageFont

        serial = i2c(port=self.i2c_port, address=self.i2c_address)
        device = ssd1306(serial, width=self.width, height=self.height, rotate=self.rotate)
        try:
            device.contrast(self.contrast)
        except Exception:
            pass
        try:
            font = ImageFont.truetype(self.font_path, self.font_size)
        except Exception as ex:
            log.warning("display: font %s failed (%s); using default", self.font_path, ex)
            font = ImageFont.load_default()

        last_text = None
        last_active = True
        try:
            while not self._stop.is_set():
                with self._active_lock:
                    active = self._active
                if not active:
                    if last_active:
                        try:
                            device.hide()
                        except Exception:
                            pass
                        last_active = False
                        last_text = None
                    self._wake.wait()
                    self._wake.clear()
                    continue
                if not last_active:
                    try:
                        device.show()
                    except Exception:
                        pass
                    last_active = True
                text = time.strftime(self.time_fmt)
                if text != last_text:
                    img = Image.new("1", (self.width, self.height), 0)
                    draw = ImageDraw.Draw(img)
                    bbox = draw.textbbox((0, 0), text, font=font)
                    tw, th = bbox[2] - bbox[0], bbox[3] - bbox[1]
                    x = (self.width - tw) // 2 - bbox[0]
                    y = (self.height - th) // 2 - bbox[1]
                    draw.text((x, y), text, font=font, fill=255)
                    device.display(img)
                    last_text = text
                # wait until next second boundary, but wake early on state change
                self._wake.clear()
                self._wake.wait(max(0.05, 1.0 - (time.time() % 1.0)))
                if self._stop.is_set():
                    break
        finally:
            try:
                device.clear()
                device.hide()
            except Exception:
                pass


# ---- main -------------------------------------------------------------------
def main() -> int:
    logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s")
    cfg = json.loads(CONFIG.read_text())

    holders = []

    display = None
    disp_cfg = cfg.get("display", {})
    if disp_cfg.get("enabled", False):
        display = Display(disp_cfg)
        display.start()
        holders.append(display)

    pir_cfg = cfg.get("pir", {})
    if pir_cfg.get("enabled", True):
        pir_display = display if (display is not None and disp_cfg.get("pir_gated", True)) else None
        holders.append(start_pir(pir_cfg, display=pir_display))

    keypad = None
    kp_cfg = cfg.get("keypad", {})
    if kp_cfg.get("enabled", True):
        keypad = Keypad(kp_cfg)
        keypad.start()
        holders.append(keypad)

    log.info("gpio-agent ready (pir=%s, keypad=%s, display=%s)",
             pir_cfg.get("enabled", True), kp_cfg.get("enabled", True),
             disp_cfg.get("enabled", False))
    signal.sigwait([signal.SIGTERM, signal.SIGINT])
    log.info("shutting down")
    if keypad:
        keypad.stop()
        keypad.join(timeout=2)
    if display:
        display.stop()
        display.join(timeout=2)
    return 0


if __name__ == "__main__":
    sys.exit(main())
