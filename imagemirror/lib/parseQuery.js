// Translate a user query string into a DuckDB SQL WHERE clause (non-tag
// constraints only), structured tag terms, and paging options. Tag terms are
// returned as data rather than SQL because the search layer routes them
// through alias/implication expansion and (when available) the posts_tags
// inverted index — see lib/searchQuery.js and lib/tagExpansion.js.
// Pure function; lives in its own module so it can be unit-tested without
// booting the server.
//
// Supported syntax:
//   bare-tag      include — every include term must match
//   -tag          exclude — none may match
//   ~tag          optional/has-any — at least one optional term matches
//   col:val       exact match (rating, file_ext) or numeric =
//   col:>=N       numeric comparison: <, <=, >, >=, !=
//   col:N..M      numeric range
//   limit:N       page size override (default 40)
//   order:id|random|score|score_asc

const NUMERIC_COLS = ['_id', 'fav_count', 'parent_id', 'change_seq', 'duration', 'score', 'ratio', 'image_width', 'image_height'];
const STRING_COLS = ['rating', 'file_ext'];
const P_COLUMNS = [...NUMERIC_COLS, ...STRING_COLS, 'tags'];

function escapeTag(tag) {
    return String(tag).replace(/'/g, "''");
}
function qualify(col) {
    return P_COLUMNS.includes(col) ? `p.${col}` : col;
}
function num(s) {
    const n = parseFloat(s);
    return Number.isFinite(n) ? n : null;
}

const EMPTY_TERMS = Object.freeze({ include: [], exclude: [], optional: [] });

function parseQuery(query) {
    const whereClauses = [];
    let limit = 40;
    let orderBy = 'RANDOM()';

    if (!query) return { where: 'TRUE', tagTerms: EMPTY_TERMS, limit, orderBy };

    const includeTags = [];
    const excludeTags = [];
    const optionalTags = [];

    const parts = String(query).split(' ').filter(Boolean);

    for (const part of parts) {
        const colonIdx = part.indexOf(':');
        const key = colonIdx === -1 ? part : part.slice(0, colonIdx);
        const value = colonIdx === -1 ? undefined : part.slice(colonIdx + 1);

        // Tag terms stay raw here — the search layer owns expansion and SQL
        // escaping for them; escapeTag below is only for string-column values
        // that go straight into the WHERE clause.
        if (value === undefined) {
            if (key.startsWith('-')) excludeTags.push(key.substring(1));
            else if (key.startsWith('~')) optionalTags.push(key.substring(1));
            else if (key) includeTags.push(key);
            continue;
        }

        if (STRING_COLS.includes(key)) {
            whereClauses.push(`${qualify(key)} = '${escapeTag(value)}'`);
            continue;
        }
        if (key.startsWith('-') && STRING_COLS.includes(key.substring(1))) {
            whereClauses.push(`${qualify(key.substring(1))} != '${escapeTag(value)}'`);
            continue;
        }

        if (NUMERIC_COLS.includes(key)) {
            const col = qualify(key);
            if (value.includes('..')) {
                const [minStr, maxStr] = value.split('..');
                const min = num(minStr), max = num(maxStr);
                if (min !== null && max !== null) whereClauses.push(`${col} BETWEEN ${min} AND ${max}`);
                else console.warn(`Invalid numeric range in query part: ${part}`);
                continue;
            }
            let op, n;
            if (value.startsWith('>=')) { op = '>='; n = num(value.substring(2)); }
            else if (value.startsWith('<=')) { op = '<='; n = num(value.substring(2)); }
            else if (value.startsWith('!=')) { op = '!='; n = num(value.substring(2)); }
            else if (value.startsWith('>')) { op = '>'; n = num(value.substring(1)); }
            else if (value.startsWith('<')) { op = '<'; n = num(value.substring(1)); }
            else { op = '='; n = num(value); }
            if (n !== null) whereClauses.push(`${col} ${op} ${n}`);
            else console.warn(`Invalid numeric value in query part: ${part}`);
            continue;
        }

        if (key === 'limit') {
            const n = parseInt(value, 10);
            if (Number.isFinite(n) && n > 0) limit = n;
            else console.warn(`Invalid limit in query part: ${part}`);
            continue;
        }

        if (key === 'order') {
            switch (value) {
                case 'id':        orderBy = 'p._id ASC'; break;
                case 'random':    orderBy = 'RANDOM()'; break;
                case 'score':     orderBy = 'p.score DESC'; break;
                case 'score_asc': orderBy = 'p.score ASC'; break;
                default: console.warn(`Unknown order value: ${value}`); break;
            }
            continue;
        }

        console.warn(`Unknown query part: ${part}`);
    }

    return {
        where: whereClauses.length ? whereClauses.join(' AND ') : 'TRUE',
        tagTerms: { include: includeTags, exclude: excludeTags, optional: optionalTags },
        limit,
        orderBy,
    };
}

module.exports = { parseQuery };
