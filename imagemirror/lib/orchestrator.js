'use strict';
//
// Server-driven slideshow orchestrator (per-display channels).
//
// One channel per `deviceId`. Sessions joining a channel render the same
// queue and advance in lockstep. A channel is created when the first session
// for that deviceId calls `slideshowConfig`; it lingers in a 2-minute grace
// window when its last session leaves and is fully evicted at end-of-grace
// (unless a session reconnects in time).
//
// Cadence is gated on a readiness barrier: after a `playback` frame is sent,
// the channel waits until every visible session reports `imageReady { id }`
// for the new image (or 10 s elapses, whichever comes first) before starting
// the dwell-time interval timer. Sessions on hidden displays are auto-ready
// — they wouldn't render the image anyway — so they don't stall the barrier.
//
// Visibility for a deviceId pauses/resumes the dwell timer using a wall-clock
// deadline (`dwellDeadline`). It never resets the deadline.
//
// `displaySync` merges every channel into one for the duration of the claim.
// While merged, the driver's channel broadcasts to every session regardless
// of deviceId, and the readiness barrier waits on every visible session
// across all channels. Non-driver channels' timers are paused.
//
// Sessions and the wire protocol — see docs/protocol.md for the full surface.
// Each WS connection can host multiple logical *sessions*, addressed by a
// per-message `sessionId`. The orchestrator's session key is `(ws, sessionId)`,
// and a single ws can have sessions in multiple channels at once. This is
// what lets one Spatialstash app instance multiplex several remote-viewer
// windows over a single TCP/TLS path.
//
//   slideshowConfig { sessionId, deviceId, interval, ratio, width, height, bright, convert, modTags? }
//   setModTags      { sessionId, tags }
//   setTagList      { sessionId, listNumber }
//   requestNext     { sessionId }
//   reshuffle       { sessionId }
//   imageReady      { sessionId, id }
//   displaySync     { sessionId, enabled }
//
// Server → clients (session-scoped):
//   playback { sessionIds: [...], payload: { deviceId, mergeDriver, interval,
//                                            currentList, modTags, current,
//                                            next, upcoming[] } }
//   The `sessionIds` array carries every session on the receiving ws that
//   belongs to this channel. One frame can therefore satisfy N sessions
//   when multiple windows on one device share a connection.

