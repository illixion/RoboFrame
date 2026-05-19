# gpio-agent

A small Python daemon for the Pi that bridges three pieces of hardware
into the rest of RoboFrame:

| Hardware                    | What it drives                                                                |
|-----------------------------|-------------------------------------------------------------------------------|
| PIR motion sensor           | HTTP POST to node-display's `/pir/motion` and `/pir/clear` (port 8765 default) — wakes/sleeps the panel. |
| 4x4 matrix keypad           | Synthesises keystrokes via `/dev/uinput` — drives the kiosk's keyboard shortcuts so the physical keypad gives you SPACE/B/S/D/P/T/RIGHT/Ctrl+R without a real keyboard. |
| Optional SSD1306 OLED       | Renders a PIR-gated `HH:MM` clock on a 128x64 I2C display.                    |

Runs as `root` because gpiozero needs `/dev/gpiomem` and evdev's `UInput`
needs `/dev/uinput`. Each subsystem is independently toggleable via its
`enabled` flag in [config.example.json](config.example.json); the
others keep running if one is disabled or unwired.

## Install (Raspberry Pi OS / Debian)

```bash
sudo apt install python3-gpiozero python3-evdev python3-luma.oled python3-pil

sudo mkdir -p /opt/gpio-agent
sudo cp agent.py /opt/gpio-agent/
sudo cp config.example.json /opt/gpio-agent/config.json
sudo cp gpio-agent.service /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable --now gpio-agent.service
```

If you skip the OLED, the `luma.oled` / `python3-pil` packages aren't
needed — those imports are lazy and only fire when `display.enabled` is
`true`.

## PIR — pin and webhook

```json
"pir": {
    "enabled": true,
    "gpio_pin": 17,
    "motion_url": "http://127.0.0.1:8765/pir/motion",
    "clear_url":  "http://127.0.0.1:8765/pir/clear",
    "http_timeout_sec": 10
}
```

`gpio_pin` is BCM. The two URLs are POSTed an empty `{"state": "motion"|"clear", "pin": N}`
body — they're consumed by [`node-display`](../node-display/server.js)'s
PIR HTTP server. Replace with any other endpoint if you wire the agent
into a different stack.

## Keypad — `key_map` syntax

The keypad is scanned by setting one row low at a time and reading the
columns. `row_pins` and `col_pins` are BCM. `layout` is the visible
character at each `[row][col]` position; that character is then looked
up in `key_map` to decide what uinput keystroke (if any) to emit.

`key_map` values may be:

| Spec                                       | Meaning                                                                                      |
|--------------------------------------------|----------------------------------------------------------------------------------------------|
| `null`                                     | No action (key is dead).                                                                     |
| `"X"`                                      | Single keystroke. Letters, digits, and aliases like `SPACE`, `ENTER`, `LEFT`, `LCTRL` work. Raw evdev names like `"KEY_F11"` pass through. |
| `["LCTRL", "R"]`                           | Chord. Modifier(s) press first, key press, then release in reverse on key-up.                |
| `{"tap": <spec>, "hold": <spec>}`          | Tap on short press; hold action fires once after `hold_ms` (default 500 ms) and suppresses the tap. Either side can be any of the above forms or `null`. |

The shipped example matches the kiosk's shortcuts:

```json
"A": "B",        // keypad A → b (block post)
"B": "S",        // keypad B → s (tag list select)
"C": "D",        // keypad C → d (displaySync toggle)
"D": "P",        // keypad D → p (hide image; clock/sensors stay visible)
"*": { "tap": "SPACE", "hold": "T" },       // SPACE saves, hold for reshuffle
"#": { "tap": "RIGHT", "hold": ["LEFTCTRL", "R"] }  // next image, hold to refresh
```

If you change the mapping, also update [`public/modules/ui.js`](../public/modules/ui.js)
or [`native-kiosk/kiosk.py`](../native-kiosk/kiosk.py) accordingly — the
agent only emits keystrokes; the kiosk decides what each one does.

Set `keypad.diagnose = true` to log every press and release with the
matrix coordinate before any debouncing — useful when wiring a new
keypad to confirm rows/cols are correct.

## OLED — optional clock

```json
"display": {
    "enabled": true,
    "i2c_port": 1,
    "i2c_address": "0x3C",
    "width": 128,
    "height": 64,
    "rotate": 0,
    "font_path": "/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf",
    "font_size": 64,
    "time_format": "%H:%M",
    "contrast": 255
}
```

Renders the current time centered, redrawing only when the displayed
string changes (so a 1-minute granularity at the default `time_format`
costs ~1 redraw per minute). The display is gated on PIR — it hides
when motion clears, comes back on the next motion event. Disable that
coupling by removing the PIR subsystem or by passing a custom display
reference (see `main()` in [agent.py](agent.py)).
