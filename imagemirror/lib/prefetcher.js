'use strict';

// Concurrency-limited background prefetcher.
//
// The orchestrator calls schedule({key, run}) for each (postId, variant)
// it wants warmed. Duplicate keys already enqueued or in-flight collapse
// to one job. `run` is expected to return a Promise — typically a call
// to imageCache.getOrCompute, which itself is single-flight, so a /get
// race against the prefetcher resolves through the same compute.
//
// Workers are unbounded in number but `concurrency` slots gate the
// number of active runs. djxl + sharp are CPU-bound; running more than
// 2-3 in parallel pessimises throughput.

function createPrefetcher({ concurrency = 2, enabled = true, onError = null } = {}) {
    const queue = [];
    const known = new Set();        // keys queued or in-flight
    let active = 0;

    function schedule({ key, run }) {
        if (!enabled) return;
        if (known.has(key)) return;
        known.add(key);
        queue.push({ key, run });
        pump();
    }

    function pump() {
        while (active < concurrency && queue.length > 0) {
            const job = queue.shift();
            active += 1;
            Promise.resolve()
                .then(() => job.run())
                .catch((err) => {
                    if (onError) {
                        try { onError(err, job.key); } catch (_) { /* ignore */ }
                    }
                })
                .finally(() => {
                    active -= 1;
                    known.delete(job.key);
                    pump();
                });
        }
    }

    function setEnabled(v) { enabled = !!v; if (enabled) pump(); }

    function stats() {
        return { active, queued: queue.length, enabled, concurrency };
    }

    function clear() {
        queue.length = 0;
        known.clear();
    }

    return { schedule, setEnabled, stats, clear };
}

module.exports = { createPrefetcher };
