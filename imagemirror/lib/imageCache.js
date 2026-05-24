'use strict';

// Variant-aware in-memory image cache for the /get response pipeline.
//
// Cache key fingerprints the full set of inputs that change the encoded
// bytes — id, convert, bright, width, height, lowmem, animated. Animated
// WebP output is variant-independent (no resize, no quality variants), so
// the animated path collapses to `{id, animated:true}`.
//
// Behaviour:
//   - Strict LRU by lastUsedAt with a byte cap (maxBytes). Eviction runs
//     after each insert; an entry larger than the cap evicts itself.
//   - Single-flight: concurrent getOrCompute() calls for the same key
//     share a Promise. The compute is invoked exactly once; the prefetcher
//     and a racing /get see the same buffer.
//   - peek() is the dedup probe for the prefetcher — it returns hit/miss
//     without touching LRU position so a stale prefetch can't keep a
//     never-displayed variant alive.
//   - evictPost(id) drops every variant for that id; used on blocklist add.

function keyOf(parts) {
    const id = Number(parts.id) || 0;
    if (parts.animated) return `${id}|anim`;
    const convert = parts.convert ? 1 : 0;
    const bright = parts.bright ? 1 : 0;
    const lowmem = parts.lowmem ? 1 : 0;
    const width = Number(parts.width) || 0;
    const height = Number(parts.height) || 0;
    return `${id}|c${convert}|b${bright}|l${lowmem}|w${width}|h${height}`;
}

function createImageCache({ maxBytes = 256 * 1024 * 1024 } = {}) {
    const entries = new Map();          // key → entry
    const inflight = new Map();         // key → Promise<entry>
    let totalBytes = 0;
    let hits = 0;
    let misses = 0;
    let evictions = 0;

    function touch(key, entry) {
        entry.lastUsedAt = Date.now();
        // Re-insert to push to the end of Map insertion order (LRU tail = MRU).
        entries.delete(key);
        entries.set(key, entry);
    }

    function evictToFit() {
        if (totalBytes <= maxBytes) return;
        for (const [k, e] of entries) {
            if (totalBytes <= maxBytes) break;
            entries.delete(k);
            totalBytes -= e.bytes;
            evictions += 1;
        }
    }

    function get(key) {
        const e = entries.get(key);
        if (!e) { misses += 1; return null; }
        hits += 1;
        touch(key, e);
        return e;
    }

    function peek(key) {
        return entries.get(key) || null;
    }

    function set(key, value) {
        const bytes = value.buffer ? value.buffer.length : 0;
        const entry = {
            buffer: value.buffer,
            mime: value.mime,
            ext: value.ext,
            id: value.id,
            bytes,
            lastUsedAt: Date.now(),
            computedAt: Date.now(),
        };
        const prev = entries.get(key);
        if (prev) totalBytes -= prev.bytes;
        entries.set(key, entry);
        totalBytes += bytes;
        evictToFit();
        return entry;
    }

    async function getOrCompute(parts, computeFn) {
        const key = keyOf(parts);
        const hit = entries.get(key);
        if (hit) {
            hits += 1;
            touch(key, hit);
            return hit;
        }
        const pending = inflight.get(key);
        if (pending) return pending;
        misses += 1;
        const p = (async () => {
            try {
                const value = await computeFn();
                if (!value || !value.buffer) {
                    throw new Error('imageCache compute returned no buffer');
                }
                return set(key, { ...value, id: Number(parts.id) || 0 });
            } finally {
                inflight.delete(key);
            }
        })();
        inflight.set(key, p);
        return p;
    }

    function evictPost(id) {
        const numericId = Number(id);
        for (const [k, e] of entries) {
            if (e.id === numericId) {
                entries.delete(k);
                totalBytes -= e.bytes;
                evictions += 1;
            }
        }
    }

    function clear() {
        entries.clear();
        totalBytes = 0;
    }

    function stats() {
        return {
            entries: entries.size,
            bytes: totalBytes,
            maxBytes,
            hits,
            misses,
            evictions,
            inflight: inflight.size,
        };
    }

    return { get, peek, set, getOrCompute, evictPost, clear, stats, keyOf };
}

module.exports = { createImageCache, keyOf };
