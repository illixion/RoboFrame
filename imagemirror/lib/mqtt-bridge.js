'use strict';
//
// MQTT bridge between Home Assistant and RoboFrame kiosks.
//
// Each kiosk auto-registers itself when it first reports state (via
// `reportDisplay` / `reportSensor` over WebSocket, or via a `visibility`
// frame for motion). On registration we publish retained MQTT discovery
// payloads so HA creates entities under `roboframe_<deviceId>_*`:
//
//   light.roboframe_<deviceId>_backlight    on/off + brightness 0–255
//   binary_sensor.roboframe_<deviceId>_motion
//   sensor.roboframe_<deviceId>_als         (only if the device reports it)
//
// Inbound flow (HA slider → kiosk):
//   HA writes light command topic
//   → broker subscribes, decodes JSON {state, brightness}
//   → broker emits server→client `setBrightness` / `displayState` to the
//     kiosk that owns this deviceId.
//
// Outbound flow (kiosk → HA reflection):
//   Kiosk sends `reportDisplay` / `reportSensor` upstream over WebSocket
//   → broker calls publishLight / publishSensor here
//   → MQTT publishes to the entity's state topic, retained.
//
// If `mqtt.url` is empty in config, the bridge stays disabled and every
// public method is a no-op.

const mqtt = require('mqtt');

