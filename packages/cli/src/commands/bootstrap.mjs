import { parseArgs } from 'node:util';
import { readdir, stat } from 'node:fs/promises';
import { join, extname, resolve } from 'node:path';
import { open, ensureSchema, insertPosts, insertPaths } from '../db.mjs';
import { classify, probeStill, probeVideo, hasFfprobe } from '../metadata.mjs';
import { tagsFromFolders, readSidecar, sanitizeTag } from '../tags.mjs';

const HELP = `roboframe-cli bootstrap <imageDir> [options]

Walks <imageDir>, probes each image/video for dimensions, derives tags,
and writes a posts.duckdb that imagemirror can attach read-only.

Options:
  --output <path>            Target DB path (default: ./posts.duckdb)
  --tags-from-folders        Derive tags from ancestor folder names (default: on)
  --no-tags-from-folders     Disable folder-derived tags
  --tags-from-sidecar        Read <stem>.tags.json sidecars next to each file (default: off)
  --include-videos           Probe .mp4/.webm/.mov etc. via ffprobe (default: on if ffprobe in PATH)
  --no-include-videos        Skip videos
  --extensions <csv>         File extensions to include (default: jxl,jpg,jpeg,png,webp,gif,mp4,webm,mov,mkv)
  --start-id <n>             First _id to assign (default: 1)
  --batch-size <n>           Rows per INSERT batch (default: 500)
  --resume                   Skip files already in posts_paths
  --dry-run                  Print summary without writing
  --help                     Show this help`;

const DEFAULT_EXTS = ['jxl', 'jpg', 'jpeg', 'png', 'webp', 'gif', 'mp4', 'webm', 'mov', 'mkv'];

