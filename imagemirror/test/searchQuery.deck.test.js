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
async function showPages({ search, run, steps, cursor, blockedIds = [] }) {
    const seen = new Set();
    for (let i = 0; i < steps; i++) {
        const { results, nextCursor } = await search.runSearch({ q: '', cursor, limit: 5, blockedIds });
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
