// Unit tests for the slideshow orchestrator. Drives the orchestrator
// directly with a fake search and a captured-broadcast spy — no HTTP, no
// real WebSocket — so we can verify the channel behaviour deterministically.

const test = require('node:test');
const assert = require('node:assert/strict');
const { createOrchestrator } = require('../lib/orchestrator');

function makeFakeSearch(pages) {
    let call = 0;
    const queries = [];
    return {
        async runSearch({ q } = {}) {
            queries.push(q);
            const page = pages[Math.min(call, pages.length - 1)];
            call += 1;
            return page;
        },
        clearCache() { call = 0; },
        get callCount() { return call; },
        get queries() { return queries; },
        get lastQuery() { return queries[queries.length - 1]; },
    };
}

function makeFakeWs() {
    const sent = [];
    return {
        readyState: 1,
        sent,
        send: (data) => sent.push(JSON.parse(data)),
    };
}

// Most existing tests treat each ws as a single-session client. The
// orchestrator's real API is multiplexed — every method takes a sessionId.
// This shim auto-assigns a stable sessionId per ws so the existing call
// sites stay readable; multi-session tests use `orch.raw` to bypass it.
function withDefaultSession(orch) {
    const idFor = new WeakMap();
    let counter = 0;
    function sid(ws) {
        let id = idFor.get(ws);
        if (!id) { id = `s${++counter}`; idFor.set(ws, id); }
        return id;
    }
    return {
        raw: orch,
        sid,
        register: (ws, payload) => orch.register(ws, sid(ws), payload),
        setModTags: (ws, tags) => orch.setModTags(ws, sid(ws), tags),
        requestAdvance: (ws) => orch.requestAdvance(ws, sid(ws)),
        requestReshuffle: (ws) => orch.requestReshuffle(ws, sid(ws)),
        notifyImageReady: (ws, id, durationMs) => orch.notifyImageReady(ws, sid(ws), id, durationMs),
        claimDisplaySync: (ws, enabled) => orch.claimDisplaySync(ws, sid(ws), enabled),
        notifyVisibility: (...args) => orch.notifyVisibility(...args),
        setTagList: (ws, listNumber) => orch.setTagList(ws, sid(ws), listNumber),
        notifyBlockedChange: (...args) => orch.notifyBlockedChange(...args),
        requeryAll: (...args) => orch.requeryAll(...args),
        unregister: (...args) => orch.unregister(...args),
        unregisterSession: (...args) => orch.unregisterSession(...args),
        close: () => orch.close(),
        get _channels() { return orch._channels; },
        _state: () => orch._state(),
    };
}

// `pages` is consumed shared across all channels (the fake search returns
// the next page on each call regardless of which channel asked). Tests that
// need per-channel isolation provide explicit pages or override.
function harness({ tagLists = [['cats']], pages, blockedIds = [], blockedTags = [], readyTimeout = 0, expandBlockedTags } = {}) {
    const broadcasts = [];
    const broadcast = (msg) => broadcasts.push(msg);
    const search = makeFakeSearch(pages || [
        { results: [{ _id: 1, file_ext: 'jpg' }, { _id: 2, file_ext: 'jpg' }, { _id: 3, file_ext: 'jpg' }], nextCursor: 0.3 },
        { results: [{ _id: 4, file_ext: 'jpg' }, { _id: 5, file_ext: 'jpg' }], nextCursor: 0 },
    ]);
    let currentList = 0;
    let blockIds = blockedIds.slice();
    let blockTags = blockedTags.slice();
    const rawOrch = createOrchestrator({
        search,
        broadcast,
        getCurrentTagsList: () => currentList,
        getTagLists: () => tagLists,
        getBlockedIds: () => blockIds,
        getBlockedTags: () => blockTags,
        ...(expandBlockedTags ? { expandBlockedTags } : {}),
        getReadyTimeout: () => readyTimeout,
    });
    const orch = withDefaultSession(rawOrch);
    return {
        orch,
        broadcasts,
        search,
        setCurrentList: (n) => { currentList = n; },
        setBlockedIds: (v) => { blockIds = v.slice(); },
        setBlockedTags: (v) => { blockTags = v.slice(); },
    };
}

const tick = () => new Promise((res) => setImmediate(res));
const delay = (ms) => new Promise((res) => setTimeout(res, ms));

// Walk the readiness barrier: all expected ws on the channel report
// imageReady for the channel's currentId. Returns the id they reported.
function reportAllReady(orch, deviceId) {
    const channel = orch._channels.get(deviceId);
    if (!channel) return null;
    const id = channel.currentId;
    // expectedReady holds session keys; resolve to the underlying ws/sessionId
    // pair via channel.sessions and call the wrapper, which stamps the
    // right sessionId.
    for (const sess of channel.sessions.values()) {
        if (channel.expectedReady.has(`${sess.ws.__rfWsId}:${sess.sessionId}`)) {
            orch.notifyImageReady(sess.ws, id);
        }
    }
    return id;
}

test('register sends a synchronous playback frame to the new client', async (t) => {
    const { orch } = harness();
    t.after(() => orch.close());
    const ws = makeFakeWs();
    orch.register(ws, { deviceId: 'kiosk1', interval: 5000 });
    // The first frame the new ws sees is the synchronous snapshot taken
    // before refill resolves: deviceId is set, queue is empty.
    assert.equal(ws.sent.length, 1);
    assert.equal(ws.sent[0].action, 'playback');
    assert.equal(ws.sent[0].payload.deviceId, 'kiosk1');
    assert.equal(ws.sent[0].payload.current, null);
    assert.equal(ws.sent[0].payload.mergeDriver, null);
});

test('first session creates the channel; refill broadcasts current image', async (t) => {
    const { orch } = harness();
    t.after(() => orch.close());
    const ws = makeFakeWs();
    orch.register(ws, { deviceId: 'kiosk1', interval: 5000 });
    await tick(); await tick(); await tick();
    const last = ws.sent.filter((m) => m.action === 'playback').pop();
    assert.equal(last.payload.deviceId, 'kiosk1');
    assert.deepEqual(last.payload.current, { id: 1, ext: 'jpg' });
});

test('two ws on the same deviceId share one channel and receive the same playback', async (t) => {
    const { orch } = harness();
    t.after(() => orch.close());
    const a = makeFakeWs();
    const b = makeFakeWs();
    orch.register(a, { deviceId: 'screen1', interval: 5000 });
    await tick(); await tick(); await tick();
    orch.register(b, { deviceId: 'screen1', interval: 5000 });
    await tick();
    assert.equal(orch._channels.size, 1);
    // Both ws received a playback for screen1; the post-refill broadcast
    // should be delivered to both clients identically.
    const aLast = a.sent.filter((m) => m.action === 'playback').pop();
    const bLast = b.sent.filter((m) => m.action === 'playback').pop();
    assert.equal(aLast.payload.deviceId, 'screen1');
    assert.equal(bLast.payload.deviceId, 'screen1');
    assert.equal(aLast.payload.current?.id, bLast.payload.current?.id);
});

