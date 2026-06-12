import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { DuckDBInstance } from '@duckdb/node-api';

const __dirname = dirname(fileURLToPath(import.meta.url));
const SCHEMA_DIR = join(__dirname, '..', 'sql');

// Normalize @duckdb/node-api values into plain JS for ergonomic consumers:
//   - BIGINT/HUGEINT arrive as BigInt; ids and counts here are small, so coerce
//     to Number (matches the behavior the old `duckdb` package gave us).
//   - LIST values (e.g. tags VARCHAR[]) arrive as { items: [...] }; unwrap to a
//     plain array.
function normalize(value) {
    if (typeof value === 'bigint') return Number(value);
    if (value && typeof value === 'object' && Array.isArray(value.items)) {
        return value.items.map(normalize);
    }
    return value;
}

// Open a DuckDB file (or ':memory:') and return a small handle whose methods
// mirror the old promisified shape: all()/run()/exec()/close(). Async now,
// because the neo API creates the instance and connection asynchronously.
export async function open(path) {
    const instance = await DuckDBInstance.create(path);
    const connection = await instance.connect();

    const all = async (sql) => {
        const reader = await connection.runAndReadAll(sql);
        return reader.getRowObjects().map((row) => {
            const out = {};
            for (const key of Object.keys(row)) out[key] = normalize(row[key]);
            return out;
        });
    };
    // The neo API's run() executes one or more ';'-separated statements, so it
    // covers both single statements and the multi-statement migration file that
    // ensureSchema feeds through exec().
    const run = async (sql) => { await connection.run(sql); };

    return {
        instance,
        connection,
        run,
        exec: run,
        all,
        async close() {
            connection.closeSync();
            instance.closeSync();
        },
    };
}

const MIGRATIONS = [
    [1, '0001_initial.sql'],
    [2, '0002_posts_tags.sql'],
];

export async function ensureSchema(handle) {
    for (const [version, file] of MIGRATIONS) {
        const sql = readFileSync(join(SCHEMA_DIR, file), 'utf8');
        await handle.exec(sql);
        const rows = await handle.all(`SELECT version FROM schema_migrations WHERE version = ${version}`);
        if (rows.length === 0) {
            await handle.run(`INSERT INTO schema_migrations (version) VALUES (${version})`);
        }
    }
}

// Rebuild the inverted tag index from posts. Clustered by tag so per-tag id
// probes are zone-map pruned. Call after any write that touches posts.tags.
export async function refreshPostsTags(handle) {
    await handle.exec(
        'CREATE OR REPLACE TABLE posts_tags AS SELECT unnest(tags) AS tag, _id FROM posts ORDER BY tag, _id;'
    );
}

// SQL string-quote: doubles single-quotes (DuckDB / standard SQL).
export function q(s) {
    return `'${String(s).replace(/'/g, "''")}'`;
}

// Build a `[...]` array literal of strings.
export function arrLit(items) {
    if (!items || items.length === 0) return '[]';
    return `[${items.map((t) => q(t)).join(',')}]`;
}

// Insert a batch of post rows. Each row is the shape produced by collect().
// We build VALUES strings rather than using prepared params because tags is
// a VARCHAR[] and the JS binding's parameter binding for arrays is finicky.
export async function insertPosts(handle, rows) {
    if (rows.length === 0) return;
    const valuesSql = rows.map((r) => (
        '(' + [
            r._id,
            arrLit(r.tags),
            q(r.file_ext),
            r.score,
            r.fav_count,
            q(r.rating),
            r.image_width ?? 'NULL',
            r.image_height ?? 'NULL',
            r.ratio ?? 'NULL',
            r.duration,
            r.change_seq,
            r.parent_id == null ? 'NULL' : r.parent_id,
        ].join(',') + ')'
    )).join(',\n');
    await handle.exec(
        'INSERT INTO posts (_id, tags, file_ext, score, fav_count, rating, image_width, image_height, ratio, duration, change_seq, parent_id) VALUES\n' +
        valuesSql + ';'
    );
}

export async function insertPaths(handle, rows) {
    if (rows.length === 0) return;
    const valuesSql = rows.map((r) => `(${r._id},${q(r.path)})`).join(',\n');
    await handle.exec('INSERT INTO posts_paths (_id, path) VALUES\n' + valuesSql + ';');
}
