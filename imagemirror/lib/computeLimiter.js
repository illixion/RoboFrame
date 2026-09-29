'use strict';

// Bounded, two-priority runner for image variant computes (djxl + sharp).
//
// Every compute decodes a full-resolution original — a 24 MP JXL is ~100 MB
// of PNG plus libvips' working set — so the number in flight is what bounds
// the server's transient memory, not the variant cache's byte cap. Both the
// /get miss path and the prefetcher go through one limiter.
//
// Interactive work (a client waiting on /get) always runs before background
// work (prefetch), and background work may hold at most `concurrency - 1`
// slots, so a burst of prefetches can never make a viewer wait for a whole
// decode to drain. A queued background task can be promoted by key: /get
// joins an in-flight prefetch through the variant cache's single-flight
// promise, so it promotes that key first rather than waiting behind the
// rest of the prefetch queue.

function createComputeLimiter({ concurrency = 2 } = {}) {
    const limit = Math.max(1, Math.floor(concurrency));
    const backgroundLimit = Math.max(1, limit - 1);
    const interactive = [];
    const background = [];
    let running = 0;
    let runningBackground = 0;

    function pump() {
        while (running < limit) {
            let task = interactive.shift();
            if (!task) {
                if (runningBackground >= backgroundLimit || background.length === 0) return;
                task = background.shift();
            }
            start(task);
        }
    }

    function start(task) {
        running += 1;
        const bg = task.priority === 'background';
        if (bg) runningBackground += 1;
        Promise.resolve()
            .then(task.fn)
            .then(task.resolve, task.reject)
            .finally(() => {
                running -= 1;
                if (bg) runningBackground -= 1;
                pump();
            });
    }

    function run(fn, { priority = 'interactive', key = null } = {}) {
        return new Promise((resolve, reject) => {
            const task = { fn, resolve, reject, priority, key };
            (priority === 'background' ? background : interactive).push(task);
            pump();
        });
    }

    // Move a queued background task with this key to the interactive queue.
    function promote(key) {
        const i = background.findIndex((t) => t.key === key);
        if (i === -1) return false;
        const [task] = background.splice(i, 1);
        task.priority = 'interactive';
        interactive.push(task);
        pump();
        return true;
    }

    function stats() {
        return { running, runningBackground, queuedInteractive: interactive.length, queuedBackground: background.length, limit };
    }

    return { run, promote, stats };
}

module.exports = { createComputeLimiter };