test('two ws on different deviceIds get independent channels', async (t) => {
    const { orch } = harness({
        pages: [
            { results: [{ _id: 1, file_ext: 'jpg' }, { _id: 2, file_ext: 'jpg' }, { _id: 3, file_ext: 'jpg' }, { _id: 4, file_ext: 'jpg' }, { _id: 5, file_ext: 'jpg' }], nextCursor: 0 },
            { results: [{ _id: 10, file_ext: 'jpg' }, { _id: 11, file_ext: 'jpg' }, { _id: 12, file_ext: 'jpg' }, { _id: 13, file_ext: 'jpg' }, { _id: 14, file_ext: 'jpg' }], nextCursor: 0 },
        ],
    });
    t.after(() => orch.close());
    const a = makeFakeWs();
    const b = makeFakeWs();
    orch.register(a, { deviceId: 'screen1', interval: 5000 });
    await tick(); await tick(); await tick();
    orch.register(b, { deviceId: 'screen2', interval: 5000 });
    await tick(); await tick(); await tick();
    assert.equal(orch._channels.size, 2);
    const c1 = orch._channels.get('screen1');
    const c2 = orch._channels.get('screen2');
    assert.notEqual(c1.currentId, c2.currentId);
});

test('readiness barrier: first imageReady from any expected ws starts the dwell timer', async (t) => {
    const { orch } = harness();
    t.after(() => orch.close());
    const a = makeFakeWs();
    const b = makeFakeWs();
    orch.register(a, { deviceId: 'screen1', interval: 5000 });
    orch.register(b, { deviceId: 'screen1', interval: 5000 });
    await tick(); await tick(); await tick();

    const ch = orch._channels.get('screen1');
    assert.equal(ch.phase, 'loading', 'channel waits in loading until someone reports ready');
    assert.equal(ch.expectedReady.size, 2);
    assert.equal(ch.timer, null, 'no dwell timer before the first report');

    // First-ready wins: a single report is enough, even with another
    // expected session still outstanding. The slow/absent peer must not
    // gate the channel.
    orch.notifyImageReady(a, ch.currentId);
    assert.equal(ch.phase, 'displaying');
    assert.ok(ch.timer, 'dwell timer arms on the first imageReady');
});

test('imageReady durationMs longer than the interval extends the dwell to the clip length', async (t) => {
    const { orch } = harness();
    t.after(() => orch.close());
    const ws = makeFakeWs();
    orch.register(ws, { deviceId: 'screen1', interval: 5000 });
    await tick(); await tick(); await tick();
    const ch = orch._channels.get('screen1');

    // A 22s clip on a 5s interval: dwell must stretch to the clip length so
    // the video plays through instead of being cut off after the interval.
    orch.notifyImageReady(ws, ch.currentId, 22000);
    assert.equal(ch.phase, 'displaying');
    assert.ok(ch.dwellDeadline - Date.now() > 5000, 'dwell extended past the interval');
    assert.ok(ch.dwellDeadline - Date.now() <= 22000);
});

test('imageReady durationMs shorter than the interval keeps the plain interval dwell', async (t) => {
    const { orch } = harness();
    t.after(() => orch.close());
    const ws = makeFakeWs();
    orch.register(ws, { deviceId: 'screen1', interval: 5000 });
    await tick(); await tick(); await tick();
    const ch = orch._channels.get('screen1');

    // A 2s clip loops until the 5s interval; the dwell stays at the interval.
    orch.notifyImageReady(ws, ch.currentId, 2000);
    assert.equal(ch.phase, 'displaying');
    assert.ok(ch.dwellDeadline - Date.now() <= 5000);
    assert.ok(ch.dwellDeadline - Date.now() > 2000, 'dwell not shrunk below the interval');
});

test('imageReady durationMs resets per image so a long clip does not stretch the next image', async (t) => {
    const { orch } = harness();
    t.after(() => orch.close());
    const ws = makeFakeWs();
    orch.register(ws, { deviceId: 'screen1', interval: 5000 });
    await tick(); await tick(); await tick();
    const ch = orch._channels.get('screen1');

    orch.notifyImageReady(ws, ch.currentId, 22000);
    assert.equal(ch.currentDurationMs, 22000);
    orch.requestAdvance(ws);
    await tick(); await tick(); await tick();
    assert.equal(ch.currentDurationMs, 0, 'duration cleared on commit');

    // Next image is an ordinary image (no durationMs) → plain interval.
    orch.notifyImageReady(ws, ch.currentId);
    assert.ok(ch.dwellDeadline - Date.now() <= 5000, 'next image dwells for the interval, not the prior clip');
});

test('indexed video duration seeds the dwell without any client durationMs report', async (t) => {
    // A live-transcoded clip's fragmented MP4 has no duration in its header,
    // so a kiosk querying its player sees 0 and reports imageReady with no
    // durationMs. The dwell must still cover the clip from the indexed
    // duration carried on the queue entry.
    const { orch } = harness({
        pages: [{
            results: [
                { _id: 100, file_ext: 'webm', duration: 122 },
                { _id: 101, file_ext: 'jpg' },
            ],
            nextCursor: 0,
        }],
    });
    t.after(() => orch.close());
    const ws = makeFakeWs();
    orch.register(ws, { deviceId: 'screen1', interval: 5000 });
    await tick(); await tick(); await tick();
    const ch = orch._channels.get('screen1');
    assert.equal(ch.currentId, 100);
    assert.equal(ch.currentDurationMs, 122000, 'dwell seeded from indexed duration');

    // Report WITHOUT a durationMs (the header-less live transcode case).
    orch.notifyImageReady(ws, ch.currentId);
    assert.equal(ch.phase, 'displaying');
    assert.ok(ch.dwellDeadline - Date.now() > 5000, 'dwell covers the clip, not just the interval');
    assert.ok(ch.dwellDeadline - Date.now() <= 122000);
});

