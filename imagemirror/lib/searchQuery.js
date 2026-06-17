'use strict';
// DuckDB query path used by the /search and /count HTTP helpers and the
// slideshow orchestrator. One implementation, one match-set cache.
//
// The expensive part of any query is the tag filter — without an inverted
// index it's a full scan of a multi-million-row varchar[] column that DuckDB
// parallelizes across every core; with file_db.posts_tags it's an id-list
// probe, but still worth doing once. So the filter runs once per *distinct
// WHERE clause* and its matching ids are materialized into a temp table
// (`match_<hash>`); every page, count, and one-shot random pick then works
// off that id set with a cheap join. Query tags pass through the
// alias/implication expander (lib/tagExpansion.js) before hitting SQL, so
// the same query selects the same posts on flattened and unflattened
// libraries. Ordering data (display_count /
// random_rank) is read live from memory.random_ranks at page time, so
// view-count bumps never invalidate a set — membership only depends on
// file_db, which is attached READ_ONLY at startup and can't change under us
// (a regenerated .duckdb has always required a server restart).
//
// Concurrent callers for the same WHERE — e.g. every channel of a sharedTags
// fleet refilling at once — await the same in-flight build promise, so the
// fleet costs one scan. Sets are LRU-evicted (DROP TABLE) beyond `maxSets`.
//
// Two paging modes:
//   - random (orderBy = RANDOM()): joins memory.random_ranks and orders by
//     (display_count, random_rank) so unseen posts appear first; cursor is
//     the (display_count, random_rank) tuple of the last row returned.
//   - deterministic (any explicit order:id|score|score_asc): OFFSET cursor.
//
// The server-side blocklist (blockedIds / blockedTags) is deliberately NOT
// part of a set's key or contents — it changes independently of the query
// (data.json edits) and is cheap to apply as page-time clauses against an
// already-filtered set.

const crypto = require('crypto');
const { parseQuery } = require('./parseQuery');
const { identityExpander } = require('./tagExpansion');

// Hide posts whose file row was deleted (image removed on disk → CLI
// dropped the posts_paths entry but kept the posts row for history /
// blocklist resolution). Without this every random page would include
// orphans that 404 on /get and warn from the prefetcher.
const HAS_PATH = 'EXISTS (SELECT 1 FROM file_db.posts_paths pp WHERE pp._id = p._id)';

// Candidate-pool size for aspect-fit picks (/random with ratioOrder). The
// pick draws this many posts — least-seen-first for the ranked deck, a fresh
// RANDOM() sample for pure-random draws — then returns the best-fitting one.
// Big enough that the fit choice has real variety to draw from, small enough
// that the closest match in the pool is still a good fit for the canvas.
const RATIO_FIT_CHUNK = 480;

