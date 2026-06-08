import { parseArgs } from 'node:util';
import { resolve } from 'node:path';
import { existsSync } from 'node:fs';
import { open } from '../db.mjs';

const HELP = `roboframe-cli doctor [options]

Validates an existing posts.duckdb against the schema imagemirror expects.
Prints row counts, sample values, and flags any obviously-wrong shape.

Options:
  --db <path>    DB path (default: ./posts.duckdb)
  --help`;

const REQUIRED_POSTS_COLS = [
    '_id', 'tags', 'file_ext', 'score', 'fav_count', 'rating',
    'image_width', 'image_height', 'ratio', 'duration', 'change_seq', 'parent_id',
];

export async function run(argv) {
    const { values } = parseArgs({
        args: argv,
        options: {
            db: { type: 'string' },
            help: { type: 'boolean' },
        },
    });

    if (values.help) { console.log(HELP); return; }

    const dbPath = resolve(values.db ?? './posts.duckdb');
    if (!existsSync(dbPath)) throw new Error(`No such file: ${dbPath}`);

    const handle = await open(dbPath);
    try {
        const tables = (await handle.all(`SELECT table_name FROM information_schema.tables WHERE table_schema = 'main'`))
            .map((r) => r.table_name);
        const have = (name) => tables.includes(name);

        if (!have('posts')) fail(`Missing table: posts`);
        if (!have('posts_paths')) fail(`Missing table: posts_paths`);

        const cols = (await handle.all(`SELECT column_name FROM information_schema.columns WHERE table_schema = 'main' AND table_name = 'posts'`))
            .map((r) => r.column_name);
        const missing = REQUIRED_POSTS_COLS.filter((c) => !cols.includes(c));
        if (missing.length) fail(`posts missing columns: ${missing.join(', ')}`);

        const postsCount = (await handle.all('SELECT COUNT(*) AS n FROM posts'))[0].n;
        const pathsCount = (await handle.all('SELECT COUNT(*) AS n FROM posts_paths'))[0].n;
        const orphans = (await handle.all('SELECT COUNT(*) AS n FROM posts p LEFT JOIN posts_paths pp ON p._id = pp._id WHERE pp._id IS NULL'))[0].n;

        console.log(`DB:           ${dbPath}`);
        console.log(`posts:        ${postsCount}`);
        console.log(`posts_paths:  ${pathsCount}`);
        console.log(`orphans:      ${orphans} (posts with no path entry)`);

        const sample = await handle.all('SELECT _id, file_ext, image_width, image_height, duration, len(tags) AS tag_count FROM posts ORDER BY _id LIMIT 3');
        if (sample.length) {
            console.log('Sample rows:');
            for (const row of sample) console.log('  ', JSON.stringify(row, bigIntReplacer));
        }

        if (orphans > 0) console.warn(`WARN: ${orphans} posts have no entry in posts_paths.`);
        console.log('OK');
    } finally {
        await handle.close();
    }
}

function fail(msg) { throw new Error(msg); }

function bigIntReplacer(_key, value) {
    return typeof value === 'bigint' ? Number(value) : value;
}