test('a client durationMs still wins when it exceeds the indexed duration', async (t) => {
    // Cached replay: the player can read the true length and reports it. If
    // the index under-counted, the reported value must raise the dwell.
    const { orch } = harness({
        pages: [{
            results: [
                { _id: 100, file_ext: 'webm', duration: 10 },
                { _id: 101, file_ext: 'jpg' },
            ],
            nextCursor: 0,
        }],
    });
    t.after(() => orch.close());
    const ws = makeFakeWs();
    orch.register(ws, { deviceId: 'screen1', interval: 5000 });
    await tick(); await tick(); await tick();
    const ch = orch._channels.get('screen1');
    assert.equal(ch.currentDurationMs, 10000);

    orch.notifyImageReady(ws, ch.currentId, 22000);
    assert.equal(ch.currentDurationMs, 22000, 'reported duration raises the seed');
    assert.ok(ch.dwellDeadline - Date.now() > 10000);
});

test('readiness barrier: a client leaving before reporting does not wedge the channel', async (t) => {
    const { orch } = harness();
    t.after(() => orch.close());
    const a = makeFakeWs();
    const b = makeFakeWs();
    orch.register(a, { deviceId: 'screen1', interval: 5000 });
    orch.register(b, { deviceId: 'screen1', interval: 5000 });
    await tick(); await tick(); await tick();

    const ch = orch._channels.get('screen1');
    assert.equal(ch.phase, 'loading');
    assert.equal(ch.expectedReady.size, 2);

    // `a` reports, `b` never does and then disconnects. The channel must
    // already be running off `a`'s report — `b` leaving can't strand it.
    orch.notifyImageReady(a, ch.currentId);
    assert.equal(ch.phase, 'displaying', 'one report is enough to advance');
    orch.unregister(b);
    assert.equal(ch.phase, 'displaying');
    assert.ok(ch.timer, 'channel keeps running after the non-reporting peer leaves');
});

test('readiness timeout disabled (0): a client that never reports holds the channel in loading forever', async (t) => {
    const { orch } = harness({ readyTimeout: 0 });
    t.after(() => orch.close());
    const a = makeFakeWs();
    const b = makeFakeWs();
    orch.register(a, { deviceId: 'screen1', interval: 5000 });
    orch.register(b, { deviceId: 'screen1', interval: 5000 });
    await tick(); await tick(); await tick();
    const ch = orch._channels.get('screen1');
    const stuckId = ch.currentId;
    // No imageReady from either visible session and the fallback disabled:
    // the barrier must not be bailed out by any timer. The channel parks on
    // the current frame rather than advancing blind and wasting work the
    // clients can't show.
    assert.equal(ch.phase, 'loading');
    assert.equal(ch.timer, null, 'no dwell timer while still loading');
    assert.equal(ch.readyTimer, null, 'no readiness timer when disabled');
    // Even after the configured interval would have elapsed, nothing moves.
    await tick(); await tick(); await tick();
    assert.equal(ch.phase, 'loading');
    assert.equal(ch.currentId, stuckId, 'channel does not advance without imageReady');
});

test('readiness timeout: a never-reporting visible client is promoted after the budget', async (t) => {
    const { orch } = harness({ readyTimeout: 40 });
    t.after(() => orch.close());
    const ws = makeFakeWs();
    orch.register(ws, { deviceId: 'screen1', interval: 5000 });
    await tick(); await tick(); await tick();
    const ch = orch._channels.get('screen1');
    const stuckId = ch.currentId;
    // A single visible session that never reports: the barrier arms a
    // readiness timer keyed on this channel.
    assert.equal(ch.phase, 'loading');
    assert.ok(ch.readyTimer, 'readiness timer armed while waiting');
    assert.ok(ch.readyDeadline - Date.now() > 0, 'readiness deadline in the future');
    // After the budget the channel promotes the frame anyway and starts the
    // dwell — recovering without a manual next or a reconnect.
    await delay(70);
    assert.equal(ch.phase, 'displaying', 'channel promotes after the readiness timeout');
    assert.equal(ch.readyTimer, null, 'readiness timer cleared on promote');
    assert.equal(ch.currentId, stuckId, 'promotes the same frame, does not skip it');
    assert.ok(ch.timer, 'dwell timer running after the timeout promote');
});

test('a streak of readiness timeouts stalls the channel instead of advancing blind', async (t) => {
    const { orch } = harness({ readyTimeout: 40 });
    t.after(() => orch.close());
    const ws = makeFakeWs();
    orch.register(ws, { deviceId: 'screen1', interval: 5000 });
    await tick(); await tick(); await tick();
    const ch = orch.raw._channels.get('screen1');
    assert.equal(ch.phase, 'loading');
    const stuckId = ch.currentId;
    // Two prior cycles already timed out (set directly — accumulating them
    // for real means riding full dwell cycles); the next fire crosses the
    // stall threshold.
    ch.readyTimeoutStreak = 2;
    await delay(70);
    assert.equal(ch.readyTimeoutStreak, 3);
    assert.equal(ch.phase, 'loading', 'stalled channel parks on the frame instead of promoting');
    assert.equal(ch.readyTimer, null, 'no readiness timer re-armed while stalled');
    assert.equal(ch.timer, null, 'no dwell timer while stalled');
    assert.equal(ch.currentId, stuckId, 'no blind advance');

    // First sign of life — the wedged client finally reports — resumes.
    orch.notifyImageReady(ws, stuckId);
    assert.equal(ch.readyTimeoutStreak, 0, 'streak cleared by the accepted report');
    assert.equal(ch.phase, 'displaying', 'accepted report promotes the stalled frame');
});

test('a visibility report resumes a stalled channel', async (t) => {
    const { orch } = harness({ readyTimeout: 40 });
    t.after(() => orch.close());
    const ws = makeFakeWs();
    orch.register(ws, { deviceId: 'screen1', interval: 5000 });
    await tick(); await tick(); await tick();
    const ch = orch.raw._channels.get('screen1');
    ch.readyTimeoutStreak = 2;
    await delay(70);
    assert.equal(ch.phase, 'loading', 'stalled');
    // The display agent finally reports the screen is off: the streak clears
    // and the all-hidden short-circuit takes over (wall-clock advance with
    // prefetch suppressed), which is the legitimate dark-display mode.
    orch.notifyVisibility('screen1', false);
    assert.equal(ch.readyTimeoutStreak, 0);
    assert.equal(ch.phase, 'displaying', 'hidden short-circuit promotes');
});

