'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { createOrchestrator } = require('../lib/orchestrator');
const { createImageCache } = require('../lib/imageCache');

function makeFakeSearch(pages) {
    let call = 0;
    return {
        async runSearch() {
            const page = pages[Math.min(call, pages.length - 1)];
            call += 1;
            return page;
        },
        clearCache() { call = 0; },
    };
}

function makeFakeWs() {
    return { readyState: 1, sent: [], send(d) { this.sent.push(JSON.parse(d)); } };
}

function captureRecorder() {
    const calls = [];
    return {
        calls,
        prefetcher: {
            schedule: ({ key, run }) => { calls.push({ key, run }); },
        },
    };
}

function harness({ visibility = {}, prefetchVariant } = {}) {
    const pages = [
        { results: Array.from({ length: 8 }, (_, i) => ({ _id: i + 1, file_ext: 'jxl' })), nextCursor: null },
    ];
    const rec = captureRecorder();
    const cache = createImageCache({ maxBytes: 1024 * 1024 });
    const orch = createOrchestrator({
        search: makeFakeSearch(pages),
        getCurrentTagsList: () => 0,
        getTagLists: () => [['cats']],
        getBlockedIds: () => [],
        getBlockedTags: () => [],
        prefetcher: rec.prefetcher,
        imageCache: cache,
        prefetchVariant: prefetchVariant || (async () => ({ buffer: Buffer.alloc(8), mime: 'image/jpeg', ext: 'jpg' })),
        getVisibility: (deviceId) => (deviceId in visibility ? visibility[deviceId] : true),
    });
    return { orch, rec, cache };
}

const tick = () => new Promise((r) => setImmediate(r));

test('commitCurrent schedules prefetch for visible session variants', async (t) => {
    const ctx = harness();
    t.after(() => ctx.orch.close());
    const ws = makeFakeWs();
    ctx.orch.register(ws, 's1', {
        deviceId: 'k1', interval: 3000, width: 1920, height: 1080, convert: true, bright: false, lowmem: false,
    });
    await tick(); await tick();
    // Adaptive depth at 3s = ceil(15000/3000) = 5, clamped to UPCOMING_COUNT=4.
    // Variants: 1. So 4 schedule calls expected.
    assert.ok(ctx.rec.calls.length >= 4, `expected >=4 prefetches, got ${ctx.rec.calls.length}`);
    for (const c of ctx.rec.calls) {
        assert.ok(c.key.includes('c1'), `key should encode convert=1: ${c.key}`);
        assert.ok(c.key.includes('w1920'));
    }
});

test('display off blocks prefetch entirely', async (t) => {
    const ctx = harness({ visibility: { k2: false } });
    t.after(() => ctx.orch.close());
    const ws = makeFakeWs();
    ctx.orch.register(ws, 's1', {
        deviceId: 'k2', interval: 2000, width: 800, height: 600, convert: true,
    });
    await tick(); await tick();
    assert.equal(ctx.rec.calls.length, 0);
});

test('two sessions with different variants → both variants prefetched per upcoming id', async (t) => {
    const ctx = harness();
    t.after(() => ctx.orch.close());
    const ws1 = makeFakeWs();
    const ws2 = makeFakeWs();
    ctx.orch.register(ws1, 's1', {
        deviceId: 'k3', interval: 15000, width: 1920, height: 1080, convert: true, lowmem: false,
    });
    await tick(); await tick();
    const beforeSecond = ctx.rec.calls.length;
    ctx.orch.register(ws2, 's2', {
        deviceId: 'k3', interval: 15000, width: 800, height: 600, convert: true, lowmem: true,
    });
    await tick(); await tick();
    // 15s interval → depth=1, only queue[1]. Two distinct variants now.
    const widths = new Set();
    for (const c of ctx.rec.calls) {
        const m = c.key.match(/w(\d+)/);
        if (m) widths.add(m[1]);
    }
    assert.ok(widths.has('1920'));
    assert.ok(widths.has('800'));
    assert.ok(ctx.rec.calls.length > beforeSecond);
});

test('adaptive depth: 15s interval → 1 image, 2s interval → 4 images', async (t) => {
    const slow = harness();
    t.after(() => slow.orch.close());
    slow.orch.register(makeFakeWs(), 's', { deviceId: 'kS', interval: 15000, width: 100, height: 100, convert: true });
    await tick(); await tick();
    const slowKeys = new Set(slow.rec.calls.map((c) => c.key));
    assert.equal(slowKeys.size, 1, `15s → 1 variant×1 image, got ${slowKeys.size}`);

    const fast = harness();
    t.after(() => fast.orch.close());
    fast.orch.register(makeFakeWs(), 's', { deviceId: 'kF', interval: 2000, width: 100, height: 100, convert: true });
    await tick(); await tick();
    const fastKeys = new Set(fast.rec.calls.map((c) => c.key));
    assert.equal(fastKeys.size, 4, `2s → 4 variants×1 image, got ${fastKeys.size}`);
});

test('already-cached variant is not re-scheduled', async (t) => {
    const ctx = harness();
    t.after(() => ctx.orch.close());
    // Pre-populate cache for id=2 (the next image after id=1).
    const parts = { id: 2, convert: true, bright: false, width: 1920, height: 1080, lowmem: false };
    await ctx.cache.getOrCompute(parts, async () => ({ buffer: Buffer.alloc(8), mime: 'image/jpeg', ext: 'jpg' }));
    ctx.orch.register(makeFakeWs(), 's1', {
        deviceId: 'kP', interval: 15000, width: 1920, height: 1080, convert: true,
    });
    await tick(); await tick();
    // 15s → depth=1, queue[1]=id 2, but already cached → no schedule.
    assert.equal(ctx.rec.calls.length, 0);
});

test('notifyVisibility(true) re-triggers prefetch', async (t) => {
    const visibility = { kV: false };
    const ctx = harness({ visibility });
    t.after(() => ctx.orch.close());
    ctx.orch.register(makeFakeWs(), 's1', { deviceId: 'kV', interval: 5000, width: 100, height: 100, convert: true });
    ctx.orch.notifyVisibility('kV', false);
    await tick(); await tick();
    assert.equal(ctx.rec.calls.length, 0);
    visibility.kV = true;
    ctx.orch.notifyVisibility('kV', true);
    await tick(); await tick();
    assert.ok(ctx.rec.calls.length > 0, 'prefetch should run after visibility on');
});
