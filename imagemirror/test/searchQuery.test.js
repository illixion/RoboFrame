// Run via the workspace's `npm test` (or `node --test test/searchQuery.test.js`).
// No external test framework — uses node's built-in test runner with a
// hand-stubbed `db` that captures the SQL each method emits.

const test = require('node:test');
const assert = require('node:assert/strict');
const { createSearch } = require('../lib/searchQuery');

function stubDb(rows = []) {
    const calls = [];
    return {
        calls,
        all(sql, paramsOrCb, maybeCb) {
            const cb = typeof paramsOrCb === 'function' ? paramsOrCb : maybeCb;
            calls.push(sql);
            cb(null, rows);
        },
    };
}

test('runRandomOne orders by RANDOM() and returns a single row', async () => {
    const db = stubDb([{ _id: 7n, path: '/x/7.jxl' }]);
    const search = createSearch({ db });
    const row = await search.runRandomOne({ q: 'cats' });

    assert.deepEqual(row, { _id: 7n, path: '/x/7.jxl' });
    assert.equal(db.calls.length, 1);
    const sql = db.calls[0];
    assert.match(sql, /ORDER BY RANDOM\(\)/);
    assert.match(sql, /LIMIT 1/);
    // Tag filter from parseQuery is applied...
    assert.match(sql, /p\.tags @> ARRAY\['cats'\]/);
    // ...and orphan posts (no posts_paths row) are excluded.
    assert.match(sql, /EXISTS \(SELECT 1 FROM file_db\.posts_paths/);
});

test('runRandomOne returns null when nothing matches', async () => {
    const db = stubDb([]);
    const search = createSearch({ db });
    assert.equal(await search.runRandomOne({ q: 'nope' }), null);
});

test('runRandomOne with an empty query falls back to TRUE', async () => {
    const db = stubDb([{ _id: 1n }]);
    const search = createSearch({ db });
    await search.runRandomOne({});
    assert.match(db.calls[0], /WHERE TRUE AND/);
});

test('runRandomOne is not served from runSearch cache', async () => {
    // Distinct rows on each db.all call prove no caching layer intercepts.
    let n = 0;
    const db = {
        all(sql, paramsOrCb, maybeCb) {
            const cb = typeof paramsOrCb === 'function' ? paramsOrCb : maybeCb;
            cb(null, [{ _id: BigInt(++n) }]);
        },
    };
    const search = createSearch({ db });
    const a = await search.runRandomOne({ q: 'cats' });
    const b = await search.runRandomOne({ q: 'cats' });
    assert.notDeepEqual(a, b);
});