test('a re-registering session resumes a stalled channel', async (t) => {
    const { orch } = harness({ readyTimeout: 40 });
    t.after(() => orch.close());
    const ws = makeFakeWs();
    orch.register(ws, { deviceId: 'screen1', interval: 5000 });
    await tick(); await tick(); await tick();
    const ch = orch.raw._channels.get('screen1');
    ch.readyTimeoutStreak = 2;
    await delay(70);
    assert.equal(ch.phase, 'loading', 'stalled');
    assert.equal(ch.readyTimer, null);
    // Kiosk reboots and replays slideshowConfig on the same deviceId.
    orch.register(ws, { deviceId: 'screen1', interval: 5000 });
    await tick(); await tick(); await tick();
    assert.equal(ch.readyTimeoutStreak, 0);
    assert.ok(ch.readyTimer, 'barrier re-armed for the rejoined session');
});

test('readiness timeout is per-channel: one wedged deviceId does not promote a co-tenant', async (t) => {
    const { orch } = harness({ readyTimeout: 40 });
    t.after(() => orch.close());
    // Two distinct deviceIds (as Spatialstash multiplexes over one socket).
    const wedged = makeFakeWs();
    const healthy = makeFakeWs();
    orch.register(wedged, { deviceId: 'screenA', interval: 5000 });
    orch.register(healthy, { deviceId: 'screenB', interval: 5000 });
    await tick(); await tick(); await tick();
    const chA = orch._channels.get('screenA');
    const chB = orch._channels.get('screenB');
    // screenB reports promptly and leaves loading; screenA never reports.
    orch.notifyImageReady(healthy, chB.currentId);
    assert.equal(chB.phase, 'displaying');
    assert.equal(chB.readyTimer, null, 'healthy channel has no readiness timer pending');
    assert.equal(chA.phase, 'loading', 'wedged channel still waiting');
    // Only the wedged channel rides its timeout; the healthy one is untouched.
    await delay(70);
    assert.equal(chA.phase, 'displaying', 'wedged channel promotes on its own timeout');
    assert.equal(chB.phase, 'displaying', 'co-tenant channel never entered a readiness timeout');
});

test('readiness timeout does not fire once the first report promotes the channel', async (t) => {
    const { orch } = harness({ readyTimeout: 40 });
    t.after(() => orch.close());
    const ws = makeFakeWs();
    orch.register(ws, { deviceId: 'screen1', interval: 5000 });
    await tick(); await tick(); await tick();
    const ch = orch._channels.get('screen1');
    orch.notifyImageReady(ws, ch.currentId);
    assert.equal(ch.phase, 'displaying');
    assert.equal(ch.readyTimer, null, 'readiness timer cleared by the first report');
    const dwellDeadline = ch.dwellDeadline;
    // Past the readiness budget the dwell must be untouched — no stray
    // promote re-running and bumping the deadline.
    await delay(70);
    assert.equal(ch.phase, 'displaying');
    assert.equal(ch.dwellDeadline, dwellDeadline, 'readiness timeout must not disturb a displaying channel');
});

test('readiness timeout: an all-hidden channel still promotes immediately, not on the timer', async (t) => {
    const { orch } = harness({ readyTimeout: 40 });
    t.after(() => orch.close());
    const ws = makeFakeWs();
    orch.notifyVisibility('screen1', false);
    orch.register(ws, { deviceId: 'screen1', interval: 5000 });
    await tick(); await tick(); await tick();
    const ch = orch._channels.get('screen1');
    // No visible readers → empty expectedReady → immediate promote, with no
    // readiness timer armed (nothing to wait on).
    assert.equal(ch.phase, 'displaying', 'all-hidden promotes without waiting for the budget');
    assert.equal(ch.readyTimer, null, 'no readiness timer when there is nothing to wait on');
});

test('node-display-style WS that never sends slideshowConfig is not in any channel', async (t) => {
    const { orch } = harness();
    t.after(() => orch.close());
    const ndWs = makeFakeWs();
    // node-display sends visibility but never slideshowConfig — the
    // orchestrator should not register it as a session.
    orch.notifyVisibility('screen1', true);
    assert.equal(orch._channels.size, 0, 'visibility alone must not create a channel');
    assert.ok(!orch._state().channels.find((c) => c.sessionCount > 0));
});

test('visibility=false pauses the dwell timer; visibility=true resumes the remaining time', async (t) => {
    const { orch } = harness();
    t.after(() => orch.close());
    const ws = makeFakeWs();
    orch.register(ws, { deviceId: 'screen1', interval: 60000 });
    await tick(); await tick(); await tick();
    reportAllReady(orch, 'screen1');
    const ch = orch._channels.get('screen1');
    assert.equal(ch.phase, 'displaying');
    assert.ok(ch.timer);
    const deadlineBefore = ch.dwellDeadline;

    orch.notifyVisibility('screen1', false);
    assert.equal(ch.timer, null, 'timer cleared while hidden');
    assert.equal(ch.dwellDeadline, deadlineBefore, 'deadline preserved across pause');

    orch.notifyVisibility('screen1', true);
    assert.ok(ch.timer, 'timer rearmed on resume');
    assert.equal(ch.dwellDeadline, deadlineBefore,
        'wake must not bump the deadline — that is the bug we are fixing');
});

test('hidden display does not stall the readiness barrier (auto-ready)', async (t) => {
    const { orch } = harness();
    t.after(() => orch.close());
    const visible = makeFakeWs();
    const hidden = makeFakeWs();
    orch.register(visible, { deviceId: 'screen-v', interval: 5000 });
    orch.register(hidden, { deviceId: 'screen-h', interval: 5000 });
    await tick(); await tick(); await tick();

    // screen-h goes hidden — its kiosk won't render, so it must not block
    // its own channel's barrier.
    orch.notifyVisibility('screen-h', false);
    const ch = orch._channels.get('screen-h');
    // Channel runs continuously even with no visible reader; it should
    // short-circuit straight to displaying.
    assert.equal(ch.phase, 'displaying',
        'channel with no visible reader auto-promotes (so wall-clock keeps ticking)');
});

test('block triggers immediate advance + broadcast via notifyBlockedChange', async (t) => {
    const ctx = harness();
    const { orch } = ctx;
    t.after(() => orch.close());
    const ws = makeFakeWs();
    orch.register(ws, { deviceId: 'screen1', interval: 5000 });
    await tick(); await tick(); await tick();
    reportAllReady(orch, 'screen1');

    const before = ws.sent.filter((m) => m.action === 'playback').pop();
    assert.deepEqual(before.payload.current, { id: 1, ext: 'jpg' });

    ctx.setBlockedIds([1]);
    orch.notifyBlockedChange();
    await tick(); await tick(); await tick();

    const after = ws.sent.filter((m) => m.action === 'playback').pop();
    assert.notEqual(after.payload.current?.id, 1, 'blocked current was dropped from queue');
});

