'use strict';
//
// Display gateway: detects the platform, delegates to the right backend in
// `./platforms`, and adds the cross-platform on/off bookkeeping (governor
// setting, brightness restoration on wake, etc.) used by server.js.

const EventEmitter = require('events');
const { detectAndCreate } = require('./platforms');

const displayEmitter = new EventEmitter();
const Display = detectAndCreate({ displayEmitter });

let displayOn = true;
let timer = null;

function turnDisplayOff(callback) {
    if (timer) clearTimeout(timer);
    // Always delegate to the backend rather than short-circuiting on the local
    // `displayOn` flag. The backend dedups idempotently (the Pi backend on its
    // `_powerStage`), and this is what lets the controller's reconciler recover:
    // a re-drive after drift must actually reach the hardware. A local guard
    // here would swallow it whenever `displayOn` had desynced from the panel.
    let completed = 0;
    let lastBrightness = null;
    let error = null;
    const done = () => {
        if (++completed === 2 && callback) callback(error, lastBrightness);
    };

    Display.setGovernor('powersave', (err) => {
        if (err) {
            console.error(`Error setting governor: ${err.message}`);
            error = err;
        }
        done();
    });

    Display.turnOff((err) => {
        if (err) {
            console.error(`Error setting brightness: ${err.message}`);
            error = err;
            lastBrightness = null;
        } else {
            displayOn = false;
            Display.getBrightness((getErr, brightness) => {
                if (getErr) {
                    error = getErr;
                    lastBrightness = null;
                } else {
                    lastBrightness = brightness;
                }
                done();
            });
            return;
        }
        done();
    });
}

function turnDisplayOn(callback) {
    // See turnDisplayOff: delegate unconditionally so a reconcile re-drive
    // always reaches the idempotent backend instead of being swallowed by a
    // stale `displayOn`.
    let completed = 0;
    let lastBrightness = null;
    let error = null;
    const done = () => {
        if (++completed === 2 && callback) callback(error, lastBrightness);
    };

    Display.setGovernor('schedutil', (err) => {
        if (err) {
            console.error(`Error setting governor: ${err.message}`);
            error = err;
        }
        done();
    });

    Display.turnOn((err) => {
        if (err) {
            console.error(`Error setting brightness: ${err.message}`);
            error = err;
            lastBrightness = null;
        } else {
            displayOn = true;
            Display.getBrightness((getErr, brightness) => {
                if (getErr) {
                    error = getErr;
                    lastBrightness = null;
                } else {
                    lastBrightness = brightness;
                }
                done();
            });
            return;
        }
        done();
    });
}

Display.initializeState((err, isOn) => {
    if (err) {
        console.error('Failed to initialize display state:', err.message);
        displayOn = true;
    } else {
        displayOn = isOn;
    }
});

module.exports = {
    getUserBrightness: Display.getUserBrightness,
    getBrightness: Display.getBrightness,
    turnDisplayOn,
    turnDisplayOff,
    mapBrightnessToDisplay: Display.mapBrightnessToDisplay,
    setBrightness: (userValue, cb) => {
        const mapped = Display.mapBrightnessToDisplay(userValue);
        Display.setBrightness(mapped, cb);
    },
    setBrightnessStateAware: (userValue, cb) => {
        const mapped = Display.mapBrightnessToDisplay(userValue);
        Display.setBrightnessStateAware(mapped, cb);
    },
    // Ground-truth query of the panel power state. Used by the controller's
    // periodic reconciler to detect drift (failed platform calls, external
    // dpms commands, DDC monitors that reset themselves). Platforms that
    // can't reliably probe (Wayland with wlopm, missing tooling) return
    // null — the controller treats null as "skip this tick", which is
    // critical: assuming "on" here would make the reconciler log spurious
    // drift every minute against a turned-off panel.
    getActualState: (cb) => {
        if (typeof Display.getActualPowerState === 'function') return Display.getActualPowerState(cb);
        return Display.initializeState(cb);
    },
    emitter: displayEmitter,
};
