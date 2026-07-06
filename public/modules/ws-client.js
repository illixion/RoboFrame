// WebSocket client + dispatcher.
//
// On open, sends `slideshowConfig` so the orchestrator can join us to the
// channel for our deviceId. The dispatcher routes each server frame to the
// appropriate module: tagLists → tags, playback → slideshow,
// displayState → visibility, update → sensors, playVideo/showText/etc. →
// effects.

import { wsUrl, params, getRenderParams, defaultInterval } from './config.js';
import { state } from './state.js';
import { tags } from './tags.js';
import { applyPlayback } from './slideshow.js';
import { disable } from './visibility.js';
import { playVideo, stopVideo, showText, dismissText, playAudio, stopAudio, playScene, stopScene } from './effects.js';
import { hassioUpdate } from './sensors.js';

const minReconnectDelay = 500;
const maxReconnectDelay = 5000;
let reconnectAttempts = 0;
let lowLightBrightness = 16;
let deviceBrightness = 255;
let halted = false;

function showFatalBanner(text) {
    let banner = document.getElementById('ws-fatal-banner');
    if (!banner) {
        banner = document.createElement('div');
        banner.id = 'ws-fatal-banner';
        banner.style.cssText = 'position:fixed;top:0;left:0;right:0;z-index:99999;'
            + 'background:#7a1f1f;color:#fff;font:14px/1.4 system-ui,sans-serif;'
            + 'padding:10px 14px;text-align:center;box-shadow:0 2px 6px rgba(0,0,0,.4)';
        document.body.appendChild(banner);
    }
    banner.textContent = text;
}

// Single-session client — every session-scoped action carries this
// constant id. Multiplexing clients (Spatialstash multi-window) generate
// per-window ids; the kiosk only ever has one slideshow per page.
export const KIOSK_SESSION_ID = 'main';

// --- Client error reporting -------------------------------------------
// Forward uncaught JS errors / promise rejections to the broker's reportLog
// sink (telemetry.jsonl) so frontend crashes on headless kiosks are visible
// without a console attached. Rate-limited and deduped so a tight error loop
// can't flood the socket or the log file, and buffered until the socket opens
// so early-boot errors aren't lost.
const ERROR_APP_NAME = 'roboframe-web';
let errorBudget = 20;            // max distinct reports per page load
const seenErrors = new Set();    // dedupe identical messages
const pendingLogs = [];          // buffered until the socket is OPEN

export function reportLog(level, domain, message) {
    const payload = {
        deviceId: state.deviceID || 'web',
        app: ERROR_APP_NAME,
        level,
        domain,
        message: String(message).slice(0, 2000),
        ts: Date.now(),
    };
    if (state.socket && state.socket.readyState === WebSocket.OPEN) {
        state.socket.send(JSON.stringify({ action: 'reportLog', payload }));
    } else if (pendingLogs.length < 50) {
        pendingLogs.push(payload);
    }
}

function reportClientError(level, domain, message) {
    if (errorBudget <= 0) return;
    const key = `${domain}:${message}`;
    if (seenErrors.has(key)) return;
    seenErrors.add(key);
    errorBudget--;
    reportLog(level, domain, message);
}

// Capture phase so resource-load failures (img/script with no bubbling error)
// are caught too. Registered once at module load — not per-connect — so
// reconnects don't stack duplicate listeners.
window.addEventListener('error', (event) => {
    if (event.error || event.message) {
        const where = event.filename ? ` (${event.filename}:${event.lineno}:${event.colno})` : '';
        reportClientError('error', 'js', `${event.message || event.error}${where}`);
    } else if (event.target && event.target.src) {
        reportClientError('warning', 'resource', `Failed to load ${event.target.src}`);
    }
}, true);

window.addEventListener('unhandledrejection', (event) => {
    const reason = event.reason;
    const msg = reason?.stack || reason?.message || String(reason);
    reportClientError('error', 'promise', msg);
});

function sendSlideshowConfig() {
    const r = getRenderParams();
    state.socket.send(JSON.stringify({
        sessionId: KIOSK_SESSION_ID,
        action: 'slideshowConfig',
        payload: {
            deviceId: state.deviceID,
            interval: defaultInterval,
            ratio: r.ratio,
            width: r.screenWidth,
            height: r.screenHeight,
            bright: r.bright,
            convert: r.convert,
            lowmem: !!r.lowmem,
            // Bundle mod tags so the orchestrator's first refill query
            // already includes them — avoids an immediately-discarded
            // refill round-trip a few ms after connect.
            modTags: tags.modTags,
        },
    }));
}

