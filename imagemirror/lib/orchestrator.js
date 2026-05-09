'use strict';
//
// Server-driven slideshow orchestrator (per-display channels).
//
// One channel per `deviceId`. Sessions joining a channel render the same
// queue and advance in lockstep. A channel is created when the first session
// for that deviceId calls `slideshowConfig`; it disappears when the last
// session leaves (unless it's the merge driver — see displaySync below).
//
// Cadence is gated on a readiness barrier: after a `playback` frame is sent,
// the channel waits until every visible session reports `imageReady { id }`
// for the new image (or 10 s elapses, whichever comes first) before starting
// the dwell-time interval timer. Sessions on hidden displays are auto-ready
// — they wouldn't render the image anyway — so they don't stall the barrier.
//
// Visibility for a deviceId pauses/resumes the dwell timer using a wall-clock
// deadline (`dwellDeadline`). It never resets the deadline. This is the fix
// for "leaving and re-entering a room refreshes the 15 s interval forever":
// a wake just resumes the remaining time. If the dwell already expired while
// hidden, the next advance fires immediately on resume.
//
// `displaySync` merges every channel into one for the duration of the claim.
// While merged, the driver's channel broadcasts to every WS regardless of
// deviceId, and the readiness barrier waits on every visible WS across all
// channels. Non-driver channels' timers are paused. Releasing the claim
// unwinds the merge: each non-driver channel re-broadcasts and resumes its
// own cadence.
//
// Wire protocol (client → server):
//   slideshowConfig { deviceId, interval, ratio, width, height, bright, convert, modTags? }
//   setModTags      { tags: string[] }
//   requestNext     {}
//   imageReady      { id }                  // mark this session ready for `id`
//   displaySync     { enabled: boolean }    // claim/release merge driver
//   setTagList      { listNumber }          // change tag list (any client)
//   visibility      { deviceId, visible }   // pauses dwell when display off
//
// Server → clients:
//   playback { deviceId, mergeDriver, interval, currentList, modTags, current, next, upcoming[] }

