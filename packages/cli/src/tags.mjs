import { readFileSync, existsSync } from 'node:fs';
import { dirname, basename, relative, sep } from 'node:path';

// Folder names like "0", "1", "12" are skipped — they're chunk subfolders from
// a CHUNK_SIZE=N layout, not meaningful tags.
const NUMERIC_ONLY = /^\d+$/;

export function sanitizeTag(raw) {
    return String(raw)
        .toLowerCase()
        .replace(/[^a-z0-9_]+/g, '_')
        .replace(/^_+|_+$/g, '');
}

// Generate tags from each ancestor folder name between the imageDir root and the file.
// Example: rootDir=/imgs, filePath=/imgs/landscape/sunset/IMG_0001.jpg
//   -> ['landscape', 'sunset']
export function tagsFromFolders(rootDir, filePath) {
    const rel = relative(rootDir, filePath);
    const parts = rel.split(sep).slice(0, -1); // drop the file basename
    const tags = [];
    for (const part of parts) {
        if (!part || NUMERIC_ONLY.test(part)) continue;
        const t = sanitizeTag(part);
        if (t && !tags.includes(t)) tags.push(t);
    }
    return tags;
}

// Optional sidecar: a file at <stem>.tags.json next to the image.
// Format: { "tags": ["..."], "rating": "s", "score": 50, "fav_count": 0 }
// Returns null if not present.
export function readSidecar(filePath) {
    const sidecarPath = filePath.replace(/\.[^./\\]+$/, '.tags.json');
    if (!existsSync(sidecarPath)) return null;
    try {
        const parsed = JSON.parse(readFileSync(sidecarPath, 'utf8'));
        return {
            tags: Array.isArray(parsed.tags) ? parsed.tags.map(String) : [],
            rating: typeof parsed.rating === 'string' ? parsed.rating : null,
            score: Number.isFinite(parsed.score) ? parsed.score : null,
            fav_count: Number.isFinite(parsed.fav_count) ? parsed.fav_count : null,
        };
    } catch (err) {
        console.warn(`Skipping malformed sidecar ${sidecarPath}: ${err.message}`);
        return null;
    }
}
