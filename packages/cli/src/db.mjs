import { promisify } from 'node:util';
import duckdb from 'duckdb';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const SCHEMA_DIR = join(__dirname, '..', 'sql');

export function open(path) {
    const db = new duckdb.Database(path);
    const conn = db.connect();
    const run = promisify(conn.run.bind(conn));
    const all = promisify(conn.all.bind(conn));
    const exec = promisify(conn.exec.bind(conn));
    return {
        db, conn, run, all, exec,
        async close() {
            await new Promise((resolve, reject) => db.close((err) => err ? reject(err) : resolve()));
        },
    };
}

export async function ensureSchema(handle) {
    const sql = readFileSync(join(SCHEMA_DIR, '0001_initial.sql'), 'utf8');
    await handle.exec(sql);
    const rows = await handle.all('SELECT version FROM schema_migrations WHERE version = 1');
    if (rows.length === 0) {
        await handle.run('INSERT INTO schema_migrations (version) VALUES (1)');
    }
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