function createOrchestrator({
    search,
    getCurrentTagsList,
    setCurrentTagsList,
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
    // How often the watchdog checks for channels that wedged in `idle` with an
    // empty queue (first refill returned nothing, transient DB error, etc.)
    // and re-attempts the refill so the slideshow recovers without needing
    // an external nudge.
    const IDLE_REFILL_INTERVAL_MS = 15000;

    const channels = new Map();           // deviceId → channel
    const wsToChannel = new Map();        // ws → channel
    const visibility = new Map();         // deviceId → boolean (true if no report)
    // displaySync merge is tracked as a property of the *driver channel*,
    // not a specific ws. All sessions on the driver channel are considered
    // equal — any of them can release. The original claimer leaving doesn't
    // tear down the merge; only the driver channel itself going fully empty
    // (after grace) does.
    let mergeDriverChannel = null;

    function makeChannel(deviceId) {
        return {
            deviceId,
            sessions: new Map(),         // ws → { params, modTags }
            queue: [],                   // [{ id, ext }]
            // Seed each channel at a random point in the random_ranks order so
            // two channels coming up at the same time don't show the same
            // dc=0 head of the queue. Deterministic queries ignore this shape
            // (they read cursor.offset, which is absent here → treated as 0).
            cursor: { dc: 0, rank: Math.random() },
            modTags: [],
            interval: DEFAULT_INTERVAL_MS,
            currentId: null,
            // Readiness barrier for the current image: `expectedReady` is the
            // set of ws snapshotted when we last advanced; `ready` accumulates
            // as those ws send `imageReady { id: currentId }`. Hidden ws are
            // auto-included in `ready` so they don't stall the barrier.
            expectedReady: new Set(),
            ready: new Set(),
            phase: 'idle',               // 'idle' | 'loading' | 'displaying'
            timer: null,
            readinessTimer: null,
            // Wall-clock deadline for the dwell timer. Set when entering
            // 'displaying'; survives visibility-driven pauses so a wake
            // resumes the remaining dwell rather than restarting it.
            dwellDeadline: null,
            refilling: false,
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

    function wsVisible(ws) {
        const ch = wsToChannel.get(ws);
        return ch ? deviceVisible(ch.deviceId) : true;
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
            currentList: getCurrentTagsList(),
            modTags: channel.modTags.slice(),
            current: channel.queue[0] || null,
            next: upcoming[0] || null,
            upcoming,
        };
    }

    // Targets for a channel's playback frame. While merged, the driver
    // channel broadcasts to every ws across all channels; non-driver channels
    // are silenced (their members hear the driver instead).
    function broadcastTargets(channel) {
        if (isMergeActive()) {
            if (channel !== mergeDriverChannel) return [];
            const all = [];
            for (const c of channels.values()) {
                for (const ws of c.sessions.keys()) all.push(ws);
            }
            return all;
        }
        return Array.from(channel.sessions.keys());
    }

    function expectedReadersFor(channel) {
        // Hidden ws are auto-ready: their kiosks won't render while hidden,
        // so demanding an imageReady from them would stall every cycle for
        // the full 10 s timeout.
        const targets = broadcastTargets(channel).filter(wsVisible);
        return new Set(targets);
    }

    function broadcastPlayback(channel) {
        const targets = broadcastTargets(channel);
        if (targets.length === 0) return;
        const payload = snapshot(channel);
        if (payload.current && payload.current.id !== channel.lastDisplayedId) {
            channel.lastDisplayedId = payload.current.id;
            if (incrementDisplayCount) incrementDisplayCount(payload.current.id);
        }
        const data = JSON.stringify({ action: 'playback', payload });
        for (const ws of targets) {
            try { ws.send(data); } catch (_) { /* socket gone */ }
        }
    }

    function sendPlaybackTo(ws, channel) {
        try {
            ws.send(JSON.stringify({ action: 'playback', payload: snapshot(channel) }));
        } catch (_) { /* socket gone */ }
    }

    function buildQuery(channel) {
        const lists = getTagLists();
        const idx = getCurrentTagsList();
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

    async function refillQueue(channel, { minSize = MIN_QUEUE_SIZE, fetchSize = REFILL_FETCH_SIZE } = {}) {
        if (channel.refilling) return;
        if (channel.queue.length >= minSize) return;
        channel.refilling = true;
        try {
            let attempts = 0;
            let wrapped = false;
            while (channel.queue.length < minSize && attempts < 6) {
                const q = buildQuery(channel);
                const { results, nextCursor } = await search.runSearch({ q, cursor: channel.cursor, limit: fetchSize });
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
        } finally {
            channel.refilling = false;
        }
    }

    function clearAndRefill(channel) {
        channel.queue.length = 0;
        channel.cursor = null;
        if (search?.clearCache) search.clearCache();
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
            // Dwell already expired (e.g., display was hidden long enough
            // for the deadline to pass). Advance now.
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
        for (const ws of channel.expectedReady) {
            if (!channel.ready.has(ws)) return;
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
            // treated as ready so the channel doesn't stall forever on a
            // wedged client.
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
            // display on the channel is dark. (When a display wakes, it
            // catches up to whatever is current at that moment.)
            promoteToDisplaying(channel);
        } else {
            armReadinessTimeout(channel);
        }
    }

    // ----- public API ------------------------------------------------------

    function register(ws, payload = {}) {
        const deviceId = String(payload.deviceId || '');
        if (!deviceId) {
            console.warn('[orchestrator] slideshowConfig without deviceId; ignoring');
            return;
        }
        // Move ws between channels if its deviceId changed (rare — usually a
        // reload with a different ?ws=).
        const prevChannel = wsToChannel.get(ws);
        if (prevChannel && prevChannel.deviceId !== deviceId) {
            removeFromChannel(ws, prevChannel);
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
        const sess = channel.sessions.get(ws) || { modTags: [] };
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
        channel.sessions.set(ws, sess);
        wsToChannel.set(ws, channel);

        // Last-write-wins on per-channel knobs. Merging differing intervals
        // across two displays of the same deviceId would be a misconfig
        // anyway; pick the latest joiner's value.
        channel.interval = sess.params.interval;
        if (sess.modTags.length) channel.modTags = sess.modTags.slice();

        const isFirstSession = channel.sessions.size === 1;
        // While merged, point the new ws at the driver channel's playback so
        // it joins the merged audience immediately.
        const playbackSource = isMergeActive() ? mergeDriverChannel : channel;
        sendPlaybackTo(ws, playbackSource);

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
            // Existing channel — fold the new ws into the readiness barrier
            // for the current image if we're still loading and it's visible.
            const target = isMergeActive() ? mergeDriverChannel : channel;
            if (target.phase === 'loading' && wsVisible(ws)) {
                target.expectedReady.add(ws);
            }
        }
    }

    function removeFromChannel(ws, channel) {
        channel.sessions.delete(ws);
        channel.expectedReady.delete(ws);
        channel.ready.delete(ws);
        if (channel.sessions.size === 0) {
            // Last session left — pause cadence and start the grace
            // window. State (queue, modTags, interval, currentId, merge
            // claim) is preserved so a quick reconnect picks up where
            // it left off without replaying slideshowConfig.
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
            // Re-check: a session may have joined just before the timer
            // fired. (clearTimeout in `register` handles the common case,
            // but JS timer semantics make the explicit guard worth it.)
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
            // remaining channels resume their own cadences instead of
            // mirroring a ghost. (Until eviction, we deliberately keep
            // the claim — see the displaySync comment in `unregister`.)
            releaseMerge();
        }
    }

    function unregister(ws) {
        const channel = wsToChannel.get(ws);
        wsToChannel.delete(ws);
        if (channel) removeFromChannel(ws, channel);
        // Note: the original claimer of displaySync leaving does NOT
        // release the merge. All sessions on the driver channel are
        // considered equal — any of them can release, and a transient
        // disconnect of the claimer shouldn't disrupt the merge for
        // everyone else. The merge only releases when the driver
        // channel itself is evicted (after the grace window).
    }

    function setModTags(ws, tags) {
        const channel = wsToChannel.get(ws);
        if (!channel) return;
        const sess = channel.sessions.get(ws);
        if (!sess) return;
        sess.modTags = Array.isArray(tags) ? tags.map(String).filter(Boolean) : [];
        // While merged, only sessions on the driver channel can change
        // mod tags. Audience channels are borrowed and shouldn't override
        // what the driver channel set. Within the driver channel any
        // session can change them — all sessions are equal peers.
        if (isMergeActive() && channel !== mergeDriverChannel) return;
        channel.modTags = sess.modTags.slice();
        clearAndRefill(channel).then(() => commitCurrent(channel));
    }

    function requestAdvance(ws) {
        const channel = wsToChannel.get(ws);
        if (!channel) return;
        const target = isMergeActive() ? mergeDriverChannel : channel;
        advance(target);
    }

    async function requestReshuffle(ws) {
        const channel = wsToChannel.get(ws);
        if (!channel) return;
        if (reshuffle) {
            try { await reshuffle(); }
            catch (err) { console.warn(`[orchestrator] reshuffle failed: ${err.message}`); }
        }
        const target = isMergeActive() ? mergeDriverChannel : channel;
        await clearAndRefill(target);
        commitCurrent(target);
    }

    function notifyImageReady(ws, id) {
        const wsChannel = wsToChannel.get(ws);
        if (!wsChannel) return;
        const target = isMergeActive() ? mergeDriverChannel : wsChannel;
        if (target.phase !== 'loading') return;
        if (Number(id) !== Number(target.currentId)) return;
        if (!target.expectedReady.has(ws)) return;
        target.ready.add(ws);
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
                || broadcastTargets(c).some((w) => wsToChannel.get(w)?.deviceId === deviceId));

        for (const channel of affected) {
            if (channel.phase === 'loading') {
                // Visible→hidden: drop hidden ws from the barrier. Hidden→visible
                // for a ws that's now expected: kiosk re-renders on wake and
                // will report imageReady; add it back to the barrier.
                channel.expectedReady = expectedReadersFor(channel);
                // Drop ready entries for ws no longer expected (keeps sets aligned).
                for (const ws of Array.from(channel.ready)) {
                    if (!channel.expectedReady.has(ws)) channel.ready.delete(ws);
                }
                if (channel.expectedReady.size === 0) {
                    promoteToDisplaying(channel);
                } else {
                    startTimerIfReady(channel);
                }
            } else if (channel.phase === 'displaying') {
                // Pause/resume the dwell timer. Hidden → cancel timer but
                // keep dwellDeadline; visible → reschedule with remaining.
                if (channelActive(channel)) {
                    if (!channel.timer) scheduleDwell(channel);
                } else {
                    stopDwellTimer(channel);
                }
            }
        }
    }

    function notifyTagListChange() {
        if (isMergeActive()) {
            clearAndRefill(mergeDriverChannel).then(() => commitCurrent(mergeDriverChannel));
            return;
        }
        for (const channel of channels.values()) {
            clearAndRefill(channel).then(() => commitCurrent(channel));
        }
    }

    function notifyBlockedChange() {
        const blockedIdSet = new Set((getBlockedIds() || []).map(Number));
        const blockedTagSet = new Set((getBlockedTags() || []).map(String));
        for (const channel of channels.values()) {
            const before = channel.queue.length;
            channel.queue = channel.queue.filter((entry) => !blockedIdSet.has(Number(entry.id)));
            // Tag-block requires re-querying since post tags aren't in the
            // queue entries. ID-only blocks can re-use the existing queue.
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

    function claimDisplaySync(ws, enabled) {
        const channel = wsToChannel.get(ws);
        if (!channel) return;
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
            // Re-enter loading on the driver, now expecting reports from the
            // merged audience (every visible WS across all channels).
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
        // Each non-driver channel resumes its own playback. Driver shrinks
        // its audience back to its own sessions.
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

    // Watchdog: any channel that's in `idle` with an empty queue is wedged —
    // its first refill returned nothing (empty DB, mismatched tag list,
    // transient search error). Without this tick, nothing in the orchestrator
    // would ever try the refill again, so the slideshow stays dead until an
    // external event (`requestNext`, `setTagList`, displaySync claim) kicks
    // it. Re-attempt the refill on a coarse interval so the queue recovers
    // automatically once the underlying issue clears (DB attached, tag list
    // edited, network restored).
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
        wsToChannel.clear();
        mergeDriverChannel = null;
    }

    return {
        register,
        unregister,
        setModTags,
        requestAdvance,
        requestReshuffle,
        notifyImageReady,
        notifyVisibility,
        notifyBlockedChange,
        notifyTagListChange,
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
