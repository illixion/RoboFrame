'use strict';

// H.264 transcode variant for video posts (`/get?vcodec=h264`).
//
// Pi-class kiosk hardware decodes 8-bit 4:2:0 H.264 up to 1920 wide and
// nothing else — VP9/HEVC/AV1 (and 10-bit or 4:4:4 H.264) software-decode at
// full CPU there, and at source resolution that is enough to freeze a 1 GB
// board. The server (typically a Mac) re-encodes on demand, and every client
// reads the encode by tailing its cache file while ffmpeg is still writing
// it, so the first play doesn't wait for the whole file. Replays hit the
// finished file through the ordinary Range-capable streaming path.
//
// The caller passes a max height (`vmaxh`) and max fps (`vmaxfps`). Sources
// already in hardware-decodable H.264 within both caps are served raw.
// Anything taller, wider than the cap's 16:9 box, faster, in another codec
// or another pixel format is scaled/resampled to fit. A cap of `0` means "no
// cap" (source resolution / frame rate): Pi kiosks ask for 720/30, while a
// client that renders H.264 directly (Hypnos) asks for 0/0 to get the
// original. The height cap is the real throttle for Pi-class kiosks: a Pi 3's
// bcm2835-codec decodes 1080p30 at ~realtime with no margin, but 720p with
// ~9x headroom, which is why native-kiosk asks for `vmaxh=720`. The caps key
// the cache, so different clients can request different heights without
// colliding.
//
// Encodes run on the GPU wherever the host allows. On macOS the whole chain
// is VideoToolbox — hardware decode into VT surfaces, `scale_vt`, hardware
// H.264 encode — which costs ~1/20 of the CPU of a software decode (measured
// 0.8 s vs 25 s CPU for 20 s of 4K HEVC on an M1). A codec the host's
// decoder can't take (AV1 before M3) fails that pipeline before emitting a
// byte; the encode transparently retries with a software decode feeding the
// same hardware encoder, and remembers the codec so later encodes skip the
// attempt. Rotated or non-square-pixel sources take the software-decode path
// directly, since scale_vt can't apply either. Without VideoToolbox, libx264
// `-preset ultrafast` encodes a software-decoded stream.
//
// Concurrency: at most `maxConcurrent` encodes run at once (the M1's single
// media engine shares its throughput across sessions: two concurrent 4K
// encodes each still run at ~3x realtime, three at ~2x). One encode serves
// every request for the same (id, caps) — a displaySync merge that shows one
// cold video on four screens costs one encode. An encode keeps running after
// its last viewer leaves so the cache still gets the file, but such an orphan
// is the first thing preempted when a viewer needs its slot, so a kiosk
// skipping through cold videos can't starve the next one.
//
// When no slot is free `stream` returns false and the caller decides: a
// capped request (a decoder-limited client) gets a 503 rather than the raw
// file, an uncapped one falls back to raw.
//
// The same encode path serves animated posts: an animated JXL, converted to
// APNG by the caller, rides through `animatedToMp4` to a short looping mp4,
// so the slideshow's animated content and its video posts share one encoder.
//
// The cache directory is `cachePath`. It is created on demand only when its
// parent exists, so a cache on an external volume that isn't mounted is
// treated as unusable (the transcoder reports unavailable) instead of
// silently filling a same-named directory on the boot disk.

const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');
const { Writable } = require('stream');

// Cache entries carry the target height and fps cap so requests with
// different budgets (a kiosk's 720p30 vs Hypnos's original 0p0fps)
// don't collide. `0` in either slot means "no cap" (source resolution /
// frame rate).
const CACHE_RE = /\.h264(?:\.\d+p)?(?:\.\d+fps)?\.mp4$|\.mjpeg$|\.poster\.jpg$/;
// HLS variant cache directories: `${id}.hls.${maxHeight}p.${maxFps}fps`.
const HLS_DIR_RE = /\.hls\.\d+p\.\d+fps$/;
// Pixel formats the Pi's (and every consumer) H.264 hardware decoder takes.
const RAW_PIX_FMTS = new Set(['yuv420p', 'yuvj420p']);
// An HLS encode counts as watched while its playlist or segments were
// fetched within this window; after that it is an orphan like any other.
const HLS_IDLE_MS = 30000;
const READ_CHUNK = 256 * 1024;