function createMqttBridge({ config, broadcast }) {
    const cfg = config || {};
    const url = (cfg.url || '').trim();
    const enabled = !!url;

    const TOPIC_PREFIX = (cfg.topicPrefix || 'roboframe').replace(/\/+$/, '');
    const DISCOVERY_PREFIX = (cfg.discoveryPrefix || 'homeassistant').replace(/\/+$/, '');

    /** @type {Map<string, { backlight: boolean, motion: boolean, als: boolean, webcam: boolean, suppress: boolean }>} */
    const registered = new Map();

    let client = null;
    let connected = false;
    let pendingPublishes = []; // queued while disconnected

    if (!enabled) {
        return {
            publishLight: noop,
            publishMotion: noop,
            publishSensor: noop,
            publishWebcam: noop,
            publishSuppress: noop,
            close: noop,
            get connected() { return false; },
            get enabled() { return false; },
        };
    }

    // Server-wide RPC and helper topics (not tied to a specific kiosk).
    // - cmd/dismiss is the discovery `button` HA renders for "make any
    //   active video / text overlay go away on every kiosk".
    // - rpc/cmd accepts arbitrary JSON `{action, payload}` from HA
    //   automations and broadcasts it to every connected client. Lets
    //   HA fire `playVideo` / `showText` / etc. via mqtt.publish without
    //   needing a token or HTTP roundtrip.
    const DISMISS_CMD_TOPIC = `${TOPIC_PREFIX}/cmd/dismiss`;
    const RPC_CMD_TOPIC = `${TOPIC_PREFIX}/rpc/cmd`;

    client = mqtt.connect(url, {
        username: cfg.username || undefined,
        password: cfg.password || undefined,
        reconnectPeriod: 5000,
        clientId: `roboframe-${process.pid}-${Math.random().toString(16).slice(2, 8)}`,
    });

    client.on('connect', () => {
        connected = true;
        console.log(`[mqtt] Connected to ${url}`);
        // Re-publish discovery for everything we already know about so HA
        // re-creates entities after a broker restart.
        for (const [deviceId, caps] of registered.entries()) {
            if (caps.backlight) publishLightDiscovery(deviceId);
            if (caps.motion) publishMotionDiscovery(deviceId);
            if (caps.als) publishAlsDiscovery(deviceId);
            if (caps.webcam) publishWebcamDiscovery(deviceId);
            if (caps.suppress) publishSuppressDiscovery(deviceId);
        }
        publishDismissDiscovery();
        // Subscribe to every kiosk's command topic with a single wildcard,
        // plus the server-wide RPC and dismiss topics.
        client.subscribe([
            `${TOPIC_PREFIX}/light/+/backlight/set`,
            `${TOPIC_PREFIX}/switch/+/webcam/set`,
            `${TOPIC_PREFIX}/switch/+/suppress/set`,
            DISMISS_CMD_TOPIC,
            RPC_CMD_TOPIC,
        ], { qos: 0 }, (err) => {
            if (err) console.warn(`[mqtt] subscribe failed: ${err.message}`);
        });
        // Drain anything we tried to publish before connect completed.
        for (const [topic, payload, options] of pendingPublishes) {
            client.publish(topic, payload, options);
        }
        pendingPublishes = [];
    });

    client.on('reconnect', () => { console.log('[mqtt] Reconnecting…'); });
    client.on('close', () => { connected = false; });
    client.on('error', (err) => { console.warn(`[mqtt] Error: ${err.message}`); });

    client.on('message', (topic, message) => {
        // Server-wide dismiss button — clear any video / text / audio
        // overlay on every connected kiosk regardless of payload.
        if (topic === DISMISS_CMD_TOPIC) {
            broadcast({ action: 'stopVideo' });
            broadcast({ action: 'dismissText' });
            broadcast({ action: 'stopAudio' });
            return;
        }

        // Generic JSON RPC: HA automations call mqtt.publish with a
        // {action, payload} body. We rebroadcast verbatim, the same way
        // HTTP /rpc/send does.
        if (topic === RPC_CMD_TOPIC) {
            let body;
            try { body = JSON.parse(message.toString()); }
            catch (err) {
                console.warn(`[mqtt] malformed JSON on ${RPC_CMD_TOPIC}: ${err.message}`);
                return;
            }
            if (!body || typeof body.action !== 'string') {
                console.warn(`[mqtt] ${RPC_CMD_TOPIC} missing string "action" field`);
                return;
            }
            broadcast({ action: body.action, payload: body.payload });
            return;
        }

        // Inbound HA webcam switch: just an ON/OFF toggle.
        const wm = topic.match(new RegExp(`^${escapeRegExp(TOPIC_PREFIX)}/switch/([^/]+)/webcam/set$`));
        if (wm) {
            const deviceId = wm[1];
            const text = message.toString().trim().toUpperCase();
            const stateOn = text === 'ON' || text === 'TRUE' || text === '1';
            broadcast({ action: 'setWebcam', payload: { target: deviceId, state: stateOn ? 'on' : 'off' } });
            return;
        }

        // Inbound HA suppress switch: when ON, the kiosk's wake-suppressor
        // is engaged — PIR motion will not wake the panel, and the panel
        // is held off. Home-control effect actions (playVideo/showText/...)
        // continue to override this.
        const sm = topic.match(new RegExp(`^${escapeRegExp(TOPIC_PREFIX)}/switch/([^/]+)/suppress/set$`));
        if (sm) {
            const deviceId = sm[1];
            const text = message.toString().trim().toUpperCase();
            const stateOn = text === 'ON' || text === 'TRUE' || text === '1';
            broadcast({ action: 'setSuppress', payload: { target: deviceId, state: stateOn ? 'on' : 'off' } });
            return;
        }

        // Inbound HA brightness command: forward to the kiosk that owns
        // this deviceId.
        const m = topic.match(new RegExp(`^${escapeRegExp(TOPIC_PREFIX)}/light/([^/]+)/backlight/set$`));
        if (!m) return;
        const deviceId = m[1];

        let body;
        try { body = JSON.parse(message.toString()); }
        catch (_) {
            // Not JSON — treat as plain "ON"/"OFF" payload for back-compat.
            const text = message.toString().trim().toUpperCase();
            body = { state: text === 'OFF' ? 'OFF' : 'ON' };
        }

        // Both the node-display service and the in-browser kiosk page
        // listen for these and filter by `target` — broadcast so both get
        // them. (Targeting just one ws via deviceWs picks the most recent
        // sender, which is usually the browser, leaving the screen on.)
        // Confirm the command back to the light's state topic. Without this,
        // HA only sees a state update when a kiosk independently reports
        // (e.g. via PIR-driven reportDisplay) — HA-originated toggles would
        // otherwise leave the entity stuck on its prior retained state.
        const confirm = {};
        if (typeof body.brightness === 'number') {
            broadcast({ action: 'setBrightness', payload: { target: deviceId, brightness: body.brightness } });
            confirm.brightness = body.brightness;
        }
        if (typeof body.state === 'string') {
            const stateOn = body.state.toUpperCase() === 'ON';
            broadcast({ action: 'displayState', payload: { target: deviceId, state: stateOn ? 'on' : 'off' } });
            confirm.state = stateOn ? 'on' : 'off';
        }
        if (confirm.state || typeof confirm.brightness === 'number') {
            publishLight(deviceId, confirm);
        }
    });

    function ensureRegistered(deviceId, kind) {
        if (!deviceId) return false;
        let caps = registered.get(deviceId);
        if (!caps) {
            caps = { backlight: false, motion: false, als: false, webcam: false, suppress: false };
            registered.set(deviceId, caps);
        }
        if (caps[kind]) return false;
        caps[kind] = true;
        return true;
    }

    function publish(topic, payload, options = { retain: true, qos: 0 }) {
        const body = typeof payload === 'string' ? payload : JSON.stringify(payload);
        if (!connected) {
            pendingPublishes.push([topic, body, options]);
            return;
        }
        client.publish(topic, body, options);
    }

    function publishLightDiscovery(deviceId) {
        const uid = `roboframe_${deviceId}_backlight`;
        const cfg = {
            name: 'Backlight',
            unique_id: uid,
            schema: 'json',
            command_topic: `${TOPIC_PREFIX}/light/${deviceId}/backlight/set`,
            state_topic: `${TOPIC_PREFIX}/light/${deviceId}/backlight/state`,
            brightness: true,
            brightness_scale: 255,
            device: deviceBlock(deviceId),
        };
        publish(`${DISCOVERY_PREFIX}/light/${uid}/config`, cfg);
    }

    function publishMotionDiscovery(deviceId) {
        const uid = `roboframe_${deviceId}_motion`;
        const cfg = {
            name: 'Motion',
            unique_id: uid,
            state_topic: `${TOPIC_PREFIX}/binary_sensor/${deviceId}/motion/state`,
            device_class: 'motion',
            payload_on: 'ON',
            payload_off: 'OFF',
            device: deviceBlock(deviceId),
        };
        publish(`${DISCOVERY_PREFIX}/binary_sensor/${uid}/config`, cfg);
    }

    function publishAlsDiscovery(deviceId) {
        const uid = `roboframe_${deviceId}_als`;
        const cfg = {
            name: 'Ambient Light',
            unique_id: uid,
            state_topic: `${TOPIC_PREFIX}/sensor/${deviceId}/als/state`,
            device_class: 'illuminance',
            unit_of_measurement: 'lx',
            device: deviceBlock(deviceId),
        };
        publish(`${DISCOVERY_PREFIX}/sensor/${uid}/config`, cfg);
    }

    function publishSuppressDiscovery(deviceId) {
        const uid = `roboframe_${deviceId}_suppress`;
        const cfg = {
            name: 'Suppress wake',
            unique_id: uid,
            command_topic: `${TOPIC_PREFIX}/switch/${deviceId}/suppress/set`,
            state_topic: `${TOPIC_PREFIX}/switch/${deviceId}/suppress/state`,
            payload_on: 'ON',
            payload_off: 'OFF',
            icon: 'mdi:sleep',
            device: deviceBlock(deviceId),
        };
        publish(`${DISCOVERY_PREFIX}/switch/${uid}/config`, cfg);
    }

    function publishWebcamDiscovery(deviceId) {
        const uid = `roboframe_${deviceId}_webcam`;
        const cfg = {
            name: 'Webcam',
            unique_id: uid,
            command_topic: `${TOPIC_PREFIX}/switch/${deviceId}/webcam/set`,
            state_topic: `${TOPIC_PREFIX}/switch/${deviceId}/webcam/state`,
            payload_on: 'ON',
            payload_off: 'OFF',
            icon: 'mdi:webcam',
            device: deviceBlock(deviceId),
        };
        publish(`${DISCOVERY_PREFIX}/switch/${uid}/config`, cfg);
    }

    function publishDismissDiscovery() {
        const uid = 'roboframe_dismiss';
        const cfg = {
            name: 'RoboFrame Dismiss',
            unique_id: uid,
            command_topic: DISMISS_CMD_TOPIC,
            device: {
                identifiers: ['roboframe_server'],
                name: 'RoboFrame',
                manufacturer: 'RoboFrame',
                model: 'Photo Frame Server',
            },
        };
        publish(`${DISCOVERY_PREFIX}/button/${uid}/config`, cfg);
    }

    function deviceBlock(deviceId) {
        return {
            identifiers: [`roboframe_${deviceId}`],
            name: `RoboFrame ${deviceId}`,
            manufacturer: 'RoboFrame',
            model: 'Photo Frame',
        };
    }

    // ----- Public API ------------------------------------------------------

    function publishLight(deviceId, { state, brightness }) {
        if (!deviceId) return;
        if (ensureRegistered(deviceId, 'backlight')) publishLightDiscovery(deviceId);
        const body = {};
        if (typeof state === 'string') body.state = state.toUpperCase() === 'ON' || state === 'on' ? 'ON' : 'OFF';
        else if (typeof state === 'boolean') body.state = state ? 'ON' : 'OFF';
        if (typeof brightness === 'number') body.brightness = Math.max(0, Math.min(255, Math.round(brightness)));
        if (Object.keys(body).length === 0) return;
        publish(`${TOPIC_PREFIX}/light/${deviceId}/backlight/state`, body);
    }

    function publishMotion(deviceId, visible) {
        if (!deviceId) return;
        if (ensureRegistered(deviceId, 'motion')) publishMotionDiscovery(deviceId);
        publish(`${TOPIC_PREFIX}/binary_sensor/${deviceId}/motion/state`, visible ? 'ON' : 'OFF');
    }

    function publishSensor(deviceId, sensor, value) {
        if (!deviceId || !sensor) return;
        if (sensor === 'als') {
            if (ensureRegistered(deviceId, 'als')) publishAlsDiscovery(deviceId);
            publish(`${TOPIC_PREFIX}/sensor/${deviceId}/als/state`, String(value));
        }
        // Future: other sensor types extend the switch here.
    }

    function publishWebcam(deviceId, { state }) {
        if (!deviceId) return;
        if (ensureRegistered(deviceId, 'webcam')) publishWebcamDiscovery(deviceId);
        let on;
        if (typeof state === 'boolean') on = state;
        else if (typeof state === 'string') on = state.toUpperCase() === 'ON' || state === 'on';
        else return;
        publish(`${TOPIC_PREFIX}/switch/${deviceId}/webcam/state`, on ? 'ON' : 'OFF');
    }

    function publishSuppress(deviceId, state) {
        if (!deviceId) return;
        if (ensureRegistered(deviceId, 'suppress')) publishSuppressDiscovery(deviceId);
        let on;
        if (typeof state === 'boolean') on = state;
        else if (typeof state === 'string') on = state.toUpperCase() === 'ON' || state === 'on';
        else return;
        publish(`${TOPIC_PREFIX}/switch/${deviceId}/suppress/state`, on ? 'ON' : 'OFF');
    }

    function close() {
        if (client) {
            try { client.end(true); } catch (_) { /* ignore */ }
        }
        registered.clear();
    }

    return {
        publishLight,
        publishMotion,
        publishSensor,
        publishWebcam,
        publishSuppress,
        close,
        get connected() { return connected; },
        get enabled() { return true; },
    };
}

function noop() {}

function escapeRegExp(s) {
    return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

module.exports = { createMqttBridge };
