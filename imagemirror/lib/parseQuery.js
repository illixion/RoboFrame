// Translate a user query string into a DuckDB SQL WHERE clause + paging options.
// Pure function; lives in its own module so it can be unit-tested without booting the server.
//
// Supported syntax:
//   bare-tag      include — `p.tags @> ARRAY[bare-tag]`
//   -tag          exclude — `NOT p.tags && ARRAY[tag]`
//   ~tag          optional/has-any — `p.tags && ARRAY[tag]`
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

function parseQuery(query) {
    const whereClauses = [];
    let limit = 40;
    let orderBy = 'RANDOM()';

    if (!query) return { where: 'TRUE', limit, orderBy };

    const includeTags = [];
    const excludeTags = [];
    const optionalTags = [];

    const parts = String(query).split(' ').filter(Boolean);

    for (const part of parts) {
        const colonIdx = part.indexOf(':');
        const key = colonIdx === -1 ? part : part.slice(0, colonIdx);
        const value = colonIdx === -1 ? undefined : part.slice(colonIdx + 1);

        if (value === undefined) {
            if (key.startsWith('-')) excludeTags.push(escapeTag(key.substring(1)));
            else if (key.startsWith('~')) optionalTags.push(escapeTag(key.substring(1)));
            else if (key) includeTags.push(escapeTag(key));
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

    if (includeTags.length) whereClauses.push(`p.tags @> ARRAY[${includeTags.map((t) => `'${t}'`).join(', ')}]`);
    if (excludeTags.length) whereClauses.push(`NOT p.tags && ARRAY[${excludeTags.map((t) => `'${t}'`).join(', ')}]`);
    if (optionalTags.length) whereClauses.push(`p.tags && ARRAY[${optionalTags.map((t) => `'${t}'`).join(', ')}]`);

    return { where: whereClauses.length ? whereClauses.join(' AND ') : 'TRUE', limit, orderBy };
}

module.exports = { parseQuery };
