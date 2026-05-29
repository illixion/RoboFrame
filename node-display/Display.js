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
    if (!displayOn) {
        return Display.getBrightness((err, brightness) => {
            if (callback) callback(err, brightness);
        });
    }

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
    if (displayOn) {
        return Display.getBrightness((err, brightness) => {
            if (callback) callback(err, brightness);
        });
    }

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
    // dpms commands, DDC monitors that reset themselves). Re-uses the same
    // probe initializeState ran at boot — no separate platform plumbing.
    getActualState: (cb) => Display.initializeState(cb),
    emitter: displayEmitter,
};
