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
// The caller passes a max height (`vmaxh`) and max fps (`vmaxfps`). Sources
// already in H.264 within both caps are detected via ffprobe and served raw —
// the client's hardware decoder handles them as-is. Anything taller, faster,
// or in another codec is downscaled/downsampled to fit. A cap of `0` means "no
// cap" (source resolution / frame rate): Pi kiosks ask for 720/30, while a
// client that renders H.264 directly (Spatialstash) asks for 0/0 to get the
// original. VideoToolbox encodes when available, else libx264 -preset ultrafast.
//
// The height cap is the real throttle for Pi-class kiosks. A Pi 3's
// bcm2835-codec decodes 1080p30 at ~realtime with no margin — the memory
// copy-back path saturates the bus, so real (detailed) content plays slower
// than realtime and stutters. Dropping to 720p falls off that cliff entirely
// (measured ~9x realtime headroom on the same board), which is why the
// native-kiosk asks for `vmaxh=720`. The cap keys the cache, so different
// clients can request different heights without colliding.
//
// The same encode path serves animated posts: an animated JXL, converted to
// APNG by the caller, rides through `animatedToMp4` → `encodeArgs` to a short
// looping 720p30 mp4, so the slideshow's animated content and its video posts
// share one code path and one budget.
//
// Everything degrades to raw streaming (or WebP/GIF for the animated path):
// ffmpeg missing, encoder probe failure, or all transcode slots busy simply
// mean the caller falls back to the untranscoded file (the client
// software-decodes, as it did before this feature existed).

const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');

// Cache entries carry the target height and fps cap so requests with
// different budgets (a kiosk's 720p30 vs Spatialstash's original 0p0fps)
// don't collide. The matcher also sweeps up legacy `${id}.h264.mp4` /
// `${id}.h264.720p.mp4` files (pre-fps cache) and MJPEG variants so they age
// out of the size budget like any other. `0` in either slot means "no cap"
// (source resolution / frame rate).
const CACHE_RE = /\.h264(?:\.\d+p)?(?:\.\d+fps)?\.mp4$|\.mjpeg$/;
// HLS variant cache directories: `${id}.hls.${maxHeight}p.${maxFps}fps`.
const HLS_DIR_RE = /\.hls\.\d+p\.\d+fps$/;

function cacheName(id, maxHeight, maxFps) {
  return `${id}.h264.${maxHeight}p.${maxFps}fps.mp4`;
}

