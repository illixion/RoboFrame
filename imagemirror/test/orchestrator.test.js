// Unit tests for the slideshow orchestrator. Drives the orchestrator
// directly with a fake search and a captured-broadcast spy — no HTTP, no
// real WebSocket — so we can verify the channel behaviour deterministically.

const test = require('node:test');
const assert = require('node:assert/strict');
const { createOrchestrator } = require('../lib/orchestrator');

function makeFakeSearch(pages) {
    let call = 0;
    return {
        async runSearch() {
            const page = pages[Math.min(call, pages.length - 1)];
            call += 1;
            return page;
        },
        clearCache() { call = 0; },
        get callCount() { return call; },
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

// `pages` is consumed shared across all channels (the fake search returns
// the next page on each call regardless of which channel asked). Tests that
// need per-channel isolation provide explicit pages or override.
function harness({ tagLists = [['cats']], pages, blockedIds = [], blockedTags = [] } = {}) {
    const broadcasts = [];
    const broadcast = (msg) => broadcasts.push(msg);
    const search = makeFakeSearch(pages || [
        { results: [{ _id: 1, file_ext: 'jpg' }, { _id: 2, file_ext: 'jpg' }, { _id: 3, file_ext: 'jpg' }], nextCursor: 0.3 },
        { results: [{ _id: 4, file_ext: 'jpg' }, { _id: 5, file_ext: 'jpg' }], nextCursor: 0 },
    ]);
    let currentList = 0;
    let blockIds = blockedIds.slice();
    let blockTags = blockedTags.slice();
    const orch = createOrchestrator({
        search,
        broadcast,
        getCurrentTagsList: () => currentList,
        setCurrentTagsList: (n) => { currentList = n; },
        getTagLists: () => tagLists,
        getBlockedIds: () => blockIds,
        getBlockedTags: () => blockTags,
    });
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

// Walk the readiness barrier: all expected ws on the channel report
// imageReady for the channel's currentId. Returns the id they reported.
function reportAllReady(orch, deviceId) {
    const channel = orch._channels.get(deviceId);
    if (!channel) return null;
    const id = channel.currentId;
    for (const ws of channel.expectedReady) {
        orch.notifyImageReady(ws, id);
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

test('readiness barrier: dwell timer waits for all expected ws to report imageReady', async (t) => {
    const { orch } = harness();
    t.after(() => orch.close());
    const a = makeFakeWs();
    const b = makeFakeWs();
    orch.register(a, { deviceId: 'screen1', interval: 5000 });
    orch.register(b, { deviceId: 'screen1', interval: 5000 });
    await tick(); await tick(); await tick();

    const ch = orch._channels.get('screen1');
    assert.equal(ch.phase, 'loading', 'channel waits in loading until clients report ready');
    assert.equal(ch.expectedReady.size, 2);
    assert.equal(ch.timer, null, 'no dwell timer before barrier closes');

    orch.notifyImageReady(a, ch.currentId);
    assert.equal(ch.phase, 'loading', 'one of two reports is not enough');
    assert.equal(ch.timer, null);

    orch.notifyImageReady(b, ch.currentId);
    assert.equal(ch.phase, 'displaying');
    assert.ok(ch.timer, 'dwell timer arms once everyone reports');
});

test('readiness fallback: 10s timer is armed while loading so a wedged client cannot stall the channel forever', async (t) => {
    const { orch } = harness();
    t.after(() => orch.close());
    const a = makeFakeWs();
    const b = makeFakeWs();
    orch.register(a, { deviceId: 'screen1', interval: 5000 });
    orch.register(b, { deviceId: 'screen1', interval: 5000 });
    await tick(); await tick(); await tick();
    const ch = orch._channels.get('screen1');
    assert.equal(ch.phase, 'loading');
    // The timer's existence is the contract; firing happens 10s out and
    // is cleaned up by orch.close() in the test teardown.
    assert.ok(ch.readinessTimer);
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

test('displaySync: driver disconnect auto-releases the merge', async (t) => {
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
    orch.unregister(a);
    assert.equal(orch._state().mergeDriverDeviceId, null,
        'driver dropped → merge released, remaining channels resume');
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
    const orch = createOrchestrator({
        search,
        broadcast: () => {},
        getCurrentTagsList: () => 0,
        setCurrentTagsList: () => {},
        getTagLists: () => [['baseTag']],
    });
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

test('setModTags clears queue and refills with the new query', async (t) => {
    const queries = [];
    const search = {
        runSearch({ q }) {
            queries.push(q);
            return Promise.resolve({ results: [{ _id: 10, file_ext: 'jpg' }, { _id: 11, file_ext: 'jpg' }], nextCursor: 0 });
        },
        clearCache() {},
    };
    const orch = createOrchestrator({
        search,
        broadcast: () => {},
        getCurrentTagsList: () => 0,
        setCurrentTagsList: () => {},
        getTagLists: () => [['baseTag']],
    });
    t.after(() => orch.close());
    const ws = makeFakeWs();
    orch.register(ws, { deviceId: 'kiosk1', interval: 5000 });
    await tick(); await tick(); await tick();

    queries.length = 0;
    orch.setModTags(ws, ['rating:s', '-blood']);
    await tick(); await tick();
    assert.match(queries[0], /baseTag rating:s -blood/);
});

test('notifyTagListChange refills every active channel with the new list', async (t) => {
    const queries = [];
    let listIdx = 0;
    const lists = [['listA'], ['listB']];
    const search = {
        runSearch({ q }) {
            queries.push(q);
            return Promise.resolve({ results: [{ _id: 1, file_ext: 'jpg' }, { _id: 2, file_ext: 'jpg' }], nextCursor: 0 });
        },
        clearCache() {},
    };
    const orch = createOrchestrator({
        search,
        broadcast: () => {},
        getCurrentTagsList: () => listIdx,
        setCurrentTagsList: (n) => { listIdx = n; },
        getTagLists: () => lists,
    });
    t.after(() => orch.close());
    const ws = makeFakeWs();
    orch.register(ws, { deviceId: 'kiosk1', interval: 5000 });
    await tick(); await tick(); await tick();

    queries.length = 0;
    listIdx = 1;
    orch.notifyTagListChange();
    await tick(); await tick();
    assert.match(queries[0], /listB/);
});