function attemptReconnect() {
    if (halted) return;
    reconnectAttempts++;
    const delay = Math.min(minReconnectDelay * reconnectAttempts, maxReconnectDelay);
    console.log(`Reconnecting in ${delay}ms...`);
    setTimeout(connectWebSocket, delay);
}

export function connectWebSocket() {
    if (halted) return;
    if (!params.token) {
        halted = true;
        const msg = 'Missing kiosk access token — add ?token=<ACCESS_TOKEN> to the page URL. WebSocket disabled.';
        console.error(msg);
        showFatalBanner(msg);
        return;
    }
    console.log('Attempting to connect...');
    state.socket = new WebSocket(wsUrl());

    state.socket.addEventListener('open', () => {
        console.log('WebSocket connected');
        reconnectAttempts = 0;
        sendSlideshowConfig();
        if (state.deviceID) {
            state.socket.send(JSON.stringify({
                action: 'visibility',
                payload: { deviceId: state.deviceID, visible: !document.hidden },
            }));
            state.socket.send(JSON.stringify({
                action: 'getDisplayState',
                payload: { target: state.deviceID },
            }));
        }
        // Flush any error reports captured before the socket was open.
        while (pendingLogs.length) {
            state.socket.send(JSON.stringify({ action: 'reportLog', payload: pendingLogs.shift() }));
        }
    });

    state.socket.addEventListener('message', (event) => {
        const message = JSON.parse(event.data);
        if (message.action) console.log(`Received ${message.action} message:`, message);

        switch (message.action) {
            case 'tagLists':
                if (Array.isArray(message.payload)) tags.setLists(message.payload);
                break;
            case 'playback':
                applyPlayback(message.payload);
                break;
            case 'displayState':
                // Only act on frames that actually carry a panel `state`. A
                // `state`-less displayState (e.g. a stray visibility echo)
                // must not toggle the panel — treating a missing state as
                // "on" would re-enable a display PIR had turned off.
                if (message.payload?.target === state.deviceID
                    && message.payload?.state !== undefined) {
                    const off = message.payload.state === 'off' || message.payload.state === false;
                    disable(off);
                }
                break;
            case 'setBrightness':
                if (message.payload?.target === state.deviceID) {
                    deviceBrightness = message.payload.brightness;
                    disable(deviceBrightness < lowLightBrightness);
                }
                break;
            case 'playVideo':
                if (message.payload?.url) playVideo(message.payload.url);
                break;
            case 'stopVideo':
                stopVideo();
                break;
            case 'showText':
                if (message.payload) {
                    const { text = '', bgColorHex = '#000000', imageUrl = '' } = message.payload;
                    showText(text, bgColorHex, imageUrl);
                }
                break;
            case 'dismissText':
                dismissText();
                break;
            case 'playAudio':
                if (message.payload?.url) playAudio(message.payload.url);
                break;
            case 'stopAudio':
                stopAudio();
                break;
            case 'playScene':
                // Live WebRTC scene; this client consumes the WHEP URL,
                // native-kiosk consumes `rtsp` from the same payload.
                if (message.payload?.whep) playScene(message.payload.whep);
                break;
            case 'stopScene':
                stopScene();
                break;
            case 'update':
                hassioUpdate(message.payload);
                break;
            case 'refresh':
                location.reload();
                break;
            case 'searchEmpty':
                console.warn(`Server reports no matches for tag query: "${message.payload?.query ?? ''}"`);
                break;
            default:
                // Unknown actions are silently ignored — server-side may
                // introduce new ones we don't yet handle.
                break;
        }
    });

    state.socket.addEventListener('close', (event) => {
        // 1008 = policy violation. Server closes the upgrade with this code
        // when the `?token=` query param is missing or doesn't match the
        // configured access/valid tokens. Reconnecting won't fix that, so
        // halt the loop and surface the reason loudly.
        if (event.code === 1008) {
            halted = true;
            const msg = `WebSocket rejected by server (token invalid): ${event.reason || 'invalid token'}. `
                + 'Check ?token=<ACCESS_TOKEN>.';
            console.error(msg);
            showFatalBanner(msg);
            return;
        }
        console.log(`WebSocket disconnected (code=${event.code}${event.reason ? `, reason=${event.reason}` : ''})`);
        attemptReconnect();
    });
    state.socket.addEventListener('error', (error) => {
        console.error('WebSocket error:', error);
        state.socket.close();
    });
}

export function sendDisplaySync(enabled) {
    if (state.socket && state.socket.readyState === WebSocket.OPEN) {
        state.socket.send(JSON.stringify({
            sessionId: KIOSK_SESSION_ID,
            action: 'displaySync',
            payload: { enabled },
        }));
    }
}

if (typeof params.ws === 'string' && params.ws.length) {
    state.deviceID = params.ws;
}
