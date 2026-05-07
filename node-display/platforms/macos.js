'use strict';
//
// macOS Display backend.
//
// Brightness control goes through the `brightness` CLI from
// https://github.com/nriley/brightness on the [0.0, 1.0] internal scale.
// For non-zero values we hand off to BetterDisplay's auto-brightness so
// ambient adjustment keeps working — direct CLI writes fight macOS's own
// brightness controller and oscillate.
//
// ALS support via `lmutracker` is wired up but the auto-adjust loop is
// commented out; macOS already has good native auto-brightness.

const { exec, spawn } = require('child_process');

function create({ displayEmitter }) {
    const BRIGHTNESS_CMD = '/usr/local/bin/brightness';
    let lastOnBrightness = 1.0;

    let alsProc = null;
    let latestALS = null;
    let autoAdjustBrightnessInterval = null;

    const ALS_MIN = 0;
    const ALS_MAX = 4096;
    const BRIGHTNESS_MIN = 15;
    const BRIGHTNESS_MAX = 100;

    function startALSLoop() {
        if (alsProc) return;
        alsProc = spawn('./lmutracker', ['-w']);
        alsProc.stdout.on('data', (data) => {
            const lines = data.toString().split('\n').filter(Boolean);
            for (const line of lines) {
                const value = parseFloat(line.trim());
                if (!isNaN(value)) {
                    latestALS = value;
                    displayEmitter.emit('alsStateChanged', value);
                }
            }
        });
        alsProc.on('error', (err) => {
            console.error('ALS process error:', err.message);
        });
        alsProc.on('exit', (code, signal) => {
            alsProc = null;
            if (signal !== 'SIGTERM' && signal !== 'SIGINT') {
                setTimeout(startALSLoop, 2000);
            }
        });
        process.on('exit', () => { if (alsProc) alsProc.kill(); });
        process.on('SIGINT', () => { if (alsProc) alsProc.kill(); process.exit(); });
        process.on('SIGTERM', () => { if (alsProc) alsProc.kill(); process.exit(); });
    }

    function mapALSToBrightness(alsValue) {
        const clampedALS = Math.max(ALS_MIN, Math.min(ALS_MAX, alsValue));
        const normalized = (clampedALS - ALS_MIN) / (ALS_MAX - ALS_MIN);
        return Math.round(normalized * (BRIGHTNESS_MAX - BRIGHTNESS_MIN) + BRIGHTNESS_MIN);
    }

    function parseCurrentBrightness(output) {
        // "display 0: brightness 0.768555"
        const match = output.match(/brightness\s+([0-9.]+)/);
        return match ? parseFloat(match[1]) : 1.0;
    }

    function getBrightness(callback) {
        exec(`${BRIGHTNESS_CMD} -l`, (err, stdout) => {
            if (err) return callback(err);
            callback(null, parseCurrentBrightness(stdout));
        });
    }

    function getUserBrightness(callback) {
        getBrightness((err, value) => {
            if (err) return callback(err);
            callback(null, Math.round(Math.max(0, Math.min(1, value)) * 255));
        });
    }

    function runBetterDisplayAutoBrightness(on, callback) {
        const state = on ? 'on' : 'off';
        const cmd = `/Applications/BetterDisplay.app/Contents/MacOS/BetterDisplay set -autoBrightness=${state}`;
        exec(cmd, (err) => {
            if (err) console.error(`BetterDisplay command failed (${state}):`, err.message);
            if (typeof callback === 'function') callback(err);
        });
    }

    function setBrightness(value, callback) {
        if (typeof value !== 'number' || value < 0.0 || value > 1.0) {
            return callback(new Error(`Brightness value out of range: ${value}`));
        }
        lastOnBrightness = value;

        // Only call the brightness CLI when forcing the display off (value=0).
        // For non-zero values, hand control back to BetterDisplay's auto-brightness
        // so ambient adjustment keeps working.
        if (value === 0.0) {
            runBetterDisplayAutoBrightness(false, (bdErr) => {
                if (bdErr) console.error('BetterDisplay command failed:', bdErr.message);
                exec(`${BRIGHTNESS_CMD} -d0 ${value}`, (err) => {
                    if (!err) {
                        getUserBrightness((gErr) => {
                            if (gErr) return callback(gErr);
                        });
                    }
                    callback(err);
                });
            });
        } else {
            runBetterDisplayAutoBrightness(true, (bdErr) => {
                if (bdErr) console.error('BetterDisplay command failed:', bdErr.message);
            });
            getUserBrightness((gErr) => {
                if (gErr) return callback(gErr);
            });
            callback(null);
        }
    }

    function setBrightnessStateAware(value, callback) {
        if (typeof value !== 'number' || value < 0.0 || value > 1.0) {
            return callback(new Error(`Brightness value out of range: ${value}`));
        }
        getBrightness((err, current) => {
            if (err) return callback(err);
            if (current > 0.01) {
                setBrightness(value, (err2) => {
                    if (!err2) {
                        getUserBrightness((gErr) => {
                            if (gErr) return callback(gErr);
                        });
                    }
                    callback(err2);
                });
            } else {
                lastOnBrightness = value;
                process.nextTick(callback);
            }
        });
    }

    function autoAdjustBrightness(callback) {
        // ALS-driven auto-adjust intentionally inert; macOS native
        // auto-brightness handles this when BetterDisplay is on.
        if (callback) callback();
    }

    function turnOff(callback) {
        setBrightness(0.0, (err) => {
            runBetterDisplayAutoBrightness(false, (bdErr) => {
                if (err) return callback(err);
                callback(bdErr);
            });
        });
    }

    function turnOn(callback) {
        setBrightness(lastOnBrightness, (err) => {
            runBetterDisplayAutoBrightness(true, (bdErr) => {
                if (err) return callback(err);
                callback(bdErr);
            });
        });
    }

    function setGovernor(_gov, cb) { process.nextTick(cb); }

    function initializeState(callback) {
        getBrightness((err, current) => {
            callback(null, current > 0.01);
        });
        if (!autoAdjustBrightnessInterval) {
            autoAdjustBrightnessInterval = setInterval(() => {
                autoAdjustBrightness();
            }, 10000);
        }
    }

    // user [0..255] → internal [0.0..1.0]
    function mapBrightnessToDisplay(brightness) {
        return Math.max(0, Math.min(1, brightness / 255));
    }

    return {
        getBrightness,
        getUserBrightness,
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
