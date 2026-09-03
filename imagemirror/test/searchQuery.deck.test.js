// Deck-rotation regression tests against the real DuckDB engine.
//
// The failure mode these guard lives in the interplay between the random
// cursor SQL and the display_count bumps: showing a post re-sorts it *after*
// the cursor, so a walking cursor is perpetually fed by the posts it just
// served, never runs off the deck's end, and everything at a lower
// (display_count, random_rank) is orphaned — the slideshow loops the small
// slice that happened to sit ahead of the cursor (e.g. above the random
// per-channel seed). A stubbed db can't exercise that feedback loop, so
// these tests run the actual ordering, cursor filter, and staleness probe
// on an in-memory database and simulate the orchestrator's
// fetch → show → bump cycle.

const test = require('node:test');
const assert = require('node:assert/strict');
const { DuckDBInstance } = require('@duckdb/node-api');
const { createSearch } = require('../lib/searchQuery');

// Minimal copy of index.js's callback shim — searchQuery only needs
// db.run(sql, cb) and db.all(sql, cb).
function wrapConnection(connection) {
    return {
        run(sql, cb) {
            connection.run(sql).then(() => cb && cb(null), (err) => cb && cb(err));
        },
        all(sql, paramsOrCb, maybeCb) {
            const cb = typeof paramsOrCb === 'function' ? paramsOrCb : maybeCb;
            connection.runAndReadAll(sql).then(
                (r) => cb && cb(null, r.getRowObjects()),
                (err) => cb && cb(err),
            );
        },
    };
}

// The schema slice searchQuery touches: file_db.posts / posts_paths and the
// memory.random_ranks deck. Ranks are deterministic (id / (n+1)) so the walk
// order — and therefore the whole test — is reproducible.
async function makeDeckDb(postCount) {
    const instance = await DuckDBInstance.create(':memory:');
    const db = wrapConnection(await instance.connect());
    const run = (sql) => new Promise((res, rej) => db.run(sql, (e) => (e ? rej(e) : res())));
    const all = (sql) => new Promise((res, rej) => db.all(sql, (e, rows) => (e ? rej(e) : res(rows || []))));
    await run(`ATTACH ':memory:' AS file_db;`);
    await run(`CREATE TABLE file_db.posts (_id BIGINT);`);
    await run(`CREATE TABLE file_db.posts_paths (_id BIGINT, path VARCHAR);`);
    await run(`CREATE TABLE random_ranks (_id BIGINT, random_rank DOUBLE, display_count BIGINT);`);
    await run(`INSERT INTO file_db.posts SELECT range FROM range(1, ${postCount + 1});`);
    await run(`INSERT INTO file_db.posts_paths SELECT range, '/p/' || range FROM range(1, ${postCount + 1});`);
    await run(`INSERT INTO random_ranks SELECT range, range / ${postCount + 1}.0, 0 FROM range(1, ${postCount + 1});`);
    return { db, run, all };
}

// The orchestrator's refill loop in miniature: page after the cursor, show
// (bump) every returned post, feed nextCursor back — null falls back to the
// deck head exactly like runRefill's `channel.cursor = nextCursor || null`.
async function showPages({ search, run, steps, cursor, blockedIds = [], origin = 0 }) {
    const seen = new Set();
    for (let i = 0; i < steps; i++) {
        const { results, nextCursor } = await search.runSearch({
            q: '', cursor: cursor || (origin ? { origin } : null), limit: 5, blockedIds,
        });
        cursor = nextCursor || null;
        for (const row of results) {
            const id = Number(row._id);
            seen.add(id);
            await run(`UPDATE random_ranks SET display_count = display_count + 1 WHERE _id = ${id};`);
        }
    }
    return { seen, cursor };
}

test('the walk covers the whole deck although shown posts re-sort ahead of the cursor', async () => {
    const { db, run, all } = await makeDeckDb(30);
    const search = createSearch({ db });

    // Seed near the deck's end, like a channel coming up. Without the
    // stale-cursor guard the walk locks onto the ~6 posts above the seed —
    // each show bumps them back ahead of the cursor — and loops them forever
    // while the other 24 sit orphaned behind it.
    let state = await showPages({ search, run, steps: 30, cursor: { dc: 0, rank: 0.8 } });
    assert.equal(state.seen.size, 30, 'first epoch must reach every post');

    // Rotation keeps going: a second epoch covers everything again.
    state = await showPages({ search, run, steps: 30, cursor: state.cursor });
    assert.equal(state.seen.size, 30, 'rotation must continue past the first pass');

    // Least-seen-first sanity: view counts stay balanced across the library.
    const rows = await all(`SELECT MAX(display_count) - MIN(display_count) AS spread FROM random_ranks;`);
    assert.ok(Number(rows[0].spread) <= 3, `view counts drifted apart (spread ${rows[0].spread})`);
});