function cacheName(id, maxHeight, maxFps) {
  return `${id}.h264.${maxHeight}p.${maxFps}fps.mp4`;
}

function mjpegName(id, { w, h, fps, sec }) {
  return `${id}.${w}x${h}.${fps}fps.${sec}s.mjpeg`;
}

function posterName(id) {
  return `${id}.poster.jpg`;
}

// Largest width a cap allows: the 16:9 box around `maxHeight`.
function capWidth(maxHeight) {
  return Math.round((maxHeight * 16) / 9);
}

// Output geometry for a source under a height cap: fit inside the cap's 16:9
// box without upscaling, even dimensions for yuv420p. `maxHeight<=0` keeps
// the source size.
function fitSize(width, height, maxHeight) {
  let w = width;
  let h = height;
  if (maxHeight > 0) {
    const s = Math.min(1, capWidth(maxHeight) / w, maxHeight / h);
    w *= s;
    h *= s;
  }
  const even = (v) => Math.max(2, Math.floor(v / 2) * 2);
  return { width: even(w), height: even(h) };
}

// A source already fits the client's decoder when it is 8-bit 4:2:0 H.264
// within the height, width and fps caps. Either cap set to `0` means "no
// cap": 0/0 accepts any H.264 as-is. The +1 fps tolerance keeps 29.97 NTSC
// on its native cadence.
function fitsRaw(info, maxHeight, maxFps) {
  if (!info || info.codec !== 'h264' || !(info.fps > 0)) return false;
  if (maxHeight <= 0 && maxFps <= 0) return true;
  if (!RAW_PIX_FMTS.has(info.pixFmt)) return false;
  const sizeOk = maxHeight <= 0
    || (info.height <= maxHeight && info.width <= capWidth(maxHeight));
  const fpsOk = maxFps <= 0 || info.fps <= maxFps + 1;
  return sizeOk && fpsOk;
}

// Encoder bitrate by output height. 720p-and-below outputs go to Pi-class
// kiosks, where every buffered megabyte is RAM a 1 GB board doesn't have;
// larger outputs keep the generous budget (on a wired LAN the extra bits
// buy sharpness, and VideoToolbox spends far less than the target on
// low-motion clips anyway).
function bitrateTier(outHeight) {
  return outHeight > 0 && outHeight <= 720
    ? { rate: '5M', max: '8M', buf: '12M' }
    : { rate: '12M', max: '16M', buf: '24M' };
}