test('any session can request advance — no primary gate, no echo loop', async (t) => {
    const { orch } = harness();
    t.after(() => orch.close());
    const a = makeFakeWs();
    const b = makeFakeWs();
    orch.register(a, { deviceId: 'screen1', interval: 5000 });
    orch.register(b, { deviceId: 'screen1', interval: 5000 });
    await tick(); await tick(); await tick();
    reportAllReady(orch, 'screen1');
    const ch = orch._channels.get('screen1');
    const beforeId = ch.currentId;

    a.sent.length = 0;
    b.sent.length = 0;
    orch.requestAdvance(b);
    await tick(); await tick(); await tick();
    assert.notEqual(ch.currentId, beforeId, 'channel advanced');
    // The advance broadcast lands on every channel session — including
    // the requester. There is no echo because clients only emit requests
    // and reports, never playback frames.
    const aPlayback = a.sent.filter((m) => m.action === 'playback');
    const bPlayback = b.sent.filter((m) => m.action === 'playback');
    assert.ok(aPlayback.length > 0);
    assert.ok(bPlayback.length > 0);
    assert.equal(aPlayback[aPlayback.length - 1].payload.current?.id, ch.currentId);
});

test('displaySync: driver merges every channel; non-driver clients see driver playback', async (t) => {
    const { orch } = harness({
        pages: [
            // screen1 first refill
            { results: [{ _id: 1, file_ext: 'jpg' }, { _id: 2, file_ext: 'jpg' }, { _id: 3, file_ext: 'jpg' }, { _id: 4, file_ext: 'jpg' }, { _id: 5, file_ext: 'jpg' }], nextCursor: 0 },
            // screen2 first refill
            { results: [{ _id: 10, file_ext: 'jpg' }, { _id: 11, file_ext: 'jpg' }, { _id: 12, file_ext: 'jpg' }, { _id: 13, file_ext: 'jpg' }, { _id: 14, file_ext: 'jpg' }], nextCursor: 0 },
        ],
    });
    t.after(() => orch.close());
    const a = makeFakeWs();
    const b = makeFakeWs();
    orch.register(a, { deviceId: 'screen1', interval: 5000 });
    await tick(); await tick(); await tick();
    reportAllReady(orch, 'screen1');
    orch.register(b, { deviceId: 'screen2', interval: 5000 });
    await tick(); await tick(); await tick();
    reportAllReady(orch, 'screen2');

    a.sent.length = 0;
    b.sent.length = 0;
    orch.claimDisplaySync(a, true);
    // Both clients should now have received a playback whose deviceId is
    // the driver's (screen1), regardless of their own deviceId.
    const aMerged = a.sent.find((m) => m.action === 'playback');
    const bMerged = b.sent.find((m) => m.action === 'playback');
    assert.equal(aMerged.payload.deviceId, 'screen1');
    assert.equal(bMerged.payload.deviceId, 'screen1');
    assert.equal(bMerged.payload.mergeDriver, 'screen1');
});

test('displaySync release: each non-driver channel resumes its own playback', async (t) => {
    const { orch } = harness({
        pages: [
            { results: [{ _id: 1, file_ext: 'jpg' }, { _id: 2, file_ext: 'jpg' }, { _id: 3, file_ext: 'jpg' }, { _id: 4, file_ext: 'jpg' }, { _id: 5, file_ext: 'jpg' }], nextCursor: 0 },
            { results: [{ _id: 10, file_ext: 'jpg' }, { _id: 11, file_ext: 'jpg' }, { _id: 12, file_ext: 'jpg' }, { _id: 13, file_ext: 'jpg' }, { _id: 14, file_ext: 'jpg' }], nextCursor: 0 },
        ],
    });
    t.after(() => orch.close());
    const a = makeFakeWs();
    const b = makeFakeWs();
    orch.register(a, { deviceId: 'screen1', interval: 5000 });
    await tick(); await tick(); await tick();
    reportAllReady(orch, 'screen1');
    orch.register(b, { deviceId: 'screen2', interval: 5000 });
    await tick(); await tick(); await tick();
    reportAllReady(orch, 'screen2');

    orch.claimDisplaySync(a, true);
    await tick();
    b.sent.length = 0;
    orch.claimDisplaySync(a, false);
    await tick(); await tick();
    const bAfter = b.sent.find((m) => m.action === 'playback');
    assert.ok(bAfter, 'non-driver gets a playback frame back to its own channel');
    assert.equal(bAfter.payload.deviceId, 'screen2');
    assert.equal(bAfter.payload.mergeDriver, null);
});

test('displaySync: driver disconnect parks driver channel and keeps merge held', async (t) => {
    const { orch } = harness({
        pages: [
            { results: [{ _id: 1, file_ext: 'jpg' }, { _id: 2, file_ext: 'jpg' }, { _id: 3, file_ext: 'jpg' }, { _id: 4, file_ext: 'jpg' }, { _id: 5, file_ext: 'jpg' }], nextCursor: 0 },
            { results: [{ _id: 10, file_ext: 'jpg' }, { _id: 11, file_ext: 'jpg' }, { _id: 12, file_ext: 'jpg' }, { _id: 13, file_ext: 'jpg' }, { _id: 14, file_ext: 'jpg' }], nextCursor: 0 },
        ],
    });
    t.after(() => orch.close());
    const a = makeFakeWs();
    const b = makeFakeWs();
    orch.register(a, { deviceId: 'screen1', interval: 5000 });
    await tick(); await tick(); await tick();
    reportAllReady(orch, 'screen1');
    orch.register(b, { deviceId: 'screen2', interval: 5000 });
    await tick(); await tick(); await tick();
    reportAllReady(orch, 'screen2');

    orch.claimDisplaySync(a, true);
    assert.equal(orch._state().mergeDriverDeviceId, 'screen1');
    // Driver disconnects. Merge stays — all sessions on the driver
    // channel are equal, and a transient disconnect of the original
    // claimer shouldn't disrupt the merge for everyone else. The
    // driver channel is parked (timers stopped) but persists with the
    // merge claim until a session on it explicitly releases.
    orch.unregister(a);
    assert.equal(orch._state().mergeDriverDeviceId, 'screen1',
        'driver ws drop alone does not release the merge');
});

