'use strict';

const fs = require('fs');
const path = require('path');

/**
 * Unified configuration for all RoboFrame services.
 *
 * Resolution order (highest precedence wins):
 *   1. Process env vars (preserves existing systemd units)
 *   2. roboframe.config.json (located by ROBOFRAME_CONFIG env var, or by
 *      walking up from process.cwd() looking for the file)
 *   3. Hard-coded defaults
 *
 * Each service calls `loadConfig()` to get the full tree, then pulls its
 * own section. Per-service env overrides are applied via `pickEnv()` at
 * the call site so the names stay close to the values they affect.
 */

function findConfigFile() {
    if (process.env.ROBOFRAME_CONFIG) {
        return path.resolve(process.env.ROBOFRAME_CONFIG);
    }
    let dir = path.resolve(process.cwd());
    for (let i = 0; i < 6; i++) {
        const candidate = path.join(dir, 'roboframe.config.json');
        if (fs.existsSync(candidate)) return candidate;
        const parent = path.dirname(dir);
        if (parent === dir) break;
        dir = parent;
    }
    return null;
}

let _cached = null;
function loadConfig({ reload = false } = {}) {
    if (_cached && !reload) return _cached;
    const configPath = findConfigFile();
    let raw = {};
    if (configPath) {
        try {
            raw = JSON.parse(fs.readFileSync(configPath, 'utf8'));
        } catch (err) {
            console.warn(`Failed to parse ${configPath}: ${err.message}`);
        }
    }
    const accessToken = raw.accessToken || '';
    const deviceId = raw.deviceId || '';
    const server = raw.server || {};
    const display = raw.display || {};
    _cached = {
        // One section per process. `server` is the merged Node server (image
        // API + WebSocket broker + optional HA bridge); `display` is the
        // on-device daemon that runs on each kiosk. `deviceId` is top-level
        // so node-display and native-kiosk pull the same identifier without
        // a second source of truth.
        accessToken,
        deviceId,
        server: { ...server, ha: { ...(server.ha || {}) }, slideshow: { ...(server.slideshow || {}) } },
        display: { ...display, pirHttp: { ...(display.pirHttp || {}) }, nightLight: { ...(display.nightLight || {}) }, webcam: { ...(display.webcam || {}) } },
        configPath,
    };
    return _cached;
}

/**
 * Pull a value with the precedence: env > configValue > fallback.
 * Casting helpers handle strings → numbers / booleans / arrays.
 */
function pickEnv(envName, configValue, fallback, { type = 'string' } = {}) {
    const envVal = process.env[envName];
    if (envVal !== undefined && envVal !== '') {
        return cast(envVal, type, fallback);
    }
    if (configValue !== undefined && configValue !== null) return configValue;
    return fallback;
}

function cast(s, type, fallback) {
    if (type === 'number') {
        const n = Number(s);
        return Number.isFinite(n) ? n : fallback;
    }
    if (type === 'boolean') {
        if (typeof s === 'boolean') return s;
        return /^(1|true|yes|on)$/i.test(String(s));
    }
    if (type === 'csv') {
        return String(s).split(',').map((x) => x.trim()).filter(Boolean);
    }
    return String(s);
}

module.exports = { loadConfig, findConfigFile, pickEnv };
