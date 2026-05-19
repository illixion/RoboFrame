'use strict';
//
// Raspberry Pi Display backend.
//
// Power-down is two-staged. Stage 1 ("dim") drops the DDC backlight
// (VCP 0x10) to the floor — instant, panel goes black, HDMI link and
// DDC channel stay alive so a subsequent wake is a single setvcp with
// no retry. Stage 2 ("off") escalates to a full HDMI cut after
// DIM_TO_OFF_DELAY_MS of continued inactivity.
//
// Under X11 we use `xrandr --output <CONN> --off`, not `xset dpms`.
// On Pi KMS the DPMS state register is software-only — the HDMI clock
// keeps scanning out the framebuffer, so monitors that don't honour
// DPMS (e.g. AOC consumer panels) see a live signal and stay backlit.
// xrandr disables the CRTC so the HDMI link drops and the panel really
// goes to standby. The historical objection to xrandr (framebuffer
// collapse to minimum size on the only output, causing the Chromium
// kiosk to resize twice per cycle) is sidestepped by pinning the
// framebuffer with `xrandr --fb` at startup. Wake is `--output --auto`,
// which reconnects to the pinned framebuffer with no resize event.
//
// Under Wayland the equivalent is `wlopm --off '*'` (wlr-output-
// power-management-v1), which behaves like DPMS but is honoured at
// the compositor level: the modeset is preserved so the kiosk client
// keeps its surface and resumes instantly. The compositor must
// implement that protocol — labwc does, cage 0.2 does not.
//
// State transitions go through a serialised queue so a websocket burst
// can't race a fresh `state:'on'` against a delayed `state:false` echo.

const { exec, execSync } = require('child_process');
const { loadConfig, pickEnv } = require('@roboframe/shared');

// HDMI-A-1's i2c bus index varies by Pi generation (Pi 3B+ = 2, Pi 4 = 20,
// CM4/Pi 5 = different again). Discover it once at startup via
// `ddcutil detect --terse`. DDC_BUS env overrides discovery. Returns null
// if no monitor advertises DDC/CI — callers fall back to DPMS-only control
// with no brightness adjustment.
function discoverDdcBus() {
    const override = process.env.DDC_BUS;
    if (override) return override;
    try {
        const out = execSync('ddcutil detect --terse', { timeout: 5000, stdio: ['ignore', 'pipe', 'ignore'] }).toString();
        const m = out.match(/I2C bus:\s*\/dev\/i2c-(\d+)/);
        if (m) return m[1];
    } catch (_) { /* fall through */ }
    return null;
}

// Confirm the panel actually answers VCP 0x10. `ddcutil detect` can list a
// bus even when the attached display ignores DDC/CI writes; only a
// successful getvcp proves brightness control is usable.
function probeDdcBrightness(bus) {
    if (!bus) return false;
    // --maxtries=1,1,1 and a tiny sleep-multiplier keep the probe quick on
    // panels that ignore DDC/CI — without it, ddcutil's default retry loop
    // can spend ~10 s and spew DDCRC_RETRIES warnings into the journal
    // before giving up.
    try {
        execSync(`ddcutil --bus=${bus} --maxtries=1,1,1 --sleep-multiplier=.1 getvcp 10`, { timeout: 3000, stdio: ['ignore', 'pipe', 'ignore'] });
        return true;
    } catch (_) {
        return false;
    }
}

// Find the first connected output and its current mode, e.g.
//   { name: 'HDMI-1', width: 1920, height: 1080 }
// Returns null if xrandr isn't available or no output is connected.
function discoverX11Output() {
    try {
        const out = execSync(`xrandr --display :0 --query`, { timeout: 3000, stdio: ['ignore', 'pipe', 'ignore'] }).toString();
        // Match "HDMI-1 connected ... 1920x1080+0+0" — primary token is optional.
        const m = out.match(/^(\S+)\s+connected\b[^\n]*?\s(\d+)x(\d+)\+\d+\+\d+/m);
        if (!m) return null;
        return { name: m[1], width: parseInt(m[2], 10), height: parseInt(m[3], 10) };
    } catch (_) {
        return null;
    }
}