test('reconnect to parked channel restores state without slideshowConfig replay', async (t) => {
    const { orch } = harness({
        pages: [
            { results: [{ _id: 1, file_ext: 'jpg' }, { _id: 2, file_ext: 'jpg' }, { _id: 3, file_ext: 'jpg' }, { _id: 4, file_ext: 'jpg' }, { _id: 5, file_ext: 'jpg' }], nextCursor: 0 },
        ],
    });
    t.after(() => orch.close());
    const a = makeFakeWs();
    orch.register(a, { deviceId: 'screen1', interval: 5000, modTags: ['rating:s'] });
    await tick(); await tick(); await tick();
    const before = orch._state().channels[0];
    assert.equal(before.deviceId, 'screen1');

    // Disconnect the only session. Channel must persist — its queue,
    // mod tags, and current id are needed when the client reconnects.
    orch.unregister(a);
    const parked = orch._state().channels[0];
    assert.ok(parked, 'channel persists after last session leaves');
    assert.equal(parked.deviceId, 'screen1');
    assert.equal(parked.sessionCount, 0);

    // Reconnect with bare deviceId (no slideshowConfig replay needed
    // for state — `register` takes care of session re-binding).
    const a2 = makeFakeWs();
    orch.register(a2, { deviceId: 'screen1', interval: 5000 });
    await tick(); await tick();
    const after = orch._state().channels[0];
    assert.equal(after.sessionCount, 1, 'new session bound to surviving channel');
    assert.deepEqual(orch._channels.get('screen1').modTags, ['rating:s'],
        'mod tags survived the disconnect');
});

test('multiplex: two sessions on one ws share a channel and get a single playback frame', async (t) => {
    // Drives the raw API (sessionId as a first-class arg) since the
    // shim is one-sessionId-per-ws. Two windows in one room sharing a
    // device id and one connection is the canonical use case.
    const { orch } = harness({
        pages: [{
            results: [
                { _id: 1, file_ext: 'jpg' }, { _id: 2, file_ext: 'jpg' },
                { _id: 3, file_ext: 'jpg' }, { _id: 4, file_ext: 'jpg' },
                { _id: 5, file_ext: 'jpg' },
            ],
            nextCursor: 0,
        }],
    });
    t.after(() => orch.close());
    const ws = makeFakeWs();
    const raw = orch.raw;
    raw.register(ws, 'win1', { deviceId: 'room', interval: 5000 });
    raw.register(ws, 'win2', { deviceId: 'room', interval: 5000 });
    await tick(); await tick(); await tick();

    const channel = orch._channels.get('room');
    assert.equal(channel.sessions.size, 2, 'both sessions live in the same channel');

    // Force a fresh playback broadcast by walking the readiness barrier.
    ws.sent.length = 0;
    raw.notifyImageReady(ws, 'win1', channel.currentId);
    raw.notifyImageReady(ws, 'win2', channel.currentId);
    // Timer fires immediately when the barrier completes; the next advance
    // is what we want to count broadcast frames against.
    await tick(); await tick();
    raw.requestAdvance(ws, 'win1');
    await tick(); await tick();

    const playbacks = ws.sent.filter((m) => m.action === 'playback');
    assert.ok(playbacks.length >= 1, 'received at least one playback frame');
    const last = playbacks[playbacks.length - 1];
    assert.deepEqual(last.sessionIds.sort(), ['win1', 'win2'],
        'one frame carries both sessionIds — no duplication on the wire');
});

test('multiplex: per-session unregister removes only that session from the channel', async (t) => {
    const { orch } = harness();
    t.after(() => orch.close());
    const ws = makeFakeWs();
    orch.raw.register(ws, 'win1', { deviceId: 'room', interval: 5000 });
    orch.raw.register(ws, 'win2', { deviceId: 'room', interval: 5000 });
    await tick(); await tick();
    assert.equal(orch._channels.get('room').sessions.size, 2);

    orch.raw.unregisterSession(ws, 'win1');
    await tick();
    const ch = orch._channels.get('room');
    assert.equal(ch.sessions.size, 1, 'only win1 dropped');
    // The remaining session still belongs to win2.
    const survivor = Array.from(ch.sessions.values())[0];
    assert.equal(survivor.sessionId, 'win2');
});

test('register with modTags bundles them into the first refill query', async (t) => {
    const queries = [];
    const search = {
        runSearch({ q }) {
            queries.push(q);
            return Promise.resolve({ results: [{ _id: 1, file_ext: 'jpg' }, { _id: 2, file_ext: 'jpg' }], nextCursor: 0 });
        },
        clearCache() {},
    };
    const orch = withDefaultSession(createOrchestrator({
        search,
        broadcast: () => {},
        getCurrentTagsList: () => 0,
        getTagLists: () => [["baseTag"]],
    }));
    t.after(() => orch.close());
    const ws = makeFakeWs();
    orch.register(ws, {
        deviceId: 'kiosk1',
        interval: 5000,
        modTags: ['rating:s', '-blood'],
    });
    await tick(); await tick(); await tick();

    assert.ok(queries.length >= 1, 'expected at least one query from the first refill');
    assert.match(queries[0], /baseTag rating:s -blood/,
        'first query should already include modTags from slideshowConfig');
});

test('refill skips posts whose _id is in the blocklist', async (t) => {
    const { orch } = harness({ blockedIds: [2, 4] });
    t.after(() => orch.close());
    const ws = makeFakeWs();
    orch.register(ws, { deviceId: 'kiosk1', interval: 5000 });
    await tick(); await tick(); await tick();
    const last = ws.sent.filter((m) => m.action === 'playback').pop();
    const ids = [last.payload.current, ...last.payload.upcoming].map((e) => e.id);
    assert.ok(!ids.includes(2));
    assert.ok(!ids.includes(4));
});

test('refill skips posts whose tags intersect the blockedTags set', async (t) => {
    const { orch } = harness({
        blockedTags: ['gore'],
        pages: [{
            results: [
                { _id: 1, file_ext: 'jpg', tags: ['cats'] },
                { _id: 2, file_ext: 'jpg', tags: ['gore', 'cats'] },
                { _id: 3, file_ext: 'jpg', tags: ['cats'] },
                { _id: 4, file_ext: 'jpg', tags: ['cats'] },
                { _id: 5, file_ext: 'jpg', tags: ['cats'] },
            ],
            nextCursor: 0,
        }],
    });
    t.after(() => orch.close());
    const ws = makeFakeWs();
    orch.register(ws, { deviceId: 'kiosk1', interval: 5000 });
    await tick(); await tick(); await tick();
    const last = ws.sent.filter((m) => m.action === 'playback').pop();
    const ids = [last.payload.current, ...last.payload.upcoming].map((e) => e.id);
    assert.ok(!ids.includes(2));
});