function mjpegName(id, { w, h, fps, sec }) {
  return `${id}.${w}x${h}.${fps}fps.${sec}s.mjpeg`;
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

  // A source already H.264 within the height + fps caps is served raw — the
  // client decodes it as-is, no transcode. Either cap set to `0` means "no
  // cap": clients that want the source resolution / frame rate (Spatialstash,
  // which renders via an <img> and can take original H.264) pass 0/0. Pi-class
  // kiosks pass 720/30. The +1 fps tolerance keeps 29.97 NTSC on its native
  // cadence (an exact check would resample it).
  function fitsRaw(info, maxHeight, maxFps) {
    if (!info || info.codec !== 'h264' || !(info.fps > 0)) return false;
    const heightOk = maxHeight <= 0 || info.height <= maxHeight;
    const fpsOk = maxFps <= 0 || info.fps <= maxFps + 1;
    return heightOk && fpsOk;
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

  function cachedFile(id, maxHeight = 1080, maxFps = 30) {
    const p = path.join(cachePath, cacheName(id, maxHeight, maxFps));
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

  // A source already H.264 within the height + fps caps doesn't need us — the
  // client's decoder takes it raw. 0/0 caps accept any H.264 source as-is.
  async function sourceNeedsTranscode(id, filePath, maxHeight = 1080, maxFps = 30) {
    return !fitsRaw(await probeSource(id, filePath), maxHeight, maxFps);
  }

  // Shared H.264 → fragmented-mp4 arg builder for both the video-post stream
  // and the animated-post buffer. `inputFormat` forces the demuxer (the
  // animated path passes 'apng' since a .apng file is probed as a still PNG);
  // `audio` is false for the silent animated path.
  // Downscale filter shared by the mp4 and HLS encoders. maxHeight<=0 → no cap:
  // keep the source resolution, forcing only even dimensions for yuv420p.
  // Otherwise fit within maxHeight (16:9 width cap) without ever upscaling;
  // force_divisible_by keeps yuv420p happy on odd source dimensions. `\,` is
  // lavfi escaping, not shell — these args go through spawn() untouched. A
  // truthy fpsTarget resamples an over-budget (or unreadable-rate) source; 0
  // leaves the native cadence alone.
  function scaleFilter(maxHeight, fpsTarget) {
    let scale;
    if (maxHeight > 0) {
      const maxW = Math.round((maxHeight * 16) / 9);
      scale = `scale=min(iw\\,${maxW}):min(ih\\,${maxHeight})`
        + ':force_original_aspect_ratio=decrease:force_divisible_by=2';
    } else {
      scale = 'scale=trunc(iw/2)*2:trunc(ih/2)*2';
    }
    if (fpsTarget) scale += `,fps=${fpsTarget}`;
    return scale;
  }

  // VideoToolbox (hardware) when available; libx264 -preset ultrafast is the
  // portable fallback — fast enough to keep up with original-resolution
  // transcodes on a CPU encoder. Bitrate is generous on purpose: on a wired
  // LAN the extra bits buy sharpness at no real cost, and VideoToolbox spends
  // far less than the target on low-motion clips anyway.
  function videoCodecArgs(encoder) {
    return encoder === 'h264_videotoolbox'
      ? ['-c:v', 'h264_videotoolbox', '-b:v', '12M', '-maxrate', '16M', '-bufsize', '24M']
      : ['-c:v', 'libx264', '-preset', 'ultrafast', '-crf', '19', '-maxrate', '16M', '-bufsize', '24M'];
  }

  function encodeArgs(encoder, filePath, fpsTarget, maxHeight, { inputFormat = null, audio = true } = {}) {
    const scale = scaleFilter(maxHeight, fpsTarget);
    const video = videoCodecArgs(encoder);
    return [
      '-hide_banner', '-loglevel', 'error',
      ...(inputFormat ? ['-f', inputFormat] : []),
      '-i', filePath,
      '-vf', scale,
      ...video,
      '-pix_fmt', 'yuv420p', '-g', '60',
      ...(audio ? ['-c:a', 'aac', '-b:a', '128k', '-ac', '2'] : ['-an']),
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
  async function stream(req, res, id, filePath, maxHeight = 1080, maxFps = 30) {
    const encoder = await detectEncoder();
    if (!encoder) throw new Error('transcoder unavailable');
    const info = await probeSource(id, filePath);
    // maxFps<=0 → keep the native cadence; otherwise resample only when the
    // source is over budget (or its rate is unreadable).
    const fpsTarget = maxFps <= 0 ? 0
      : ((info && info.fps > 0 && info.fps <= maxFps + 1) ? 0 : maxFps);
    active += 1;

    await fs.promises.mkdir(cachePath, { recursive: true });
    const finalPath = path.join(cachePath, cacheName(id, maxHeight, maxFps));
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

  // MJPEG variant for decoder-poor clients (the PSP kiosk): a plain
  // concatenation of JPEG frames the client splits on SOI markers and feeds
  // to its JPEG decoder. Unlike the H.264 path this transcodes to the cache
  // *first* and serves the finished file — the outputs are small (fps- and
  // duration-capped), and a complete response with Content-Length is what a
  // hand-rolled HTTP client on 802.11b wants. Silent by design (-an).
  // Resolves to the cached path, or null when ffmpeg is missing/fails —
  // the route turns that into an error the client treats as "skip".
  const mjpegInflight = new Map();
  function mjpeg(id, filePath, opts) {
    const finalPath = path.join(cachePath, mjpegName(id, opts));
    if (fs.existsSync(finalPath)) return Promise.resolve(finalPath);
    if (mjpegInflight.has(finalPath)) return mjpegInflight.get(finalPath);
    const job = fs.promises.mkdir(cachePath, { recursive: true }).then(() => new Promise((resolve) => {
      const tempPath = path.join(cachePath, `.${id}.${process.pid}.${tempCounter++}.part`);
      const scale = `scale=min(iw\\,${opts.w}):min(ih\\,${opts.h})`
        + `:force_original_aspect_ratio=decrease,fps=${opts.fps}`;
      const ff = spawn(ffmpegPath, [
        '-hide_banner', '-loglevel', 'error',
        '-i', filePath, '-t', String(opts.sec),
        '-vf', scale, '-an', '-c:v', 'mjpeg', '-q:v', String(opts.q ?? 7),
        '-f', 'mjpeg', '-y', tempPath,
      ], { stdio: ['ignore', 'ignore', 'pipe'] });
      let ffErr = '';
      ff.stderr.on('data', (d) => { ffErr += d; });
      ff.on('error', () => resolve(null));
      ff.on('close', (code) => {
        if (code === 0) {
          fs.rename(tempPath, finalPath, (err) => {
            if (err) { log.error(`mjpeg cache commit failed for ${id}: ${err.message}`); resolve(null); }
            else { prune(); resolve(finalPath); }
          });
        } else {
          fs.unlink(tempPath, () => {});
          log.error(`mjpeg transcode failed for ${id} (ffmpeg exit ${code}): ${ffErr.trim().slice(0, 500)}`);
          resolve(null);
        }
      });
    })).finally(() => mjpegInflight.delete(finalPath));
    mjpegInflight.set(finalPath, job);
    return job;
  }

  // Animated-still → short looping H.264 mp4, sharing encodeArgs with the
  // video-post path. Animated JXL posts are delivered as video to every client
  // that can decode it (the web kiosk's <video>, native-kiosk's mpv,
  // Spatialstash's <img>); this is the encode step. `maxHeight`/`maxFps` cap
  // the output — Pi kiosks pass 720/30, clients that want the source geometry
  // (Spatialstash) pass 0/0. The caller passes the APNG it already produced
  // from the source via djxl — ffmpeg's apng demuxer reads it, but only from
  // a seekable file (it errors "Function not implemented" on a pipe), so the
  // APNG is staged to a temp file first. The mp4 still streams out over pipe:1
  // (fragmented, no seekable output needed) and is collected into a buffer:
  // the clips are small, cached in the image variant cache, and served with a
  // Content-Length like any image variant. Returns null when no H.264 encoder
  // is available — the caller falls back to the pre-mp4 WebP/GIF variants.
  async function animatedToMp4(apng, { maxHeight = 0, maxFps = 0 } = {}) {
    const encoder = await detectEncoder();
    if (!encoder) return null;

    await fs.promises.mkdir(cachePath, { recursive: true });
    const tempPath = path.join(cachePath, `.${process.pid}.${tempCounter++}.apng`);
    await fs.promises.writeFile(tempPath, apng);

    try {
      return await new Promise((resolve) => {
        const chunks = [];
        let ffErr = '';
        const ff = spawn(ffmpegPath,
          encodeArgs(encoder, tempPath, maxFps > 0 ? maxFps : 0, maxHeight, { inputFormat: 'apng', audio: false }),
          { stdio: ['ignore', 'pipe', 'pipe'] });
        ff.stdout.on('data', (c) => chunks.push(c));
        ff.stderr.on('data', (c) => { ffErr += c; });
        ff.on('error', (err) => {
          log.error(`animated mp4 spawn failed: ${err.message}`);
          resolve(null);
        });
        ff.on('close', (code) => {
          if (code === 0 && chunks.length) return resolve(Buffer.concat(chunks));
          log.error(`animated mp4 transcode failed (ffmpeg exit ${code}): ${ffErr.trim().slice(0, 500)}`);
          resolve(null);
        });
      });
    } finally {
      fs.unlink(tempPath, () => {});
    }
  }

  function hlsDir(id, maxHeight, maxFps) {
    return path.join(cachePath, `${id}.hls.${maxHeight}p.${maxFps}fps`);
  }

  // HLS variant for Safari/WebKit clients (Spatialstash's `<video>`). Safari
  // refuses to play an on-the-fly transcode piped as a single unbounded mp4
  // (no Content-Length → it never produces media metadata), but plays HLS
  // fMP4 fine, starting on segment 0 while later segments are still encoding —
  // so this is the only way to *stream* a cold transcode to Safari. ffmpeg
  // writes the growing playlist + segments to a per-(id,caps) cache dir; the
  // route serves them (rewriting segment URIs to authenticated `/get` URLs).
  // `event` playlist type appends segments live and writes ENDLIST on a clean
  // finish, so a completed dir replays as a plain VOD. Resolves to the dir
  // once it's startable (playlist + init + first segment exist), or null when
  // no encoder is free/available — the caller then falls back to the raw file.
  const hlsStarts = new Map(); // dir -> Promise<dir|null>
  async function hls(id, filePath, maxHeight = 0, maxFps = 0) {
    const encoder = await detectEncoder();
    if (!encoder) return null;
    const dir = hlsDir(id, maxHeight, maxFps);
    const playlist = path.join(dir, 'index.m3u8');

    // An existing playlist (a completed VOD, or a still-running job's growing
    // list) is usable immediately.
    if (fs.existsSync(playlist)) return dir;
    if (hlsStarts.has(dir)) return hlsStarts.get(dir);
    if (!hasFreeSlot()) return null;

    const start = (async () => {
      const info = await probeSource(id, filePath);
      const fpsTarget = maxFps <= 0 ? 0
        : ((info && info.fps > 0 && info.fps <= maxFps + 1) ? 0 : maxFps);
      await fs.promises.mkdir(dir, { recursive: true });
      active += 1;
      const ff = spawn(ffmpegPath, [
        '-hide_banner', '-loglevel', 'error', '-i', filePath,
        '-vf', scaleFilter(maxHeight, fpsTarget),
        ...videoCodecArgs(encoder),
        '-pix_fmt', 'yuv420p', '-g', '60',
        '-c:a', 'aac', '-b:a', '128k', '-ac', '2',
        // ~2s segments (g=60 → keyframe every 2s at 30fps) so segment 0 is
        // ready fast; independent_segments lets the player start anywhere.
        '-f', 'hls', '-hls_time', '2', '-hls_playlist_type', 'event',
        '-hls_flags', 'independent_segments', '-hls_segment_type', 'fmp4',
        '-hls_fmp4_init_filename', 'init.mp4',
        '-hls_segment_filename', path.join(dir, 'seg_%03d.m4s'),
        playlist,
      ], { stdio: ['ignore', 'ignore', 'pipe'] });
      let ffErr = '';
      ff.stderr.on('data', (d) => { ffErr += d; });
      ff.on('error', (err) => log.error(`hls spawn failed for ${id}: ${err.message}`));
      ff.on('close', (code) => {
        active -= 1;
        if (code === 0) prune();
        else log.error(`hls transcode failed for ${id} (ffmpeg exit ${code}): ${ffErr.trim().slice(0, 500)}`);
      });

      // Startable once the playlist, init segment, and first media segment
      // exist. Poll briefly; give up (→ null, caller serves raw) if ffmpeg
      // dies first or it takes too long.
      const init = path.join(dir, 'init.mp4');
      const seg0 = path.join(dir, 'seg_000.m4s');
      for (let i = 0; i < 300; i++) {
        if (fs.existsSync(playlist) && fs.existsSync(init) && fs.existsSync(seg0)) return dir;
        if (ff.exitCode !== null && ff.exitCode !== 0) return null;
        await new Promise((r) => setTimeout(r, 100));
      }
      return fs.existsSync(playlist) ? dir : null;
    })().finally(() => hlsStarts.delete(dir));
    hlsStarts.set(dir, start);
    return start;
  }

  // Drop the oldest cache entries beyond maxCacheBytes. Runs after each
  // commit; mtime order approximates LRU well enough for a slideshow.
  function prune() {
    fs.readdir(cachePath, (err, names) => {
      if (err) return;
      const entries = [];
      for (const name of names) {
        const full = path.join(cachePath, name);
        try {
          if (HLS_DIR_RE.test(name)) {
            // Age an HLS variant as a single unit: total bytes, newest mtime.
            const files = fs.readdirSync(full);
            let size = 0;
            let mtime = 0;
            for (const f of files) {
              const fst = fs.statSync(path.join(full, f));
              size += fst.size;
              if (fst.mtimeMs > mtime) mtime = fst.mtimeMs;
            }
            entries.push({ name, size, mtime, dir: true });
          } else if (CACHE_RE.test(name)) {
            const st = fs.statSync(full);
            entries.push({ name, size: st.size, mtime: st.mtimeMs, dir: false });
          }
        } catch { /* raced a concurrent prune */ }
      }
      entries.sort((a, b) => b.mtime - a.mtime);
      let total = 0;
      for (const e of entries) {
        total += e.size;
        if (total > maxCacheBytes) {
          const full = path.join(cachePath, e.name);
          if (e.dir) fs.rm(full, { recursive: true, force: true }, () => {});
          else fs.unlink(full, () => {});
        }
      }
    });
  }

  return {
    available, hasFreeSlot, cachedFile, sourceNeedsTranscode, stream,
    mjpeg, animatedToMp4, hls, hlsDir, prune,
  };
}

module.exports = { createVideoTranscoder };