// Lock the X root framebuffer to the connected output's mode. Without
// this, `xrandr --output --off` on the only attached output collapses
// the screen to the minimum (320x200), and Chromium / SDL clients
// resize twice per cycle when the connector comes back.
function pinX11Framebuffer({ width, height }) {
    try {
        execSync(`xrandr --display :0 --fb ${width}x${height}`, { timeout: 3000, stdio: ['ignore', 'ignore', 'ignore'] });
    } catch (_) { /* not fatal — the resize cost is cosmetic on wake */ }
}

// Detect session type once at startup. WAYLAND_DISPLAY is the most
// reliable signal — labwc/cage on Pi OS Bookworm set it for the
// kiosk session.
function detectSession() {
    if (process.env.SESSION_TYPE === 'x11' || process.env.SESSION_TYPE === 'wayland') {
        return process.env.SESSION_TYPE;
    }
    if (process.env.WAYLAND_DISPLAY) return 'wayland';
    if (process.env.XDG_SESSION_TYPE === 'wayland') return 'wayland';
    return 'x11';
}

function create() {
    const SESSION = detectSession();
    const XRANDR_DISPLAY = ':0';
    // X11 path: discover the connector name (e.g. HDMI-1) once and pin
    // the framebuffer to its current resolution so `--output --off`
    // doesn't shrink the X screen. If discovery fails we fall back to
    // xset DPMS, which works on monitors that honour DPMS even though
    // many Pi-attached panels don't.
    const X11_OUTPUT = SESSION === 'wayland' ? null : discoverX11Output();
    if (X11_OUTPUT) pinX11Framebuffer(X11_OUTPUT);
    const DPMS_OFF_CMD = SESSION === 'wayland'
        ? `wlopm --off '*'`
        : (X11_OUTPUT
            ? `xrandr --display ${XRANDR_DISPLAY} --output ${X11_OUTPUT.name} --off`
            : `xset -display ${XRANDR_DISPLAY} dpms force off`);
    // On wake we must re-pin --fb in the same xrandr invocation: when the
    // only output was --off'd, X auto-shrunk the root window to its 320x200
    // minimum, and `--auto` alone can't grow it back to fit a 1920x1080
    // mode. Doing both in one call combines into a single modeset.
    const DPMS_ON_CMD = SESSION === 'wayland'
        ? `wlopm --on '*'`
        : (X11_OUTPUT
            ? `xrandr --display ${XRANDR_DISPLAY} --fb ${X11_OUTPUT.width}x${X11_OUTPUT.height} --output ${X11_OUTPUT.name} --auto`
            : `xset -display ${XRANDR_DISPLAY} dpms force on`);
    const DDC_BUS = discoverDdcBus();
    // When the panel doesn't speak DDC/CI (or `ddcutil` is missing) we
    // drop brightness control entirely and use DPMS-only on/off. The
    // dim stage is also skipped because it relies on a DDC setvcp.
    const DDC_AVAILABLE = probeDdcBrightness(DDC_BUS);
    if (!DDC_AVAILABLE) {
        console.log('node-display: DDC/CI brightness control unavailable, falling back to DPMS-only on/off');
    }
    // VCP 0x10 minimum. The AOC panel rejects setvcp 10 0 (some firmwares
    // treat 0 as an invalid value rather than "off"), so the dim stage and
    // every brightness clamp floor at 1. Powering the panel down is the
    // job of the DPMS stage, not of a zero brightness write.
    const BRIGHTNESS_FLOOR = 1;
    // Two-stage power-down delay (seconds before escalating dim → DPMS off).
    //   positive: seconds before escalation
    //   0:        skip dim, go straight to DPMS off (legacy behaviour)
    //   null / non-finite: never escalate; stay in dim forever
    // Forced to skip-dim when DDC/CI isn't available.
    const _cfgDisplay = (loadConfig().display) || {};
    const _dimToOffSecondsRaw = pickEnv('DIM_TO_OFF_SECONDS', _cfgDisplay.dimToOffSeconds, 120, { type: 'number' });
    const _dimEscalates = DDC_AVAILABLE && Number.isFinite(_dimToOffSecondsRaw) && _dimToOffSecondsRaw > 0;
    const _skipDimStage = !DDC_AVAILABLE || _dimToOffSecondsRaw === 0;
    const DIM_TO_OFF_DELAY_MS = _dimEscalates ? Math.round(_dimToOffSecondsRaw * 1000) : 0;
    let currentState = true;
    let _powerStage = 'on'; // 'on' | 'dim' | 'off'
    let _dimToOffTimer = null;
    let lastOnBrightness = 100;

    function clampPct(v) {
        if (typeof v !== 'number' || isNaN(v)) return 100;
        return Math.max(BRIGHTNESS_FLOOR, Math.min(100, Math.round(v)));
    }

    function autoAdjustBrightness(callback) {
        if (callback) callback();
    }

    function applyBrightness(pct, callback) {
        if (!DDC_AVAILABLE) return process.nextTick(() => callback(null));
        const v = clampPct(pct);
        exec(`ddcutil --bus=${DDC_BUS} setvcp 10 ${v}`, (err) => {
            if (err) return callback(err);
            lastOnBrightness = v;
            callback(null);
        });
    }

    // All on/off transitions go through `_scheduleState` so they
    // serialise and coalesce: only the most recently requested state
    // actually runs.
    let _stateQueue = Promise.resolve();
    let _stateRequestId = 0;

    function _clearDimTimer() {
        if (_dimToOffTimer) {
            clearTimeout(_dimToOffTimer);
            _dimToOffTimer = null;
        }
    }

    // After HDMI re-link the panel's DDC channel takes a moment to come
    // back; the first setvcp can fail with an i2c read error. Retry a
    // few times before giving up.
    function _applyBrightnessWithRetry(pct, attemptsLeft, cb) {
        applyBrightness(pct, (err) => {
            if (!err) return cb(null);
            if (attemptsLeft <= 0) return cb(err);
            setTimeout(() => _applyBrightnessWithRetry(pct, attemptsLeft - 1, cb), 500);
        });
    }

    function _doTurnOn(cb) {
        _clearDimTimer();
        if (_powerStage === 'on') {
            currentState = true;
            return cb(null);
        }
        if (_powerStage === 'dim') {
            // DDC channel is alive; a single setvcp with no retry is
            // enough and the wake is near-instant.
            applyBrightness(lastOnBrightness, (err) => {
                if (err) return cb(err);
                _powerStage = 'on';
                currentState = true;
                cb(null);
            });
            return;
        }
        // _powerStage === 'off' — wake, then retry brightness while the
        // DDC channel comes back up. The brightness apply is cosmetic and
        // best-effort: a DDCRC_RETRIES failure on the AOC panel doesn't
        // mean the wake itself failed. Surface the wake's success/failure
        // upstream and only log brightness errors, so a flaky DDC channel
        // doesn't leave Display.js's `displayOn` flag stuck at false and
        // turn every subsequent turnDisplayOff into a no-op.
        exec(DPMS_ON_CMD, (err) => {
            if (err) return cb(err);
            _powerStage = 'on';
            currentState = true;
            _applyBrightnessWithRetry(lastOnBrightness, 4, (brightErr) => {
                if (brightErr) console.error(`Brightness apply on wake failed (continuing): ${brightErr.message}`);
                cb(null);
            });
        });
    }

    function _dpmsOff(cb) {
        exec(DPMS_OFF_CMD, (err) => {
            _powerStage = 'off';
            currentState = false;
            cb(err || null);
        });
    }

    function _doTurnOff(cb) {
        _clearDimTimer();
        if (_powerStage === 'off') {
            currentState = false;
            return cb(null);
        }
        // dimToOffSeconds === 0: skip dim, go straight to DPMS off.
        if (_skipDimStage) return _dpmsOff(cb);
        // Stage 1: DDC dim. Bypass applyBrightness so lastOnBrightness
        // is preserved for wake.
        exec(`ddcutil --bus=${DDC_BUS} setvcp 10 ${BRIGHTNESS_FLOOR}`, (err) => {
            if (err) return cb(err);
            _powerStage = 'dim';
            currentState = false;
            // Stage 2: escalate to DPMS off after the inactivity window —
            // unless dimToOffSeconds is null/non-finite, in which case
            // we stay in dim forever. The escalation runs via the state
            // queue so it serialises with any racing wake; if turnOn
            // ran first, _powerStage will be 'on' here and this is a
            // no-op.
            if (_dimEscalates) {
                _dimToOffTimer = setTimeout(() => {
                    _dimToOffTimer = null;
                    _stateQueue = _stateQueue.then(() => new Promise((resolve) => {
                        if (_powerStage !== 'dim') return resolve();
                        exec(DPMS_OFF_CMD, () => {
                            _powerStage = 'off';
                            resolve();
                        });
                    }));
                }, DIM_TO_OFF_DELAY_MS);
            }
            cb(null);
        });
    }

    function _scheduleState(target, callback) {
        const myId = ++_stateRequestId;
        _stateQueue = _stateQueue.then(() => new Promise((resolve) => {
            if (myId !== _stateRequestId) {
                callback(null);
                return resolve();
            }
            const op = target ? _doTurnOn : _doTurnOff;
            op((err) => {
                callback(err || null);
                resolve();
            });
        }));
    }

    function turnOff(callback) { _scheduleState(false, callback); }
    function turnOn(callback)  { _scheduleState(true, callback); }

    function setGovernor(_gov, cb) { process.nextTick(cb); }

    function initializeState(callback) {
        // Determine the current monitor power state and cached brightness.
        // Under X11 we parse `xrandr --query` for "HDMI-1 connected
        // ... NxM" vs "disconnected"/no-mode (output --off). Under Wayland
        // we don't probe — wlopm has no query mode, and assuming "on" at
        // startup is safe: the next displayState command will reconcile.
        const probeBrightness = (isOn) => {
            currentState = isOn;
            _powerStage = isOn ? 'on' : 'off';
            if (!isOn) return callback(null, false);
            if (!DDC_AVAILABLE) return callback(null, true);
            exec(`ddcutil --bus=${DDC_BUS} getvcp 10`, (e2, out2) => {
                if (!e2) {
                    const m2 = out2.match(/current value\s*=\s*(\d+)/);
                    if (m2) lastOnBrightness = clampPct(parseInt(m2[1], 10));
                }
                callback(null, true);
            });
        };
        if (SESSION === 'wayland' || !X11_OUTPUT) {
            probeBrightness(true);
            return;
        }
        exec(`xrandr --display ${XRANDR_DISPLAY} --query`, (err, stdout) => {
            let isOn = true;
            if (!err) {
                // The active output has a `<W>x<H>+x+y` token. When `--off`'d
                // the line still says "connected" but the mode is absent.
                const re = new RegExp(`^${X11_OUTPUT.name}\\s+connected\\b[^\\n]*?\\s\\d+x\\d+\\+\\d+\\+\\d+`, 'm');
                isOn = re.test(stdout);
            }
            probeBrightness(isOn);
        });
    }

    // user [0..255] → DDC percent [0..100]; 0 maps to 0 (= power off).
    function mapBrightnessToDisplay(brightness) {
        if (brightness <= 0) return 0;
        return Math.round(Math.max(0, Math.min(255, brightness)) / 255 * 100);
    }

    function setBrightness(value, cb) {
        if (typeof value !== 'number' || value < 0 || value > 100) {
            return process.nextTick(() => cb(new Error(`Brightness value out of range: ${value}`)));
        }
        if (value === 0) return turnOff(cb);
        const v = clampPct(value);
        if (!currentState) {
            // Display is off; remember the value, don't power on here.
            lastOnBrightness = v;
            return process.nextTick(cb);
        }
        applyBrightness(v, cb);
    }

    function setBrightnessStateAware(value, cb) {
        if (typeof value !== 'number' || value < 0 || value > 100) {
            return process.nextTick(() => cb(new Error(`Brightness value out of range: ${value}`)));
        }
        if (currentState) {
            setBrightness(value, cb);
        } else {
            if (value > 0) lastOnBrightness = clampPct(value);
            process.nextTick(cb);
        }
    }

    function getBrightness(cb) {
        process.nextTick(() => {
            if (!currentState) return cb(null, 0);
            // 0–255 user scale, derived from the cached DDC percent.
            cb(null, Math.round(lastOnBrightness / 100 * 255));
        });
    }

    return {
        getBrightness,
        getUserBrightness: getBrightness,
        setBrightness,
        setBrightnessStateAware,
        turnOff,
        turnOn,
        setGovernor,
        autoAdjustBrightness,
        initializeState,
        mapBrightnessToDisplay,
    };
}

module.exports = { create };
