'use strict';
// DuckDB query path used by both the (now-removed-from-HTTP) search endpoint
// and the slideshow orchestrator. One implementation, one cache.
//
// The orchestrator is the only caller in production; the export is a factory
// so tests can stub `db`.
//
// Two paging modes:
//   - random (orderBy = RANDOM()): joins memory.random_ranks and orders by
//     (display_count, random_rank) so unseen posts appear first; cursor is
//     the (display_count, random_rank) tuple of the last row returned.
//   - deterministic (any explicit order:id|score|score_asc): direct query
//     with OFFSET-based cursor.

const { parseQuery } = require('./parseQuery');

// Hide posts whose file row was deleted (image removed on disk → CLI
// dropped the posts_paths entry but kept the posts row for history /
// blocklist resolution). Without this every random page would include
// orphans that 404 on /get and warn from the prefetcher.
const HAS_PATH = 'EXISTS (SELECT 1 FROM file_db.posts_paths pp WHERE pp._id = p._id)';

function createSearch({ db, cacheSize = 20 } = {}) {
    const cache = []; // LRU: [{ key, value }]

    function runSearch({ q = '', cursor = null, limit } = {}) {
        const { where, limit: parsedLimit, orderBy } = parseQuery(q);
        const effectiveLimit = Number.isFinite(limit) && limit > 0 ? limit : parsedLimit;
        const cacheKey = JSON.stringify({ q: q || '', cursor, limit: effectiveLimit });

        const cachedIdx = cache.findIndex((e) => e.key === cacheKey);
        if (cachedIdx !== -1) {
            const hit = cache.splice(cachedIdx, 1)[0];
            cache.unshift(hit);
            return Promise.resolve(hit.value);
        }

        const isRandom = orderBy === 'RANDOM()';
        const sql = isRandom
            ? buildRandomSql({ where, cursor, limit: effectiveLimit })
            : buildDeterministicSql({ where, orderBy, cursor, limit: effectiveLimit });

        return new Promise((resolve, reject) => {
            db.all(sql, (err, rows) => {
                if (err) return reject(err);
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
                const value = { results: rows, nextCursor };
                cache.unshift({ key: cacheKey, value });
                if (cache.length > cacheSize) cache.pop();
                resolve(value);
            });
        });
    }

    function clearCache() {
        cache.length = 0;
    }

    function runCount({ q = '' } = {}) {
        const { where } = parseQuery(q);
        const baseWhere = where && where !== 'TRUE' ? where : 'TRUE';
        const sql = `SELECT COUNT(*)::BIGINT AS n FROM file_db.posts p WHERE ${baseWhere} AND ${HAS_PATH};`;
        return new Promise((resolve, reject) => {
            db.all(sql, (err, rows) => {
                if (err) return reject(err);
                const n = rows && rows[0] ? rows[0].n : 0;
                resolve(Number(n));
            });
        });
    }

    return { runSearch, runCount, clearCache };
}

function buildRandomSql({ where, cursor, limit }) {
    const baseWhere = where && where !== 'TRUE' ? `(${where})` : 'TRUE';
    let pageFilter = '';
    if (cursor && typeof cursor === 'object' && Number.isFinite(cursor.rank)) {
        const dc = Number(cursor.dc) || 0;
        const rank = Number(cursor.rank);
        pageFilter = ` AND (r.display_count > ${dc} OR (r.display_count = ${dc} AND r.random_rank > ${rank}))`;
    }
    return `
        SELECT p.*, pp.path, r.random_rank, r.display_count
        FROM file_db.posts p
        JOIN memory.random_ranks r ON p._id = r._id
        LEFT JOIN file_db.posts_paths pp ON pp._id = p._id
        WHERE ${baseWhere}${pageFilter} AND ${HAS_PATH}
        ORDER BY r.display_count ASC, r.random_rank ASC
        LIMIT ${limit};
    `;
}

function buildDeterministicSql({ where, orderBy, cursor, limit }) {
    const baseWhere = where && where !== 'TRUE' ? where : 'TRUE';
    const offset = (cursor && Number(cursor.offset)) || 0;
    return `
        SELECT p.*, pp.path
        FROM file_db.posts p
        LEFT JOIN file_db.posts_paths pp ON pp._id = p._id
        WHERE ${baseWhere} AND ${HAS_PATH}
        ORDER BY ${orderBy}
        LIMIT ${limit} OFFSET ${offset};
    `;
}

module.exports = { createSearch };
