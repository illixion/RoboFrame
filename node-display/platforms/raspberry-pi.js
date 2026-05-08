'use strict';
//
// Raspberry Pi Display backend.
//
// Power-down is two-staged. Stage 1 ("dim") drops the DDC backlight
// (VCP 0x10) to the floor — instant, panel goes black, HDMI link and
// DDC channel stay alive so a subsequent wake is a single setvcp with
// no retry. Stage 2 ("off") escalates to `xset dpms force off` after
// DIM_TO_OFF_DELAY_MS of continued inactivity to actually power the
// panel down. DPMS is preferred over `xrandr --off` because xrandr
// does a full modeset — when the only output goes away X collapses
// the framebuffer to its minimum size and the browser resizes twice
// per cycle, desyncing kiosk visibility from display state. State
// transitions go through a serialised queue so a websocket burst
// can't race a fresh `state:'on'` against a delayed `state:false`
// echo.

const { exec } = require('child_process');
const { loadConfig, pickEnv } = require('@roboframe/shared');

function create() {
    const XRANDR_DISPLAY = ':0';
    // The DDC bus index is stable enough to hard-code (Pi 3B+ HDMI-A-1 = i2c-2).
    // Pinning avoids a per-call detect (~1s) and prevents stalls if EDID
    // readback flaps.
    const DDC_BUS = '2';
    // VCP 0x10 minimum. The AOC panel rejects setvcp 10 0 (some firmwares
    // treat 0 as an invalid value rather than "off"), so the dim stage and
    // every brightness clamp floor at 1. Powering the panel down is the
    // job of the DPMS stage, not of a zero brightness write.
    const BRIGHTNESS_FLOOR = 1;
    // Two-stage power-down delay (seconds before escalating dim → DPMS off).
    //   positive: seconds before escalation
    //   0:        skip dim, go straight to DPMS off (legacy behaviour)
    //   null / non-finite: never escalate; stay in dim forever
    const _cfgDisplay = (loadConfig().display) || {};
    const _dimToOffSecondsRaw = pickEnv('DIM_TO_OFF_SECONDS', _cfgDisplay.dimToOffSeconds, 120, { type: 'number' });
    const _dimEscalates = Number.isFinite(_dimToOffSecondsRaw) && _dimToOffSecondsRaw > 0;
    const _skipDimStage = _dimToOffSecondsRaw === 0;
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
        // _powerStage === 'off' — DPMS wake, then retry brightness while
        // the DDC channel comes back up.
        exec(`xset -display ${XRANDR_DISPLAY} dpms force on`, (err) => {
            if (err) return cb(err);
            _powerStage = 'on';
            currentState = true;
            _applyBrightnessWithRetry(lastOnBrightness, 4, cb);
        });
    }

    function _dpmsOff(cb) {
        exec(`xset -display ${XRANDR_DISPLAY} dpms force off`, (err) => {
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
                        exec(`xset -display ${XRANDR_DISPLAY} dpms force off`, () => {
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
        // Ensure DPMS is enabled (some X configs ship with it off, in
        // which case `dpms force off` is a no-op), then determine the
        // current monitor power state and cached brightness.
        exec(`xset -display ${XRANDR_DISPLAY} +dpms`, () => {
            exec(`xset -display ${XRANDR_DISPLAY} q`, (err, stdout) => {
                let isOn = true;
                if (!err) {
                    const m = stdout.match(/Monitor is\s+(\w+)/i);
                    if (m) isOn = /^On$/i.test(m[1]);
                }
                currentState = isOn;
                _powerStage = isOn ? 'on' : 'off';
                if (!isOn) return callback(null, false);
                exec(`ddcutil --bus=${DDC_BUS} getvcp 10`, (e2, out2) => {
                    if (!e2) {
                        const m2 = out2.match(/current value\s*=\s*(\d+)/);
                        if (m2) lastOnBrightness = clampPct(parseInt(m2[1], 10));
                    }
                    callback(null, true);
                });
            });
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