function videoCodecArgs(encoder, outHeight) {
  const t = bitrateTier(outHeight);
  return encoder === 'h264_videotoolbox'
    ? ['-c:v', 'h264_videotoolbox', '-b:v', t.rate, '-maxrate', t.max, '-bufsize', t.buf]
    : ['-c:v', 'libx264', '-preset', 'ultrafast', '-crf', '19', '-maxrate', t.max, '-bufsize', t.buf];
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
  let active = 0;            // encode slots held
  let tempCounter = 0;
  let cacheWarned = false;
  const sourceInfoCache = new Map(); // post id -> probe info | null
  const jobs = new Map();            // cache key -> running encode
  // Codecs VideoToolbox failed to decode on this host; their encodes go
  // straight to the software-decode pipeline.
  const hwDecodeFailed = new Set();

  // Create the cache dir if needed, but only under an existing parent: a
  // cache on an unmounted volume must not quietly land on the boot disk.
  function cacheUsable() {
    try {
      if (fs.statSync(cachePath).isDirectory()) return true;
    } catch { /* missing — maybe create below */ }
    try {
      if (fs.statSync(path.dirname(cachePath)).isDirectory()) {
        fs.mkdirSync(cachePath);
        return true;
      }
    } catch { /* parent missing or not writable */ }
    if (!cacheWarned) {
      cacheWarned = true;
      log.warn(`video transcode: cache dir ${cachePath} is unavailable (volume not mounted?); transcoding disabled`);
    }
    return false;
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
      else log.warn('video transcode: no usable ffmpeg/H.264 encoder');
      return enc;
    });
    return encoderPromise;
  }

  async function available() {
    return Boolean(await detectEncoder()) && cacheUsable();
  }

  function isOrphan(job) {
    if (job.state !== 'running') return false;
    if (job.kind === 'hls') return Date.now() - job.lastTouch > HLS_IDLE_MS;
    return job.viewers === 0;
  }

  // A slot is free, or an orphaned encode can be preempted for one.
  function hasFreeSlot() {
    if (active < maxConcurrent) return true;
    for (const job of jobs.values()) if (isOrphan(job)) return true;
    return false;
  }

  function releaseSlot(job) {
    if (!job.holdsSlot) return;
    job.holdsSlot = false;
    active -= 1;
  }

  // Take a slot, preempting the youngest orphan (least work lost) if all are
  // held. Returns false when every slot serves a live viewer.
  function acquireSlot() {
    if (active < maxConcurrent) {
      active += 1;
      return true;
    }
    let victim = null;
    for (const job of jobs.values()) {
      if (isOrphan(job) && (!victim || job.startedAt > victim.startedAt)) victim = job;
    }
    if (!victim) return false;
    log.log(`video transcode: preempting orphaned ${victim.kind} encode of ${victim.id} for a viewer`);
    victim.kill();
    active += 1;
    return true;
  }

  function cachedFile(id, maxHeight = 1080, maxFps = 30) {
    const p = path.join(cachePath, cacheName(id, maxHeight, maxFps));
    return fs.existsSync(p) ? p : null;
  }

  // ffprobe the source's video stream. `null` means the probe failed —
  // callers treat that as "transcode, and cap conservatively".
  function probeSource(id, filePath) {
    if (sourceInfoCache.has(id)) return Promise.resolve(sourceInfoCache.get(id));
    return new Promise((resolve) => {
      const fp = spawn(probeBin, [
        '-v', 'error', '-select_streams', 'v:0',
        '-show_entries',
        'stream=codec_name,width,height,avg_frame_rate,pix_fmt,sample_aspect_ratio:stream_tags=rotate:stream_side_data=rotation',
        '-of', 'json', filePath,
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
              const sideRot = (s.side_data_list || []).find((d) => d.rotation !== undefined);
              const rotation = Number(sideRot ? sideRot.rotation : (s.tags && s.tags.rotate)) || 0;
              const sar = String(s.sample_aspect_ratio || '1:1');
              info = {
                codec: s.codec_name,
                width: Number(s.width) || 0,
                height: Number(s.height) || 0,
                fps: num > 0 && den > 0 ? num / den : 0,
                pixFmt: s.pix_fmt || '',
                rotated: rotation % 360 !== 0,
                squarePixels: sar === '1:1' || sar === '0:1' || sar === 'N/A',
              };
            }
          } catch { /* fall through */ }
        }
        sourceInfoCache.set(id, info);
        resolve(info);
      });
    });
  }

  async function sourceNeedsTranscode(id, filePath, maxHeight = 1080, maxFps = 30) {
    return !fitsRaw(await probeSource(id, filePath), maxHeight, maxFps);
  }

  // Which pipeline an encode starts on: 'gpu' is VideoToolbox end to end,
  // 'sw' a software decode + CPU scale feeding the same encoder. Only a
  // known-geometry, upright, square-pixel source whose codec VT hasn't
  // already refused goes to the GPU.
  function initialPlan(encoder, info) {
    if (encoder !== 'h264_videotoolbox' || !info || !info.width || !info.height) return 'sw';
    if (info.rotated || !info.squarePixels || hwDecodeFailed.has(info.codec)) return 'sw';
    return 'gpu';
  }

  function noteHwDecodeFailure(info, ffErr) {
    if (!info || hwDecodeFailed.has(info.codec)) return;
    hwDecodeFailed.add(info.codec);
    log.warn(`video transcode: VideoToolbox can't decode ${info.codec} here; using software decode for it `
      + `(${ffErr.trim().split('\n').pop().slice(0, 200)})`);
  }

  // Software-path scale filter: fit within the cap's 16:9 box without
  // upscaling (maxHeight<=0 keeps the source size, forcing only even
  // dimensions). `\,` is lavfi escaping, not shell — these args go through
  // spawn() untouched. A truthy fpsTarget resamples.
  function swScaleFilter(maxHeight, fpsTarget) {
    let scale;
    if (maxHeight > 0) {
      scale = `scale=min(iw\\,${capWidth(maxHeight)}):min(ih\\,${maxHeight})`
        + ':force_original_aspect_ratio=decrease:force_divisible_by=2';
    } else {
      scale = 'scale=trunc(iw/2)*2:trunc(ih/2)*2';
    }
    if (fpsTarget) scale += `,fps=${fpsTarget}`;
    return scale;
  }

  // maxFps<=0 keeps the native cadence; otherwise resample only an
  // over-budget (or unreadable-rate) source.
  function fpsTargetFor(info, maxFps) {
    if (maxFps <= 0) return 0;
    return (info && info.fps > 0 && info.fps <= maxFps + 1) ? 0 : maxFps;
  }

  // Output height an encode will produce, for the bitrate tier. Unknown
  // geometry falls back to the cap (or the large tier when uncapped).
  function outputHeight(info, maxHeight) {
    if (info && info.width && info.height) return fitSize(info.width, info.height, maxHeight).height;
    return maxHeight;
  }

  // Input + filter + video-codec args for one pipeline. The GPU plan keeps
  // frames in VT surfaces through scale_vt, so it takes no -pix_fmt (the
  // encoder emits 8-bit 4:2:0 from any VT surface, 10-bit included); the
  // software plan forces yuv420p for the encoder.
  function videoPipelineArgs(plan, encoder, filePath, info, maxHeight, fpsTarget, inputFormat = null) {
    const outH = outputHeight(info, maxHeight);
    if (plan === 'gpu') {
      const { width, height } = fitSize(info.width, info.height, maxHeight);
      let vf = `scale_vt=w=${width}:h=${height}`;
      if (fpsTarget) vf += `,fps=${fpsTarget}`;
      return [
        '-hwaccel', 'videotoolbox', '-hwaccel_output_format', 'videotoolbox_vld',
        '-i', filePath, '-vf', vf, ...videoCodecArgs(encoder, outH),
      ];
    }
    return [
      ...(inputFormat ? ['-f', inputFormat] : []),
      '-i', filePath, '-vf', swScaleFilter(maxHeight, fpsTarget),
      ...videoCodecArgs(encoder, outH), '-pix_fmt', 'yuv420p',
    ];
  }

  function encodeArgs(plan, encoder, filePath, info, maxHeight, fpsTarget, { inputFormat = null, audio = true } = {}) {
    return [
      '-hide_banner', '-loglevel', 'error',
      ...videoPipelineArgs(plan, encoder, filePath, info, maxHeight, fpsTarget, inputFormat),
      '-g', '60',
      ...(audio ? ['-c:a', 'aac', '-b:a', '128k', '-ac', '2'] : ['-an']),
      // Fragmented MP4: playable from the first bytes, no seekable output
      // needed while the encode is still running.
      '-movflags', 'frag_keyframe+empty_moov+default_base_moof',
      '-f', 'mp4', 'pipe:1',
    ];
  }

  // Start the shared encode for (id, caps). ffmpeg's stdout goes to a temp
  // file in the cache dir, never straight to a client, so a slow client
  // can't stall the encode; viewers tail that file (see `follow`). A clean
  // exit renames it into the cache. The slot is held for the job's whole
  // life, across a GPU→software retry.
  function startJob(key, id, filePath, info, encoder, maxHeight, maxFps) {
    const finalPath = path.join(cachePath, key);
    const job = {
      kind: 'mp4', key, id, finalPath, tempPath: null,
      state: 'running', flushed: 0, viewers: 0, holdsSlot: true,
      startedAt: Date.now(), ff: null, waiters: [],
      notify() { const w = job.waiters; job.waiters = []; for (const r of w) r(); },
      waitProgress() { return new Promise((r) => job.waiters.push(r)); },
      currentPath() { return job.state === 'done' ? finalPath : job.tempPath; },
      kill() {
        if (job.state !== 'running') return;
        job.state = 'killed';
        releaseSlot(job);
        jobs.delete(key);
        if (job.ff) job.ff.kill('SIGKILL');
        job.notify();
      },
    };
    jobs.set(key, job);
    const fpsTarget = fpsTargetFor(info, maxFps);

    const attempt = (plan) => {
      job.tempPath = path.join(cachePath, `.${id}.${process.pid}.${tempCounter++}.part`);
      const fd = fs.openSync(job.tempPath, 'w');
      const sink = new Writable({
        write(chunk, _enc, cb) {
          fs.write(fd, chunk, 0, chunk.length, null, (err) => {
            if (!err) {
              job.flushed += chunk.length;
              job.notify();
            }
            cb(err);
          });
        },
        final(cb) { fs.close(fd, () => cb()); },
      });
      const ff = spawn(ffmpegPath, encodeArgs(plan, encoder, filePath, info, maxHeight, fpsTarget), {
        stdio: ['ignore', 'pipe', 'pipe'],
      });
      job.ff = ff;
      let ffErr = '';
      ff.stderr.on('data', (d) => { ffErr += d; });
      ff.stdout.pipe(sink);
      ff.on('error', (err) => log.error(`video transcode spawn failed for ${id}: ${err.message}`));
      const sinkDone = new Promise((r) => sink.on('finish', r).on('error', r));
      ff.on('close', async (code) => {
        await sinkDone;
        const tempPath = job.tempPath;
        if (job.state === 'killed') {
          fs.unlink(tempPath, () => {});
          return;
        }
        if (code !== 0 && plan === 'gpu' && job.flushed === 0) {
          // VT refused the source before any output — retry in software.
          noteHwDecodeFailure(info, ffErr);
          fs.unlink(tempPath, () => {});
          attempt('sw');
          return;
        }
        jobs.delete(key);
        releaseSlot(job);
        if (code === 0) {
          fs.rename(tempPath, finalPath, (err) => {
            if (err) {
              log.error(`video transcode cache commit failed for ${id}: ${err.message}`);
              job.state = 'failed';
            } else {
              job.state = 'done';
              prune();
            }
            job.notify();
          });
        } else {
          fs.unlink(tempPath, () => {});
          log.error(`video transcode failed for ${id} (ffmpeg exit ${code}): ${ffErr.trim().slice(0, 500)}`);
          job.state = 'failed';
          job.notify();
        }
      });
    };
    attempt(initialPlan(encoder, info));
    return job;
  }

  // Stream a job's output to one client from byte 0, following the file as
  // ffmpeg extends it. The first viewer and a late joiner take the same path.
  async function follow(job, res) {
    job.viewers += 1;
    let counted = true;
    const leave = () => { if (counted) { counted = false; job.viewers -= 1; } };
    res.on('close', leave);
    let fh = null;
    let pos = 0;
    try {
      for (;;) {
        if (res.destroyed) return;
        if (pos < job.flushed) {
          if (!fh) {
            try {
              fh = await fs.promises.open(job.currentPath(), 'r');
            } catch {
              // Raced the rename into the cache — the finished file has it.
              fh = await fs.promises.open(job.currentPath(), 'r');
            }
          }
          const len = Math.min(READ_CHUNK, job.flushed - pos);
          const buf = Buffer.allocUnsafe(len);
          const { bytesRead } = await fh.read(buf, 0, len, pos);
          if (bytesRead === 0) {
            await job.waitProgress();
            continue;
          }
          pos += bytesRead;
          if (!res.write(bytesRead === len ? buf : buf.subarray(0, bytesRead))) {
            await new Promise((r) => { res.once('drain', r); res.once('close', r); });
          }
          continue;
        }
        if (job.state === 'done') {
          res.end();
          return;
        }
        if (job.state !== 'running') {
          res.destroy();
          return;
        }
        await job.waitProgress();
      }
    } catch (err) {
      log.error(`video transcode stream to client failed for ${job.id}: ${err.message}`);
      res.destroy();
    } finally {
      leave();
      if (fh) fh.close().catch(() => {});
    }
  }

  // Serve the (id, caps) transcode to `res`: join the running encode, or
  // start one. Resolves false without touching `res` when no slot can be
  // had; the caller then chooses between a 503 and the raw file.
  async function stream(req, res, id, filePath, maxHeight = 1080, maxFps = 30) {
    const key = cacheName(id, maxHeight, maxFps);
    let job = jobs.get(key);
    if (!job) {
      const encoder = await detectEncoder();
      if (!encoder || !cacheUsable()) return false;
      const info = await probeSource(id, filePath);
      job = jobs.get(key); // started by a concurrent request during the probes
      if (!job) {
        if (!acquireSlot()) return false;
        job = startJob(key, id, filePath, info, encoder, maxHeight, maxFps);
      }
    }
    res.setHeader('Content-Type', 'video/mp4');
    res.setHeader('Content-Disposition', `inline; filename="${id}.mp4"`);
    // No Content-Length / Accept-Ranges: the file is still growing.
    await follow(job, res);
    return true;
  }

  // Decode args for the ffmpeg jobs whose output isn't H.264 (mjpeg,
  // poster): VT hardware decode with frames copied back to system memory
  // for the software filters/encoder, or a plain software decode.
  function decodeInputArgs(plan, filePath) {
    return plan === 'gpu' ? ['-hwaccel', 'videotoolbox', '-i', filePath] : ['-i', filePath];
  }

  // Run a file-output ffmpeg job, retrying in software when the GPU decode
  // attempt fails. Resolves the exit code of the final attempt.
  async function runFileJob(id, filePath, buildArgs) {
    const encoder = await detectEncoder();
    const info = await probeSource(id, filePath);
    const run = (plan) => new Promise((resolve) => {
      const ff = spawn(ffmpegPath, buildArgs(plan), { stdio: ['ignore', 'ignore', 'pipe'] });
      let ffErr = '';
      ff.stderr.on('data', (d) => { ffErr += d; });
      ff.on('error', () => resolve({ code: -1, ffErr }));
      ff.on('close', (code) => resolve({ code, ffErr }));
    });
    const plan = initialPlan(encoder, info);
    let result = await run(plan);
    if (result.code !== 0 && plan === 'gpu') {
      noteHwDecodeFailure(info, result.ffErr);
      result = await run('sw');
    }
    return result;
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
    if (!cacheUsable()) return Promise.resolve(null);
    const tempPath = path.join(cachePath, `.${id}.${process.pid}.${tempCounter++}.part`);
    const scale = `scale=min(iw\\,${opts.w}):min(ih\\,${opts.h})`
      + `:force_original_aspect_ratio=decrease,fps=${opts.fps}`;
    const job = runFileJob(id, filePath, (plan) => [
      '-hide_banner', '-loglevel', 'error',
      ...decodeInputArgs(plan, filePath), '-t', String(opts.sec),
      '-vf', scale, '-an', '-c:v', 'mjpeg', '-q:v', String(opts.q ?? 7),
      '-f', 'mjpeg', '-y', tempPath,
    ]).then(({ code, ffErr }) => new Promise((resolve) => {
      if (code !== 0) {
        fs.unlink(tempPath, () => {});
        log.error(`mjpeg transcode failed for ${id} (ffmpeg exit ${code}): ${ffErr.trim().slice(0, 500)}`);
        return resolve(null);
      }
      fs.rename(tempPath, finalPath, (err) => {
        if (err) { log.error(`mjpeg cache commit failed for ${id}: ${err.message}`); resolve(null); }
        else { prune(); resolve(finalPath); }
      });
    })).finally(() => mjpegInflight.delete(finalPath));
    mjpegInflight.set(finalPath, job);
    return job;
  }

  // First-frame JPEG for a video post — a contact-sheet thumbnail a client can
  // fetch like any image, rather than relying on a `<video>` element's own
  // network/decode pipeline. That pipeline is a browser-controlled black box:
  // Chrome (and others) defer or suspend it on a backgrounded tab, so a
  // gallery of `<video preload="metadata">` posters can silently never load
  // while plain `fetch()`-based image thumbnails on the same page load fine.
  // Built once and cached like the mjpeg variant. No height cap: the caller
  // resizes same as any other thumbnail.
  const posterInflight = new Map();
  function poster(id, filePath) {
    const finalPath = path.join(cachePath, posterName(id));
    if (fs.existsSync(finalPath)) return Promise.resolve(finalPath);
    if (posterInflight.has(finalPath)) return posterInflight.get(finalPath);
    if (!cacheUsable()) return Promise.resolve(null);
    const tempPath = path.join(cachePath, `.${id}.${process.pid}.${tempCounter++}.poster.jpg`);
    const job = runFileJob(id, filePath, (plan) => [
      '-hide_banner', '-loglevel', 'error',
      ...decodeInputArgs(plan, filePath), '-frames:v', '1', '-q:v', '3',
      '-y', tempPath,
    ]).then(({ code, ffErr }) => new Promise((resolve) => {
      if (code !== 0) {
        fs.unlink(tempPath, () => {});
        log.error(`poster extraction failed for ${id} (ffmpeg exit ${code}): ${ffErr.trim().slice(0, 500)}`);
        return resolve(null);
      }
      fs.rename(tempPath, finalPath, (err) => {
        if (err) { log.error(`poster commit failed for ${id}: ${err.message}`); resolve(null); }
        else { prune(); resolve(finalPath); }
      });
    })).finally(() => posterInflight.delete(finalPath));
    posterInflight.set(finalPath, job);
    return job;
  }

  // Animated-still → short looping H.264 mp4. Animated JXL posts are
  // delivered as video to every client that can decode it (the web kiosk's
  // <video>, native-kiosk's mpv, Hypnos's <img>); this is the encode step.
  // `maxHeight`/`maxFps` cap the output — Pi kiosks pass 720/30, clients
  // that want the source geometry (Hypnos) pass 0/0. The caller passes the
  // APNG it already produced from the source via djxl — ffmpeg's apng
  // demuxer reads it, but only from a seekable file (it errors "Function not
  // implemented" on a pipe), so the APNG is staged to a temp file first. APNG
  // has no hardware decoder, so this is always the software-decode pipeline
  // into the H.264 encoder. The mp4 streams out over pipe:1 and is collected
  // into a buffer: the clips are small, cached in the image variant cache,
  // and served with a Content-Length like any image variant. Returns null
  // when no H.264 encoder is available — the caller falls back to the
  // pre-mp4 WebP/GIF variants.
  async function animatedToMp4(apng, { maxHeight = 0, maxFps = 0 } = {}) {
    const encoder = await detectEncoder();
    if (!encoder || !cacheUsable()) return null;

    const tempPath = path.join(cachePath, `.${process.pid}.${tempCounter++}.apng`);
    await fs.promises.writeFile(tempPath, apng);

    try {
      return await new Promise((resolve) => {
        const chunks = [];
        let ffErr = '';
        const ff = spawn(ffmpegPath,
          encodeArgs('sw', encoder, tempPath, null, maxHeight, maxFps > 0 ? maxFps : 0,
            { inputFormat: 'apng', audio: false }),
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

  // Mark an HLS encode as watched (its playlist or a segment was fetched),
  // keeping it from being preempted as an orphan.
  function touchHls(id, maxHeight, maxFps) {
    const job = jobs.get(path.basename(hlsDir(id, maxHeight, maxFps)));
    if (job) job.lastTouch = Date.now();
  }

  // HLS variant for Safari/WebKit clients (Hypnos's `<video>`). Safari
  // refuses to play an on-the-fly transcode piped as a single unbounded mp4
  // (no Content-Length → it never produces media metadata), but plays HLS
  // fMP4 fine, starting on segment 0 while later segments are still encoding —
  // so this is the only way to *stream* a cold transcode to Safari. ffmpeg
  // writes the growing playlist + segments to a per-(id,caps) cache dir; the
  // route serves them (rewriting segment URIs to authenticated `/get` URLs).
  // `event` playlist type appends segments live and writes ENDLIST on a clean
  // finish, so a completed dir replays as a plain VOD. A dir without ENDLIST
  // and no encode behind it (a killed or crashed run) is discarded and
  // re-encoded rather than served truncated. Resolves to the dir once it's
  // startable (playlist + init + first segment exist), or null when no slot
  // is free or the encode fails — the caller then falls back to the raw file.
  const hlsStarts = new Map(); // dir -> Promise<dir|null>
  async function hls(id, filePath, maxHeight = 0, maxFps = 0) {
    const encoder = await detectEncoder();
    if (!encoder || !cacheUsable()) return null;
    const dir = hlsDir(id, maxHeight, maxFps);
    const key = path.basename(dir);
    const playlist = path.join(dir, 'index.m3u8');

    if (jobs.has(key)) {
      touchHls(id, maxHeight, maxFps);
      return hlsStarts.get(dir) || dir;
    }
    if (hlsStarts.has(dir)) return hlsStarts.get(dir);
    if (fs.existsSync(playlist)) {
      try {
        if (fs.readFileSync(playlist, 'utf8').includes('#EXT-X-ENDLIST')) return dir;
      } catch { /* unreadable — rebuild */ }
      fs.rmSync(dir, { recursive: true, force: true });
    }
    if (!acquireSlot()) return null;

    const start = (async () => {
      const info = await probeSource(id, filePath);
      const fpsTarget = fpsTargetFor(info, maxFps);
      const job = {
        kind: 'hls', key, id, state: 'running', holdsSlot: true,
        startedAt: Date.now(), lastTouch: Date.now(), ff: null,
        kill() {
          if (job.state !== 'running') return;
          job.state = 'killed';
          releaseSlot(job);
          jobs.delete(key);
          if (job.ff) job.ff.kill('SIGKILL');
        },
      };
      jobs.set(key, job);
      const init = path.join(dir, 'init.mp4');
      const seg0 = path.join(dir, 'seg_000.m4s');

      const attempt = async (plan) => {
        await fs.promises.mkdir(dir, { recursive: true });
        const ff = spawn(ffmpegPath, [
          '-hide_banner', '-loglevel', 'error',
          ...videoPipelineArgs(plan, encoder, filePath, info, maxHeight, fpsTarget),
          '-g', '60',
          '-c:a', 'aac', '-b:a', '128k', '-ac', '2',
          // ~2s segments (g=60 → keyframe every 2s at 30fps) so segment 0 is
          // ready fast; independent_segments lets the player start anywhere.
          '-f', 'hls', '-hls_time', '2', '-hls_playlist_type', 'event',
          '-hls_flags', 'independent_segments', '-hls_segment_type', 'fmp4',
          '-hls_fmp4_init_filename', 'init.mp4',
          '-hls_segment_filename', path.join(dir, 'seg_%03d.m4s'),
          playlist,
        ], { stdio: ['ignore', 'ignore', 'pipe'] });
        job.ff = ff;
        let ffErr = '';
        ff.stderr.on('data', (d) => { ffErr += d; });
        ff.on('error', (err) => log.error(`hls spawn failed for ${id}: ${err.message}`));
        const exited = new Promise((resolve) => {
          ff.on('close', (code) => {
            if (job.state === 'killed') {
              fs.rmSync(dir, { recursive: true, force: true });
              return resolve('killed');
            }
            if (code !== 0 && plan === 'gpu' && !fs.existsSync(seg0)) {
              noteHwDecodeFailure(info, ffErr);
              fs.rmSync(dir, { recursive: true, force: true });
              return resolve('retry');
            }
            jobs.delete(key);
            releaseSlot(job);
            if (code === 0) {
              job.state = 'done';
              prune();
            } else {
              job.state = 'failed';
              fs.rmSync(dir, { recursive: true, force: true });
              log.error(`hls transcode failed for ${id} (ffmpeg exit ${code}): ${ffErr.trim().slice(0, 500)}`);
            }
            resolve(job.state);
          });
        });
        // Startable once the playlist, init segment, and first media
        // segment exist; poll briefly, bail out if ffmpeg exits first.
        let exitResult = null;
        exited.then((r) => { exitResult = r; });
        for (let i = 0; i < 300; i++) {
          if (fs.existsSync(playlist) && fs.existsSync(init) && fs.existsSync(seg0)) return dir;
          if (exitResult === 'retry') return attempt('sw');
          if (exitResult) return exitResult === 'done' && fs.existsSync(playlist) ? dir : null;
          await new Promise((r) => setTimeout(r, 100));
        }
        return fs.existsSync(playlist) ? dir : null;
      };
      return attempt(initialPlan(encoder, info));
    })().finally(() => hlsStarts.delete(dir));
    hlsStarts.set(dir, start);
    return start;
  }

  // Drop the oldest cache entries beyond maxCacheBytes. Runs after each
  // commit; mtime order approximates LRU well enough for a slideshow. An
  // HLS dir with a running encode is never touched.
  function prune() {
    fs.readdir(cachePath, (err, names) => {
      if (err) return;
      const entries = [];
      for (const name of names) {
        const full = path.join(cachePath, name);
        try {
          if (HLS_DIR_RE.test(name)) {
            if (jobs.has(name)) continue;
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

  function stats() {
    const running = [...jobs.values()].filter((j) => j.state === 'running');
    return {
      active,
      maxConcurrent,
      encodes: running.map((j) => ({
        kind: j.kind, id: j.id, orphan: isOrphan(j),
        viewers: j.kind === 'mp4' ? j.viewers : undefined,
        ageMs: Date.now() - j.startedAt,
      })),
      hwDecodeFailed: [...hwDecodeFailed],
    };
  }

  return {
    available, hasFreeSlot, cachedFile, sourceNeedsTranscode, stream,
    mjpeg, poster, animatedToMp4, hls, hlsDir, touchHls, prune, stats,
  };
}

module.exports = { createVideoTranscoder, fitsRaw, fitSize, bitrateTier };