// `expander` resolves a query tag to every tag name that should match it
// (aliases + transitive implication antecedents — see lib/tagExpansion.js).
// `hasPostsTags` routes tag terms through the file_db.posts_tags inverted
// index (id lists per tag, clustered by tag) instead of scanning the
// posts.tags arrays — ~20x cheaper set builds when the CLI shipped the table.
function createSearch({ db, maxSets = 16, expander = identityExpander(), hasPostsTags = false } = {}) {
    // WHERE-clause key → { key, table, count, lastUsed, ready: Promise<entry> }
    const sets = new Map();
    let tick = 0;

    function quoteList(tags) {
        return tags.map((t) => `'${String(t).replace(/'/g, "''")}'`).join(', ');
    }

    // "post has at least one of these tag spellings".
    function anyTagClause(expandedTags) {
        return hasPostsTags
            ? `p._id IN (SELECT _id FROM file_db.posts_tags WHERE tag IN (${quoteList(expandedTags)}))`
            : `p.tags && ARRAY[${quoteList(expandedTags)}]`;
    }

    function noneTagClause(expandedTags) {
        return hasPostsTags
            ? `p._id NOT IN (SELECT _id FROM file_db.posts_tags WHERE tag IN (${quoteList(expandedTags)}))`
            : `NOT p.tags && ARRAY[${quoteList(expandedTags)}]`;
    }

    // Full WHERE for a parsed query: each include term must match through its
    // expansion; excludes and optionals work on the union of theirs. Terms
    // are sorted so equivalent queries share one set key.
    function composeWhere({ where, tagTerms }) {
        const clauses = [];
        const include = (tagTerms?.include || []).slice().sort();
        for (const t of include) clauses.push(anyTagClause(expander.expand(t)));
        const exclude = tagTerms?.exclude || [];
        if (exclude.length) clauses.push(noneTagClause(Array.from(expander.expandAll(exclude)).sort()));
        const optional = tagTerms?.optional || [];
        if (optional.length) clauses.push(anyTagClause(Array.from(expander.expandAll(optional)).sort()));
        if (where && where !== 'TRUE') clauses.push(where);
        return clauses.length ? clauses.join(' AND ') : 'TRUE';
    }

    function runAsync(sql) {
        return new Promise((resolve, reject) => db.run(sql, (err) => (err ? reject(err) : resolve())));
    }
    function allAsync(sql) {
        return new Promise((resolve, reject) => db.all(sql, (err, rows) => (err ? reject(err) : resolve(rows || []))));
    }

    function setKeyOf(where) {
        return where && where !== 'TRUE' ? where : 'TRUE';
    }
    function tableNameOf(key) {
        return 'match_' + crypto.createHash('sha1').update(key).digest('hex').slice(0, 16);
    }

    async function buildSet(key, table) {
        const t0 = Date.now();
        // CREATE OR REPLACE so a retry after a half-failed build can't trip
        // over a leftover table.
        await runAsync(`CREATE OR REPLACE TEMP TABLE ${table} AS
            SELECT p._id FROM file_db.posts p
            WHERE (${key}) AND ${HAS_PATH};`);
        const rows = await allAsync(`SELECT COUNT(*)::BIGINT AS n FROM ${table};`);
        const count = Number(rows[0] ? rows[0].n : 0);
        // The WHERE clause embeds the user's tag selection — keep it out of
        // the default log. SEARCH_DEBUG=1 includes it for query debugging.
        const label = process.env.SEARCH_DEBUG ? ` for: ${key}` : '';
        console.log(`[search] built ${table} (${count} rows, ${Date.now() - t0}ms)${label}`);
        return count;
    }

    // Resolve (building if needed) the match set for a WHERE clause. The
    // entry goes into the map before the build resolves, so concurrent
    // callers share one scan; a failed build removes the entry so the key
    // isn't poisoned.
    function getMatchSet(where) {
        const key = setKeyOf(where);
        let entry = sets.get(key);
        if (entry) {
            entry.lastUsed = ++tick;
            return entry.ready;
        }
        const table = tableNameOf(key);
        entry = { key, table, count: null, lastUsed: ++tick };
        entry.ready = buildSet(key, table).then(
            (count) => { entry.count = count; return entry; },
            (err) => { sets.delete(key); throw err; },
        );
        sets.set(key, entry);
        evictIfNeeded();
        return entry.ready;
    }

    // DROP only after the build settles so a DROP can never overtake its own
    // CREATE on the connection. A page query already queued against a
    // just-dropped table fails once and the caller's next attempt rebuilds —
    // the same narrow race refreshRandomRanks has always had.
    function dropSet(entry) {
        entry.ready
            .catch(() => {})
            .then(() => runAsync(`DROP TABLE IF EXISTS ${entry.table};`))
            .catch(() => {});
    }

    function evictIfNeeded() {
        while (sets.size > maxSets) {
            let oldest = null;
            for (const e of sets.values()) {
                if (!oldest || e.lastUsed < oldest.lastUsed) oldest = e;
            }
            if (!oldest) break;
            sets.delete(oldest.key);
            dropSet(oldest);
        }
    }

    async function runSearch({ q = '', cursor = null, limit } = {}) {
        const parsed = parseQuery(q);
        const { limit: parsedLimit, orderBy } = parsed;
        const effectiveLimit = Number.isFinite(limit) && limit > 0 ? limit : parsedLimit;
        const set = await getMatchSet(composeWhere(parsed));
        if (set.count === 0) return { results: [], nextCursor: null };

        const isRandom = orderBy === 'RANDOM()';
        const sql = isRandom
            ? buildRandomPageSql({ table: set.table, cursor, limit: effectiveLimit })
            : buildDeterministicPageSql({ table: set.table, orderBy, cursor, limit: effectiveLimit });
        const rows = await allAsync(sql);

        let nextCursor = null;
        if (rows.length === effectiveLimit) {
            if (isRandom) {
                const last = rows[rows.length - 1];
                nextCursor = {
                    dc: Number(last.display_count) || 0,
                    rank: Number(last.random_rank),
                };
            } else {
                const offset = (cursor && Number(cursor.offset)) || 0;
                nextCursor = { offset: offset + effectiveLimit };
            }
        }
        return { results: rows, nextCursor };
    }

    // Drop every materialized set. Wired to the explicit `reshuffle` action —
    // the user-facing "reset everything" — not to routine state changes.
    function clearCache() {
        const entries = Array.from(sets.values());
        sets.clear();
        for (const entry of entries) dropSet(entry);
    }

    // Page-time blocklist clauses for the one-shot random selectors. The id
    // list filters the match set directly. Blocked *tags* are resolved to
    // their own materialized id set (same registry, keyed on the sorted tag
    // list) and anti-joined — evaluating `tags && ARRAY[...]` inline against
    // every candidate row would re-scan the tags column on every page, which
    // is the exact cost the match sets exist to avoid.
    async function blockedClause({ blockedIds = [], blockedTags = [] } = {}) {
        let sql = '';
        const ids = blockedIds.map(Number).filter(Number.isFinite);
        if (ids.length) sql += ` AND m._id NOT IN (${ids.join(', ')})`;
        const tags = Array.from(expander.expandAll(blockedTags)).sort();
        if (tags.length) {
            const set = await getMatchSet(anyTagClause(tags));
            if (set.count > 0) sql += ` AND m._id NOT IN (SELECT _id FROM ${set.table})`;
        }
        return sql;
    }

    function hydrateOneSql(pageCte, extraCols = '') {
        return `
            WITH page AS (${pageCte})
            SELECT p.*, pp.path${extraCols}
            FROM page
            JOIN file_db.posts p ON p._id = page._id
            LEFT JOIN file_db.posts_paths pp ON pp._id = page._id;
        `;
    }

    // Validate an aspect-fit target. A finite positive number (width/height)
    // turns the one-shot picks into "best-fitting from a random chunk" mode;
    // anything else leaves the pick unbiased.
    function ratioTarget(v) {
        const t = Number(v);
        return Number.isFinite(t) && t > 0 ? t : null;
    }

    // Pick one matching post by re-rolling DuckDB's RANDOM() on every call —
    // independent uniform draws, with replacement (a post can recur, and the
    // selection ignores the slideshow's view counts). With `ratioOrder`, draw
    // a random RATIO_FIT_CHUNK-sized chunk and return its best-fitting post.
    async function runRandomOne({ q = '', blockedIds = [], blockedTags = [], ratioOrder = null } = {}) {
        const set = await getMatchSet(composeWhere(parseQuery(q)));
        if (set.count === 0) return null;
        const blocked = await blockedClause({ blockedIds, blockedTags });
        const target = ratioTarget(ratioOrder);
        const pageSql = target === null
            ? `
                SELECT m._id
                FROM ${set.table} m
                WHERE TRUE${blocked}
                ORDER BY RANDOM()
                LIMIT 1`
            : `
                SELECT chunk._id
                FROM (
                    SELECT m._id, pr.ratio AS _ratio
                    FROM ${set.table} m
                    JOIN file_db.posts pr ON pr._id = m._id
                    WHERE TRUE${blocked}
                    ORDER BY RANDOM()
                    LIMIT ${RATIO_FIT_CHUNK}
                ) chunk
                ORDER BY ABS(chunk._ratio - ${target.toFixed(4)}) ASC NULLS LAST
                LIMIT 1`;
        const rows = await allAsync(hydrateOneSql(pageSql));
        return rows.length ? rows[0] : null;
    }

    // Pick one matching post off the shared random_ranks deck the slideshow
    // uses: least-seen first, ties broken by the deck's frozen random_rank.
    // The caller is expected to bump display_count for the returned id so the
    // next call advances — that turns repeated calls into a shuffle *without*
    // replacement (every post once before any repeats), which spreads a
    // scheduled wallpaper across the whole library far better than independent
    // RANDOM() draws. Shares the deck with the slideshow, so a pick here also
    // deprioritises that post on the frame until the next reshuffle.
    //
    // With `ratioOrder`, take the RATIO_FIT_CHUNK least-seen posts (so the
    // chunk's lowest view-tier is the library's) and return the best-fitting
    // one, keeping display_count ahead of fit in the final pick so a viewed
    // post is never chosen while a less-seen one is in the chunk. The chunk —
    // not the single global nearest ratio — is the candidate pool, so the
    // pick spreads across hundreds of posts instead of looping the handful at
    // the exact closest ratio.
    async function runRankedRandomOne({ q = '', blockedIds = [], blockedTags = [], ratioOrder = null } = {}) {
        const set = await getMatchSet(composeWhere(parseQuery(q)));
        if (set.count === 0) return null;
        const blocked = await blockedClause({ blockedIds, blockedTags });
        const target = ratioTarget(ratioOrder);
        const pageSql = target === null
            ? `
                SELECT m._id, r.random_rank, r.display_count
                FROM ${set.table} m
                JOIN memory.random_ranks r ON r._id = m._id
                WHERE TRUE${blocked}
                ORDER BY r.display_count ASC, r.random_rank ASC
                LIMIT 1`
            : `
                SELECT chunk._id, chunk.random_rank, chunk.display_count
                FROM (
                    SELECT m._id, r.random_rank, r.display_count, pr.ratio AS _ratio
                    FROM ${set.table} m
                    JOIN memory.random_ranks r ON r._id = m._id
                    JOIN file_db.posts pr ON pr._id = m._id
                    WHERE TRUE${blocked}
                    ORDER BY r.display_count ASC, r.random_rank ASC
                    LIMIT ${RATIO_FIT_CHUNK}
                ) chunk
                ORDER BY chunk.display_count ASC, ABS(chunk._ratio - ${target.toFixed(4)}) ASC NULLS LAST
                LIMIT 1`;
        const rows = await allAsync(hydrateOneSql(pageSql, ', page.random_rank, page.display_count'));
        return rows.length ? rows[0] : null;
    }

    // Set membership is exactly "matches the WHERE and has a path", so the
    // count captured at build time is the answer — no extra scan.
    async function runCount({ q = '' } = {}) {
        const set = await getMatchSet(composeWhere(parseQuery(q)));
        return set.count;
    }

    return { runSearch, runCount, runRandomOne, runRankedRandomOne, clearCache };
}

