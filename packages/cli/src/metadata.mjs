import sharp from 'sharp';
import { spawnSync } from 'node:child_process';

const STILL_EXTS = new Set(['jpg', 'jpeg', 'png', 'webp', 'gif', 'jxl', 'avif', 'tiff', 'bmp']);
const VIDEO_EXTS = new Set(['mp4', 'mov', 'm4v', 'mkv', 'webm', 'avi', 'wmv', 'flv', '3gp']);

export function classify(ext) {
    const lower = ext.toLowerCase();
    if (STILL_EXTS.has(lower)) return 'still';
    if (VIDEO_EXTS.has(lower)) return 'video';
    return 'unknown';
}

let ffprobeAvailable = null;
export function hasFfprobe() {
    if (ffprobeAvailable !== null) return ffprobeAvailable;
    const r = spawnSync('ffprobe', ['-version'], { stdio: 'ignore' });
    ffprobeAvailable = r.status === 0;
    return ffprobeAvailable;
}

export async function probeStill(filePath) {
    try {
        const meta = await sharp(filePath).metadata();
        if (!meta.width || !meta.height) return null;
        return {
            image_width: meta.width,
            image_height: meta.height,
            ratio: meta.width / meta.height,
            duration: 0,
        };
    } catch (err) {
        return { error: err.message };
    }
}

export function probeVideo(filePath) {
    if (!hasFfprobe()) return { error: 'ffprobe not available in PATH' };
    const r = spawnSync('ffprobe', [
        '-v', 'quiet',
        '-print_format', 'json',
        '-show_streams',
        '-show_format',
        filePath,
    ], { encoding: 'utf8' });
    if (r.status !== 0) return { error: `ffprobe exited ${r.status}` };
    let parsed;
    try { parsed = JSON.parse(r.stdout); } catch (e) { return { error: `ffprobe json parse: ${e.message}` }; }
    const video = (parsed.streams || []).find((s) => s.codec_type === 'video');
    if (!video) return { error: 'no video stream' };
    const duration = parseFloat(parsed.format?.duration ?? video.duration ?? 0) || 0;
    return {
        image_width: video.width || null,
        image_height: video.height || null,
        ratio: (video.width && video.height) ? video.width / video.height : null,
        duration,
    };
}
