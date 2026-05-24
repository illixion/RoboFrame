'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { createPrefetcher } = require('../lib/prefetcher');

const tick = () => new Promise((r) => setImmediate(r));

test('duplicate keys collapse to a single run', async () => {
    let runs = 0;
    const p = createPrefetcher({ concurrency: 2 });
    p.schedule({ key: 'a', run: async () => { runs += 1; } });
    p.schedule({ key: 'a', run: async () => { runs += 1; } });
    p.schedule({ key: 'a', run: async () => { runs += 1; } });
    await tick(); await tick();
    assert.equal(runs, 1);
});

test('concurrency limit gates active runs', async () => {
    let active = 0;
    let peak = 0;
    const gate = [];
    const p = createPrefetcher({ concurrency: 2 });
    for (let i = 0; i < 5; i++) {
        p.schedule({
            key: `k${i}`,
            run: async () => {
                active += 1;
                peak = Math.max(peak, active);
                await new Promise((r) => gate.push(r));
                active -= 1;
            },
        });
    }
    // Let the first batch enter
    await tick(); await tick();
    assert.equal(peak, 2);
    // Drain
    while (gate.length) gate.shift()();
    await tick(); await tick(); await tick();
});

test('disabled prefetcher drops jobs silently', async () => {
    let runs = 0;
    const p = createPrefetcher({ concurrency: 2, enabled: false });
    p.schedule({ key: 'a', run: async () => { runs += 1; } });
    await tick();
    assert.equal(runs, 0);
});

test('errors do not halt the queue', async () => {
    let ok = 0;
    let errs = 0;
    const p = createPrefetcher({
        concurrency: 1,
        onError: () => { errs += 1; },
    });
    p.schedule({ key: 'a', run: async () => { throw new Error('boom'); } });
    p.schedule({ key: 'b', run: async () => { ok += 1; } });
    await tick(); await tick(); await tick();
    assert.equal(ok, 1);
    assert.equal(errs, 1);
});

test('a key re-enters the queue after its run completes', async () => {
    let runs = 0;
    const p = createPrefetcher({ concurrency: 1 });
    p.schedule({ key: 'a', run: async () => { runs += 1; } });
    await tick(); await tick();
    p.schedule({ key: 'a', run: async () => { runs += 1; } });
    await tick(); await tick();
    assert.equal(runs, 2);
});