export async function run(argv) {
    const { values, positionals } = parseArgs({
        args: argv,
        allowPositionals: true,
        options: {
            output: { type: 'string' },
            'tags-from-folders': { type: 'boolean', default: true },
            'no-tags-from-folders': { type: 'boolean' },
            'tags-from-sidecar': { type: 'boolean', default: false },
            'include-videos': { type: 'boolean' },
            'no-include-videos': { type: 'boolean' },
            extensions: { type: 'string' },
            'start-id': { type: 'string' },
            'batch-size': { type: 'string' },
            resume: { type: 'boolean', default: false },
            'dry-run': { type: 'boolean', default: false },
            help: { type: 'boolean', default: false },
        },
    });

    if (values.help || positionals.length === 0) {
        console.log(HELP);
        return;
    }

    const imageDir = resolve(positionals[0]);
    const dbPath = resolve(values.output ?? './posts.duckdb');
    const useFolders = values['no-tags-from-folders'] ? false : values['tags-from-folders'];
    const useSidecar = values['tags-from-sidecar'];
    const includeVideos = values['no-include-videos'] ? false : (values['include-videos'] ?? hasFfprobe());
    const extensions = (values.extensions ?? DEFAULT_EXTS.join(','))
        .split(',').map((s) => s.trim().toLowerCase()).filter(Boolean);
    const startId = parseInt(values['start-id'] ?? '1', 10);
    const batchSize = parseInt(values['batch-size'] ?? '500', 10);
    const resume = values.resume;
    const dryRun = values['dry-run'];

    if (!Number.isFinite(startId) || startId < 1) throw new Error(`--start-id must be a positive integer`);
    if (!Number.isFinite(batchSize) || batchSize < 1) throw new Error(`--batch-size must be a positive integer`);

    const dirInfo = await stat(imageDir).catch(() => null);
    if (!dirInfo || !dirInfo.isDirectory()) throw new Error(`Not a directory: ${imageDir}`);

    console.log(`Source:    ${imageDir}`);
    console.log(`Output:    ${dbPath}${dryRun ? ' (dry-run, not written)' : ''}`);
    console.log(`Folders:   ${useFolders ? 'on' : 'off'}    Sidecars: ${useSidecar ? 'on' : 'off'}    Videos: ${includeVideos ? (hasFfprobe() ? 'on' : 'on (no ffprobe!)') : 'off'}`);
    console.log(`Extensions: ${extensions.join(', ')}`);

    const handle = dryRun ? null : await open(dbPath);
    if (handle) await ensureSchema(handle);

    let knownPaths = new Set();
    let nextId = startId;
    if (handle && resume) {
        const existing = await handle.all('SELECT path, _id FROM posts_paths');
        for (const row of existing) knownPaths.add(row.path);
        if (existing.length > 0) {
            const maxId = await handle.all('SELECT MAX(_id) AS m FROM posts');
            nextId = Math.max(nextId, (maxId[0]?.m ?? 0) + 1);
        }
        console.log(`Resume:    ${knownPaths.size} known paths, starting next _id at ${nextId}`);
    }

    let scanned = 0, included = 0, skipped = 0, failed = 0;
    const postBatch = [];
    const pathBatch = [];

    async function flush() {
        if (!handle || postBatch.length === 0) return;
        await insertPosts(handle, postBatch);
        await insertPaths(handle, pathBatch);
        postBatch.length = 0;
        pathBatch.length = 0;
    }

    for await (const filePath of walk(imageDir)) {
        scanned++;
        const ext = extname(filePath).slice(1).toLowerCase();
        if (!extensions.includes(ext)) { skipped++; continue; }
        if (knownPaths.has(filePath)) { skipped++; continue; }

        const kind = classify(ext);
        if (kind === 'video' && !includeVideos) { skipped++; continue; }
        if (kind === 'unknown') { skipped++; continue; }

        let probe;
        if (kind === 'still') probe = await probeStill(filePath);
        else probe = probeVideo(filePath);

        if (!probe || probe.error) {
            failed++;
            console.warn(`  ${probe?.error ?? 'no metadata'}: ${filePath}`);
            continue;
        }

        const tags = [];
        if (useFolders) tags.push(...tagsFromFolders(imageDir, filePath));
        let rating = 's', score = 0, favCount = 0;
        if (useSidecar) {
            const sc = readSidecar(filePath);
            if (sc) {
                if (sc.tags) for (const t of sc.tags) {
                    const s = sanitizeTag(t);
                    if (s && !tags.includes(s)) tags.push(s);
                }
                if (sc.rating) rating = sc.rating;
                if (sc.score != null) score = sc.score;
                if (sc.fav_count != null) favCount = sc.fav_count;
            }
        }
        tags.push('_imported');
        if (kind === 'video') tags.push('_videos');

        const post = {
            _id: nextId++,
            tags,
            file_ext: ext,
            score,
            fav_count: favCount,
            rating,
            image_width: probe.image_width,
            image_height: probe.image_height,
            ratio: probe.ratio,
            duration: probe.duration ?? 0,
            change_seq: 0,
            parent_id: null,
        };
        postBatch.push(post);
        pathBatch.push({ _id: post._id, path: filePath });
        included++;

        if (postBatch.length >= batchSize) {
            await flush();
            if (included % (batchSize * 10) === 0) {
                console.log(`  ... ${included} ingested (${scanned} scanned)`);
            }
        }
    }

    await flush();

    console.log('');
    console.log(`Scanned:  ${scanned}`);
    console.log(`Included: ${included}`);
    console.log(`Skipped:  ${skipped}`);
    console.log(`Failed:   ${failed}`);

    if (handle) {
        await handle.close();
        console.log(`Wrote ${dbPath}`);
        console.log('');
        console.log(`Point imagemirror at it: DUCKDB_PATH=${dbPath} npm run start:imagemirror`);
    }
}

async function* walk(dir) {
    const entries = await readdir(dir, { withFileTypes: true });
    for (const entry of entries) {
        const full = join(dir, entry.name);
        if (entry.isDirectory()) {
            yield* walk(full);
        } else if (entry.isFile()) {
            yield full;
        }
    }
}
