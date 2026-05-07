// Run via the workspace's `npm test` (or `node --test test/parseQuery.test.js` directly).
// No external test framework — uses node's built-in test runner.

const test = require('node:test');
const assert = require('node:assert/strict');
const { parseQuery } = require('../lib/parseQuery');

// Most warnings the parser emits are noise during tests; silence them
// so failures show up clearly. Restore at the end of each test where it matters.
const realWarn = console.warn;

test('empty query → TRUE', () => {
    assert.deepEqual(parseQuery(''), { where: 'TRUE', limit: 40, orderBy: 'RANDOM()' });
    assert.deepEqual(parseQuery(undefined), { where: 'TRUE', limit: 40, orderBy: 'RANDOM()' });
});

test('bare tag becomes include-array', () => {
    const r = parseQuery('foo');
    assert.equal(r.where, "p.tags @> ARRAY['foo']");
});

test('multiple bare tags compose into one include-array', () => {
    const r = parseQuery('foo bar');
    assert.equal(r.where, "p.tags @> ARRAY['foo', 'bar']");
});

test('-tag becomes exclude clause', () => {
    const r = parseQuery('-bar');
    assert.equal(r.where, "NOT p.tags && ARRAY['bar']");
});

test('~tag becomes optional/has-any clause', () => {
    const r = parseQuery('~maybe');
    assert.equal(r.where, "p.tags && ARRAY['maybe']");
});

test('numeric comparisons cover all operators', () => {
    assert.equal(parseQuery('score:>=50').where, 'p.score >= 50');
    assert.equal(parseQuery('score:<=50').where, 'p.score <= 50');
    assert.equal(parseQuery('score:>50').where, 'p.score > 50');
    assert.equal(parseQuery('score:<50').where, 'p.score < 50');
    assert.equal(parseQuery('score:!=50').where, 'p.score != 50');
    assert.equal(parseQuery('score:50').where, 'p.score = 50');
});

test('numeric range a..b becomes BETWEEN', () => {
    assert.equal(parseQuery('score:30..70').where, 'p.score BETWEEN 30 AND 70');
});

test('rating: and file_ext: produce equality with apostrophe-escape', () => {
    assert.equal(parseQuery('rating:s').where, "p.rating = 's'");
    assert.equal(parseQuery('file_ext:jxl').where, "p.file_ext = 'jxl'");
});

test('order: rewrites orderBy and limit: rewrites limit', () => {
    assert.equal(parseQuery('order:id').orderBy, 'p._id ASC');
    assert.equal(parseQuery('order:random').orderBy, 'RANDOM()');
    assert.equal(parseQuery('order:score').orderBy, 'p.score DESC');
    assert.equal(parseQuery('order:score_asc').orderBy, 'p.score ASC');
    assert.equal(parseQuery('limit:5').limit, 5);
    assert.equal(parseQuery('limit:80').limit, 80);
});

test('SQL injection guard: apostrophes inside tags are doubled', () => {
    const r = parseQuery("weird'tag");
    assert.equal(r.where, "p.tags @> ARRAY['weird''tag']");
});

test('unknown column is rejected (no SQL emitted)', () => {
    console.warn = () => {};
    try {
        const r = parseQuery('evil_col:0');
        assert.equal(r.where, 'TRUE');
    } finally {
        console.warn = realWarn;
    }
});

test('NaN guard: score:abc does not produce score = NaN SQL', () => {
    console.warn = () => {};
    try {
        const r = parseQuery('score:abc');
        assert.equal(r.where, 'TRUE');
        assert.ok(!String(r.where).includes('NaN'));
    } finally {
        console.warn = realWarn;
    }
});

test('NaN range guard: score:.. does not produce BETWEEN NaN AND NaN', () => {
    console.warn = () => {};
    try {
        const r = parseQuery('score:..');
        assert.ok(!String(r.where).includes('NaN'));
    } finally {
        console.warn = realWarn;
    }
});

test('multi-clause query joins with AND', () => {
    const r = parseQuery('foo -bar score:>=50 limit:5 order:random');
    assert.equal(r.where, "p.score >= 50 AND p.tags @> ARRAY['foo'] AND NOT p.tags && ARRAY['bar']");
    assert.equal(r.limit, 5);
    assert.equal(r.orderBy, 'RANDOM()');
});
