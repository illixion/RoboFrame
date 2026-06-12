// Run via the workspace's `npm test` (or `node --test test/parseQuery.test.js` directly).
// No external test framework — uses node's built-in test runner.

const test = require('node:test');
const assert = require('node:assert/strict');
const { parseQuery } = require('../lib/parseQuery');

// Most warnings the parser emits are noise during tests; silence them
// so failures show up clearly. Restore at the end of each test where it matters.
const realWarn = console.warn;

const NO_TAGS = { include: [], exclude: [], optional: [] };

test('empty query → TRUE with no tag terms', () => {
    assert.deepEqual(parseQuery(''), { where: 'TRUE', tagTerms: NO_TAGS, limit: 40, orderBy: 'RANDOM()' });
    assert.deepEqual(parseQuery(undefined), { where: 'TRUE', tagTerms: NO_TAGS, limit: 40, orderBy: 'RANDOM()' });
});

test('bare tags become include terms, not SQL', () => {
    const r = parseQuery('foo bar');
    assert.deepEqual(r.tagTerms, { include: ['foo', 'bar'], exclude: [], optional: [] });
    assert.equal(r.where, 'TRUE');
});

test('-tag becomes an exclude term', () => {
    const r = parseQuery('-bar');
    assert.deepEqual(r.tagTerms, { include: [], exclude: ['bar'], optional: [] });
    assert.equal(r.where, 'TRUE');
});

test('~tag becomes an optional term', () => {
    const r = parseQuery('~maybe');
    assert.deepEqual(r.tagTerms, { include: [], exclude: [], optional: ['maybe'] });
    assert.equal(r.where, 'TRUE');
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

test('tag terms stay raw — escaping is the search layer\'s job', () => {
    const r = parseQuery("weird'tag");
    assert.deepEqual(r.tagTerms.include, ["weird'tag"]);
    assert.doesNotMatch(r.where, /weird/);
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

test('mixed query splits SQL clauses from tag terms', () => {
    const r = parseQuery('foo -bar score:>=50 limit:5 order:random');
    assert.equal(r.where, 'p.score >= 50');
    assert.deepEqual(r.tagTerms, { include: ['foo'], exclude: ['bar'], optional: [] });
    assert.equal(r.limit, 5);
    assert.equal(r.orderBy, 'RANDOM()');
});