test('blocked posts pinned at the deck floor neither wedge nor leak into the walk', async () => {
    const { db, run } = await makeDeckDb(30);
    const search = createSearch({ db });
    const blockedIds = [1, 2, 3];

    // A blocked post is never shown, so its display_count never moves. With
    // the blocklist applied in SQL it drops out of both the pages and the
    // staleness probe; were it left in, it would pin the least-seen tier and
    // force every page back onto rows the orchestrator discards.
    let state = await showPages({ search, run, steps: 30, cursor: { dc: 0, rank: 0.8 }, blockedIds });
    assert.equal(state.seen.size, 27, 'every unblocked post must be reached');
    for (const b of blockedIds) assert.ok(!state.seen.has(b), `blocked post ${b} was served`);

    state = await showPages({ search, run, steps: 30, cursor: state.cursor, blockedIds });
    assert.equal(state.seen.size, 27, 'unblocked rotation must continue');
    for (const b of blockedIds) assert.ok(!state.seen.has(b), `blocked post ${b} was served`);
});

// A channel's rotation of the deck: the walk opens at the origin's rank in
// the least-seen tier, runs to the deck's end, wraps through rank 0 back up
// to the origin, and only then moves on to the next tier. It must still
// reach every post, epoch after epoch.
test('a rotated walk wraps within its tier and still covers the whole deck', async () => {
    const { db, run, all } = await makeDeckDb(30);
    const search = createSearch({ db });

    // Ranks are id/31, so origin 0.9 opens on ids 28..30, then wraps to 1, 2.
    const first = await search.runSearch({ q: '', cursor: { origin: 0.9 }, limit: 5 });
    assert.deepEqual(first.results.map((r) => Number(r._id)), [28, 29, 30, 1, 2]);
    assert.deepEqual(first.nextCursor, { dc: 0, rank: 2 / 31, origin: 0.9 });
    const second = await search.runSearch({ q: '', cursor: first.nextCursor, limit: 5 });
    assert.deepEqual(second.results.map((r) => Number(r._id)), [3, 4, 5, 6, 7]);

    let state = await showPages({ search, run, steps: 30, origin: 0.9 });
    assert.equal(state.seen.size, 30, 'first epoch must reach every post');
    state = await showPages({ search, run, steps: 30, cursor: state.cursor, origin: 0.9 });
    assert.equal(state.seen.size, 30, 'rotation must continue past the first pass');
    const rows = await all(`SELECT MAX(display_count) - MIN(display_count) AS spread FROM random_ranks;`);
    assert.ok(Number(rows[0].spread) <= 3, `view counts drifted apart (spread ${rows[0].spread})`);
});

// The restart scenario: the deck snapshot survives a server restart, so on a
// library that has been walked once every post sits at display_count 1 and
// there is no dc=0 tier for a seed to land in. Three windows coming up
// together must still open on different posts — a shared origin would put
// the same head page on every wall.
test('channels opening on a once-seen deck start at their own origins', async () => {
    const { db, run } = await makeDeckDb(60);
    const search = createSearch({ db });
    await run(`UPDATE random_ranks SET display_count = 1;`);

    const pages = [];
    for (const origin of [0.1, 0.5, 0.8]) {
        const { results } = await search.runSearch({ q: '', cursor: { origin }, limit: 10 });
        pages.push(results.map((r) => Number(r._id)));
    }
    assert.deepEqual(pages[0], [7, 8, 9, 10, 11, 12, 13, 14, 15, 16]);
    assert.deepEqual(pages[1], [31, 32, 33, 34, 35, 36, 37, 38, 39, 40]);
    assert.deepEqual(pages[2], [49, 50, 51, 52, 53, 54, 55, 56, 57, 58]);
});

// Two channels sharing a deck eventually meet: when only a sliver of the
// least-seen tier is left, both cursors point at it. Excluding what the
// other channel has already queued makes them take disjoint pages of that
// sliver instead of showing the same posts in the same order.
test('excludeIds make two channels leapfrog through a contested tier', async () => {
    const { db, run } = await makeDeckDb(30);
    const search = createSearch({ db });
    await run(`UPDATE random_ranks SET display_count = 1 WHERE _id <= 20;`);

    // Both channels want the ten dc=0 posts (21..30). A has queued 21..25.
    const a = await search.runSearch({ q: '', cursor: { origin: 0.2 }, limit: 5 });
    assert.deepEqual(a.results.map((r) => Number(r._id)), [21, 22, 23, 24, 25]);
    const b = await search.runSearch({ q: '', cursor: { origin: 0.4 }, limit: 5, excludeIds: [21, 22, 23, 24, 25] });
    assert.deepEqual(b.results.map((r) => Number(r._id)), [26, 27, 28, 29, 30]);

    // When the exclusions leave nothing, the page is served regardless.
    const c = await search.runSearch({
        q: '', cursor: { origin: 0.4 }, limit: 5,
        excludeIds: [21, 22, 23, 24, 25, 26, 27, 28, 29, 30, ...Array.from({ length: 20 }, (_, i) => i + 1)],
    });
    assert.equal(c.results.length, 5);
});
