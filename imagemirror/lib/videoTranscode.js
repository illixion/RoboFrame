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
// The caller passes a max height (`vmaxh`, default 1080). Sources already in
// H.264 at or below that height and within the fps budget are detected via
// ffprobe and served raw — the client's hardware decoder handles them as-is.
// Anything taller, faster, or in another codec is downscaled/downsampled to
// fit. The fps budget scales with the height cap: 60fps is allowed at <=720p,
// 30fps at 1080p (see fpsBudget).
//
// The height cap is the real throttle for Pi-class kiosks. A Pi 3's
// bcm2835-codec decodes 1080p30 at ~realtime with no margin — the memory
// copy-back path saturates the bus, so real (detailed) content plays slower
// than realtime and stutters. Dropping to 720p falls off that cliff entirely
// (measured ~9x realtime headroom on the same board), which is why the
// native-kiosk asks for `vmaxh=720`. The cap keys the cache, so different
// clients can request different heights without colliding.
//
// Everything degrades to raw streaming: ffmpeg missing, encoder probe
// failure, or all transcode slots busy simply mean the caller falls back to
// the untranscoded file (the client software-decodes, as it did before this
// feature existed).

const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');

// Cache entries carry the target height so a 720p and a 1080p request for the
// same post don't collide. The matcher also sweeps up legacy `${id}.h264.mp4`
// files (pre-height cache) so they age out of the size budget like any other.
const CACHE_RE = /\.h264(?:\.\d+p)?\.mp4$/;

function cacheName(id, maxHeight) {
  return `${id}.h264.${maxHeight}p.mp4`;
}

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
  const sourceInfoCache = new Map(); // post id -> { codec, height, fps } | null

  // The fps ceiling scales with the height cap: a Pi-class decoder sustains
  // 720p60 with room to spare (~13% of realtime measured) but only 1080p30, so
  // 60fps is allowed only when the output is <=720p. The tolerances (31/61)
  // keep 29.97/59.94 NTSC sources on their native cadence — an exact 30/60
  // check would resample them. `target` is what a faster source resamples to.
  function fpsBudget(maxHeight) {
    return maxHeight <= 720 ? { cap: 61, target: 60 } : { cap: 31, target: 30 };
  }

  function fitsRaw(info, maxHeight) {
    return Boolean(info && info.codec === 'h264' && info.height <= maxHeight
      && info.fps > 0 && info.fps <= fpsBudget(maxHeight).cap);
  }

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

  function cachedFile(id, maxHeight = 1080) {
    const p = path.join(cachePath, cacheName(id, maxHeight));
    return fs.existsSync(p) ? p : null;
  }

  // ffprobe the source's video stream (codec, height, fps). `null` means the
  // probe failed — callers treat that as "transcode, and cap conservatively".
  function probeSource(id, filePath) {
    if (sourceInfoCache.has(id)) return Promise.resolve(sourceInfoCache.get(id));
    return new Promise((resolve) => {
      const fp = spawn(probeBin, [
        '-v', 'error', '-select_streams', 'v:0',
        '-show_entries', 'stream=codec_name,height,avg_frame_rate', '-of', 'json', filePath,
      ], { stdio: ['ignore', 'pipe', 'ignore'] });
      let out = '';
      fp.stdout.on('data', (d) => { out += d; });
      fp.on('error', () => resolve(null)); // probe unavailable
      fp.on('close', (code) => {
        let info = null;
        if (code === 0) {
          try {
            const s = (JSON.parse(out).streams || [])[0];
            if (s) {
              const [num, den] = String(s.avg_frame_rate || '').split('/').map(Number);
              info = {
                codec: s.codec_name,
                height: Number(s.height) || 0,
                fps: num > 0 && den > 0 ? num / den : 0,
              };
            }
          } catch { /* fall through */ }
        }
        sourceInfoCache.set(id, info);
        resolve(info);
      });
    });
  }

  // A source that is already H.264 within the height cap and <=30fps doesn't
  // need us — the kiosk's hardware decoder takes it raw.
  async function sourceNeedsTranscode(id, filePath, maxHeight = 1080) {
    return !fitsRaw(await probeSource(id, filePath), maxHeight);
  }

  function encodeArgs(encoder, filePath, fpsTarget, maxHeight) {
    // Fit within maxHeight (16:9 width cap) without ever upscaling;
    // force_divisible_by keeps yuv420p happy on odd source dimensions. `\,` is
    // lavfi escaping, not shell — these args go through spawn() untouched. A
    // truthy fpsTarget resamples an over-budget (or unreadable-rate) source;
    // 0 leaves the native cadence alone (24/25/30, and 50/60 at <=720p).
    const maxW = Math.round((maxHeight * 16) / 9);
    const scale = `scale=min(iw\\,${maxW}):min(ih\\,${maxHeight})`
      + ':force_original_aspect_ratio=decrease:force_divisible_by=2'
      + (fpsTarget ? `,fps=${fpsTarget}` : '');
    // Bitrate is generous on purpose: the cap that fixes Pi-class playback is
    // the resolution, not the bitrate, and on a wired kiosk the extra bits buy
    // a sharper 720p at no cost. VideoToolbox spends far less than the target
    // on low-motion clips anyway.
    const video = encoder === 'h264_videotoolbox'
      ? ['-c:v', 'h264_videotoolbox', '-b:v', '12M', '-maxrate', '16M', '-bufsize', '24M']
      : ['-c:v', 'libx264', '-preset', 'veryfast', '-crf', '19', '-maxrate', '16M', '-bufsize', '24M'];
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
  async function stream(req, res, id, filePath, maxHeight = 1080) {
    const encoder = await detectEncoder();
    if (!encoder) throw new Error('transcoder unavailable');
    const info = await probeSource(id, filePath);
    const { cap, target } = fpsBudget(maxHeight);
    const fpsTarget = (info && info.fps > 0 && info.fps <= cap) ? 0 : target;
    active += 1;

    await fs.promises.mkdir(cachePath, { recursive: true });
    const finalPath = path.join(cachePath, cacheName(id, maxHeight));
    const tempPath = path.join(cachePath, `.${id}.${process.pid}.${tempCounter++}.part`);
    const tempWs = fs.createWriteStream(tempPath);

    const ff = spawn(ffmpegPath, encodeArgs(encoder, filePath, fpsTarget, maxHeight), {
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
        if (!CACHE_RE.test(name)) continue;
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
