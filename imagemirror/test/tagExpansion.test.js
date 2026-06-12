// Run via the workspace's `npm test` (or `node --test test/tagExpansion.test.js`).

const test = require('node:test');
const assert = require('node:assert/strict');
const { createTagExpander, identityExpander } = require('../lib/tagExpansion');

function expander({ aliases = [], implications = [] } = {}) {
    const impMap = new Map();
    for (const [a, c] of implications) {
        if (!impMap.has(a)) impMap.set(a, []);
        impMap.get(a).push(c);
    }
    return createTagExpander({ aliases: new Map(aliases), implications: impMap });
}

test('a tag with no relations expands to itself', () => {
    const e = expander();
    assert.deepEqual(e.expand('cat'), ['cat']);
});

test('implication closure is transitive', () => {
    const e = expander({ implications: [['cat', 'felid'], ['felid', 'mammal'], ['dog', 'mammal']] });
    assert.deepEqual(e.expand('mammal'), ['cat', 'dog', 'felid', 'mammal']);
    assert.deepEqual(e.expand('felid'), ['cat', 'felid']);
    // Leaves have no antecedents.
    assert.deepEqual(e.expand('cat'), ['cat']);
});

test('alias antecedents of every closure member are included', () => {
    const e = expander({
        aliases: [['kitty', 'cat']],
        implications: [['cat', 'felid']],
    });
    assert.deepEqual(e.expand('felid'), ['cat', 'felid', 'kitty']);
});

test('querying by an alias antecedent resolves through the canonical name', () => {
    const e = expander({
        aliases: [['kitty', 'cat']],
        implications: [['tabby', 'cat']],
    });
    // 'kitty' canonicalizes to 'cat', whose closure pulls in 'tabby'; the
    // literal spelling stays in the list.
    assert.deepEqual(e.expand('kitty'), ['cat', 'kitty', 'tabby']);
});

test('alias chains are followed; cycles terminate', () => {
    const chained = expander({ aliases: [['a', 'b'], ['b', 'c']] });
    assert.ok(chained.expand('a').includes('c'));

    const cyclic = expander({
        aliases: [['x', 'y'], ['y', 'x']],
        implications: [['p', 'q'], ['q', 'p']],
    });
    assert.ok(cyclic.expand('x').length > 0);
    assert.ok(cyclic.expand('p').includes('q'));
});

test('expandAll unions expansions for blocklist matching', () => {
    const e = expander({ implications: [['cat', 'felid'], ['dog', 'canid']] });
    const set = e.expandAll(['felid', 'canid']);
    assert.deepEqual(Array.from(set).sort(), ['canid', 'cat', 'dog', 'felid']);
    assert.deepEqual(e.expandAll(null), new Set());
});

test('expand memoizes and returns frozen lists', () => {
    const e = expander({ implications: [['cat', 'felid']] });
    const a = e.expand('felid');
    assert.equal(e.expand('felid'), a);
    assert.ok(Object.isFrozen(a));
});

test('identityExpander maps every tag to itself', () => {
    const e = identityExpander();
    assert.deepEqual(e.expand('anything'), ['anything']);
    assert.deepEqual(Array.from(e.expandAll(['a', '', 'b'])).sort(), ['a', 'b']);
});
