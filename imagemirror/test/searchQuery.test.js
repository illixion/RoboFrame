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

function stubDb({ rows = [], count = 1 } = {}) {
    const state = { rows, count };
    const calls = [];
    return {
        state,
        calls,
        creates() { return calls.filter((s) => /CREATE OR REPLACE TEMP TABLE/.test(s)); },
        drops() { return calls.filter((s) => /DROP TABLE IF EXISTS/.test(s)); },
        pages() {
            return calls.filter((s) => !/CREATE OR REPLACE TEMP TABLE|COUNT\(\*\)|DROP TABLE/.test(s));
        },
        run(sql, cb) {
            calls.push(sql);
            cb(null);
        },
        all(sql, paramsOrCb, maybeCb) {
            const cb = typeof paramsOrCb === 'function' ? paramsOrCb : maybeCb;
            calls.push(sql);
            if (/COUNT\(\*\)/.test(sql)) return cb(null, [{ n: BigInt(state.count) }]);
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