function createOrchestrator({
    search,
    getCurrentTagsList,
    getTagLists,
    getBlockedIds = () => [],
    getBlockedTags = () => [],
    reshuffle,
    incrementDisplayCount,
}) {
    const UPCOMING_COUNT = 4;
    const MIN_QUEUE_SIZE = 1 + UPCOMING_COUNT;
    const REFILL_FETCH_SIZE = Math.max(5, MIN_QUEUE_SIZE * 2);
    const READINESS_TIMEOUT_MS = 10000;
    const DEFAULT_INTERVAL_MS = 15000;
    const MIN_INTERVAL_MS = 2000;
    const MAX_INTERVAL_MS = 3600000;
    // How long an empty channel lingers before it's torn down. A
    // disconnecting visionOS window — sleep/wake or transient network —
    // will reconnect well within this window, so its channel state
    // (queue, mod tags, interval, displaySync claim, currentId) survives
    // the round-trip and the client doesn't have to replay slideshowConfig
    // to re-bind. Fully empties (server-driven cleanup) still happen, just
    // delayed.
    const CHANNEL_GRACE_MS = 2 * 60 * 1000;
    // How often the watchdog checks for channels that wedged in `idle` with
    // an empty queue (first refill returned nothing, transient DB error,
    // etc.) and re-attempts the refill so the slideshow recovers without
    // an external nudge.
    const IDLE_REFILL_INTERVAL_MS = 15000;

    const channels = new Map();           // deviceId → channel
    // Stable per-ws id used to build session keys. Stored on the ws object
    // itself — the ws is the source of truth, we don't need a separate
    // Map keeping it alive past close.
    let wsIdCounter = 0;
    function ensureWsId(ws) {
        if (!ws.__rfWsId) ws.__rfWsId = `w${++wsIdCounter}`;
        return ws.__rfWsId;
    }
    function sessionKeyOf(ws, sessionId) {
        return `${ensureWsId(ws)}:${sessionId}`;
    }

    // (ws, sessionId) → { ws, sessionId, channel, params, modTags }
    const sessionsByKey = new Map();
    // ws → Set<sessionKey>; lets us drop every session for a ws on close.
    const wsSessions = new Map();
    const visibility = new Map();         // deviceId → boolean (true if no report)
    // displaySync merge is tracked as a property of the *driver channel*,
    // not a specific ws or session. All sessions on the driver channel are
    // considered equal — any of them can release. Original claimer leaving
    // doesn't tear down the merge; only the driver channel itself going
    // fully empty (after grace) does.
    let mergeDriverChannel = null;

    function makeChannel(deviceId) {
        return {
            deviceId,
            // sessionKey → { ws, sessionId, params, modTags } (modTags also
            // mirrored on `channel.modTags` — last-write-wins, see register).
            sessions: new Map(),
            queue: [],                   // [{ id, ext }]
            // Seed each channel at a random point in random_ranks order so
            // two channels coming up at the same time don't show the same
            // dc=0 head of the queue. Deterministic queries ignore this
            // shape (they read cursor.offset, which is absent here → 0).
            cursor: { dc: 0, rank: Math.random() },
            modTags: [],
            // Index into getTagLists() that this channel uses for its base
            // tags. Per-channel so two displays can run different lists
            // independently; defaults to whatever getCurrentTagsList() seeds
            // (0 in production, anything tests pass).
            currentTagsList: (() => {
                const n = Number(getCurrentTagsList ? getCurrentTagsList() : 0);
                return Number.isFinite(n) && n >= 0 ? n : 0;
            })(),
            interval: DEFAULT_INTERVAL_MS,
            currentId: null,
            // Readiness barrier for the current image. expectedReady is
            // the set of sessionKeys snapshotted when we last advanced;
            // ready accumulates as those sessions send `imageReady`. Hidden
            // sessions are auto-included so they don't stall the barrier.
            expectedReady: new Set(),
            ready: new Set(),
            phase: 'idle',               // 'idle' | 'loading' | 'displaying'
            timer: null,
            readinessTimer: null,
            // Wall-clock deadline for the dwell timer. Set when entering
            // 'displaying'; survives visibility-driven pauses.
            dwellDeadline: null,
            // In-flight refill promise; coalesces concurrent refillQueue
            // callers onto a single search round-trip.
            refillPromise: null,
            // Bumped whenever the query context changes (modTags / tagList /
            // explicit clearAndRefill). Any in-flight refill that captured an
            // older generation discards its results instead of polluting the
            // freshly-cleared queue with stale-query rows.
            refillGen: 0,
            lastDisplayedId: null,
            // Set when sessions hit zero; cleared if a session rejoins
            // before it fires. On expiry the channel is fully evicted
            // (and a held merge claim is released).
            teardownTimer: null,
        };
    }

    function getOrCreateChannel(deviceId) {
        let ch = channels.get(deviceId);
        if (!ch) {
            ch = makeChannel(deviceId);
            channels.set(deviceId, ch);
        }
        return ch;
    }

    function isMergeActive() {
        return mergeDriverChannel !== null;
    }

    function deviceVisible(deviceId) {
        // Default to visible; only an explicit `visible: false` report pauses.
        return visibility.get(deviceId) !== false;
    }

    function sessionVisible(sessionKey) {
        const sess = sessionsByKey.get(sessionKey);
        return sess ? deviceVisible(sess.channel.deviceId) : true;
    }

    function channelActive(channel) {
        if (isMergeActive() && channel === mergeDriverChannel) {
            return deviceVisible(mergeDriverChannel.deviceId);
        }
        return deviceVisible(channel.deviceId);
    }

    function snapshot(channel) {
        const upcoming = channel.queue.slice(1, 1 + UPCOMING_COUNT);
        return {
            deviceId: channel.deviceId,
            mergeDriver: isMergeActive() ? mergeDriverChannel.deviceId : null,
            interval: channel.interval,
            currentList: channel.currentTagsList,
            modTags: channel.modTags.slice(),
            current: channel.queue[0] || null,
            next: upcoming[0] || null,
            upcoming,
        };
    }

    // Targets for a channel's playback frame. While merged, the driver
    // channel's frame goes to every session across all channels; non-driver
    // channels are silenced (their members hear the driver instead).
    function broadcastTargets(channel) {
        if (isMergeActive()) {
            if (channel !== mergeDriverChannel) return [];
            const all = [];
            for (const c of channels.values()) {
                for (const key of c.sessions.keys()) all.push(key);
            }
            return all;
        }
        return Array.from(channel.sessions.keys());
    }

    function expectedReadersFor(channel) {
        // Hidden sessions are auto-ready: their displays won't render
        // while hidden, so demanding an imageReady from them would stall
        // every cycle for the full 10 s timeout.
        const targets = broadcastTargets(channel).filter(sessionVisible);
        return new Set(targets);
    }

    // Group session keys by their owning ws so a single send call
    // delivers one playback frame per ws (carrying every sessionId on
    // that ws that belongs to this channel).
    function groupKeysByWs(keys) {
        const byWs = new Map();
        for (const key of keys) {
            const sess = sessionsByKey.get(key);
            if (!sess) continue;
            let arr = byWs.get(sess.ws);
            if (!arr) { arr = []; byWs.set(sess.ws, arr); }
            arr.push(sess.sessionId);
        }
        return byWs;
    }

    function broadcastPlayback(channel) {
        const targets = broadcastTargets(channel);
        if (targets.length === 0) return;
        const payload = snapshot(channel);
        if (payload.current && payload.current.id !== channel.lastDisplayedId) {
            channel.lastDisplayedId = payload.current.id;
            if (incrementDisplayCount) incrementDisplayCount(payload.current.id);
        }
        const byWs = groupKeysByWs(targets);
        for (const [ws, sessionIds] of byWs) {
            const data = JSON.stringify({ action: 'playback', sessionIds, payload });
            try { ws.send(data); } catch (_) { /* socket gone */ }
        }
    }

    function sendPlaybackTo(sessionKey, channel) {
        const sess = sessionsByKey.get(sessionKey);
        if (!sess) return;
        try {
            sess.ws.send(JSON.stringify({
                action: 'playback',
                sessionIds: [sess.sessionId],
                payload: snapshot(channel),
            }));
        } catch (_) { /* socket gone */ }
    }

    function buildQuery(channel) {
        const lists = getTagLists();
        const idx = channel.currentTagsList;
        const baseTags = Array.isArray(lists[idx]) ? lists[idx].slice() : [];
        const all = baseTags.concat(channel.modTags || []).filter(Boolean);
        return all.join(' ');
    }

    function isPostBlocked(post, blockedIdSet, blockedTagSet) {
        if (blockedIdSet.has(Number(post._id))) return true;
        if (blockedTagSet.size === 0) return false;
        const tags = Array.isArray(post.tags) ? post.tags : [];
        for (const tag of tags) {
            if (blockedTagSet.has(String(tag))) return true;
        }
        return false;
    }

    function refillQueue(channel, opts = {}) {
        if (channel.refillPromise) return channel.refillPromise;
        const minSize = opts.minSize ?? MIN_QUEUE_SIZE;
        if (channel.queue.length >= minSize) return Promise.resolve();
        const p = runRefill(channel, opts).finally(() => { channel.refillPromise = null; });
        channel.refillPromise = p;
        return p;
    }

    async function runRefill(channel, { minSize = MIN_QUEUE_SIZE, fetchSize = REFILL_FETCH_SIZE } = {}) {
        const startedEmpty = channel.queue.length === 0;
        let totalResults = 0;
        let lastQuery = '';
        try {
            let attempts = 0;
            let wrapped = false;
            while (channel.queue.length < minSize && attempts < 6) {
                const q = buildQuery(channel);
                lastQuery = q;
                const gen = channel.refillGen;
                const { results, nextCursor } = await search.runSearch({ q, cursor: channel.cursor, limit: fetchSize });
                // If clearAndRefill ran while we were awaiting, the query
                // context has changed under us — drop these results instead
                // of pushing stale-query rows into the cleared queue.
                if (channel.refillGen !== gen) return;
                totalResults += results.length;
                const beforeLen = channel.queue.length;
                const present = new Set(channel.queue.map((e) => e.id));
                const blockedIdSet = new Set((getBlockedIds() || []).map(Number));
                const blockedTagSet = new Set((getBlockedTags() || []).map(String));
                for (const post of results) {
                    if (!post || !post._id) continue;
                    const id = Number(post._id);
                    if (present.has(id)) continue;
                    if (isPostBlocked(post, blockedIdSet, blockedTagSet)) continue;
                    present.add(id);
                    channel.queue.push({ id, ext: String(post.file_ext || '') });
                }
                const added = channel.queue.length - beforeLen;
                channel.cursor = nextCursor || null;
                attempts += 1;

                if (added === 0 && !channel.cursor) break;
                if (!channel.cursor) {
                    if (wrapped) break;
                    wrapped = true;
                }
            }
        } catch (err) {
            console.warn(`[orchestrator] refill failed (${channel.deviceId}): ${err.message}`);
        }
        // Surface "no matches" for an active tag query so the user can tell a
        // stuck slideshow apart from a typo'd tag set. Only fire when we
        // started from an empty queue *and* the query returned zero rows.
        if (startedEmpty && totalResults === 0 && lastQuery && channel.queue.length === 0) {
            console.warn(`[orchestrator] search returned 0 results (${channel.deviceId}): q="${lastQuery}"`);
            broadcastSearchEmpty(channel, lastQuery);
        }
    }

    function broadcastSearchEmpty(channel, query) {
        const targets = broadcastTargets(channel);
        if (targets.length === 0) return;
        const byWs = groupKeysByWs(targets);
        for (const [ws, sessionIds] of byWs) {
            const data = JSON.stringify({ action: 'searchEmpty', sessionIds, payload: { query } });
            try { ws.send(data); } catch (_) { /* socket gone */ }
        }
    }

    async function clearAndRefill(channel) {
        channel.queue.length = 0;
        channel.cursor = null;
        channel.refillGen += 1;
        if (search?.clearCache) search.clearCache();
        // Wait for any in-flight refill to drain so its (aborted) results
        // can't race ahead of ours. The gen bump above guarantees that
        // refill's results have been discarded.
        if (channel.refillPromise) {
            try { await channel.refillPromise; } catch (_) { /* errors already logged */ }
        }
        return refillQueue(channel);
    }

    function clearReadiness(channel) {
        channel.expectedReady = new Set();
        channel.ready = new Set();
        if (channel.readinessTimer) {
            clearTimeout(channel.readinessTimer);
            channel.readinessTimer = null;
        }
    }

    function stopDwellTimer(channel) {
        if (channel.timer) {
            clearTimeout(channel.timer);
            channel.timer = null;
        }
    }

    function scheduleDwell(channel) {
        stopDwellTimer(channel);
        if (!channelActive(channel)) return;
        if (!channel.dwellDeadline) return;
        const remaining = channel.dwellDeadline - Date.now();
        if (remaining <= 0) {
            advance(channel);
            return;
        }
        channel.timer = setTimeout(() => {
            channel.timer = null;
            advance(channel);
        }, remaining);
    }

    function startTimerIfReady(channel) {
        if (channel.phase !== 'loading') return;
        for (const key of channel.expectedReady) {
            if (!channel.ready.has(key)) return;
        }
        promoteToDisplaying(channel);
    }

    function promoteToDisplaying(channel) {
        channel.phase = 'displaying';
        if (channel.readinessTimer) {
            clearTimeout(channel.readinessTimer);
            channel.readinessTimer = null;
        }
        channel.dwellDeadline = Date.now() + Math.max(MIN_INTERVAL_MS, channel.interval);
        scheduleDwell(channel);
    }

    function armReadinessTimeout(channel) {
        if (channel.readinessTimer) clearTimeout(channel.readinessTimer);
        channel.readinessTimer = setTimeout(() => {
            channel.readinessTimer = null;
            // Bad-network fallback: anyone who hasn't reported by now is
            // treated as ready so the channel doesn't stall forever.
            if (channel.phase === 'loading') promoteToDisplaying(channel);
        }, READINESS_TIMEOUT_MS);
    }

    async function advance(channel) {
        if (channel.queue.length > 0) channel.queue.shift();
        await refillQueue(channel);
        commitCurrent(channel);
    }

    function commitCurrent(channel) {
        const current = channel.queue[0] || null;
        channel.currentId = current ? current.id : null;
        clearReadiness(channel);
        channel.expectedReady = expectedReadersFor(channel);
        channel.dwellDeadline = null;
        stopDwellTimer(channel);
        if (channel.currentId === null) {
            channel.phase = 'idle';
            broadcastPlayback(channel);
            return;
        }
        channel.phase = 'loading';
        broadcastPlayback(channel);
        if (channel.expectedReady.size === 0) {
            // No visible readers — short-circuit straight to displaying so
            // the channel's wall-clock keeps advancing even when every
            // display on the channel is dark.
            promoteToDisplaying(channel);
        } else {
            armReadinessTimeout(channel);
        }
    }

    // ----- public API ------------------------------------------------------

    function register(ws, sessionId, payload = {}) {
        if (typeof sessionId !== 'string' || !sessionId) {
            console.warn('[orchestrator] slideshowConfig without sessionId; ignoring');
            return;
        }
        const deviceId = String(payload.deviceId || '');
        if (!deviceId) {
            console.warn('[orchestrator] slideshowConfig without deviceId; ignoring');
            return;
        }
        const key = sessionKeyOf(ws, sessionId);
        const existing = sessionsByKey.get(key);
        // Move session between channels if its deviceId changed.
        if (existing && existing.channel.deviceId !== deviceId) {
            removeSession(key);
        }
        const channel = getOrCreateChannel(deviceId);
        // Reconnect within the grace window: cancel teardown so we keep
        // queue / modTags / interval / currentId / merge claim. Existing
        // dwellDeadline (if any) is invalidated below by commitCurrent's
        // reset path, so the slideshow restarts the readiness barrier
        // for the same image rather than firing immediately.
        if (channel.teardownTimer) {
            clearTimeout(channel.teardownTimer);
            channel.teardownTimer = null;
        }
        const sess = sessionsByKey.get(key) || { ws, sessionId, channel, modTags: [] };
        sess.ws = ws;
        sess.sessionId = sessionId;
        sess.channel = channel;
        sess.params = {
            interval: clampInterval(payload.interval),
            ratio: payload.ratio || null,
            width: numberOrNull(payload.width),
            height: numberOrNull(payload.height),
            bright: !!payload.bright,
            convert: !!payload.convert,
        };
        if (Array.isArray(payload.modTags)) {
            sess.modTags = payload.modTags.map(String).filter(Boolean);
        }
        sessionsByKey.set(key, sess);
        channel.sessions.set(key, sess);
        let wsKeys = wsSessions.get(ws);
        if (!wsKeys) { wsKeys = new Set(); wsSessions.set(ws, wsKeys); }
        wsKeys.add(key);

        // Last-write-wins on per-channel knobs. Merging differing intervals
        // across two displays of the same deviceId is a misconfig anyway;
        // pick the latest joiner's value.
        channel.interval = sess.params.interval;
        if (sess.modTags.length) channel.modTags = sess.modTags.slice();

        const isFirstSession = channel.sessions.size === 1;
        // While merged, point the new session at the driver channel's
        // playback so it joins the merged audience immediately.
        const playbackSource = isMergeActive() ? mergeDriverChannel : channel;
        sendPlaybackTo(key, playbackSource);

        if (isFirstSession) {
            if (channel.queue.length === 0) {
                refillQueue(channel).then(() => {
                    if (isMergeActive() && channel !== mergeDriverChannel) return;
                    commitCurrent(channel);
                });
            } else if (!isMergeActive() || channel === mergeDriverChannel) {
                commitCurrent(channel);
            }
        } else {
            // Existing channel — fold the new session into the readiness
            // barrier for the current image if we're still loading and
            // the session is visible.
            const target = isMergeActive() ? mergeDriverChannel : channel;
            if (target.phase === 'loading' && sessionVisible(key)) {
                target.expectedReady.add(key);
            }
        }
    }

    function removeSession(key) {
        const sess = sessionsByKey.get(key);
        if (!sess) return;
        const { ws, channel } = sess;
        sessionsByKey.delete(key);
        channel.sessions.delete(key);
        channel.expectedReady.delete(key);
        channel.ready.delete(key);
        const wsKeys = wsSessions.get(ws);
        if (wsKeys) {
            wsKeys.delete(key);
            if (wsKeys.size === 0) wsSessions.delete(ws);
        }
        if (channel.sessions.size === 0) {
            // Last session left — pause cadence and start the grace
            // window. State (queue, modTags, interval, currentId, merge
            // claim) is preserved so a quick reconnect picks up where it
            // left off without replaying slideshowConfig.
            stopDwellTimer(channel);
            if (channel.readinessTimer) {
                clearTimeout(channel.readinessTimer);
                channel.readinessTimer = null;
            }
            scheduleChannelTeardown(channel);
        } else if (channel.phase === 'loading') {
            // Disconnect during the readiness barrier — re-check now that
            // the expected set is smaller.
            startTimerIfReady(channel);
        }
    }

    function scheduleChannelTeardown(channel) {
        if (channel.teardownTimer) clearTimeout(channel.teardownTimer);
        channel.teardownTimer = setTimeout(() => {
            channel.teardownTimer = null;
            if (channel.sessions.size > 0) return;
            evictChannel(channel);
        }, CHANNEL_GRACE_MS);
        if (typeof channel.teardownTimer.unref === 'function') {
            channel.teardownTimer.unref();
        }
    }

    function evictChannel(channel) {
        stopDwellTimer(channel);
        if (channel.readinessTimer) {
            clearTimeout(channel.readinessTimer);
            channel.readinessTimer = null;
        }
        channels.delete(channel.deviceId);
        if (channel === mergeDriverChannel) {
            // Driver channel actually went away. Release the merge so
            // remaining channels resume their own cadences.
            releaseMerge();
        }
    }

    /// Drop a single session from this ws (per-sessionId teardown).
    function unregisterSession(ws, sessionId) {
        if (typeof sessionId !== 'string' || !sessionId) return;
        const key = sessionKeyOf(ws, sessionId);
        removeSession(key);
    }

    /// Drop every session attached to a ws (typically called from the
    /// broker's `close` handler).
    function unregister(ws) {
        const wsKeys = wsSessions.get(ws);
        if (!wsKeys) return;
        // Iterate over a copy — removeSession mutates wsKeys via the
        // sessionsByKey deletion path.
        for (const key of Array.from(wsKeys)) removeSession(key);
        // Note: a ws closing does NOT release a held merge claim. Only
        // full eviction of the driver channel does that (after grace).
    }

    function setModTags(ws, sessionId, tags) {
        const key = sessionKeyOf(ws, sessionId);
        const sess = sessionsByKey.get(key);
        if (!sess) return;
        const channel = sess.channel;
        sess.modTags = Array.isArray(tags) ? tags.map(String).filter(Boolean) : [];
        // While merged, only sessions on the driver channel can change
        // mod tags. Audience channels are borrowed and shouldn't override
        // what the driver channel set. Within the driver channel any
        // session can change them — all sessions are equal peers.
        if (isMergeActive() && channel !== mergeDriverChannel) return;
        channel.modTags = sess.modTags.slice();
        clearAndRefill(channel).then(() => commitCurrent(channel));
    }

    function requestAdvance(ws, sessionId) {
        const key = sessionKeyOf(ws, sessionId);
        const sess = sessionsByKey.get(key);
        if (!sess) return;
        const target = isMergeActive() ? mergeDriverChannel : sess.channel;
        advance(target);
    }

    async function requestReshuffle(ws, sessionId) {
        const key = sessionKeyOf(ws, sessionId);
        const sess = sessionsByKey.get(key);
        if (!sess) return;
        if (reshuffle) {
            try { await reshuffle(); }
            catch (err) { console.warn(`[orchestrator] reshuffle failed: ${err.message}`); }
        }
        const target = isMergeActive() ? mergeDriverChannel : sess.channel;
        await clearAndRefill(target);
        commitCurrent(target);
    }

    function notifyImageReady(ws, sessionId, id) {
        const key = sessionKeyOf(ws, sessionId);
        const sess = sessionsByKey.get(key);
        if (!sess) return;
        const target = isMergeActive() ? mergeDriverChannel : sess.channel;
        if (target.phase !== 'loading') return;
        if (Number(id) !== Number(target.currentId)) return;
        if (!target.expectedReady.has(key)) return;
        target.ready.add(key);
        startTimerIfReady(target);
    }

    function notifyVisibility(deviceId, visible) {
        if (typeof deviceId !== 'string' || !deviceId) return;
        const prev = deviceVisible(deviceId);
        visibility.set(deviceId, !!visible);
        if (prev === !!visible) return;

        // Re-evaluate every channel touched by this deviceId. While merged,
        // only the driver channel is running, so we only have to react when
        // the driver's deviceId visibility flips.
        const affected = isMergeActive()
            ? (deviceId === mergeDriverChannel.deviceId ? [mergeDriverChannel] : [])
            : Array.from(channels.values()).filter((c) => c.deviceId === deviceId
                || broadcastTargets(c).some((k) => sessionsByKey.get(k)?.channel.deviceId === deviceId));

        for (const channel of affected) {
            if (channel.phase === 'loading') {
                channel.expectedReady = expectedReadersFor(channel);
                for (const key of Array.from(channel.ready)) {
                    if (!channel.expectedReady.has(key)) channel.ready.delete(key);
                }
                if (channel.expectedReady.size === 0) {
                    promoteToDisplaying(channel);
                } else {
                    startTimerIfReady(channel);
                }
            } else if (channel.phase === 'displaying') {
                if (channelActive(channel)) {
                    if (!channel.timer) scheduleDwell(channel);
                } else {
                    stopDwellTimer(channel);
                }
            }
        }
    }

    function setTagList(ws, sessionId, listNumber) {
        const key = sessionKeyOf(ws, sessionId);
        const sess = sessionsByKey.get(key);
        if (!sess) return;
        const channel = sess.channel;
        const n = Number(listNumber);
        if (!Number.isFinite(n) || n < 0) return;
        // While merged, only the driver channel's sessions can change the
        // active list. Audience channels are paused; honoring their request
        // would silently mutate state the driver doesn't know about.
        if (isMergeActive() && channel !== mergeDriverChannel) return;
        if (channel.currentTagsList === n) return;
        channel.currentTagsList = n;
        clearAndRefill(channel).then(() => commitCurrent(channel));
    }

    function notifyBlockedChange() {
        const blockedIdSet = new Set((getBlockedIds() || []).map(Number));
        const blockedTagSet = new Set((getBlockedTags() || []).map(String));
        for (const channel of channels.values()) {
            const before = channel.queue.length;
            channel.queue = channel.queue.filter((entry) => !blockedIdSet.has(Number(entry.id)));
            if (blockedTagSet.size > 0 && search?.clearCache) search.clearCache();
            if (isMergeActive() && channel !== mergeDriverChannel) continue;
            const dropped = channel.queue.length !== before;
            if (dropped) {
                refillQueue(channel).then(() => commitCurrent(channel));
            } else {
                refillQueue(channel);
            }
        }
    }

    function claimDisplaySync(ws, sessionId, enabled) {
        const key = sessionKeyOf(ws, sessionId);
        const sess = sessionsByKey.get(key);
        if (!sess) return;
        const channel = sess.channel;
        if (enabled) {
            if (mergeDriverChannel === channel) return;
            mergeDriverChannel = channel;
            for (const c of channels.values()) {
                if (c === channel) continue;
                stopDwellTimer(c);
                if (c.readinessTimer) {
                    clearTimeout(c.readinessTimer);
                    c.readinessTimer = null;
                }
                c.phase = 'idle';
                c.dwellDeadline = null;
            }
            channel.expectedReady = expectedReadersFor(channel);
            channel.ready = new Set();
            channel.phase = 'loading';
            broadcastPlayback(channel);
            if (channel.expectedReady.size === 0) promoteToDisplaying(channel);
            else armReadinessTimeout(channel);
        } else if (channel === mergeDriverChannel) {
            // Any session on the driver channel can release the merge.
            releaseMerge();
        }
    }

    function releaseMerge() {
        const wasDriver = mergeDriverChannel;
        mergeDriverChannel = null;
        if (!wasDriver) return;
        for (const channel of channels.values()) {
            if (channel === wasDriver) {
                channel.expectedReady = expectedReadersFor(channel);
                channel.ready = new Set();
                if (channel.currentId !== null) {
                    channel.phase = 'loading';
                    broadcastPlayback(channel);
                    if (channel.expectedReady.size === 0) promoteToDisplaying(channel);
                    else armReadinessTimeout(channel);
                } else {
                    channel.phase = 'idle';
                }
                continue;
            }
            if (channel.queue.length === 0) {
                refillQueue(channel).then(() => commitCurrent(channel));
            } else {
                commitCurrent(channel);
            }
        }
    }

    const idleRefillTimer = setInterval(() => {
        for (const channel of channels.values()) {
            if (channel.phase !== 'idle') continue;
            if (channel.queue.length > 0) continue;
            if (channel.refilling) continue;
            if (isMergeActive() && channel !== mergeDriverChannel) continue;
            refillQueue(channel).then(() => {
                if (channel.queue.length > 0) commitCurrent(channel);
            });
        }
    }, IDLE_REFILL_INTERVAL_MS);
    if (typeof idleRefillTimer.unref === 'function') idleRefillTimer.unref();

    function close() {
        clearInterval(idleRefillTimer);
        for (const channel of channels.values()) {
            stopDwellTimer(channel);
            if (channel.readinessTimer) {
                clearTimeout(channel.readinessTimer);
                channel.readinessTimer = null;
            }
            if (channel.teardownTimer) {
                clearTimeout(channel.teardownTimer);
                channel.teardownTimer = null;
            }
            channel.sessions.clear();
            channel.queue.length = 0;
        }
        channels.clear();
        sessionsByKey.clear();
        wsSessions.clear();
        mergeDriverChannel = null;
    }

    return {
        register,
        unregister,
        unregisterSession,
        setModTags,
        setTagList,
        requestAdvance,
        requestReshuffle,
        notifyImageReady,
        notifyVisibility,
        notifyBlockedChange,
        claimDisplaySync,
        close,
        // exposed for tests
        _channels: channels,
        _state: () => ({
            mergeDriverDeviceId: mergeDriverChannel?.deviceId || null,
            channels: Array.from(channels.values()).map((c) => ({
                deviceId: c.deviceId,
                phase: c.phase,
                currentId: c.currentId,
                queue: c.queue.slice(),
                sessionCount: c.sessions.size,
                expectedReady: c.expectedReady.size,
                ready: c.ready.size,
                hasTimer: !!c.timer,
                dwellRemaining: c.dwellDeadline ? c.dwellDeadline - Date.now() : null,
            })),
        }),
    };
}

function clampInterval(v) {
    const n = Number(v);
    if (!Number.isFinite(n)) return 15000;
    return Math.max(2000, Math.min(3600000, n));
}
function numberOrNull(v) {
    const n = Number(v);
    return Number.isFinite(n) ? n : null;
}

module.exports = { createOrchestrator };
