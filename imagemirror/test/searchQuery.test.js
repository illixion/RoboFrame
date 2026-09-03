// Run via the workspace's `npm test` (or `node --test test/searchQuery.test.js`).
// No external test framework — uses node's built-in test runner with a
// hand-stubbed `db` that captures the SQL each method emits.
//
// The search layer materializes one temp table of matching ids per distinct
// WHERE clause and serves every page / count / one-shot pick from it, so the
// stub answers three SQL shapes: CREATE (set build), COUNT (set size), and
// everything else (page queries → the configured rows).

const test = require('node:test');
const assert = require('node:assert/strict');
const { createSearch } = require('../lib/searchQuery');

function stubDb({ rows = [], count = 1, stale = false } = {}) {
    const state = { rows, count, stale };
    const calls = [];
    return {
        state,
        calls,
        creates() { return calls.filter((s) => /CREATE OR REPLACE TEMP TABLE/.test(s)); },
        drops() { return calls.filter((s) => /DROP TABLE IF EXISTS/.test(s)); },
        probes() { return calls.filter((s) => /AS stale/.test(s)); },
        pages() {
            return calls.filter((s) => !/CREATE OR REPLACE TEMP TABLE|COUNT\(\*\)|DROP TABLE|AS stale/.test(s));
        },
        run(sql, cb) {
            calls.push(sql);
            cb(null);
        },
        all(sql, paramsOrCb, maybeCb) {
            const cb = typeof paramsOrCb === 'function' ? paramsOrCb : maybeCb;
            calls.push(sql);
            if (/COUNT\(\*\)/.test(sql)) return cb(null, [{ n: BigInt(state.count) }]);
            if (/AS stale/.test(sql)) return cb(null, state.stale ? [{ stale: 1 }] : []);
            cb(null, state.rows);
        },
    };
}

