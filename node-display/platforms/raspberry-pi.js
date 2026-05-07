'use strict';
//
// Raspberry Pi Display backend.
//
// xrandr drives output on/off; ddcutil drives the monitor's real
// backlight via DDC/CI VCP 0x10 (Brightness, 0–100 percent). State
// transitions go through a serialised queue so a websocket burst can't
// race a fresh `state:'on'` against a delayed `state:false` echo.

const { exec } = require('child_process');

function create() {
    const XRANDR_DISPLAY = ':0';
    const XRANDR_OUTPUT = 'HDMI-1';
    // The DDC bus index is stable enough to hard-code (Pi 3B+ HDMI-A-1 = i2c-2).
    // Pinning avoids a per-call detect (~1s) and prevents stalls if EDID
    // readback flaps.
    const DDC_BUS = '2';
    const BRIGHTNESS_FLOOR = 5; // percent; below this the AOC panel is effectively black
    let currentState = true;
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

    // All on/off transitions go through `_scheduleState` so they serialise
    // and coalesce: only the most recently requested state actually runs.
    // After --auto we verify the output came up; if X has a stale
    // "disconnected" view we fall back to --preferred + explicit pos.
    let _stateQueue = Promise.resolve();
    let _stateRequestId = 0;

    function _isHdmiActive(cb) {
        exec(`xrandr --display ${XRANDR_DISPLAY} --query`, (err, stdout) => {
            if (err) return cb(err, false);
            const re = new RegExp(`^${XRANDR_OUTPUT}\\s+connected[^\\n]*?(\\d+x\\d+\\+\\d+\\+\\d+)`, 'm');
            cb(null, re.test(stdout));
        });
    }

    function _doTurnOn(cb) {
        exec(`xrandr --display ${XRANDR_DISPLAY} --output ${XRANDR_OUTPUT} --auto`, (err1) => {
            _isHdmiActive((_e, active) => {
                const finish = (e) => {
                    if (e) return cb(e);
                    currentState = true;
                    applyBrightness(lastOnBrightness, cb);
                };
                if (active) return finish(null);
                exec(`xrandr --display ${XRANDR_DISPLAY} --output ${XRANDR_OUTPUT} --preferred --pos 0x0 --rotate normal`, (err2) => {
                    finish(err2 || err1 || null);
                });
            });
        });
    }

    function _doTurnOff(cb) {
        exec(`xrandr --display ${XRANDR_DISPLAY} --output ${XRANDR_OUTPUT} --off`, (err) => {
            currentState = false;
            cb(err || null);
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
        // Determine on/off via xrandr (mode-string presence), then read
        // brightness via DDC.
        exec(`xrandr --display ${XRANDR_DISPLAY} --verbose`, (err, stdout) => {
            let isOn = true;
            if (!err) {
                const lines = stdout.split('\n');
                let inSection = false;
                for (const line of lines) {
                    if (line.startsWith(`${XRANDR_OUTPUT} `)) {
                        inSection = true;
                        isOn = /\d+x\d+\+\d+\+\d+/.test(line);
                        continue;
                    }
                    if (inSection && /^\S/.test(line)) break;
                }
            }
            currentState = isOn;
            if (!isOn) return callback(null, false);
            exec(`ddcutil --bus=${DDC_BUS} getvcp 10`, (e2, out2) => {
                if (!e2) {
                    const m = out2.match(/current value\s*=\s*(\d+)/);
                    if (m) lastOnBrightness = clampPct(parseInt(m[1], 10));
                }
                callback(null, true);
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
