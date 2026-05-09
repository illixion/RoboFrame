// WebSocket client + dispatcher.
//
// On open, sends `slideshowConfig` so the orchestrator can join us to the
// channel for our deviceId. The dispatcher routes each server frame to the
// appropriate module: tagLists/currentTagList → tags, playback → slideshow,
// displayState → visibility, update → sensors, playVideo/showText/etc. →
// effects.

import { wsUrl, params, getRenderParams, defaultInterval } from './config.js';
import { state } from './state.js';
import { tags } from './tags.js';
import { applyPlayback } from './slideshow.js';
import { disable } from './visibility.js';
import { playVideo, stopVideo, showText, dismissText, playAudio, stopAudio } from './effects.js';
import { hassioUpdate } from './sensors.js';

const minReconnectDelay = 500;
const maxReconnectDelay = 5000;
let reconnectAttempts = 0;
let lowLightBrightness = 16;
let deviceBrightness = 255;
let halted = false;

// Peers we've heard from via `displayState`, so we can detect whether a
// `<our deviceId>_primary` peer is currently connected. When it is, we
// keep the slideshow gated off — the primary owns the panel.
const knownPeers = new Set();
function primaryActive() {
    return !!state.deviceID && knownPeers.has(`${state.deviceID}_primary`);
}

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
        // Drop stale peers learned in the previous session — peers may have
        // disconnected while we were offline and we'd never have seen the
        // `displayDisconnect`. The broker replays cached `displayState`
        // frames after a brief settle window, which repopulates this.
        knownPeers.clear();
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
    });

    state.socket.addEventListener('message', (event) => {
        const message = JSON.parse(event.data);
        if (message.action) console.log(`Received ${message.action} message:`, message);

        switch (message.action) {
            case 'tagLists':
                if (Array.isArray(message.payload)) tags.setLists(message.payload);
                break;
            case 'currentTagList':
                if (typeof message.payload?.listNumber === 'number') {
                    tags.applyServer(message.payload.listNumber);
                }
                break;
            case 'playback':
                applyPlayback(message.payload);
                break;
            case 'displayState':
                if (message.payload?.target) knownPeers.add(message.payload.target);
                if (message.payload?.target === state.deviceID) {
                    const off = message.payload.state === 'off' || message.payload.state === false;
                    // Suppress turn-on while a `<deviceId>_primary` peer is
                    // connected — that peer owns waking the panel. Off events
                    // still apply so HA/MQTT can force-blank us.
                    if (off || !primaryActive()) disable(off);
                }
                break;
            case 'displayDisconnect':
                if (message.payload?.target) knownPeers.delete(message.payload.target);
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
            case 'update':
                hassioUpdate(message.payload);
                break;
            case 'refresh':
                location.reload();
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