test('blocked-tag matching goes through the injected expansion', async (t) => {
    // Blocking 'felid' must drop a post tagged only 'cat' when the expander
    // says cat resolves to felid — the unflattened-library case where the
    // post's array never contains the blocked ancestor itself.
    const { orch } = harness({
        blockedTags: ['felid'],
        expandBlockedTags: (tags) => new Set(tags.flatMap((tg) => (tg === 'felid' ? ['felid', 'cat'] : [tg]))),
        pages: [{
            results: [
                { _id: 1, file_ext: 'jpg', tags: ['dog'] },
                { _id: 2, file_ext: 'jpg', tags: ['cat'] },
                { _id: 3, file_ext: 'jpg', tags: ['bird'] },
                { _id: 4, file_ext: 'jpg', tags: ['fish'] },
                { _id: 5, file_ext: 'jpg', tags: ['lizard'] },
            ],
            nextCursor: 0,
        }],
    });
    t.after(() => orch.close());
    const ws = makeFakeWs();
    orch.register(ws, { deviceId: 'kiosk1', interval: 5000 });
    await tick(); await tick(); await tick();
    const last = ws.sent.filter((m) => m.action === 'playback').pop();
    const ids = [last.payload.current, ...last.payload.upcoming].map((e) => e.id);
    assert.ok(!ids.includes(2), 'post tagged cat must be dropped when felid is blocked');
    assert.ok(ids.includes(1));
});

test('setModTags clears queue and refills with the new query', async (t) => {
    const queries = [];
    const search = {
        runSearch({ q }) {
            queries.push(q);
            return Promise.resolve({ results: [{ _id: 10, file_ext: 'jpg' }, { _id: 11, file_ext: 'jpg' }], nextCursor: 0 });
        },
        clearCache() {},
    };
    const orch = withDefaultSession(createOrchestrator({
        search,
        broadcast: () => {},
        getCurrentTagsList: () => 0,
        getTagLists: () => [["baseTag"]],
    }));
    t.after(() => orch.close());
    const ws = makeFakeWs();
    orch.register(ws, { deviceId: 'kiosk1', interval: 5000 });
    await tick(); await tick(); await tick();

    queries.length = 0;
    orch.setModTags(ws, ['rating:s', '-blood']);
    await tick(); await tick();
    assert.match(queries[0], /baseTag rating:s -blood/);
});

test('setTagList changes only the sender channel; other channels keep their list', async (t) => {
    const queries = [];
    const lists = [['listA'], ['listB']];
    const search = {
        runSearch({ q }) {
            queries.push(q);
            return Promise.resolve({ results: [{ _id: 1, file_ext: 'jpg' }, { _id: 2, file_ext: 'jpg' }], nextCursor: 0 });
        },
        clearCache() {},
    };
    const orch = withDefaultSession(createOrchestrator({
        search,
        broadcast: () => {},
        getCurrentTagsList: () => 0,
        getTagLists: () => lists,
    }));
    t.after(() => orch.close());
    const a = makeFakeWs();
    const b = makeFakeWs();
    orch.register(a, { deviceId: 'kioskA', interval: 5000 });
    orch.register(b, { deviceId: 'kioskB', interval: 5000 });
    await tick(); await tick(); await tick();

    queries.length = 0;
    orch.setTagList(a, 1);
    await tick(); await tick();

    // kioskA refilled against listB; kioskB never re-queried.
    assert.ok(queries.some((q) => /listB/.test(q)), 'expected kioskA to query listB');
    assert.ok(!queries.some((q) => /listA/.test(q)), 'kioskB should not refill on a peer\'s setTagList');

    const aLast = a.sent.filter((m) => m.action === 'playback').pop();
    const bLast = b.sent.filter((m) => m.action === 'playback').pop();
    assert.equal(aLast.payload.currentList, 1);
    assert.equal(bLast.payload.currentList, 0);
});

test('sharedTags mode: setTagList on one channel switches every channel', async (t) => {
    const queries = [];
    const lists = [['listA'], ['listB']];
    let shared = true;
    const search = {
        runSearch({ q }) {
            queries.push(q);
            return Promise.resolve({ results: [{ _id: 1, file_ext: 'jpg' }, { _id: 2, file_ext: 'jpg' }], nextCursor: 0 });
        },
        clearCache() {},
    };
    const orch = withDefaultSession(createOrchestrator({
        search,
        broadcast: () => {},
        getCurrentTagsList: () => 0,
        getTagLists: () => lists,
        getSharedTags: () => shared,
    }));
    t.after(() => orch.close());
    const a = makeFakeWs();
    const b = makeFakeWs();
    orch.register(a, { deviceId: 'kioskA', interval: 5000 });
    orch.register(b, { deviceId: 'kioskB', interval: 5000 });
    await tick(); await tick(); await tick();

    queries.length = 0;
    orch.setTagList(a, 1);
    await tick(); await tick(); await tick();

    // Both channels requeried against the shared list index.
    const fromB = queries.filter((q) => /listB/.test(q));
    assert.ok(fromB.length >= 2, 'expected both channels to query listB');
    assert.ok(!queries.some((q) => /listA/.test(q)), 'no channel should keep listA');

    const aLast = a.sent.filter((m) => m.action === 'playback').pop();
    const bLast = b.sent.filter((m) => m.action === 'playback').pop();
    assert.equal(aLast.payload.currentList, 1);
    assert.equal(bLast.payload.currentList, 1, 'peer channel follows the shared list');
});

test('sharedTags mode: setModTags on one channel applies to every channel', async (t) => {
    const queries = [];
    let shared = true;
    const search = {
        runSearch({ q }) {
            queries.push(q);
            return Promise.resolve({ results: [{ _id: 1, file_ext: 'jpg' }, { _id: 2, file_ext: 'jpg' }], nextCursor: 0 });
        },
        clearCache() {},
    };
    const orch = withDefaultSession(createOrchestrator({
        search,
        broadcast: () => {},
        getCurrentTagsList: () => 0,
        getTagLists: () => [['baseTag']],
        getSharedTags: () => shared,
    }));
    t.after(() => orch.close());
    const a = makeFakeWs();
    const b = makeFakeWs();
    orch.register(a, { deviceId: 'kioskA', interval: 5000 });
    orch.register(b, { deviceId: 'kioskB', interval: 5000 });
    await tick(); await tick(); await tick();

    queries.length = 0;
    orch.setModTags(a, ['rating:s']);
    await tick(); await tick(); await tick();

    // Both channels picked up the shared mod tag.
    assert.ok(queries.filter((q) => /rating:s/.test(q)).length >= 2,
        'expected both channels to query the shared mod tag');

    const aLast = a.sent.filter((m) => m.action === 'playback').pop();
    const bLast = b.sent.filter((m) => m.action === 'playback').pop();
    assert.deepEqual(aLast.payload.modTags, ['rating:s']);
    assert.deepEqual(bLast.payload.modTags, ['rating:s'], 'peer channel follows the shared mod tags');
});

