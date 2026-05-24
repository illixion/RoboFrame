'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { createImageCache, keyOf } = require('../lib/imageCache');

function makeBuffer(bytes) {
    return Buffer.alloc(bytes, 0xab);
}

test('keyOf folds animated variants to a single key', () => {
    const a = keyOf({ id: 7, animated: true, convert: true, width: 1920, height: 1080 });
    const b = keyOf({ id: 7, animated: true });
    assert.equal(a, b);
    assert.notEqual(a, keyOf({ id: 7 }));
});

test('keyOf is variant-aware', () => {
    const base = { id: 1, convert: true, bright: false, width: 1920, height: 1080, lowmem: false };
    const k1 = keyOf(base);
    const k2 = keyOf({ ...base, lowmem: true });
    const k3 = keyOf({ ...base, width: 3840 });
    assert.notEqual(k1, k2);
    assert.notEqual(k1, k3);
});

test('LRU eviction respects maxBytes', async () => {
    const cache = createImageCache({ maxBytes: 1000 });
    let n = 0;
    async function fill(id) {
        return cache.getOrCompute({ id, convert: false, bright: false, width: 100, height: 100, lowmem: false }, async () => ({
            buffer: makeBuffer(400),
            mime: 'image/jpeg',
            ext: 'jpg',
        }));
    }
    await fill(1);
    await fill(2);
    // Both fit (800 bytes). Insert a third, evicts the LRU (id=1).
    await fill(3);
    const stats = cache.stats();
    assert.ok(stats.bytes <= 1000, `bytes=${stats.bytes}`);
    // id=1 must be evicted; peek should miss
    assert.equal(cache.peek(keyOf({ id: 1, convert: false, bright: false, width: 100, height: 100, lowmem: false })), null);
    assert.ok(cache.peek(keyOf({ id: 3, convert: false, bright: false, width: 100, height: 100, lowmem: false })));
});

test('single-flight: concurrent getOrCompute invokes compute once', async () => {
    const cache = createImageCache({ maxBytes: 1024 * 1024 });
    let calls = 0;
    let resolveCompute;
    const computePromise = new Promise((r) => { resolveCompute = r; });
    const parts = { id: 42, convert: true, bright: false, width: 1920, height: 1080, lowmem: false };
    const compute = async () => {
        calls += 1;
        await computePromise;
        return { buffer: makeBuffer(128), mime: 'image/jpeg', ext: 'jpg' };
    };
    const p1 = cache.getOrCompute(parts, compute);
    const p2 = cache.getOrCompute(parts, compute);
    const p3 = cache.getOrCompute(parts, compute);
    resolveCompute();
    const [a, b, c] = await Promise.all([p1, p2, p3]);
    assert.equal(calls, 1);
    assert.equal(a.buffer, b.buffer);
    assert.equal(b.buffer, c.buffer);
});

test('peek does not touch LRU position', async () => {
    const cache = createImageCache({ maxBytes: 800 });
    const mk = (id) => cache.getOrCompute({ id, convert: false, bright: false, width: 1, height: 1, lowmem: false }, async () => ({
        buffer: makeBuffer(300), mime: 'image/jpeg', ext: 'jpg',
    }));
    await mk(1);
    await mk(2);
    // Peek id=1 — must not promote it above id=2.
    cache.peek(keyOf({ id: 1, convert: false, bright: false, width: 1, height: 1, lowmem: false }));
    await mk(3); // evicts oldest, which should be id=1
    assert.equal(cache.peek(keyOf({ id: 1, convert: false, bright: false, width: 1, height: 1, lowmem: false })), null);
});

test('evictPost drops every variant for an id', async () => {
    const cache = createImageCache({ maxBytes: 1024 * 1024 });
    const variants = [
        { id: 9, convert: false, bright: false, width: 100, height: 100, lowmem: false },
        { id: 9, convert: true, bright: false, width: 1920, height: 1080, lowmem: false },
        { id: 9, convert: true, bright: true, width: 1920, height: 1080, lowmem: true },
        { id: 10, convert: false, bright: false, width: 1, height: 1, lowmem: false },
    ];
    for (const v of variants) {
        await cache.getOrCompute(v, async () => ({ buffer: makeBuffer(64), mime: 'image/jpeg', ext: 'jpg' }));
    }
    cache.evictPost(9);
    for (const v of variants.slice(0, 3)) {
        assert.equal(cache.peek(keyOf(v)), null);
    }
    assert.ok(cache.peek(keyOf(variants[3])));
});