function buildRandomPageSql({ table, cursor, limit }) {
    let pageFilter = '';
    if (cursor && typeof cursor === 'object' && Number.isFinite(cursor.rank)) {
        const dc = Number(cursor.dc) || 0;
        const rank = Number(cursor.rank);
        pageFilter = ` AND (r.display_count > ${dc} OR (r.display_count = ${dc} AND r.random_rank > ${rank}))`;
    }
    // Narrow id pick first, then hydrate the full rows; the hydration joins
    // don't preserve order, hence the outer re-ORDER.
    return `
        WITH page AS (
            SELECT m._id, r.random_rank, r.display_count
            FROM ${table} m
            JOIN memory.random_ranks r ON r._id = m._id
            WHERE TRUE${pageFilter}
            ORDER BY r.display_count ASC, r.random_rank ASC
            LIMIT ${limit}
        )
        SELECT p.*, pp.path, page.random_rank, page.display_count
        FROM page
        JOIN file_db.posts p ON p._id = page._id
        LEFT JOIN file_db.posts_paths pp ON pp._id = page._id
        ORDER BY page.display_count ASC, page.random_rank ASC;
    `;
}

function buildDeterministicPageSql({ table, orderBy, cursor, limit }) {
    const offset = (cursor && Number(cursor.offset)) || 0;
    return `
        WITH page AS (
            SELECT m._id
            FROM ${table} m
            JOIN file_db.posts p ON p._id = m._id
            ORDER BY ${orderBy}
            LIMIT ${limit} OFFSET ${offset}
        )
        SELECT p.*, pp.path
        FROM page
        JOIN file_db.posts p ON p._id = page._id
        LEFT JOIN file_db.posts_paths pp ON pp._id = page._id
        ORDER BY ${orderBy};
    `;
}

module.exports = { createSearch };
