'use strict';
//
// Server-driven slideshow orchestrator (per-display channels).
//
// One channel per `deviceId`. Sessions joining a channel render the same
// queue and advance in lockstep. A channel is created when the first session
// for that deviceId calls `slideshowConfig` and persists for the lifetime of
// the server process: when its last session leaves, the channel is *parked*
// — all timers (dwell, readiness, prefetch) stop, but the queue, cursor,
// mod tags, tag list, interval, currentId, and any held merge claim survive.
// A returning client for the same deviceId rebinds to the parked channel
// and resumes from the same image without replaying slideshowConfig.
//
// Cadence is gated on a readiness barrier: after a `playback` frame is sent,
// the channel waits until every visible session reports `imageReady { id }`
// for the new image before starting the dwell-time interval timer. There is
// no timeout: a client that never reports parks the channel on the current
// frame indefinitely rather than advancing blind, so the server never burns
// work the client can't display. Sessions on hidden displays are auto-ready
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

const VIDEO_EXTS = new Set(['webm', 'mp4']);
function isVideoExt(ext) {
    return VIDEO_EXTS.has(String(ext || '').toLowerCase());
}

function createOrchestrator({
    search,
    getCurrentTagsList,
    getTagLists,
    getBlockedIds = () => [],
    getBlockedTags = () => [],
    reshuffle,
    incrementDisplayCount,
    prefetcher = null,
    imageCache = null,
    prefetchVariant = null,
    getVisibility = null,
}) {
    const UPCOMING_COUNT = 4;
    const MIN_QUEUE_SIZE = 1 + UPCOMING_COUNT;
    const REFILL_FETCH_SIZE = Math.max(5, MIN_QUEUE_SIZE * 2);
    const DEFAULT_INTERVAL_MS = 15000;
    const MIN_INTERVAL_MS = 2000;
    const MAX_INTERVAL_MS = 3600000;
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
    // doesn't tear down the merge — the driver channel parks with the
    // claim held. Only an explicit displaySync {enabled:false} or
    // process shutdown releases it.
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
            // True between the last session leaving and the next one
            // arriving. While parked, timers stay stopped (no wasted DB
            // / prefetch / readiness work) but every other piece of
            // state is preserved verbatim for the eventual reconnect.
            parked: false,
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
        // the channel forever — there's no timeout to bail it out.
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

    // Pick a single session's `ratio:"lo..hi"` advert for the channel: the
    // one whose range is centered closest to square (1.0). Each client sends
    // a window around its own aspect ratio (width/height), so on a channel
    // with mixed-orientation windows — a landscape and a portrait, say —
    // intersecting their ranges would collapse to empty and drop the filter
    // entirely. Choosing the most-square advertiser instead keeps a usable
    // constraint that crops acceptably on every window. Sessions without a
    // ratio claim are unconstrained and don't participate; returns null when
    // none advertise one.
    function channelRatioClause(channel) {
        let best = null, bestDist = Infinity;
        for (const sess of channel.sessions.values()) {
            const raw = sess.params && sess.params.ratio;
            if (typeof raw !== 'string') continue;
            const m = raw.match(/^(-?\d+(?:\.\d+)?)\.\.(-?\d+(?:\.\d+)?)$/);
            if (!m) continue;
            const sLo = Number(m[1]), sHi = Number(m[2]);
            if (!Number.isFinite(sLo) || !Number.isFinite(sHi) || sLo > sHi) continue;
            const dist = Math.abs((sLo + sHi) / 2 - 1);
            if (dist < bestDist) {
                bestDist = dist;
                best = { lo: sLo, hi: sHi };
            }
        }
        if (!best) return null;
        return `ratio:${best.lo.toFixed(2)}..${best.hi.toFixed(2)}`;
    }

    function buildQuery(channel) {
        const lists = getTagLists();
        const idx = channel.currentTagsList;
        const baseTags = Array.isArray(lists[idx]) ? lists[idx].slice() : [];
        const ratioClause = channelRatioClause(channel);
        const all = baseTags.concat(channel.modTags || []);
        if (ratioClause) all.push(ratioClause);
        return all.filter(Boolean).join(' ');
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
        channel.dwellDeadline = Date.now() + Math.max(MIN_INTERVAL_MS, channel.interval);
        scheduleDwell(channel);
    }

    async function advance(channel) {
        if (channel.queue.length > 0) channel.queue.shift();
        await refillQueue(channel);
        commitCurrent(channel);
    }

    // Warm the per-channel cache with the exact variants the channel's
    // sessions will request next. Bounded by interval-adaptive depth, so
    // a 2s slideshow gets the next 4 images converted in the background
    // while a 30s slideshow only bothers with the next one.
    function schedulePrefetch(channel) {
        if (!prefetcher || !prefetchVariant || !imageCache) return;
        if (!channel || channel.sessions.size === 0) return;
        if (channel.phase === 'idle' || channel.queue.length <= 1) return;
        // Display off → kiosk isn't rendering, don't burn CPU warming bytes
        // it won't ask for.
        if (getVisibility) {
            const driver = isMergeActive() ? mergeDriverChannel : channel;
            if (driver && getVisibility(driver.deviceId) === false) return;
        } else if (!channelActive(channel)) {
            return;
        }
        // While merged, every audience channel's sessions are mirroring the
        // driver's playback — they'll all be requesting the driver-channel's
        // upcoming IDs. Walk every session, but only run from the driver's queue.
        const driverChannel = isMergeActive() ? mergeDriverChannel : channel;
        if (driverChannel !== channel && isMergeActive() && channel !== mergeDriverChannel) return;
        const interval = Math.max(MIN_INTERVAL_MS, driverChannel.interval || DEFAULT_INTERVAL_MS);
        const depth = Math.max(1, Math.min(UPCOMING_COUNT, Math.ceil(15000 / interval)));
        const upcoming = driverChannel.queue.slice(1, 1 + depth);
        if (upcoming.length === 0) return;

        // Distinct variants across every visible session participating in
        // this channel's playback. While merged, that's every session across
        // every channel; otherwise just this channel's sessions.
        const variantList = [];
        const seen = new Set();
        const sessionPools = isMergeActive()
            ? Array.from(channels.values()).map((c) => c.sessions)
            : [driverChannel.sessions];
        for (const pool of sessionPools) {
            for (const [key, sess] of pool) {
                if (!sessionVisible(key)) continue;
                const p = sess.params || {};
                const v = {
                    convert: !!p.convert,
                    bright: !!p.bright,
                    lowmem: !!p.lowmem,
                    width: Number(p.width) || 3840,
                    height: Number(p.height) || 2160,
                };
                const sig = `c${v.convert ? 1 : 0}b${v.bright ? 1 : 0}l${v.lowmem ? 1 : 0}w${v.width}h${v.height}`;
                if (seen.has(sig)) continue;
                seen.add(sig);
                variantList.push(v);
            }
        }
        if (variantList.length === 0) return;

        for (const entry of upcoming) {
            const id = Number(entry.id);
            if (!Number.isFinite(id) || id <= 0) continue;
            // Videos stream from disk on demand — prefetching them would just
            // pull a ~100MB blob into a cache the streaming path doesn't use.
            if (isVideoExt(entry.ext)) continue;
            for (const v of variantList) {
                const parts = { id, ...v };
                const key = imageCache.keyOf(parts);
                if (imageCache.peek(key)) continue;
                prefetcher.schedule({
                    key,
                    run: () => prefetchVariant(parts),
                });
            }
        }
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
        schedulePrefetch(channel);
        if (channel.expectedReady.size === 0) {
            // No visible readers — short-circuit straight to displaying so
            // the channel's wall-clock keeps advancing even when every
            // display on the channel is dark.
            promoteToDisplaying(channel);
        }
        // Otherwise the channel stays in 'loading' until every visible
        // session reports `imageReady`. No timeout: an unreporting client
        // holds the channel here rather than letting it advance blind.
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
        // Reconnect to a parked channel: queue / modTags / interval /
        // currentId / merge claim are all still here from last time.
        // Any stale dwellDeadline is invalidated below by commitCurrent's
        // reset path, so the slideshow restarts the readiness barrier
        // for the same image rather than firing immediately.
        channel.parked = false;
        const sess = sessionsByKey.get(key) || { ws, sessionId, channel, modTags: [] };
        sess.ws = ws;
        sess.sessionId = sessionId;
        sess.channel = channel;
        const hadPrevParams = !!sess.params;
        const prevRatio = sess.params ? sess.params.ratio : null;
        sess.params = {
            interval: clampInterval(payload.interval),
            ratio: payload.ratio || null,
            width: numberOrNull(payload.width),
            height: numberOrNull(payload.height),
            bright: !!payload.bright,
            convert: !!payload.convert,
            lowmem: !!payload.lowmem,
        };
        // Only treat ratio as "changed" if this is a re-register of an
        // existing session whose ratio is actually different. On first
        // register prevRatio is null by construction; treating that as a
        // change triggers a clearAndRefill on every initial join, which
        // races the first-session refillQueue → commitCurrent path.
        const ratioChanged = hadPrevParams && prevRatio !== sess.params.ratio;
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
            // New session's variant fingerprint may be unseen — warm the
            // upcoming queue for it now rather than waiting for the next
            // commitCurrent.
            schedulePrefetch(target);
        }

        // Ratio is folded into the channel query (see channelRatioClause);
        // when a re-register changes a session's ratio (e.g. visionOS window
        // resize), the existing queue is stale and must be redrawn against
        // the new constraint. Skip while merged — non-driver channels are
        // dormant and refilling would just discard their work.
        if (ratioChanged && (!isMergeActive() || channel === mergeDriverChannel)) {
            clearAndRefill(channel).then(() => commitCurrent(channel));
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
            // Last session left — park the channel. Every timer stops
            // so no DB/prefetch/dwell work runs while no one's listening,
            // but queue / modTags / interval / currentId / merge claim
            // are preserved verbatim. The next register() for this
            // deviceId rebinds to the same channel and resumes from the
            // same image; no slideshowConfig replay needed for state.
            stopDwellTimer(channel);
            channel.parked = true;
        } else if (channel.phase === 'loading') {
            // Disconnect during the readiness barrier — re-check now that
            // the expected set is smaller.
            startTimerIfReady(channel);
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
        // Note: a ws closing does NOT release a held merge claim. The
        // driver channel parks (timers stopped) and keeps the claim so
        // a reconnect resumes the merged display layout. The only
        // automatic release is close() at process shutdown; otherwise
        // some session on the driver channel must explicitly disable
        // displaySync.
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
            if (visible) schedulePrefetch(channel);
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
                c.phase = 'idle';
                c.dwellDeadline = null;
            }
            channel.expectedReady = expectedReadersFor(channel);
            channel.ready = new Set();
            channel.phase = 'loading';
            broadcastPlayback(channel);
            if (channel.expectedReady.size === 0) promoteToDisplaying(channel);
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
            if (channel.parked) continue;
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
