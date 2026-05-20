'use strict';
//
// WebSocket broker + MQTT bridge — owns per-device state, the push-based
// tagLists/displayState protocol, and the MQTT bridge that exposes each
// kiosk to Home Assistant via discovery (no manual helper entities).
//
// Block lists are server-only state. The orchestrator filters blocked
// posts out of every channel's queue before broadcasting `playback`, so
// clients never see a `blocked` frame on the wire. `block { id }` from a
// client persists into data.json and triggers an orchestrator advance;
// hand-edits to data.json's blockedIds/blockedTags do the same.
//
// An optional read-side HA WebSocket subscription forwards picked sensor
// state changes back to kiosks via the `update` action — used by the kiosk
// frontend to show outdoor temperature, etc. That's the only thing the HA
// WebSocket path does now: control flows through MQTT.
//
// Hosted by imagemirror's main process; mounted via setupBroker(). Nothing
// here talks to the image API directly — they share a process and an Express
// app + http.Server.
//
const fs = require('fs');
const path = require('path');
const WebSocket = require('ws');
const { pickEnv } = require('@roboframe/shared');
const { createOrchestrator } = require('./orchestrator');
const { createMqttBridge } = require('./mqtt-bridge');

function setupBroker({ server, app, config, dataPath, search, reshuffle, incrementDisplayCount }) {
    const srv = config.server || {};
    const ha = srv.ha || {};
    const mqttCfg = srv.mqtt || {};

    const rpcToken = pickEnv('RPC_TOKEN', srv.rpcToken, '');
    const accessToken = pickEnv('ACCESS_TOKEN', config.accessToken, '');
    const HA_URL = pickEnv('HA_URL', ha.url, '');
    const HA_TOKEN = pickEnv('HA_TOKEN', ha.token, '');
    const HA_FILTER_ENTITIES = pickEnv('HA_FILTER_ENTITIES', ha.filterEntities, [], { type: 'csv' });

    // HA WebSocket subscription is auto-enabled when both URL and token are
    // present and used only to forward sensor state changes (see HA_FILTER_ENTITIES)
    // to kiosks. Control flow uses MQTT (see mqtt-bridge.js).
    const HA_ENABLED = (ha.enabled !== false) && !!(HA_URL && HA_TOKEN);

    if (!rpcToken) {
        console.error('ERROR: rpcToken is required (set server.rpcToken in roboframe.config.json or RPC_TOKEN env var)');
        process.exit(1);
    }
    if (!accessToken) {
        console.error('ERROR: accessToken is required (set top-level accessToken in roboframe.config.json or ACCESS_TOKEN env var)');
        process.exit(1);
    }
    if (accessToken === rpcToken) {
        console.error('ERROR: accessToken must differ from rpcToken — they grant different privilege tiers');
        process.exit(1);
    }

    const wss = new WebSocket.Server({ server, path: '/rpc/ws' });

    // ----- In-memory state -------------------------------------------------
    const displayStates = {};              // deviceId → last `displayState` message
    const visibilityStates = {};           // deviceId → { visible, lastChangedAt }
    const haStates = {};                   // entity_id → last `update` message
    const deviceWs = new Map();            // deviceId → ws (most recent kiosk for that ID)
    const wsDeviceIds = new WeakMap();     // ws → Set<deviceId> claimed by this ws

    // Track every (ws, deviceId) association in one place so the close handler
    // can announce a `displayDisconnect` for each deviceId this ws was the
    // most recent reporter for.
    function attachDeviceId(ws, deviceId) {
        if (typeof deviceId !== 'string' || !deviceId) return;
        let set = wsDeviceIds.get(ws);
        if (!set) { set = new Set(); wsDeviceIds.set(ws, set); }
        set.add(deviceId);
        deviceWs.set(deviceId, ws);
    }
    // Local data store — a single hand-editable JSON file holding three
    // arrays. Reads always go through readDataStore() (no in-memory cache),
    // so a hand-edit between the broker's read-modify-write of any one
    // field can't be clobbered by a stale cache. SSD latency is fine; data
    // safety wins.
    //
    // The file is also watched: an external edit triggers a broadcast of
    // the affected slice. The watcher only fires the broadcast — the
    // actual reads happen on demand elsewhere.

    function parseTagListsField(raw) {
        if (!Array.isArray(raw)) return [];
        // Accept both array-of-arrays (canonical) and array-of-strings (each
        // string a space-separated list) — same forgiveness rule the
        // protocol applies on the wire.
        return raw.map((entry) => {
            if (Array.isArray(entry)) return entry.map(String);
            if (typeof entry === 'string') return entry.split(/\s+/).filter(Boolean);
            return [];
        });
    }

    function ensureDataFile() {
        if (!fs.existsSync(dataPath)) {
            fs.mkdirSync(path.dirname(dataPath), { recursive: true });
            fs.writeFileSync(dataPath, JSON.stringify({
                blockedIds: [],
                blockedTags: [],
                tagLists: [],
            }, null, 2) + '\n');
        }
    }

    function readDataStore() {
        try {
            const raw = JSON.parse(fs.readFileSync(dataPath, 'utf-8'));
            return {
                blockedIds: Array.isArray(raw.blockedIds) ? raw.blockedIds : [],
                blockedTags: Array.isArray(raw.blockedTags)
                    ? raw.blockedTags.map(String).filter(Boolean)
                    : [],
                tagLists: parseTagListsField(raw.tagLists),
            };
        } catch (err) {
            console.warn(`Failed to read ${dataPath}: ${err.message}; treating as empty`);
            return { blockedIds: [], blockedTags: [], tagLists: [] };
        }
    }

    /// Read-modify-write: pulls the latest values from disk before applying
    /// the partial update, so we can never overwrite an external edit to a
    /// field we weren't even touching.
    function writeDataStore(updates) {
        const current = readDataStore();
        const merged = {
            blockedIds: updates.blockedIds ?? current.blockedIds,
            blockedTags: updates.blockedTags ?? current.blockedTags,
            tagLists: updates.tagLists ?? current.tagLists,
        };
        fs.writeFileSync(dataPath, JSON.stringify(merged, null, 2) + '\n');
        return merged;
    }

    ensureDataFile();
    // Snapshot used by the file watcher to dedupe broadcasts. Updated when
    // the broker writes its own changes (see saveBlockedIds) so the watcher
    // doesn't re-broadcast our own writes.
    let lastBroadcastSnapshot = (() => {
        const init = readDataStore();
        return {
            blockedIds: JSON.stringify(init.blockedIds),
            blockedTags: JSON.stringify(init.blockedTags),
            tagLists: JSON.stringify(init.tagLists),
        };
    })();

    function getBlockedTags() { return readDataStore().blockedTags; }
    function getBlockedPosts() { return readDataStore().blockedIds; }
    function getTagLists() { return readDataStore().tagLists; }
    function saveBlockedIds(updated) {
        writeDataStore({ blockedIds: updated });
        lastBroadcastSnapshot.blockedIds = JSON.stringify(updated);
    }

    // ----- File watcher: detect external edits, broadcast diffs ------------
    let dataReloadTimer = null;
    let dataWatcher = null;
    try {
        dataWatcher = fs.watch(dataPath, () => {
            if (dataReloadTimer) clearTimeout(dataReloadTimer);
            dataReloadTimer = setTimeout(() => {
                const current = readDataStore();
                const tagListsKey = JSON.stringify(current.tagLists);
                const blockedKey = JSON.stringify(current.blockedIds);
                const blockedTagsKey = JSON.stringify(current.blockedTags);

                if (tagListsKey !== lastBroadcastSnapshot.tagLists) {
                    console.log(`${dataPath} changed; broadcasting tagLists`);
                    broadcast({ action: 'tagLists', payload: current.tagLists });
                    lastBroadcastSnapshot.tagLists = tagListsKey;
                }
                if (blockedKey !== lastBroadcastSnapshot.blockedIds
                    || blockedTagsKey !== lastBroadcastSnapshot.blockedTags) {
                    // Block lists are server-only — no client frame is
                    // emitted. Just kick the orchestrator to drop newly
                    // blocked posts from every channel's queue.
                    console.log(`${dataPath} changed; applying blocklist update`);
                    lastBroadcastSnapshot.blockedIds = blockedKey;
                    lastBroadcastSnapshot.blockedTags = blockedTagsKey;
                    if (orchestrator) orchestrator.notifyBlockedChange();
                }
            }, 50);
        });
    } catch (err) {
        console.warn(`Could not watch ${dataPath}: ${err.message}`);
    }

    // ----- Broadcast utility -----------------------------------------------
    function broadcast(message, except = null) {
        const data = JSON.stringify(message);
        // Cache select message types so late joiners get the current state.
        if (message.action === 'displayState' && message.payload?.target) {
            displayStates[message.payload.target] = message;
        }
        if (message.action === 'update' && message.payload?.entity) {
            haStates[message.payload.entity] = message;
        }
        wss.clients.forEach((client) => {
            if (client.readyState === WebSocket.OPEN && client !== except) {
                client.send(data);
            }
        });
    }

    async function ensureClientConnected() {
        for (let i = 0; i < 30 && wss.clients.size === 0; i++) {
            await new Promise((r) => setTimeout(r, 1000));
        }
    }

    // ----- Slideshow orchestrator ------------------------------------------
    // The orchestrator is the single source of truth for "what's playing now".
    // It uses the broker's `broadcast` to push `playback` frames and reads tag
    // list state through the closures below.
    const orchestrator = search ? createOrchestrator({
        search,
        // Default seed for a new channel's currentTagsList. The active index
        // lives on each channel — see orchestrator.setTagList — so this is
        // only consulted when a channel is first created.
        getCurrentTagsList: () => 0,
        getTagLists,
        getBlockedIds: getBlockedPosts,
        getBlockedTags,
        reshuffle,
        incrementDisplayCount,
    }) : null;

    // ----- MQTT bridge -----------------------------------------------------
    // Auto-discovery for HA. When mqtt.url is empty in config the bridge is
    // disabled and every method below is a no-op, so the rest of the broker
    // doesn't need to feature-detect.
    const mqtt = createMqttBridge({
        config: mqttCfg,
        broadcast,
    });

    // ----- WebSocket connection handler ------------------------------------
    wss.on('connection', (ws, req) => {
        const clientId = req.headers['x-forwarded-for']?.split(',')[0].trim() || req.socket.remoteAddress;

        // Token-tiered auth on connect. `rpcToken` grants the `rpc` tier
        // (can call `rpcsend` to broadcast arbitrary actions). `accessToken`
        // grants the `access` tier (subscribe + kiosk-scoped actions only).
        // Token comes from the `?token=` query parameter on the upgrade URL.
        let connToken = '';
        try {
            const u = new URL(req.url, 'ws://placeholder');
            connToken = u.searchParams.get('token') || '';
        } catch (_) { /* leave empty */ }
        let tier = null;
        if (connToken === rpcToken) tier = 'rpc';
        else if (connToken === accessToken) tier = 'access';
        if (!tier) {
            console.warn(`Rejecting WebSocket client ${clientId}: missing or invalid token`);
            try { ws.close(1008, 'invalid token'); } catch (_) { /* ignore */ }
            return;
        }
        ws.tier = tier;
        console.log(`WebSocket client connected: ${clientId} (tier=${tier})`);

        ws.send(JSON.stringify({ action: 'tagLists', payload: getTagLists() }));
        // currentTagList is per-channel now and arrives in each `playback`
        // frame's `currentList` field. There's no global to send on connect.

        // Replay cached displayStates and HA sensor updates after a brief
        // settle window so a freshly connected (or reconnecting) client has
        // current panel state and the most recent sensor readings without
        // having to wait for the next HA state_changed event.
        setTimeout(() => {
            for (const target in displayStates) {
                ws.send(JSON.stringify(displayStates[target]));
            }
            for (const entity in haStates) {
                ws.send(JSON.stringify(haStates[entity]));
            }
        }, 2000);

        ws.on('close', () => {
            console.log(`WebSocket client disconnected: ${clientId}`);
            if (orchestrator) orchestrator.unregister(ws);
            const claimed = wsDeviceIds.get(ws);
            if (claimed) {
                wsDeviceIds.delete(ws);
                for (const deviceId of claimed) {
                    // Only announce departure if this ws was still the most
                    // recent reporter for that deviceId — otherwise a newer
                    // session has already taken over and the peer's view of
                    // "still present" is correct.
                    if (deviceWs.get(deviceId) !== ws) continue;
                    deviceWs.delete(deviceId);
                    // Cached displayState / visibility is intentionally kept
                    // so that when a client for this deviceId (re)connects,
                    // the connect-time replay restores the last known panel
                    // state — including states that arrived (e.g. via HA or
                    // `rpcsend`) while no client was connected.
                    broadcast({
                        action: 'displayDisconnect',
                        payload: { target: deviceId },
                    });
                }
            }
        });

        ws.on('message', (message) => {
            if (Buffer.byteLength(message) > 1024 * 1024) {
                console.warn(`Received message exceeds 1MB limit from ${clientId}`);
                ws.send(JSON.stringify({ error: 'Message too large' }));
                return;
            }
            let parsed;
            try { parsed = JSON.parse(message); }
            catch (err) { console.warn(`Malformed JSON from ${clientId}: ${err.message}`); return; }
            const { action, payload, token, sessionId } = parsed;
            // sessionId is the per-session multiplexing key. Required for
            // every action that the orchestrator routes through a session
            // (slideshowConfig, setModTags, setTagList, requestNext,
            // reshuffle, imageReady, displaySync). Connection-wide actions
            // (block, visibility, getDisplayState, ping, the various report*
            // frames, rpcsend) ignore it.
            function requireSessionId(label) {
                if (typeof sessionId !== 'string' || !sessionId) {
                    console.warn(`Missing sessionId on ${label} from ${clientId}; ignoring`);
                    return false;
                }
                return true;
            }

            if (action === 'block') {
                // Blocklist is server-only state. We persist the new id and
                // let the orchestrator drop it from every channel's queue;
                // clients see the effect via the resulting `playback`
                // advance, not via a `blocked` frame.
                const blocked = getBlockedPosts();
                if (payload?.id && !blocked.includes(payload.id)) {
                    blocked.push(payload.id);
                    saveBlockedIds(blocked);
                    console.log(`Blocked post ID: ${payload.id}`);
                    if (orchestrator) orchestrator.notifyBlockedChange();
                }

            } else if (action === 'getDisplayState' && payload?.target) {
                const lastMessage = displayStates[payload.target];
                const vis = visibilityStates[payload.target];
                if (lastMessage) {
                    ws.send(JSON.stringify({
                        ...lastMessage,
                        payload: {
                            ...lastMessage.payload,
                            visible: vis?.visible,
                            visibilitySince: vis?.lastChangedAt,
                        },
                    }));
                } else if (vis) {
                    ws.send(JSON.stringify({
                        action: 'displayState',
                        payload: {
                            target: payload.target,
                            visible: vis.visible,
                            visibilitySince: vis.lastChangedAt,
                        },
                    }));
                }
                for (const entityId in haStates) {
                    ws.send(JSON.stringify(haStates[entityId]));
                }

            } else if (action === 'visibility') {
                const deviceId = payload?.deviceId;
                const visible = payload?.visible;
                if (typeof deviceId !== 'string' || typeof visible !== 'boolean') {
                    console.warn('Invalid visibility payload:', payload);
                    return;
                }
                visibilityStates[deviceId] = { visible, lastChangedAt: Date.now() };
                attachDeviceId(ws, deviceId);
                mqtt.publishMotion(deviceId, visible);
                if (orchestrator) orchestrator.notifyVisibility(deviceId, visible);
                if (!visible) {
                    const lastState = displayStates[deviceId]?.payload?.state;
                    if (lastState === 'on' || lastState === true) {
                        broadcast({
                            action: 'displayState',
                            payload: { target: deviceId, state: 'off' },
                        }, ws);
                        mqtt.publishLight(deviceId, { state: 'off' });
                    }
                }

            } else if (action === 'reportDisplay') {
                // Kiosk → broker: "I'm now in this state". Forward to MQTT
                // so HA's light entity reflects the local change, and
                // rebroadcast as a `displayState` so peer clients sharing
                // this deviceId converge on what the panel is actually
                // doing — without this, a PIR-driven wake on node-display
                // leaves an already-connected browser kiosk on the same
                // deviceId stuck on the prior `off` state.
                const deviceId = payload?.deviceId;
                if (typeof deviceId === 'string') {
                    attachDeviceId(ws, deviceId);
                    mqtt.publishLight(deviceId, {
                        state: payload.state,
                        brightness: payload.brightness,
                    });
                    if (typeof payload.state === 'string' || typeof payload.state === 'boolean') {
                        const onOff = (typeof payload.state === 'boolean')
                            ? (payload.state ? 'on' : 'off')
                            : (String(payload.state).toLowerCase() === 'off' ? 'off' : 'on');
                        broadcast({
                            action: 'displayState',
                            payload: { target: deviceId, state: onOff },
                        }, ws);
                    }
                }

            } else if (action === 'reportSensor') {
                // Kiosk → broker: arbitrary sensor reading (currently `als`).
                const deviceId = payload?.deviceId;
                const sensor = payload?.sensor;
                const value = payload?.value;
                if (typeof deviceId === 'string' && typeof sensor === 'string') {
                    attachDeviceId(ws, deviceId);
                    mqtt.publishSensor(deviceId, sensor, value);
                }

            } else if (action === 'reportSuppress') {
                // Kiosk → broker: "my wake-suppressor is now on/off". Mirror
                // to a HA switch entity via MQTT so the user can toggle it.
                const deviceId = payload?.deviceId;
                if (typeof deviceId === 'string') {
                    attachDeviceId(ws, deviceId);
                    mqtt.publishSuppress(deviceId, payload.state);
                }

            } else if (action === 'reportWebcam') {
                // Kiosk → broker: native webcam stream is on/off. Mirror to
                // a HA switch entity via MQTT.
                const deviceId = payload?.deviceId;
                if (typeof deviceId === 'string') {
                    attachDeviceId(ws, deviceId);
                    mqtt.publishWebcam(deviceId, { state: payload.state });
                }

            } else if (action === 'slideshowConfig') {
                if (!requireSessionId('slideshowConfig')) return;
                if (orchestrator) orchestrator.register(ws, sessionId, payload || {});
                attachDeviceId(ws, payload?.deviceId);

            } else if (action === 'sessionEnd') {
                // Optional teardown for one logical session without closing
                // the underlying ws. Useful when a multiplexing client
                // closes one of N viewer windows but keeps others open.
                if (!requireSessionId('sessionEnd')) return;
                if (orchestrator) orchestrator.unregisterSession(ws, sessionId);

            } else if (action === 'setModTags') {
                if (!requireSessionId('setModTags')) return;
                if (orchestrator) orchestrator.setModTags(ws, sessionId, payload?.tags);

            } else if (action === 'requestNext') {
                if (!requireSessionId('requestNext')) return;
                if (orchestrator) orchestrator.requestAdvance(ws, sessionId);

            } else if (action === 'reshuffle') {
                if (!requireSessionId('reshuffle')) return;
                if (orchestrator) orchestrator.requestReshuffle(ws, sessionId);

            } else if (action === 'imageReady') {
                if (!requireSessionId('imageReady')) return;
                if (orchestrator && payload?.id != null) {
                    orchestrator.notifyImageReady(ws, sessionId, payload.id);
                }

            } else if (action === 'setTagList') {
                // Per-channel: only the sender's channel switches list.
                if (!requireSessionId('setTagList')) return;
                if (typeof payload?.listNumber === 'number' && orchestrator) {
                    orchestrator.setTagList(ws, sessionId, payload.listNumber);
                }

            } else if (action === 'ping') {
                ws.send(JSON.stringify({ action: 'pong' }));

            } else if (action === 'displaySync') {
                // displaySync merges every channel into one for the duration
                // of the claim. `enabled: true` makes the sender's channel
                // the merge driver (every other display mirrors that
                // channel); `enabled: false` releases the merge.
                if (!requireSessionId('displaySync')) return;
                if (typeof payload?.enabled === 'boolean' && orchestrator) {
                    orchestrator.claimDisplaySync(ws, sessionId, payload.enabled);
                }

            } else if (action === 'rpcsend') {
                if (ws.tier !== 'rpc' || token !== rpcToken) {
                    console.warn('Failed auth attempt from client:', clientId);
                    return;
                }
                const { action: nestedAction, payload: nestedPayload } = payload || {};
                if (nestedAction && nestedPayload) {
                    broadcast({ action: nestedAction, payload: nestedPayload });
                } else {
                    console.warn('Invalid payload for rpcsend action:', payload);
                }

            } else {
                console.warn(`Unknown action from WebSocket client: ${action}`);
            }
        });
    });

    // ----- HTTP routes (mounted on the host's Express app) ------------------
    app.get('/rpc/tags.json', (req, res) => {
        res.json(getTagLists());
    });

    app.get('/rpc/send', async (req, res) => {
        const { action, payload, token } = req.query;
        if (token !== rpcToken) {
            console.warn('Failed auth attempt');
            return res.status(401).send('Unauthorized: Invalid token');
        }
        let parsedPayload = payload;
        try { parsedPayload = JSON.parse(payload); }
        catch (err) { console.warn('Failed to parse payload as JSON:', err.message); }
        console.log('[RPC message] Received:', { action, payload: parsedPayload });
        await ensureClientConnected();
        broadcast({ action, payload: parsedPayload });
        res.send('Message sent to WebSocket clients');
    });

    app.post('/rpc/deviceDC', require('express').text({ type: '*/*' }), async (req, res) => {
        let target;
        try {
            if (typeof req.body === 'string' && req.body.length) {
                const parsed = JSON.parse(req.body);
                target = parsed?.target;
            } else if (req.body && typeof req.body === 'object') {
                target = req.body.target || req.body?.payload?.target;
            }
        } catch (err) {
            console.warn('Failed to parse /rpc/deviceDC body as JSON:', err.message);
        }
        if (!target && req.query?.target) target = req.query.target;
        console.log(`[Device Disconnect] Display disconnected: ${target}`);
        await ensureClientConnected();
        broadcast({ action: 'displaySync', payload: { target, enabled: false } });
        res.status(204).send();
    });

    // ----- HA WebSocket sensor forwarder (read-only) ------------------------
    // Subscribes to state_changed events and forwards readings for the
    // entities listed in HA_FILTER_ENTITIES to kiosks via the `update`
    // action so they can render outdoor temperature, humidity, etc. All
    // control flow goes through the MQTT bridge above; this path never
    // calls services and never echoes anything back to HA.
    let haSocket = null;
    let haMessageId = 1;
    let haGetStatesId = 0;

    function connectToHA() {
        haSocket = new WebSocket(HA_URL);
        haSocket.on('open', () => {
            console.log('Connected to Home Assistant WebSocket API (sensor forwarding)');
            haSocket.send(JSON.stringify({ type: 'auth', access_token: HA_TOKEN }));
        });
        haSocket.on('message', (data) => {
            const message = JSON.parse(data);
            if (message.type === 'auth_invalid') {
                console.error('HA authentication failed:', message.message, '— disabling HA sensor forwarding');
                haSocket.close();
                return;
            }
            if (message.type === 'auth_ok') {
                // Subscribe to future changes, then prime the cache with a
                // one-shot get_states so reconnecting clients see current
                // readings even if no state_changed event fired since the
                // broker started.
                haSocket.send(JSON.stringify({ id: haMessageId++, type: 'subscribe_events', event_type: 'state_changed' }));
                haGetStatesId = haMessageId++;
                haSocket.send(JSON.stringify({ id: haGetStatesId, type: 'get_states' }));
                return;
            }
            if (message.type === 'result' && message.id === haGetStatesId && Array.isArray(message.result)) {
                for (const s of message.result) {
                    if (!s?.entity_id) continue;
                    if (HA_FILTER_ENTITIES.length === 0 || !HA_FILTER_ENTITIES.includes(s.entity_id)) continue;
                    broadcast({
                        action: 'update',
                        payload: {
                            entity: s.entity_id,
                            state: s.state,
                            attributes: s.attributes,
                        },
                    });
                }
                return;
            }
            if (message.type === 'event' && message.event?.data?.entity_id) {
                const { entity_id, new_state } = message.event.data;
                if (!new_state) return;
                if (HA_FILTER_ENTITIES.length === 0 || !HA_FILTER_ENTITIES.includes(entity_id)) return;
                broadcast({
                    action: 'update',
                    payload: {
                        entity: entity_id,
                        state: new_state.state,
                        attributes: new_state.attributes,
                    },
                });
            }
        });
        haSocket.on('close', () => {
            console.log('Disconnected from Home Assistant, reconnecting in 5s...');
            setTimeout(connectToHA, 5000);
        });
        haSocket.on('error', (err) => console.error('Home Assistant WebSocket Error:', err));
    }

    if (HA_ENABLED) {
        console.log('Home Assistant sensor forwarding enabled');
        connectToHA();
    } else {
        console.log('Home Assistant sensor forwarding disabled (HA_URL and HA_TOKEN not configured)');
    }

    function close() {
        if (dataReloadTimer) clearTimeout(dataReloadTimer);
        if (dataWatcher) dataWatcher.close();
        if (orchestrator) orchestrator.close();
        if (mqtt) mqtt.close();
        if (haSocket) {
            haSocket.removeAllListeners('close');
            try { haSocket.close(); } catch (_) { /* ignore */ }
        }
        wss.clients.forEach((client) => { try { client.terminate(); } catch (_) { /* ignore */ } });
        wss.close();
    }

    return { broadcast, close, orchestrator, mqtt };
}

module.exports = { setupBroker };
