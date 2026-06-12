'use strict';
// Query-time tag semantics over an unflattened library.
//
// posts.tags stores each post's direct tags exactly as the source recorded
// them; the alias and implication relations live in their own tables
// (file_db.tag_aliases / file_db.tag_implications) instead of being baked
// into every row's array. A query for tag T must therefore match any post
// whose direct tags *resolve* to T:
//
//   - alias antecedents of T (a post tagged with an old/alternate name)
//   - tags whose implication chain reaches T, transitively (a post tagged
//     `cat` matches a query for `felid` when cat → felid), including each
//     such tag's own alias antecedents
//
// expand(tag) returns that full candidate list, memoized — the relation
// tables are immutable for the process lifetime (file_db is attached
// read-only). The expansion is a superset of the literal tag, so running it
// against a legacy flattened library (ancestors materialized into every
// array) selects exactly the same posts: harmless there, required here.
//
// The same expansion backs query include/exclude/optional terms, the
// server-side blocklist's SQL clauses, and the orchestrator's in-JS queue
// filter — one definition of "matches tag T" everywhere.

// `aliases` maps antecedent → consequent (active rows only); `implications`
// maps antecedent → [consequents]. Both keyed on raw tag names.
function createTagExpander({ aliases = new Map(), implications = new Map() } = {}) {
    // consequent → [antecedents], for both relations.
    const aliasAntecedents = new Map();
    for (const [ante, cons] of aliases) {
        let arr = aliasAntecedents.get(cons);
        if (!arr) { arr = []; aliasAntecedents.set(cons, arr); }
        arr.push(ante);
    }
    const impliedBy = new Map();
    for (const [ante, consList] of implications) {
        for (const cons of consList) {
            let arr = impliedBy.get(cons);
            if (!arr) { arr = []; impliedBy.set(cons, arr); }
            arr.push(ante);
        }
    }

    // Follow alias chains to the canonical name (guarding against cycles a
    // malformed dump could contain).
    function canonical(tag) {
        let t = String(tag);
        const seen = new Set();
        while (aliases.has(t) && !seen.has(t)) {
            seen.add(t);
            t = aliases.get(t);
        }
        return t;
    }

    const memo = new Map();

    // All tag names that resolve to `tag`: itself, alias antecedents, and the
    // transitive closure of tags implying it (each with their antecedents).
    // Sorted so callers get a stable list for cache keys.
    function expand(tag) {
        const key = String(tag);
        const hit = memo.get(key);
        if (hit) return hit;

        const out = new Set();
        const stack = [canonical(key)];
        const visited = new Set();
        while (stack.length) {
            const c = stack.pop();
            if (visited.has(c)) continue;
            visited.add(c);
            out.add(c);
            for (const a of aliasAntecedents.get(c) || []) out.add(a);
            for (const child of impliedBy.get(c) || []) stack.push(child);
        }
        // The literal query spelling always matches itself even when it's an
        // alias antecedent (canonical() rewrote the seed above).
        out.add(key);

        const result = Object.freeze(Array.from(out).sort());
        memo.set(key, result);
        return result;
    }

    // Union expansion for a blocklist: a post is blocked when any of its
    // direct tags appears in this set.
    function expandAll(tags) {
        const out = new Set();
        for (const t of Array.isArray(tags) ? tags : []) {
            if (!t) continue;
            for (const e of expand(t)) out.add(e);
        }
        return out;
    }

    return { expand, expandAll };
}

// For libraries without relation tables (e.g. roboframe-cli folder imports):
// every tag stands for itself.
function identityExpander() {
    return {
        expand: (tag) => Object.freeze([String(tag)]),
        expandAll: (tags) => new Set((Array.isArray(tags) ? tags : []).filter(Boolean).map(String)),
    };
}

module.exports = { createTagExpander, identityExpander };
