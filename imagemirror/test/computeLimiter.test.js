'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { createComputeLimiter } = require('../lib/computeLimiter');

// A task that stays in flight until released, recording its start.
function gate(log, name) {
    let release;
    const done = new Promise((r) => { release = r; });
    return {
        fn: () => { log.push(name); return done.then(() => name); },
        release: () => release(),
    };
}

const tick = () => new Promise((r) => setImmediate(r));

test('never runs more than `concurrency` tasks at once', async () => {
    const lim = createComputeLimiter({ concurrency: 2 });
    const log = [];
    const gates = [1, 2, 3].map((n) => gate(log, `i${n}`));
    const results = gates.map((g) => lim.run(g.fn));
    await tick();
    assert.deepEqual(log, ['i1', 'i2']);
    gates[0].release();
    await results[0];
    await tick();
    assert.deepEqual(log, ['i1', 'i2', 'i3']);
    gates[1].release();
    gates[2].release();
    assert.deepEqual(await Promise.all(results), ['i1', 'i2', 'i3']);
});

test('background work leaves a slot free for interactive work', async () => {
    const lim = createComputeLimiter({ concurrency: 2 });
    const log = [];
    const bg = [1, 2, 3].map((n) => gate(log, `b${n}`));
    bg.forEach((g) => lim.run(g.fn, { priority: 'background' }));
    await tick();
    assert.deepEqual(log, ['b1'], 'only concurrency-1 background tasks start');
    const fg = gate(log, 'i1');
    const fgDone = lim.run(fg.fn);
    await tick();
    assert.deepEqual(log, ['b1', 'i1'], 'interactive runs immediately in the reserved slot');
    fg.release();
    assert.equal(await fgDone, 'i1');
    bg.forEach((g) => g.release());
});

test('queued interactive work runs before queued background work', async () => {
    const lim = createComputeLimiter({ concurrency: 1 });
    const log = [];
    const first = gate(log, 'i0');
    const firstDone = lim.run(first.fn);
    const b = gate(log, 'b1');
    lim.run(b.fn, { priority: 'background' });
    const i = gate(log, 'i1');
    const iDone = lim.run(i.fn);
    await tick();
    first.release();
    await firstDone;
    await tick();
    assert.deepEqual(log, ['i0', 'i1']);
    i.release();
    await iDone;
    await tick();
    assert.deepEqual(log, ['i0', 'i1', 'b1']);
    b.release();
});

test('promote moves a queued background task ahead of the prefetch queue', async () => {
    const lim = createComputeLimiter({ concurrency: 2 });
    const log = [];
    const b1 = gate(log, 'b1');
    const b2 = gate(log, 'b2');
    const b3 = gate(log, 'b3');
    lim.run(b1.fn, { priority: 'background', key: 'k1' });
    lim.run(b2.fn, { priority: 'background', key: 'k2' });
    lim.run(b3.fn, { priority: 'background', key: 'k3' });
    await tick();
    assert.deepEqual(log, ['b1']);
    assert.equal(lim.promote('k3'), true);
    await tick();
    assert.deepEqual(log, ['b1', 'b3'], 'promoted task took the interactive slot');
    assert.equal(lim.promote('missing'), false);
    [b1, b2, b3].forEach((g) => g.release());
});

test('a rejecting task frees its slot and rejects its caller', async () => {
    const lim = createComputeLimiter({ concurrency: 1 });
    await assert.rejects(lim.run(() => Promise.reject(new Error('boom'))), /boom/);
    assert.equal(await lim.run(() => 'ok'), 'ok');
    await tick();
    assert.equal(lim.stats().running, 0);
});
