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
const { pickEnv, loadConfig } = require('@roboframe/shared');
const { createOrchestrator } = require('./orchestrator');
const { createMqttBridge } = require('./mqtt-bridge');

function setupBroker({ server, app, config, dataPath, search, reshuffle, incrementDisplayCount, imageCache, prefetcher, prefetchVariant, expandBlockedTags }) {
    const srv = config.server || {};
    const ha = srv.ha || {};
    const mqttCfg = srv.mqtt || {};

    // ±window the orchestrator expands a client's raw aspect ratio into.
    // Live-reloadable: the config watcher below updates `ratioWindow` and
    // requeries active channels, so a roboframe.config.json edit takes effect
    // without a restart. env > config > default, re-evaluated on each reload.
    function readRatioWindow(cfg) {
        return pickEnv('SLIDESHOW_RATIO_WINDOW', cfg?.server?.slideshow?.ratioWindow, 0.15, { type: 'number' });
    }
    let ratioWindow = readRatioWindow(config);

    // When enabled, the active tag-list index and mod tags become a single
    // global selection shared by every channel regardless of deviceId — see
    // orchestrator's shared-tag mode. Distinct from displaySync (which merges
    // playback frames). Live-reloadable like ratioWindow.
    function readSharedTags(cfg) {
        return pickEnv('SLIDESHOW_SHARED_TAGS', cfg?.server?.slideshow?.sharedTags, false, { type: 'boolean' });
    }
    let sharedTags = readSharedTags(config);

    // Readiness-barrier fallback budget (ms). A client that stays on the
    // socket but stops sending `imageReady` — a frozen render loop, not a dead
    // socket — would otherwise park its channel on one frame indefinitely. If
    // no expected session reports within this budget the orchestrator promotes
    // the frame anyway and logs the laggards. 0 disables (park forever, the
    // old behaviour). Per-channel, so it keys on deviceId. Live-reloadable;
    // takes effect on the next loading phase, no requery needed.
    function readReadyTimeout(cfg) {
        return pickEnv('SLIDESHOW_READY_TIMEOUT_MS', cfg?.server?.slideshow?.readyTimeoutMs, 15000, { type: 'number' });
    }
    let readyTimeout = readReadyTimeout(config);

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
    // deviceId → { sources: Map<ws, {visible, at}>, aggregate, lastChangedAt }
    // Visibility is OR-ed across every ws reporting for the same deviceId so
    // two reporters on one device (browser kiosk + visionOS viewer, or PIR
    // agent + foreground app) can't fight: as long as ANY of them reports
    // visible:true the device is treated as visible. Aggregate flips drive
    // both the orchestrator pause/resume and the HA motion publish.
    const visibilityStates = {};
    const haStates = {};                   // entity_id → last `update` message
    const deviceWs = new Map();            // deviceId → ws (most recent kiosk for that ID)
    const wsDeviceIds = new WeakMap();     // ws → Set<deviceId> claimed by this ws
    const deviceRefcount = new Map();      // deviceId → count of live ws that have claimed it

    // Track every (ws, deviceId) association in one place so the close handler
    // can announce a `displayDisconnect` for each deviceId this ws was the
    // most recent reporter for.
    // Recompute aggregate visibility for a deviceId from its per-ws sources.
    // Returns the new aggregate if it changed (so the caller can fan out to
    // orchestrator/MQTT/peers), or null when unchanged.
    function recomputeVisibility(deviceId) {
        const state = visibilityStates[deviceId];
        if (!state) return null;
        let agg = false;
        for (const v of state.sources.values()) {
            if (v.visible) { agg = true; break; }
        }
        if (agg === state.aggregate) return null;
        state.aggregate = agg;
        state.lastChangedAt = Date.now();
        return agg;
    }

    function attachDeviceId(ws, deviceId) {
        if (typeof deviceId !== 'string' || !deviceId) return;
        let set = wsDeviceIds.get(ws);
        if (!set) { set = new Set(); wsDeviceIds.set(ws, set); }
        if (!set.has(deviceId)) {
            set.add(deviceId);
            const prev = deviceRefcount.get(deviceId) || 0;
            deviceRefcount.set(deviceId, prev + 1);
            if (prev === 0) mqtt.publishConnected(deviceId, true);
        }
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

    // ----- Device telemetry (reportMetrics / reportLog) --------------------
    // Append-only JSONL sink for client device telemetry, emitted by
    // web frontend JS and Spatialshash slideshows. Kept separate from
    // data.json — that file is hand-editable config; this is high-volume
    // machine output. Rotated at ~5 MB to a single .1 backup so it can't
    // grow unbounded. See docs/protocol.md `reportMetrics` / `reportLog`.
    const telemetryPath = path.join(path.dirname(dataPath), 'telemetry.jsonl');
    const TELEMETRY_MAX_BYTES = 5 * 1024 * 1024;
    function appendTelemetry(kind, payload) {
        try {
            const line = JSON.stringify({ kind, recvTs: Date.now(), ...payload }) + '\n';
            try {
                const st = fs.statSync(telemetryPath);
                if (st.size + Buffer.byteLength(line) > TELEMETRY_MAX_BYTES) {
                    fs.renameSync(telemetryPath, telemetryPath + '.1');
                }
            } catch { /* not created yet — first write makes it */ }
            fs.appendFileSync(telemetryPath, line);
        } catch (err) {
            console.warn(`Failed to append telemetry: ${err.message}`);
        }
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

    // Add an id to the server-only blocklist. Persists it, evicts any cached
    // variant, and kicks the orchestrator to drop it from every channel's
    // queue. Shared by the WS `block` action and the HTTP /block route.
    // Returns true if the id was newly blocked, false if already present.
    function blockPostId(id) {
        if (!id) return false;
        const blocked = getBlockedPosts();
        if (blocked.includes(id)) return false;
        blocked.push(id);
        saveBlockedIds(blocked);
        console.log(`Blocked post ID: ${id}`);
        if (imageCache) imageCache.evictPost(id);
        if (orchestrator) orchestrator.notifyBlockedChange();
        return true;
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
                    if (imageCache) {
                        for (const id of current.blockedIds) imageCache.evictPost(id);
                    }
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
    // Per-deviceId visibility lookup for the prefetcher: skip warming
    // variants for displays whose panel is off — the kiosk's slideshow is
    // paused there and we'd just heat the LRU with stale work.
    function getVisibility(deviceId) {
        const state = visibilityStates[deviceId];
        if (!state) return true;
        return state.aggregate;
    }

    const orchestrator = search ? createOrchestrator({
        search,
        // Default seed for a new channel's currentTagsList. The active index
        // lives on each channel — see orchestrator.setTagList — so this is
        // only consulted when a channel is first created.
        getCurrentTagsList: () => 0,
        getTagLists,
        getBlockedIds: getBlockedPosts,
        getBlockedTags,
        ...(expandBlockedTags ? { expandBlockedTags } : {}),
        reshuffle,
        incrementDisplayCount,
        prefetcher,
        imageCache,
        prefetchVariant,
        getVisibility,
        getRatioWindow: () => ratioWindow,
        getSharedTags: () => sharedTags,
        getReadyTimeout: () => readyTimeout,
    }) : null;

    // ----- Config watcher: hot-reload tunables -----------------------------
    // Re-read roboframe.config.json on change and apply the slideshow
    // tunables that are safe to swap live (ratioWindow, sharedTags,
    // readyTimeoutMs); structural settings (tokens, ports, paths) still
    // require a restart.
    let configReloadTimer = null;
    const configPath = config.configPath;
    if (configPath) {
        try {
            fs.watch(configPath, () => {
                if (configReloadTimer) clearTimeout(configReloadTimer);
                configReloadTimer = setTimeout(() => {
                    let fresh;
                    try { fresh = loadConfig({ reload: true }); }
                    catch (err) { console.warn(`Reload of ${configPath} failed: ${err.message}`); return; }
                    const next = readRatioWindow(fresh);
                    const nextShared = readSharedTags(fresh);
                    let requery = false;
                    if (next !== ratioWindow) {
                        console.log(`${configPath} changed; ratioWindow ${ratioWindow} -> ${next}`);
                        ratioWindow = next;
                        requery = true;
                    }
                    if (nextShared !== sharedTags) {
                        console.log(`${configPath} changed; sharedTags ${sharedTags} -> ${nextShared}`);
                        sharedTags = nextShared;
                        requery = true;
                    }
                    // readyTimeout is read live by the orchestrator on each
                    // loading phase — no requery, just swap the value.
                    const nextReady = readReadyTimeout(fresh);
                    if (nextReady !== readyTimeout) {
                        console.log(`${configPath} changed; readyTimeoutMs ${readyTimeout} -> ${nextReady}`);
                        readyTimeout = nextReady;
                    }
                    if (requery && orchestrator) orchestrator.requeryAll();
                }, 50);
            });
        } catch (err) {
            console.warn(`Could not watch ${configPath}: ${err.message}`);
        }
    }

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
                // Drop this ws's visibility contributions before announcing
                // departure so the aggregate reflects only still-connected
                // reporters. If removing it flips the aggregate to false,
                // fan out the same way as an inbound visibility report.
                for (const deviceId of claimed) {
                    const vstate = visibilityStates[deviceId];
                    if (!vstate || !vstate.sources.has(ws)) continue;
                    vstate.sources.delete(ws);
                    const aggregate = recomputeVisibility(deviceId);
                    if (aggregate !== null) {
                        mqtt.publishMotion(deviceId, aggregate);
                        if (orchestrator) orchestrator.notifyVisibility(deviceId, aggregate);
                    }
                }
                for (const deviceId of claimed) {
                    const prev = deviceRefcount.get(deviceId) || 0;
                    if (prev <= 1) {
                        deviceRefcount.delete(deviceId);
                        mqtt.publishConnected(deviceId, false);
                    } else {
                        deviceRefcount.set(deviceId, prev - 1);
                    }
                }
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
                blockPostId(payload?.id);

            } else if (action === 'getDisplayState' && payload?.target) {
                // Echo only the cached panel `displayState` (it carries
                // `state`, including a PIR/HA-driven `off`). Page-visibility is
                // a separate concept tracked via the `visibility` action;
                // folding `visible`/`visibilitySince` into a displayState frame
                // produced a `state`-less message that clients read as
                // `off=false` and used to re-enable a panel PIR had turned off.
                const lastMessage = displayStates[payload.target];
                if (lastMessage) {
                    ws.send(JSON.stringify(lastMessage));
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
                attachDeviceId(ws, deviceId);
                let state = visibilityStates[deviceId];
                if (!state) {
                    state = { sources: new Map(), aggregate: false, lastChangedAt: 0 };
                    visibilityStates[deviceId] = state;
                }
                state.sources.set(ws, { visible, at: Date.now() });
                const aggregate = recomputeVisibility(deviceId);
                if (aggregate !== null) {
                    mqtt.publishMotion(deviceId, aggregate);
                    if (orchestrator) orchestrator.notifyVisibility(deviceId, aggregate);
                    if (!aggregate) {
                        const lastState = displayStates[deviceId]?.payload?.state;
                        if (lastState === 'on' || lastState === true) {
                            broadcast({
                                action: 'displayState',
                                payload: { target: deviceId, state: 'off' },
                            }, ws);
                            mqtt.publishLight(deviceId, { state: 'off' });
                        }
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

            } else if (action === 'reportMetrics') {
                // Device → broker: periodic process-wide memory/state sample
                // (web kiosk JS errors or Spatialstash). Appended to telemetry.jsonl
                // for diagnosing multi-window slideshow memory pressure during
                // live playback. Not part of the slideshow loop.
                const deviceId = payload?.deviceId;
                if (typeof deviceId === 'string') {
                    attachDeviceId(ws, deviceId);
                    appendTelemetry('metrics', payload);
                }

            } else if (action === 'reportLog') {
                // Device → broker: event-driven diagnostic log line (memory
                // warnings, working-set trims, oversized-decode guard hits).
                // Paired with reportMetrics; appended to telemetry.jsonl and
                // echoed to stdout so it shows up alongside server logs.
                const deviceId = payload?.deviceId;
                if (typeof deviceId === 'string') {
                    attachDeviceId(ws, deviceId);
                    appendTelemetry('log', payload);
                    const lvl = String(payload?.level || 'info');
                    console.log(`[device ${deviceId}] ${lvl}: ${payload?.message || ''}`);
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
                    orchestrator.notifyImageReady(ws, sessionId, payload.id, payload.durationMs);
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

    // Block a post from HTTP — the kiosk-tier counterpart to the WS `block`
    // action, used by the /history page's Block button. Accepts either token
    // tier (same as the WS action, which is allowed on the access tier).
    app.get('/block', (req, res) => {
        const token = req.query.token || req.headers['x-roboframe-token'] || '';
        if (token !== accessToken && token !== rpcToken) {
            return res.status(401).send('Unauthorized: invalid or missing token');
        }
        const id = Number(req.query.id) || 0;
        if (!id) return res.status(400).send('Missing post ID');
        blockPostId(id);
        return res.status(200).send('Post blocked');
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

    return {
        broadcast, close, orchestrator, mqtt,
        getTagLists, getRatioWindow: () => ratioWindow,
        getBlockedPosts, getBlockedTags,
        getSharedTags: () => sharedTags,
    };
}

module.exports = { setupBroker };
