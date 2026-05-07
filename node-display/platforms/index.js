'use strict';
//
// Platform detection + dispatch for node-display.
//
// Each platform module exports a `create({ displayEmitter })` factory that
// returns a Display object with the contract below. The outer Display.js
// glue calls these methods uniformly; methods that don't apply on a given
// platform are still present and are no-ops (nextTick callback) rather
// than missing — that way callers don't need to feature-detect.
//
// Contract — every platform Display object exposes:
//
//   getBrightness(cb)              cb(err, internalValue)
//   getUserBrightness(cb)          cb(err, userValue [0..255])
//   setBrightness(value, cb)       value is the platform's internal scale
//   setBrightnessStateAware(value, cb)  same as setBrightness but only writes
//                                       through if the display is currently on
//   turnOff(cb)                    cb(err)
//   turnOn(cb)                     cb(err)
//   setGovernor(governor, cb)      cb(err) — CPU governor; no-op on macOS/Pi
//   autoAdjustBrightness(cb?)      ALS-driven; no-op on platforms without ALS
//   initializeState(cb)            cb(err, isOn)
//   mapBrightnessToDisplay(brightness)  user [0..255] → platform internal
//

const fs = require('fs');

const isMac = process.platform === 'darwin';
const isLinux = process.platform === 'linux';

function isRaspberryPi() {
    if (!isLinux) return false;
    if (!fs.existsSync('/proc/device-tree/model')) return false;
    return fs.readFileSync('/proc/device-tree/model', 'utf8')
        .toLowerCase()
        .includes('raspberry');
}

function detectAndCreate(deps) {
    if (isMac) return require('./macos').create(deps);
    if (isRaspberryPi()) return require('./raspberry-pi').create(deps);
    if (isLinux) return require('./linux-sysfs').create(deps);
    throw new Error('Unsupported platform');
}

module.exports = { detectAndCreate };