test('set build carries the tag filter and orphan guard; pages do not rescan', async () => {
    const db = stubDb({ rows: [{ _id: 7n, path: '/x/7.jxl' }] });
    const search = createSearch({ db });
    const row = await search.runRandomOne({ q: 'cats' });

    assert.deepEqual(row, { _id: 7n, path: '/x/7.jxl' });
    const creates = db.creates();
    assert.equal(creates.length, 1);
    assert.match(creates[0], /p\.tags && ARRAY\['cats'\]/);
    assert.match(creates[0], /EXISTS \(SELECT 1 FROM file_db\.posts_paths/);
    // The page query works off the set — no tag filter, no orphan guard.
    const pages = db.pages();
    assert.equal(pages.length, 1);
    assert.match(pages[0], /ORDER BY RANDOM\(\)/);
    assert.match(pages[0], /LIMIT 1/);
    assert.doesNotMatch(pages[0], /@>/);
});

test('one set serves runSearch across cursors, limits, and order variants', async () => {
    const db = stubDb({ rows: [] });
    const search = createSearch({ db });
    await search.runSearch({ q: 'cats' });
    await search.runSearch({ q: 'cats', cursor: { dc: 0, rank: 0.5 } });
    await search.runSearch({ q: 'cats', limit: 5 });
    await search.runSearch({ q: 'cats limit:7' });
    await search.runSearch({ q: 'cats order:id' });
    assert.equal(db.creates().length, 1);
});

test('concurrent same-query callers share one in-flight build', async () => {
    const pendingRuns = [];
    const calls = [];
    const db = {
        run(sql, cb) { calls.push(sql); pendingRuns.push(cb); },
        all(sql, paramsOrCb, maybeCb) {
            const cb = typeof paramsOrCb === 'function' ? paramsOrCb : maybeCb;
            calls.push(sql);
            if (/COUNT\(\*\)/.test(sql)) return cb(null, [{ n: 3n }]);
            cb(null, []);
        },
    };
    const search = createSearch({ db });
    const a = search.runSearch({ q: 'cats' });
    const b = search.runSearch({ q: 'cats' });
    assert.equal(pendingRuns.length, 1); // one CREATE for both callers
    pendingRuns[0](null);
    await Promise.all([a, b]);
    assert.equal(calls.filter((s) => /CREATE/.test(s)).length, 1);
});

test('least-recently-used set is evicted and rebuilt on return', async () => {
    const db = stubDb({ rows: [] });
    const search = createSearch({ db, maxSets: 2 });
    await search.runSearch({ q: 'one' });
    await search.runSearch({ q: 'two' });
    await search.runSearch({ q: 'three' }); // evicts 'one'
    await new Promise((r) => setImmediate(r)); // let the deferred DROP run
    assert.equal(db.drops().length, 1);
    const createsBefore = db.creates().length;
    await search.runSearch({ q: 'one' }); // evicted → rebuilt
    assert.equal(db.creates().length, createsBefore + 1);
});

test('blocklist is applied at page time, never baked into the query set', async () => {
    const db = stubDb({ rows: [{ _id: 9n }] });
    const search = createSearch({ db });
    await search.runRandomOne({
        q: 'cats -comic',
        blockedIds: [11, 22],
        blockedTags: ['nsfw', "o'brien"],
    });
    const creates = db.creates();
    // Two sets: the query's, plus one materializing the blocked-tag ids
    // (sorted, deduped) so pages anti-join instead of rescanning tags.
    assert.equal(creates.length, 2);
    assert.match(creates[0], /NOT p\.tags && ARRAY\['comic'\]/);
    assert.doesNotMatch(creates[0], /NOT IN/);
    assert.doesNotMatch(creates[0], /nsfw/);
    assert.match(creates[1], /p\.tags && ARRAY\['nsfw', 'o''brien'\]/);
    const page = db.pages()[0];
    assert.match(page, /m\._id NOT IN \(11, 22\)/);
    assert.match(page, /m\._id NOT IN \(SELECT _id FROM match_/);
    assert.doesNotMatch(page, /&& ARRAY/);
});

test('the blocked-tag set is keyed order-independently and reused', async () => {
    const db = stubDb({ rows: [{ _id: 1n }] });
    const search = createSearch({ db });
    await search.runRandomOne({ q: 'cats', blockedTags: ['b', 'a'] });
    await search.runRandomOne({ q: 'cats', blockedTags: ['a', 'b'] });
    // One set for 'cats', one for the blocked tags — no rebuild on reorder.
    assert.equal(db.creates().length, 2);
});

test('non-numeric blocked ids are dropped; empty blocklist emits no clauses', async () => {
    const db = stubDb({ rows: [{ _id: 1n }] });
    const search = createSearch({ db });
    await search.runRandomOne({ q: 'cats', blockedIds: [5, 'bogus', NaN, 7] });
    assert.match(db.pages()[0], /m\._id NOT IN \(5, 7\)/);

    const db2 = stubDb({ rows: [{ _id: 1n }] });
    const search2 = createSearch({ db: db2 });
    await search2.runRandomOne({ q: 'cats' });
    const page = db2.pages()[0];
    assert.doesNotMatch(page, /NOT IN/);
    assert.doesNotMatch(page, /&& ARRAY/);
    assert.doesNotMatch(page, /JOIN file_db\.posts pb/);
});

test('runRankedRandomOne walks the deck least-seen-first off random_ranks', async () => {
    const db = stubDb({ rows: [{ _id: 3n, display_count: 0n, random_rank: 0.1 }] });
    const search = createSearch({ db });
    const row = await search.runRankedRandomOne({ q: 'cats' });

    assert.equal(Number(row._id), 3);
    const page = db.pages()[0];
    assert.match(page, /JOIN memory\.random_ranks r ON r\._id = m\._id/);
    assert.match(page, /ORDER BY r\.display_count ASC, r\.random_rank ASC/);
    assert.match(page, /LIMIT 1/);
    assert.doesNotMatch(page, /ORDER BY RANDOM\(\)/);
});

test('ratioOrder picks best fit from a least-seen chunk, view-tier first', async () => {
    const db = stubDb({ rows: [{ _id: 3n, display_count: 0n, random_rank: 0.1 }] });
    const search = createSearch({ db });
    await search.runRankedRandomOne({ q: 'cats', ratioOrder: 1179 / 2556 });

    const page = db.pages()[0];
    // Inner chunk: the 480 least-seen posts off the deck, joined to posts for
    // the ratio column. Outer: lowest view-tier first, then closest ratio, so
    // a viewed post never wins while a less-seen one is in the chunk.
    assert.match(page, /JOIN file_db\.posts pr ON pr\._id = m\._id/);
    assert.match(page, /ORDER BY r\.display_count ASC, r\.random_rank ASC\s+LIMIT 480/);
    assert.match(page, /ORDER BY chunk\.display_count ASC, ABS\(chunk\._ratio - 0\.4613\) ASC NULLS LAST\s+LIMIT 1/);
});

test('ratioOrder picks best fit from a random chunk for pure-random draws', async () => {
    const db = stubDb({ rows: [{ _id: 7n }] });
    const search = createSearch({ db });
    await search.runRandomOne({ q: 'cats', ratioOrder: 1.6 });

    const page = db.pages()[0];
    assert.match(page, /ORDER BY RANDOM\(\)\s+LIMIT 480/);
    assert.match(page, /ORDER BY ABS\(chunk\._ratio - 1\.6000\) ASC NULLS LAST\s+LIMIT 1/);
});

test('ratioOrder absent or invalid leaves the pick query unbiased', async () => {
    const db = stubDb({ rows: [{ _id: 3n, display_count: 0n, random_rank: 0.1 }] });
    const search = createSearch({ db });
    await search.runRankedRandomOne({ q: 'cats' });
    await search.runRankedRandomOne({ q: 'cats', ratioOrder: 0 });

    for (const page of db.pages()) {
        assert.doesNotMatch(page, /pr\.ratio/);
        assert.match(page, /ORDER BY r\.display_count ASC, r\.random_rank ASC/);
    }
});

test('runCount answers from the build-time count without a page query', async () => {
    const db = stubDb({ count: 42 });
    const search = createSearch({ db });
    assert.equal(await search.runCount({ q: 'cats' }), 42);
    assert.equal(db.pages().length, 0);
    // A warm set answers again with no further DB work.
    const callsBefore = db.calls.length;
    assert.equal(await search.runCount({ q: 'cats' }), 42);
    assert.equal(db.calls.length, callsBefore);
});

test('a zero-match set short-circuits every read path', async () => {
    const db = stubDb({ count: 0, rows: [{ _id: 1n }] });
    const search = createSearch({ db });
    assert.deepEqual(await search.runSearch({ q: 'nope' }), { results: [], nextCursor: null });
    assert.equal(await search.runRandomOne({ q: 'nope' }), null);
    assert.equal(await search.runRankedRandomOne({ q: 'nope' }), null);
    assert.equal(db.pages().length, 0);
    assert.equal(db.creates().length, 1);
});

test('random-mode cursor advances on a full page (BigInt display_count)', async () => {
    const rows = Array.from({ length: 3 }, (_, i) => ({
        _id: BigInt(i + 1), display_count: 2n, random_rank: 0.1 * (i + 1),
    }));
    const db = stubDb({ rows });
    const search = createSearch({ db });
    const { nextCursor } = await search.runSearch({ q: 'cats', limit: 3 });
    assert.deepEqual(nextCursor, { dc: 2, rank: 0.30000000000000004 });

    // The cursor lands in the page filter on the next call.
    await search.runSearch({ q: 'cats', cursor: nextCursor, limit: 3 });
    const page2 = db.pages()[1];
    assert.match(page2, /r\.display_count > 2 OR \(r\.display_count = 2 AND r\.random_rank > 0\.30000000000000004\)/);
});

// Displaying a post bumps its display_count, re-sorting it *after* the
// cursor — so a walking cursor is perpetually fed by the posts it just
// served and never runs off the deck's end on its own. Everything at a
// lower (display_count, random_rank) would be orphaned forever: the
// slideshow visibly loops the small slice ahead of the cursor. The guard:
// a cursor above the deck's least-seen tier restarts from the head.
test('a cursor stranded above less-seen posts restarts from the deck head', async () => {
    const db = stubDb({ rows: [{ _id: 5n, display_count: 1n, random_rank: 0.2 }], stale: true });
    const search = createSearch({ db });
    await search.runSearch({ q: 'cats', cursor: { dc: 4, rank: 0.9 }, limit: 3 });

    const probe = db.probes()[0];
    assert.match(probe, /r\.display_count < 4/);
    assert.match(probe, /LIMIT 1/);
    // The page restarted from the head — the tuple filter is gone.
    const page = db.pages()[0];
    assert.doesNotMatch(page, /display_count > 4/);
    assert.doesNotMatch(page, /random_rank > 0\.9/);
});

test('a non-stale cursor keeps walking; the dc=0 floor skips the probe', async () => {
    const db = stubDb({ rows: [] });
    const search = createSearch({ db });
    // dc=0 can't have a less-seen tier below it — no probe at all.
    await search.runSearch({ q: 'cats', cursor: { dc: 0, rank: 0.5 }, limit: 3 });
    assert.equal(db.probes().length, 0);
    // dc>0 probes, and a clean answer leaves the tuple filter standing.
    await search.runSearch({ q: 'cats', cursor: { dc: 3, rank: 0.5 }, limit: 3 });
    assert.equal(db.probes().length, 1);
    assert.match(db.pages()[1], /display_count > 3/);
});

test('runSearch filters the blocklist in SQL — pages and the staleness probe', async () => {
    const db = stubDb({ rows: [] });
    const search = createSearch({ db });
    await search.runSearch({
        q: 'cats', cursor: { dc: 2, rank: 0.5 }, limit: 3,
        blockedIds: [11, 22], blockedTags: ['nsfw'],
    });
    for (const sql of [db.probes()[0], db.pages()[0]]) {
        assert.match(sql, /m\._id NOT IN \(11, 22\)/);
        assert.match(sql, /m\._id NOT IN \(SELECT _id FROM match_/);
    }
    // Deterministic order takes the same clauses.
    await search.runSearch({ q: 'cats order:id', blockedIds: [11] });
    assert.match(db.pages()[1], /m\._id NOT IN \(11\)/);
    // And an empty blocklist emits nothing.
    await search.runSearch({ q: 'cats', cursor: { dc: 2, rank: 0.5 }, limit: 3 });
    assert.doesNotMatch(db.pages()[2], /NOT IN/);
});

// /search turns `?cursor=<float>` into one object carrying both cursor
// shapes, so the same bare float has to seed the deck in random order and
// act as a row offset in a deterministic one.
test("the route's bare-float cursor serves both order modes", async () => {
    const db = stubDb({ rows: [{ _id: 1n, display_count: 0n, random_rank: 0.9 }] });
    const search = createSearch({ db });
    const cursor = { origin: 0.4137, offset: 0 };

    // Random order: the float rotates the deck — the page is the head of the
    // least-seen tier on that rotation, whatever its display_count is.
    await search.runSearch({ q: 'cats', cursor, limit: 3 });
    const page = db.pages()[0];
    assert.match(page, /\(\(r\.random_rank - 0\.4137\) \+ 1\.0\) % 1\.0 AS pos/);
    assert.match(page, /ORDER BY r\.display_count ASC, pos ASC/);
    assert.doesNotMatch(page, /display_count = 0/, 'a rotation is not a tuple cursor');

    await search.runSearch({ q: 'cats order:id', cursor: { ...cursor, offset: 12 }, limit: 3 });
    const deterministic = db.pages()[1];
    assert.match(deterministic, /OFFSET 12/);
    assert.doesNotMatch(deterministic, /0\.4137/);
});

// Each orchestrator channel walks its own rotation of the deck. The cursor
// filter is the cyclic interval from the cursor's rank round to the origin,
// written as plain rank comparisons on both sides so the boundary row is
// never skipped or repeated by a float-rounding mismatch.
test('a rotated cursor pages the cyclic interval back to its origin', async () => {
    const rows = [{ _id: 1n, display_count: 2n, random_rank: 0.95 }, { _id: 2n, display_count: 2n, random_rank: 0.97 }];
    const db = stubDb({ rows });
    const search = createSearch({ db });

    // Above the origin: everything up to the deck's end, then rank 0 up to it.
    const { nextCursor } = await search.runSearch({ q: 'cats', cursor: { dc: 2, rank: 0.9, origin: 0.6 }, limit: 2 });
    assert.match(db.pages()[0], /r\.display_count = 2 AND \(r\.random_rank > 0\.9 OR r\.random_rank < 0\.6\)/);
    assert.deepEqual(nextCursor, { dc: 2, rank: 0.97, origin: 0.6 }, 'the rotation rides along');

    // Wrapped below the origin: only the gap left before it.
    await search.runSearch({ q: 'cats', cursor: { dc: 2, rank: 0.1, origin: 0.6 }, limit: 2 });
    assert.match(db.pages()[1], /r\.display_count = 2 AND \(r\.random_rank > 0\.1 AND r\.random_rank < 0\.6\)/);

    // No rotation keeps the plain tuple filter and no `origin` in the cursor.
    const plain = await search.runSearch({ q: 'cats', cursor: { dc: 2, rank: 0.1 }, limit: 2 });
    assert.match(db.pages()[2], /r\.display_count = 2 AND r\.random_rank > 0\.1\)/);
    assert.deepEqual(plain.nextCursor, { dc: 2, rank: 0.97 });
});

test('a stale rotated cursor restarts from its own origin, not rank 0', async () => {
    const db = stubDb({ rows: [{ _id: 5n, display_count: 1n, random_rank: 0.2 }], stale: true });
    const search = createSearch({ db });
    await search.runSearch({ q: 'cats', cursor: { dc: 4, rank: 0.9, origin: 0.3 }, limit: 3 });
    const page = db.pages()[0];
    assert.doesNotMatch(page, /random_rank > 0\.9/);
    assert.match(page, /r\.random_rank - 0\.3/, 'the restart keeps the rotation');
});

test('excludeIds keep queued-elsewhere posts off the page and out of the probe, with a fallback', async () => {
    const db = stubDb({ rows: [] });
    const search = createSearch({ db });
    await search.runSearch({ q: 'cats', cursor: { dc: 2, rank: 0.5 }, limit: 3, excludeIds: [7, 8] });
    assert.match(db.probes()[0], /m\._id NOT IN \(7, 8\)/);
    const pages = db.pages();
    assert.match(pages[0], /m\._id NOT IN \(7, 8\)/);
    // The stub returned nothing, so the page re-ran without the exclusions:
    // a deck with nothing else left still serves rather than reading empty.
    assert.equal(pages.length, 2);
    assert.doesNotMatch(pages[1], /NOT IN \(7, 8\)/);
});

// A random cursor lands near the deck's end sometimes; /search asks for a
// wrap so the caller still gets `limit` rows. The orchestrator must not get
// this — it reads a short page as the end of the deck.
test('wrap tops a short cursored page up from the deck head, without duplicates', async () => {
    const db = stubDb({ rows: [{ _id: 1n, display_count: 0n, random_rank: 0.99 }] });
    const search = createSearch({ db });
    const { results, nextCursor } = await search.runSearch({
        q: 'cats', cursor: { dc: 0, rank: 0.98 }, limit: 3, wrap: true,
    });

    // The stub replays the same row for the top-up query, so it dedupes away:
    // what matters is that the head query ran and nothing repeated.
    assert.deepEqual(results.map((r) => Number(r._id)), [1]);
    assert.equal(nextCursor, null, 'a wrapped page has no continuation');
    const pages = db.pages();
    assert.equal(pages.length, 2, 'a second, head-of-deck page query ran');
    assert.match(pages[0], /r\.random_rank > 0\.98/);
    assert.doesNotMatch(pages[1], /random_rank > /, 'the top-up starts at the head');
});

test('wrap is inert without a cursor, on a full page, and in deterministic order', async () => {
    const rows = Array.from({ length: 3 }, (_, i) => ({
        _id: BigInt(i + 1), display_count: 0n, random_rank: 0.1 * (i + 1),
    }));
    const search = createSearch({ db: stubDb({ rows }) });

    // Page 1 (no cursor): a short page here is a genuinely exhausted deck.
    const bare = await search.runSearch({ q: 'cats', limit: 9, wrap: true });
    assert.equal(bare.results.length, 3);

    // A full page needs no top-up, so its cursor still round-trips.
    const full = await search.runSearch({ q: 'cats', cursor: { dc: 0, rank: 0.05 }, limit: 3, wrap: true });
    assert.deepEqual(full.nextCursor, { dc: 0, rank: 0.30000000000000004 });

    // Deterministic order has no deck to wrap around.
    const det = await search.runSearch({ q: 'cats order:id', cursor: { offset: 90 }, limit: 9, wrap: true });
    assert.equal(det.results.length, 3);
});

test('a short page ends pagination', async () => {
    const db = stubDb({ rows: [{ _id: 1n, display_count: 0n, random_rank: 0.5 }] });
    const search = createSearch({ db });
    const { nextCursor } = await search.runSearch({ q: 'cats', limit: 3 });
    assert.equal(nextCursor, null);
});

test('deterministic order pages by OFFSET from the set', async () => {
    const rows = [{ _id: 1n }, { _id: 2n }];
    const db = stubDb({ rows });
    const search = createSearch({ db });
    const first = await search.runSearch({ q: 'cats order:score', limit: 2 });
    assert.deepEqual(first.nextCursor, { offset: 2 });
    await search.runSearch({ q: 'cats order:score', cursor: first.nextCursor, limit: 2 });
    const page2 = db.pages()[1];
    assert.match(page2, /ORDER BY p\.score DESC/);
    assert.match(page2, /OFFSET 2/);
    assert.doesNotMatch(page2, /random_ranks/);
});

test('runRandomOne re-rolls on every call (one set, two draws)', async () => {
    let n = 0;
    const db = {
        run(sql, cb) { cb(null); },
        all(sql, paramsOrCb, maybeCb) {
            const cb = typeof paramsOrCb === 'function' ? paramsOrCb : maybeCb;
            if (/COUNT\(\*\)/.test(sql)) return cb(null, [{ n: 5n }]);
            cb(null, [{ _id: BigInt(++n) }]);
        },
    };
    const search = createSearch({ db });
    const a = await search.runRandomOne({ q: 'cats' });
    const b = await search.runRandomOne({ q: 'cats' });
    assert.notDeepEqual(a, b);
});

test('clearCache drops every set and the next query rebuilds', async () => {
    const db = stubDb({ rows: [] });
    const search = createSearch({ db });
    await search.runSearch({ q: 'cats' });
    await search.runSearch({ q: 'dogs' });
    search.clearCache();
    await new Promise((r) => setImmediate(r));
    assert.equal(db.drops().length, 2);
    await search.runSearch({ q: 'cats' });
    assert.equal(db.creates().length, 3);
});

test('a failed build does not poison its key', async () => {
    let failNext = true;
    const db = stubDb({ rows: [] });
    const origRun = db.run.bind(db);
    db.run = (sql, cb) => {
        if (failNext && /CREATE/.test(sql)) {
            failNext = false;
            db.calls.push(sql);
            return cb(new Error('disk full'));
        }
        origRun(sql, cb);
    };
    const search = createSearch({ db });
    await assert.rejects(() => search.runSearch({ q: 'cats' }), /disk full/);
    const { results } = await search.runSearch({ q: 'cats' });
    assert.deepEqual(results, []);
    assert.equal(db.creates().length, 2);
});

test('each include term must match through its expansion; terms sort into one key', async () => {
    const { createTagExpander } = require('../lib/tagExpansion');
    const expander = createTagExpander({
        aliases: new Map([['kitty', 'cat']]),
        implications: new Map([['cat', ['felid']], ['felid', ['mammal']]]),
    });
    const db = stubDb({ rows: [] });
    const search = createSearch({ db, expander });
    await search.runSearch({ q: 'mammal dogs' });
    const create = db.creates()[0];
    // Transitive implication antecedents + alias antecedents, one && per term.
    assert.match(create, /p\.tags && ARRAY\['cat', 'felid', 'kitty', 'mammal'\]/);
    assert.match(create, /p\.tags && ARRAY\['dogs'\]/);
    // Term order doesn't fork the set.
    await search.runSearch({ q: 'dogs mammal' });
    assert.equal(db.creates().length, 1);
});

test('excluded and blocked tags expand the same way', async () => {
    const { createTagExpander } = require('../lib/tagExpansion');
    const expander = createTagExpander({
        aliases: new Map(),
        implications: new Map([['cat', ['felid']]]),
    });
    const db = stubDb({ rows: [{ _id: 1n }] });
    const search = createSearch({ db, expander });
    await search.runRandomOne({ q: '-felid', blockedTags: ['felid'] });
    const creates = db.creates();
    assert.match(creates[0], /NOT p\.tags && ARRAY\['cat', 'felid'\]/);
    assert.match(creates[1], /p\.tags && ARRAY\['cat', 'felid'\]/);
});

test('posts_tags routes tag terms through the inverted index', async () => {
    const db = stubDb({ rows: [] });
    const search = createSearch({ db, hasPostsTags: true });
    await search.runSearch({ q: "cats -o'brien" });
    const create = db.creates()[0];
    assert.match(create, /p\._id IN \(SELECT _id FROM file_db\.posts_tags WHERE tag IN \('cats'\)\)/);
    assert.match(create, /p\._id NOT IN \(SELECT _id FROM file_db\.posts_tags WHERE tag IN \('o''brien'\)\)/);
    assert.doesNotMatch(create, /p\.tags/);
});

test('an empty query materializes the TRUE set', async () => {
    const db = stubDb({ rows: [{ _id: 1n }] });
    const search = createSearch({ db });
    await search.runRandomOne({});
    assert.match(db.creates()[0], /WHERE \(TRUE\) AND/);
});
