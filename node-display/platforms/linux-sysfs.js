'use strict';
//
// Generic Linux Display backend.
//
// Brightness via /sys/class/backlight/intel_backlight; ALS via /sys/bus/iio.
// CPU governor switching is a no-op in production (the early `return`
// preserves a battery-tuning path that's been disabled but kept around for
// reference). mjpg-streamer is invoked via systemctl.

const fs = require('fs');
const { exec } = require('child_process');

function create({ displayEmitter }) {
    const ALS_DEVICE_PATH = '/sys/bus/iio/devices/iio:device0/in_illuminance_raw';
    const BRIGHTNESS_PATH = '/sys/class/backlight/intel_backlight/brightness';
    const MIN_BRIGHTNESS = 0;
    const MAX_BRIGHTNESS_PATH = '/sys/class/backlight/intel_backlight/max_brightness';
    const MAX_BRIGHTNESS = getSystemMaxBrightness();
    let lastOnBrightness = MAX_BRIGHTNESS;
    let autoAdjustBrightnessInterval = null;

    const ALS_MIN = 0;
    const ALS_MAX = 100000;
    const BRIGHTNESS_MIN = 15;
    const BRIGHTNESS_MAX = 100;

    function readALS() {
        try {
            const raw = fs.readFileSync(ALS_DEVICE_PATH, 'utf8');
            return parseInt(raw.trim(), 10);
        } catch (err) {
            console.error('Failed to read ALS value:', err.message);
            return null;
        }
    }

    function mapALSToBrightness(alsValue) {
        const clampedALS = Math.max(ALS_MIN, Math.min(ALS_MAX, alsValue));
        const normalized = (clampedALS - ALS_MIN) / (ALS_MAX - ALS_MIN);
        return Math.round(normalized * (BRIGHTNESS_MAX - BRIGHTNESS_MIN) + BRIGHTNESS_MIN);
    }

    function getSystemMaxBrightness() {
        try {
            const raw = fs.readFileSync(MAX_BRIGHTNESS_PATH, 'utf8');
            return parseInt(raw.trim(), 10);
        } catch (err) {
            console.error('Failed to read max brightness:', err.message);
            return 100;
        }
    }

    function startALSLoop() {
        if (autoAdjustBrightnessInterval) return;
        autoAdjustBrightnessInterval = setInterval(() => {
            autoAdjustBrightness();
        }, 10000);
    }

    function getBrightness(callback) {
        fs.readFile(BRIGHTNESS_PATH, 'utf8', (err, data) => {
            if (err) return callback(err);
            callback(null, parseInt(data.trim(), 10));
        });
    }

    function getUserBrightness(callback) {
        getBrightness((err, value) => {
            if (err) return callback(err);
            const userValue = Math.round((value / getSystemMaxBrightness()) * 255);
            callback(null, userValue);
        });
    }

    function setBrightnessStateAware(value, callback) {
        if (typeof value !== 'number' || value < MIN_BRIGHTNESS || value > MAX_BRIGHTNESS) {
            return callback(new Error(`Brightness value out of range: ${value}`));
        }
        getBrightness((err, current) => {
            if (err) return callback(err);
            if (current > MIN_BRIGHTNESS) {
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

    function setBrightness(value, callback) {
        if (typeof value !== 'number' || value < MIN_BRIGHTNESS || value > MAX_BRIGHTNESS) {
            return callback(new Error(`Brightness value out of range: ${value}`));
        }
        const systemMax = getSystemMaxBrightness();
        const toWrite = String(Math.max(MIN_BRIGHTNESS, Math.min(systemMax, Math.round(value))));

        console.log(`Setting brightness to ${toWrite} (requested: ${value}, max: ${systemMax})`);

        fs.writeFile(BRIGHTNESS_PATH, toWrite, 'utf8', (err) => {
            if (!err) {
                getUserBrightness((gErr) => {
                    if (gErr) return callback(gErr);
                });
            }
            callback(err);
        });
    }

    function autoAdjustBrightness(callback) {
        const als = readALS();
        if (als !== null) {
            displayEmitter.emit('alsStateChanged', als);
            const brightness = mapALSToBrightness(als);
            setBrightnessStateAware(brightness, () => {
                if (callback) callback();
            });
            return;
        }
        if (callback) callback();
    }

    function turnOff(callback) {
        getBrightness((err, current) => {
            if (!err && current > MIN_BRIGHTNESS) lastOnBrightness = current;
            setBrightness(MIN_BRIGHTNESS, callback);
        });
    }

    function turnOn(callback) {
        setBrightness(lastOnBrightness || BRIGHTNESS_MAX, callback);
    }

    function setGovernor(governor, callback) {
        process.nextTick(callback);
        return;
        // Battery-tuning path retained for reference but disabled.
        try {
            const cpus = fs.readdirSync('/sys/devices/system/cpu').filter((name) => /^cpu[0-9]+$/.test(name));
            let remaining = cpus.length;
            if (remaining === 0) return process.nextTick(callback);
            let hasError = false;
            cpus.forEach((cpu) => {
                fs.writeFile(`/sys/devices/system/cpu/${cpu}/cpufreq/scaling_governor`, governor, 'utf8', (err) => {
                    if (hasError) return;
                    if (err) {
                        hasError = true;
                        return callback(err);
                    }
                    if (--remaining === 0) callback();
                });
            });
        } catch (error) {
            process.nextTick(() => callback(error));
        }
    }

    function initializeState(callback) {
        getBrightness((err, current) => {
            callback(null, current > MIN_BRIGHTNESS);
        });
    }

    // user [0..255] → [MIN_BRIGHTNESS..MAX_BRIGHTNESS]
    function mapBrightnessToDisplay(brightness) {
        const min = 0, max = 255;
        if (brightness === 0) return MIN_BRIGHTNESS;
        return Math.round((brightness - min) * (MAX_BRIGHTNESS - MIN_BRIGHTNESS) / (max - min) + MIN_BRIGHTNESS);
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