test('sharedTags off: setTagList stays per-channel (regression guard)', async (t) => {
    const lists = [['listA'], ['listB']];
    let shared = false;
    const search = {
        runSearch() {
            return Promise.resolve({ results: [{ _id: 1, file_ext: 'jpg' }, { _id: 2, file_ext: 'jpg' }], nextCursor: 0 });
        },
        clearCache() {},
    };
    const orch = withDefaultSession(createOrchestrator({
        search,
        broadcast: () => {},
        getCurrentTagsList: () => 0,
        getTagLists: () => lists,
        getSharedTags: () => shared,
    }));
    t.after(() => orch.close());
    const a = makeFakeWs();
    const b = makeFakeWs();
    orch.register(a, { deviceId: 'kioskA', interval: 5000 });
    orch.register(b, { deviceId: 'kioskB', interval: 5000 });
    await tick(); await tick(); await tick();

    orch.setTagList(a, 1);
    await tick(); await tick();

    const aLast = a.sent.filter((m) => m.action === 'playback').pop();
    const bLast = b.sent.filter((m) => m.action === 'playback').pop();
    assert.equal(aLast.payload.currentList, 1);
    assert.equal(bLast.payload.currentList, 0, 'peer keeps its own list when sharing is off');
});

function ratioHarness(t, { getRatioWindow } = {}) {
    const queries = [];
    const search = {
        runSearch({ q }) {
            queries.push(q);
            return Promise.resolve({ results: [{ _id: 1, file_ext: 'jpg' }, { _id: 2, file_ext: 'jpg' }], nextCursor: 0 });
        },
        clearCache() {},
    };
    const orch = withDefaultSession(createOrchestrator({
        search,
        broadcast: () => {},
        getCurrentTagsList: () => 0,
        getTagLists: () => [[]],
        getRatioWindow,
    }));
    t.after(() => orch.close());
    return { orch, queries };
}

test('channel ratio clause adopts the most-square advertiser, not the intersection (legacy range strings)', async (t) => {
    const { orch, queries } = ratioHarness(t);
    // A 16:9 landscape window (mid 1.78) and a near-square window (mid 1.0)
    // on one deviceId. Intersecting these would collapse to empty; the
    // channel should instead pick the squarer advertiser's range.
    const landscape = makeFakeWs();
    const squareish = makeFakeWs();
    orch.register(landscape, { deviceId: 'screen1', interval: 5000, ratio: '1.51..2.04' });
    orch.register(squareish, { deviceId: 'screen1', interval: 5000, ratio: '0.80..1.20' });
    await tick(); await tick(); await tick();

    queries.length = 0;
    orch.requestReshuffle(landscape); // rebuild the query with both sessions present
    await tick(); await tick();

    assert.ok(queries.length >= 1, 'reshuffle should rebuild the query');
    assert.ok(queries.every((q) => /ratio:0\.80\.\.1\.20/.test(q)),
        'channel should adopt the most-square advertiser\'s range');
    assert.ok(!queries.some((q) => /ratio:1\.51/.test(q)),
        'the landscape range must not win over the squarer one');
});

test('bare float ratio advert is expanded ±15% server-side; squarest wins', async (t) => {
    const { orch, queries } = ratioHarness(t);
    const landscape = makeFakeWs();
    const squareish = makeFakeWs();
    // Clients now send their raw aspect ratio; the server applies the window.
    orch.register(landscape, { deviceId: 'screen1', interval: 5000, ratio: 1.78 });
    orch.register(squareish, { deviceId: 'screen1', interval: 5000, ratio: 1.0 });
    await tick(); await tick(); await tick();

    queries.length = 0;
    orch.requestReshuffle(landscape);
    await tick(); await tick();

    assert.ok(queries.length >= 1, 'reshuffle should rebuild the query');
    // 1.0 is squarest → expanded to 0.85..1.15.
    assert.ok(queries.every((q) => /ratio:0\.85\.\.1\.15/.test(q)),
        'square float advert should be expanded by ±15% and win');
    assert.ok(!queries.some((q) => /ratio:1\.51/.test(q)),
        'the landscape float must not win over the squarer one');
});

test('numeric-string and float ratio adverts are treated identically', async (t) => {
    const { orch, queries } = ratioHarness(t);
    const ws = makeFakeWs();
    orch.register(ws, { deviceId: 'screen1', interval: 5000, ratio: '1.50' });
    await tick(); await tick(); await tick();

    queries.length = 0;
    orch.requestReshuffle(ws);
    await tick(); await tick();

    // 1.50 expanded ±15% → 1.275..1.725, formatted to 2dp as 1.27..1.72.
    assert.ok(queries.every((q) => /ratio:1\.27\.\.1\.72/.test(q)),
        'a numeric string advert should expand like a bare float');
});

test('ratio window comes from getRatioWindow and is read live on every query', async (t) => {
    let window = 0.10;
    const { orch, queries } = ratioHarness(t, { getRatioWindow: () => window });
    const ws = makeFakeWs();
    orch.register(ws, { deviceId: 'screen1', interval: 5000, ratio: 2.0 });
    await tick(); await tick(); await tick();

    queries.length = 0;
    orch.requestReshuffle(ws);
    await tick(); await tick();
    // ±10% of 2.0 → 1.80..2.20.
    assert.ok(queries.every((q) => /ratio:1\.80\.\.2\.20/.test(q)),
        'first query should use the initial window');

    // Change the config-backed value; no re-register needed.
    window = 0.25;
    queries.length = 0;
    orch.requeryAll();
    await tick(); await tick();
    // ±25% of 2.0 → 1.50..2.50.
    assert.ok(queries.length >= 1, 'requeryAll should rebuild active channels');
    assert.ok(queries.every((q) => /ratio:1\.50\.\.2\.50/.test(q)),
        'the new window must take effect without a restart or re-register');
});

test('invalid getRatioWindow values fall back to the 0.15 default', async (t) => {
    const { orch, queries } = ratioHarness(t, { getRatioWindow: () => 'nonsense' });
    const ws = makeFakeWs();
    orch.register(ws, { deviceId: 'screen1', interval: 5000, ratio: 2.0 });
    await tick(); await tick(); await tick();

    queries.length = 0;
    orch.requestReshuffle(ws);
    await tick(); await tick();
    // Falls back to ±15% → 1.70..2.30.
    assert.ok(queries.every((q) => /ratio:1\.70\.\.2\.30/.test(q)),
        'a non-numeric window should fall back to the default');
});
