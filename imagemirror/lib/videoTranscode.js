'use strict';

// H.264 transcode variant for video posts (`/get?vcodec=h264`).
//
// Pi-class kiosk hardware decodes H.264 and nothing else — VP9/AV1 sources
// software-decode at near-full CPU there. The server (typically a Mac, where
// h264_videotoolbox makes the encode nearly free) re-encodes on demand,
// streaming fragmented MP4 to the client *while* ffmpeg runs so the first
// play doesn't wait for the whole file. The output is simultaneously tee'd
// into a disk cache keyed by post id; replays hit a plain seekable file and
// go through the ordinary Range-capable streaming path.
//
// Sources that are already H.264 at <=1080p are detected via ffprobe and
// served raw — the client's hardware decoder handles them as-is.
//
// Everything degrades to raw streaming: ffmpeg missing, encoder probe
// failure, or all transcode slots busy simply mean the caller falls back to
// the untranscoded file (the client software-decodes, as it did before this
// feature existed).

const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');

const CACHE_EXT = '.h264.mp4';

function createVideoTranscoder({
  cachePath,
  maxCacheBytes = 2 * 1024 * 1024 * 1024,
  ffmpegPath = 'ffmpeg',
  ffprobePath = null,
  maxConcurrent = 2,
  log = console,
} = {}) {
  const probeBin = ffprobePath
    || path.join(path.dirname(ffmpegPath), path.basename(ffmpegPath).replace(/ffmpeg/, 'ffprobe'));

  let encoderPromise = null; // resolves to 'h264_videotoolbox' | 'libx264' | null
  let active = 0;
  let tempCounter = 0;
  const sourceInfoCache = new Map(); // post id -> { codec, height } | null

  // Probe once which H.264 encoder this ffmpeg build offers. VideoToolbox
  // (macOS hardware) wins; libx264 is the portable fallback. `null` means
  // ffmpeg itself is unusable and the whole feature stays dormant.
  function detectEncoder() {
    if (encoderPromise) return encoderPromise;
    encoderPromise = new Promise((resolve) => {
      const ff = spawn(ffmpegPath, ['-hide_banner', '-encoders'], { stdio: ['ignore', 'pipe', 'ignore'] });
      let out = '';
      ff.stdout.on('data', (d) => { out += d; });
      ff.on('error', () => resolve(null));
      ff.on('close', (code) => {
        if (code !== 0) return resolve(null);
        if (/\bh264_videotoolbox\b/.test(out)) return resolve('h264_videotoolbox');
        if (/\blibx264\b/.test(out)) return resolve('libx264');
        resolve(null);
      });
    }).then((enc) => {
      if (enc) log.log(`video transcode: using ${enc}`);
      else log.warn('video transcode: no usable ffmpeg/H.264 encoder, serving videos raw');
      return enc;
    });
    return encoderPromise;
  }

  async function available() {
    return Boolean(await detectEncoder());
  }

  function hasFreeSlot() {
    return active < maxConcurrent;
  }

  function cachedFile(id) {
    const p = path.join(cachePath, `${id}${CACHE_EXT}`);
    return fs.existsSync(p) ? p : null;
  }

  // ffprobe the source's video stream. A source that is already H.264 at
  // <=1080p doesn't need us — the kiosk's hardware decoder takes it raw.
  function sourceNeedsTranscode(id, filePath) {
    if (sourceInfoCache.has(id)) {
      const info = sourceInfoCache.get(id);
      return !(info && info.codec === 'h264' && info.height <= 1080);
    }
    return new Promise((resolve) => {
      const fp = spawn(probeBin, [
        '-v', 'error', '-select_streams', 'v:0',
        '-show_entries', 'stream=codec_name,height', '-of', 'json', filePath,
      ], { stdio: ['ignore', 'pipe', 'ignore'] });
      let out = '';
      fp.stdout.on('data', (d) => { out += d; });
      fp.on('error', () => resolve(true)); // probe unavailable -> just transcode
      fp.on('close', (code) => {
        let info = null;
        if (code === 0) {
          try {
            const s = (JSON.parse(out).streams || [])[0];
            if (s) info = { codec: s.codec_name, height: Number(s.height) || 0 };
          } catch { /* fall through */ }
        }
        sourceInfoCache.set(id, info);
        resolve(!(info && info.codec === 'h264' && info.height <= 1080));
      });
    });
  }

  function encodeArgs(encoder, filePath) {
    // Fit within 1080p without ever upscaling; force_divisible_by keeps
    // yuv420p happy on odd source dimensions. `\,` is lavfi escaping, not
    // shell — these args go through spawn() untouched.
    const scale = 'scale=min(iw\\,1920):min(ih\\,1080)'
      + ':force_original_aspect_ratio=decrease:force_divisible_by=2';
    const video = encoder === 'h264_videotoolbox'
      ? ['-c:v', 'h264_videotoolbox', '-b:v', '8M', '-maxrate', '10M', '-bufsize', '16M']
      : ['-c:v', 'libx264', '-preset', 'veryfast', '-crf', '21', '-maxrate', '10M', '-bufsize', '16M'];
    return [
      '-hide_banner', '-loglevel', 'error',
      '-i', filePath,
      '-vf', scale,
      ...video,
      '-pix_fmt', 'yuv420p', '-g', '60',
      '-c:a', 'aac', '-b:a', '128k', '-ac', '2',
      // Fragmented MP4: playable from the first bytes, no seekable output
      // needed while the encode is still running.
      '-movflags', 'frag_keyframe+empty_moov+default_base_moof',
      '-f', 'mp4', 'pipe:1',
    ];
  }

  // Transcode `filePath`, piping fragmented MP4 to `res` and tee'ing it into
  // the cache. The cache write survives a client disconnect (the encode is
  // cheap and the next play of the same post then hits the cached file), and
  // only a clean ffmpeg exit commits the cache entry. Caller must have
  // checked available() + hasFreeSlot().
  async function stream(req, res, id, filePath) {
    const encoder = await detectEncoder();
    if (!encoder) throw new Error('transcoder unavailable');
    active += 1;

    await fs.promises.mkdir(cachePath, { recursive: true });
    const finalPath = path.join(cachePath, `${id}${CACHE_EXT}`);
    const tempPath = path.join(cachePath, `.${id}.${process.pid}.${tempCounter++}.part`);
    const tempWs = fs.createWriteStream(tempPath);

    const ff = spawn(ffmpegPath, encodeArgs(encoder, filePath), {
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let ffErr = '';
    ff.stderr.on('data', (d) => { ffErr += d; });

    res.setHeader('Content-Type', 'video/mp4');
    res.setHeader('Content-Disposition', `inline; filename="${id}.mp4"`);
    // No Content-Length / Accept-Ranges: this response is a live pipe.

    ff.stdout.pipe(tempWs);
    ff.stdout.pipe(res);
    // A client disconnect must not kill the encode (the tee still warms the
    // cache) — detach res so the broken pipe doesn't back-pressure ffmpeg.
    res.on('close', () => {
      if (!res.writableEnded) ff.stdout.unpipe(res);
    });

    ff.on('error', (err) => {
      log.error(`video transcode spawn failed for ${id}: ${err.message}`);
    });
    ff.on('close', (code) => {
      active -= 1;
      tempWs.end(() => {
        if (code === 0) {
          fs.rename(tempPath, finalPath, (err) => {
            if (err) log.error(`video transcode cache commit failed for ${id}: ${err.message}`);
            else prune();
          });
        } else {
          fs.unlink(tempPath, () => {});
          log.error(`video transcode failed for ${id} (ffmpeg exit ${code}): ${ffErr.trim().slice(0, 500)}`);
          if (!res.writableEnded) res.destroy();
        }
      });
    });
  }

  // Drop the oldest cache entries beyond maxCacheBytes. Runs after each
  // commit; mtime order approximates LRU well enough for a slideshow.
  function prune() {
    fs.readdir(cachePath, (err, names) => {
      if (err) return;
      const entries = [];
      for (const name of names) {
        if (!name.endsWith(CACHE_EXT)) continue;
        try {
          const st = fs.statSync(path.join(cachePath, name));
          entries.push({ name, size: st.size, mtime: st.mtimeMs });
        } catch { /* raced a concurrent prune */ }
      }
      entries.sort((a, b) => b.mtime - a.mtime);
      let total = 0;
      for (const e of entries) {
        total += e.size;
        if (total > maxCacheBytes) {
          fs.unlink(path.join(cachePath, e.name), () => {});
        }
      }
    });
  }

  return { available, hasFreeSlot, cachedFile, sourceNeedsTranscode, stream, prune };
}

module.exports = { createVideoTranscoder };
