try { require("dotenv").config(); } catch (_) { /* dotenv is optional; env vars from the shell still work */ }
const express = require('express');
const http = require('http');
const fs = require('fs');
const path = require('path');
const axios = require('axios');
const cookieParser = require('cookie-parser');
const sharp = require('sharp');
const { spawn } = require('child_process');
const { DuckDBInstance } = require('@duckdb/node-api');
const bodyParser = require("body-parser");
const cors = require('cors');
const zlib = require('zlib');
const { loadConfig, pickEnv } = require('@roboframe/shared');
const { setupBroker } = require('./lib/broker');
const { createSearch } = require('./lib/searchQuery');
const { createTagExpander, identityExpander } = require('./lib/tagExpansion');
const { createHistory } = require('./lib/history');
const { createImageCache } = require('./lib/imageCache');
const { createPrefetcher } = require('./lib/prefetcher');
const { createVideoTranscoder } = require('./lib/videoTranscode');
const { createSceneProducer } = require('./lib/sceneProducer');

const config = loadConfig();
const srv = config.server;
const app = express();
const PORT = pickEnv('PORT', srv.port, 3123, { type: 'number' });
const HOST = pickEnv('SERVER_HOST', srv.host, 'localhost');
const RPC_TOKEN = pickEnv('RPC_TOKEN', srv.rpcToken, '');
const ACCESS_TOKEN = pickEnv('ACCESS_TOKEN', config.accessToken, '');

// Any caller of an image API route must present `accessToken` (read-mostly,
// shared with kiosks) or `rpcToken` (privileged). Token comes from the
// `?token=` query parameter or the `X-RoboFrame-Token` header.
function requireToken(req, res, next) {
    const t = req.query.token || req.headers['x-roboframe-token'] || '';
    if (t && (t === ACCESS_TOKEN || t === RPC_TOKEN)) return next();
    res.status(401).send('Unauthorized: invalid or missing token');
}

// Local data store: a single hand-editable JSON file holding blocked
// posts, blocked tags, and the tag list catalog. The broker watches it
// and rebroadcasts the affected slice on any external edit.
const DATA_PATH = pickEnv('DATA_PATH', srv.dataPath, path.join(__dirname, 'data.json'));

// Body parsers / CORS apply to the image API routes. /rpc routes attached by
// the broker register their own body handling where needed.
app.use(bodyParser.json());
app.use(cors());

// Serve the top-level kiosk frontend (the photo frame at /). The same single
// port also serves index.html, sobel.js, auth-overlay.{js,css}, etc.
app.use(express.static(path.join(__dirname, '..', 'public')));

app.use(cookieParser());

app.use(['/get', '/save', '/history', '/history.json', '/addtohistory', '/post', '/search', '/random', '/count', '/custom_page', '/rpc/tags.json'], requireToken);

// Folder of user-supplied HTML files surfaced by /custom_page (P key
// "custom page" mode on the kiosk). Per-install, gitignored — see README.
const CUSTOM_PAGES_PATH = pickEnv('CUSTOM_PAGES_PATH', srv.customPagesPath, path.join(__dirname, 'custom_pages'));

// Setup view engine
app.set('views', path.join(__dirname, 'views'));
app.set('view engine', 'ejs');

// Resolved from roboframe.config.json[server] with env-var overrides.
const filesOriginalPath = pickEnv('IMAGE_DB_PATH', srv.imageDbPath, '/Volumes/HDD/imagedb');
const mirrorFilesPath = pickEnv('IMAGE_MIRROR_PATH', srv.imageMirrorPath, '/Volumes/HDD/imagedb_mirror');
const SAVE_PATH = pickEnv('SAVE_PATH', srv.savePath, '/tmp');
const DJXL_PATH = pickEnv('DJXL_PATH', srv.djxlPath, 'djxl');
const JXLINFO_PATH = pickEnv('JXLINFO_PATH', srv.jxlinfoPath, 'jxlinfo');

// `/get?vcodec=h264` for video posts — Pi-class kiosks only hardware-decode
// H.264, so the server re-encodes other codecs on demand (see
// lib/videoTranscode.js), capping height to `vmaxh` (default 1080, kiosks 720).
// Degrades to raw streaming when ffmpeg is absent.
const videoTranscoder = createVideoTranscoder({
  cachePath: pickEnv('VIDEO_CACHE_PATH', srv.video?.cachePath, path.join(__dirname, 'video_cache')),
  maxCacheBytes: pickEnv('VIDEO_CACHE_MAX_BYTES', srv.video?.cacheMaxBytes, 2 * 1024 * 1024 * 1024, { type: 'number' }),
  ffmpegPath: pickEnv('FFMPEG_PATH', srv.video?.ffmpegPath, 'ffmpeg'),
  maxConcurrent: pickEnv('VIDEO_TRANSCODE_CONCURRENCY', srv.video?.transcodeConcurrency, 2, { type: 'number' }),
});

// Live scene producers (see lib/sceneProducer.js). Kiosks receive scenes
// via the `playScene` effect action; this only supervises the render side.
const sceneProducer = createSceneProducer({
  enabled: pickEnv('SCENES_ENABLED', srv.scenes?.enabled, false, { type: 'boolean' }),
  chromiumPath: pickEnv('SCENES_CHROMIUM_PATH', srv.scenes?.chromiumPath, ''),
  whipBase: pickEnv('SCENES_WHIP_BASE', srv.scenes?.whipBase, 'http://127.0.0.1:8889'),
  producerBase: pickEnv('SCENES_PRODUCER_BASE', srv.scenes?.producerBase, `http://127.0.0.1:${PORT}`),
  streams: srv.scenes?.streams || [],
});
process.on('exit', () => sceneProducer.close());

// Graceful shutdown: snapshot the in-memory slideshow deck before exiting so
// a restart (the deploy git hook sends SIGTERM) resumes the same shuffle
// order and view counts. `exit` handlers can't await, so the async save runs
// here on the termination signals. Guarded so a second signal during the
// write doesn't start a competing snapshot.
let shuttingDown = false;
async function gracefulShutdown(signal) {
  if (shuttingDown) return;
  shuttingDown = true;
  try { await saveRandomRanks(); }
  catch (err) { console.warn(`[shutdown] random_ranks snapshot failed: ${err.message}`); }
  process.exit(0);
}
process.on('SIGTERM', () => gracefulShutdown('SIGTERM'));
process.on('SIGINT', () => gracefulShutdown('SIGINT'));

// Set the default user agent for all Axios requests
axios.defaults.headers.common['User-Agent'] = 'roboframe/1.0';


// Rolling history of post IDs requested (state + dedup/cap logic in lib/history.js)
const history = createHistory({ maxSize: 50 });

// Variant-aware response cache. `/get` resolves through this so the
// prefetcher's pre-converted bytes are returned when a client arrives.
const IMAGE_CACHE_MAX_BYTES = pickEnv('IMAGE_CACHE_MAX_BYTES', srv.cache?.maxBytes, 256 * 1024 * 1024, { type: 'number' });
const PREFETCH_CONCURRENCY = pickEnv('IMAGE_PREFETCH_CONCURRENCY', srv.cache?.prefetchConcurrency, 2, { type: 'number' });
const PREFETCH_DISABLED = pickEnv('IMAGE_PREFETCH_DISABLED', srv.cache?.prefetchDisabled, false, { type: 'boolean' });
const imageCache = createImageCache({ maxBytes: IMAGE_CACHE_MAX_BYTES });
const prefetcher = createPrefetcher({
  concurrency: PREFETCH_CONCURRENCY,
  enabled: !PREFETCH_DISABLED,
  onError: (err, key) => {
    console.warn(`[prefetch] ${key}: ${err.message}`);
  },
});

const PNG_SIG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

function pngChunk(type, data) {
  const typeBuf = Buffer.from(type, 'ascii');
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length, 0);
  const crcInput = Buffer.concat([typeBuf, data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(zlib.crc32(crcInput), 0);
  return Buffer.concat([len, typeBuf, data, crc]);
}

/**
 * Split an APNG buffer into an array of { png, delayNum, delayDen } per
 * frame, where `png` is a standalone PNG of that frame. Assumes every
 * frame covers the full canvas — partial-frame APNGs (x/y offsets or
 * disposal compositing) are not supported and would need a real
 * compositor. Sources here are video → APNG so this holds.
 */
function splitApngFrames(buf) {
  if (buf.length < 8 || !buf.slice(0, 8).equals(PNG_SIG)) {
    throw new Error('not a PNG');
  }
  let ihdrChunk = null;
  const ancillary = [];
  const frames = [];
  let cur = null;
  let sawIdat = false;
  let p = 8;
  while (p + 8 <= buf.length) {
    const len = buf.readUInt32BE(p);
    const type = buf.slice(p + 4, p + 8).toString('ascii');
    const dataStart = p + 8;
    const dataEnd = dataStart + len;
    const chunkEnd = dataEnd + 4;
    if (chunkEnd > buf.length) break;
    const whole = buf.slice(p, chunkEnd);

    if (type === 'IHDR') {
      ihdrChunk = whole;
    } else if (type === 'fcTL') {
      const width = buf.readUInt32BE(dataStart + 4);
      const height = buf.readUInt32BE(dataStart + 8);
      const delayNum = buf.readUInt16BE(dataStart + 20);
      const delayDen = buf.readUInt16BE(dataStart + 22);
      cur = { width, height, delayNum, delayDen, idats: [] };
      frames.push(cur);
    } else if (type === 'IDAT') {
      sawIdat = true;
      if (cur) cur.idats.push(whole);
    } else if (type === 'fdAT') {
      const frameData = buf.slice(dataStart + 4, dataEnd);
      cur.idats.push(pngChunk('IDAT', frameData));
    } else if (type === 'IEND') {
      break;
    } else if (type !== 'acTL') {
      if (!sawIdat) ancillary.push(whole);
    }
    p = chunkEnd;
  }

  if (!ihdrChunk) throw new Error('APNG missing IHDR');
  if (frames.length === 0) throw new Error('APNG has no frames');

  const ihdrData = Buffer.from(ihdrChunk.slice(8, 8 + 13));
  const iend = pngChunk('IEND', Buffer.alloc(0));

  return frames.map((f) => {
    const ihdr = Buffer.from(ihdrData);
    ihdr.writeUInt32BE(f.width, 0);
    ihdr.writeUInt32BE(f.height, 4);
    const parts = [PNG_SIG, pngChunk('IHDR', ihdr), ...ancillary, ...f.idats, iend];
    return { png: Buffer.concat(parts), delayNum: f.delayNum, delayDen: f.delayDen };
  });
}

/**
 * Decode an animated JXL to APNG (djxl's only animated output format).
 * Shared by every animated variant path — the WebP/GIF splitters and the
 * mp4 encoder all start from this intermediate.
 * @param {Buffer} imageData - Raw JXL bytes.
 * @returns {Promise<Buffer>} APNG bytes.
 */
function jxlToApng(imageData) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let err = '';
    const djxl = spawn(DJXL_PATH, ['-', '-', '--output_format', 'apng']);
    djxl.stdout.on('data', (c) => chunks.push(c));
    djxl.stderr.on('data', (c) => { err += c.toString(); });
    djxl.on('error', (e) => reject(new Error(`djxl spawn failed: ${e.message}`)));
    djxl.on('close', (code) => {
      if (code !== 0) return reject(new Error(`djxl exit ${code}: ${err.trim()}`));
      resolve(Buffer.concat(chunks));
    });
    djxl.stdin.on('error', () => {});
    djxl.stdin.end(imageData);
  });
}

/**
 * Convert an animated JXL to animated WebP. djxl emits APNG; we split that
 * into standalone PNG frames in memory and let sharp join them into an
 * animated WebP. Encoding rides on sharp's bundled libvips/libwebp — the
 * same stack already rebuilt by scripts/fix-sharp-libvips.sh — so there's
 * no separate ffmpeg/libwebp binary to keep in step with it. libvips' PNG
 * loader doesn't decode APNG animation itself, hence the explicit per-frame
 * split. This is the no-flag fallback; convert/lowmem serve mp4 instead.
 * @param {Buffer} imageData - Raw JXL bytes.
 * @returns {Promise<Buffer>}
 */
async function convertToAnimatedWebP(imageData) {
  const apngBuf = await jxlToApng(imageData);

  const frames = splitApngFrames(apngBuf);
  // APNG per-frame delay is delayNum/delayDen seconds (delayDen == 0 is spec
  // shorthand for /100); WebP wants it in milliseconds, per frame.
  const delay = frames.map((f) => Math.round(((f.delayNum || 1) / (f.delayDen || 100)) * 1000));
  return sharp(frames.map((f) => f.png), { join: { animated: true } })
    .webp({ quality: 90, effort: 4, loop: 0, delay })
    .toBuffer();
}

/**
 * Convert an animated JXL to a size-capped animated GIF. Same djxl → APNG →
 * per-frame split as convertToAnimatedWebP, but each frame is resized before
 * the join and the result is GIF: this is the `lowmem=1` animated variant for
 * clients that can't decode WebP at all (PSP kiosk) or only in software
 * (Pi-class boards). 256 colors is the price of universal decodability.
 * Reached via `gif=1` — the opt-in that keeps decoder-poor clients on GIF
 * now that plain lowmem serves animated posts as mp4.
 * @param {Buffer} imageData - Raw JXL bytes.
 * @param {number} [width] - Max output width (fit inside, no enlargement).
 * @param {number} [height] - Max output height.
 * @returns {Promise<Buffer>}
 */
async function convertToAnimatedGif(imageData, width, height) {
  const apngBuf = await jxlToApng(imageData);

  const frames = splitApngFrames(apngBuf);
  const delay = frames.map((f) => Math.round(((f.delayNum || 1) / (f.delayDen || 100)) * 1000));
  // Frames are resized individually (identical source dims → identical output
  // dims) because libvips' joined-animation resize needs page-height plumbing
  // that per-frame PNG resize sidesteps.
  const resized = await Promise.all(frames.map((f) =>
    sharp(f.png)
      .resize(width || null, height || null, { fit: 'inside', withoutEnlargement: true })
      .png()
      .toBuffer()));
  return sharp(resized, { join: { animated: true } })
    .gif({ loop: 0, delay, effort: 4 })
    .toBuffer();
}

/**
 * Probe a JXL buffer with jxlinfo and resolve true if it's animated.
 * jxlinfo prints "JPEG XL animation" on the header line for animated files.
 * Resolves false on any failure — caller falls through to the static path.
 * @param {Buffer} imageData
 * @returns {Promise<boolean>}
 */
function isAnimatedJxl(imageData) {
  return new Promise((resolve) => {
    let stdout = '';
    let stderr = '';
    let settled = false;
    const done = (v) => { if (!settled) { settled = true; resolve(v); } };
    const proc = spawn(JXLINFO_PATH, ['/dev/stdin']);
    proc.stdout.on('data', (chunk) => { stdout += chunk.toString(); });
    proc.stderr.on('data', (chunk) => { stderr += chunk.toString(); });
    proc.on('close', (code) => {
      if (code !== 0) console.error(`jxlinfo exit ${code}: ${stderr.trim()}`);
      done(/JPEG XL animation/.test(stdout));
    });
    proc.on('error', (err) => {
      console.error(`jxlinfo spawn failed: ${err.message}`);
      done(false);
    });
    proc.stdin.on('error', () => {});
    proc.stdin.end(imageData);
  });
}

/**
 * Determine if an image is mostly dark
 * @param {Buffer|ArrayBuffer} imageBuffer - Raw image data (Buffer from fs.readFile)
 * @param {number} sampleStep - Pixels to skip for sampling (higher = faster, lower = more accurate)
 * @returns {Promise<boolean>} true if dark, false otherwise
 */
async function isImageDark(imageBuffer, sampleStep = 10) {
    // Ensure we have a Node Buffer (ArrayBuffer => Buffer)
    if (imageBuffer instanceof ArrayBuffer) {
        imageBuffer = Buffer.from(imageBuffer);
    }

    // Get raw RGBA pixel data from sharp
    const { data, info } = await sharp(imageBuffer)
        .raw()
        .ensureAlpha()
        .toBuffer({ resolveWithObject: true });

    let totalBrightness = 0;
    let count = 0;

    for (let y = 0; y < info.height; y += sampleStep) {
        for (let x = 0; x < info.width; x += sampleStep) {
            const idx = (y * info.width + x) * 4; // 4 channels: R,G,B,A
            const r = data[idx];
            const g = data[idx + 1];
            const b = data[idx + 2];
            // Perceived brightness formula
            const brightness = 0.299 * r + 0.587 * g + 0.114 * b;
            totalBrightness += brightness;
            count++;
        }
    }

    const avgBrightness = totalBrightness / count;
    return avgBrightness < 100; // Dark threshold
}

/**
 * Dim an image for ambient/night-light viewing and emit JPEG.
 *
 * Multiplying RGB by `dim` is mathematically equivalent to alpha-blending
 * the source over a black page background — which is what the kiosk does
 * — so the dim is applied in colour space directly and the result needs
 * no alpha channel. JPEG output then plays nicely with hardware decode
 * on Pi-class hardware.
 *
 * @param {Buffer|ArrayBuffer} imageBuffer
 * @param {number} dim - RGB multiplier in (0, 1].
 * @param {number} width
 * @param {number} height
 * @returns {Promise<Buffer>}
 */
async function applyDimAndConvertToJpeg(imageBuffer, dim, width, height) {
    if (imageBuffer instanceof ArrayBuffer) {
        imageBuffer = Buffer.from(imageBuffer);
    }
    if (dim <= 0 || dim > 1) {
        throw new RangeError('dim must be in (0, 1]');
    }

    return sharp(imageBuffer)
        .resize(width, height, { fit: 'inside', withoutEnlargement: true })
        .flatten({ background: '#000000' })
        .linear(dim, 0)
        .jpeg({ quality: 95, mozjpeg: true })
        .toBuffer();
}
/**
 * Decode a JPEG-XL image to a PNG buffer via djxl. The PNG is the common
 * input to every downstream sharp path (resize, dim, wallpaper compose) —
 * sharp has no native JXL decoder.
 *
 * @param {Buffer} imageData - Raw JXL bytes.
 * @returns {Promise<Buffer>} - PNG bytes.
 */
async function decodeJxlToPng(imageData) {
  return new Promise((resolve, reject) => {
    const outputChunks = [];
    const djxl = spawn(DJXL_PATH, ['-', '-', '--output_format', 'png']);
    djxl.stdin.write(imageData);
    djxl.stdin.end();
    djxl.stdout.on('data', (chunk) => outputChunks.push(chunk));
    djxl.on('close', (code) => {
      if (code !== 0) return reject(new Error(`djxl failed with exit code ${code}`));
      resolve(Buffer.concat(outputChunks));
    });
    djxl.on('error', (err) => reject(new Error(`Failed to start djxl: ${err.message}`)));
  });
}

/**
 * Pick the ambient dim factor for `bright` mode. Already-bright photos use a
 * stronger multiplier so they don't stay glaring at the same level that keeps
 * dark photos readable. Bumped from 0.30/0.15 once the prior contrast-bump
 * (which clipped highlights on bright images) was dropped.
 *
 * @param {Buffer} pngBuffer
 * @returns {Promise<number>}
 */
async function pickAmbientDim(pngBuffer) {
  return (await isImageDark(pngBuffer)) ? 0.32 : 0.20;
}

/**
 * Decode a JPEG-XL image and emit JPEG (q95, black-flattened). When
 * `bright` is set, also dim the image for ambient/night-light viewing.
 *
 * @param {Buffer} imageData - Raw JXL bytes.
 * @param {number} width
 * @param {number} height
 * @param {boolean} bright - Apply ambient dim.
 * @returns {Promise<Buffer>}
 */
async function convertFromJxl(imageData, width, height, bright = false) {
  const pngBuffer = await decodeJxlToPng(imageData);
  try {
    if (bright) {
      return await applyDimAndConvertToJpeg(pngBuffer, await pickAmbientDim(pngBuffer), width, height);
    }
    return await convertBufferToJpeg(pngBuffer, width, height, 95);
  } catch (e) {
    throw new Error(`Sharp processing failed: ${e.message}`);
  }
}

// Pi-class kiosks can't sustain WebP software decode at 1080p — JPEG
// hits VideoCore's hardware decoder via MMAL and is ~5× cheaper. Alpha
// is flattened to black so PNG/transparent sources don't render with
// the JPEG default white. `?lowmem=1` lowers quality further to keep
// the kiosk's per-image blob memory down on the prefetch side.
async function convertBufferToJpeg(imageBuffer, width, height, quality = 95) {
  return sharp(imageBuffer, { animated: false })
    .resize(width, height, { fit: 'inside', withoutEnlargement: true })
    .flatten({ background: '#000000' })
    .jpeg({ quality, mozjpeg: true })
    .toBuffer();
}

// Gaussian blur applied to the backdrop copy in wallpaper mode. Tuned for
// 1080-class canvases — large enough that the under-image fill reads as a
// soft wash of colour rather than a recognizable second copy of the photo.
const WALLPAPER_BLUR_SIGMA = 24;
// How close an image's aspect must be to the canvas to crop-fill rather than
// letterbox: crop only when covering would discard no more than this fraction
// of the image's longer side. Beyond it the mismatch is large enough that
// cropping would lose real content, so we fit-inside and fill the gap. Tuned
// to keep a 9:16 image on a 19.5:9 phone (≈18% loss) on the fill side while
// near-fits (16:10 on 16:9, slightly-too-tall on a phone) still crop clean.
const WALLPAPER_MAX_CROP = 0.15;
// Edge-fill detection: sample this many rows/columns at an image's edge and
// treat it as a solid colour when a strong majority of the strip's pixels sit
// within the tolerance of the strip's median colour. Such images
// (illustrations, stickers on flat/transparent backgrounds, screenshots with
// letterbox bars) get that colour extended into the gap on that side instead
// of a blurred copy of the photo, so the subject doesn't ghost through.
// Judging against the median with a conforming-fraction threshold means a
// sticker whose anti-aliased edge or drop shadow touches the border can't
// veto the fill with a handful of outlier pixels, and the tolerance rides out
// JPEG noise and soft gradients across the thin strip.
const WALLPAPER_EDGE_STRIP = 3;
const WALLPAPER_EDGE_TOLERANCE = 24;
const WALLPAPER_EDGE_CONFORM = 0.9;
// Cutout (sticker) detection: an image whose alpha channel has at least this
// fraction of fully transparent pixels was authored to composite onto a
// backdrop, so wallpaper gaps get the flatten colour (black) on every side —
// the transparent background continues seamlessly into the gap no matter how
// much of the subject touches the image edges. Edge-colour heuristics can't
// see this (the subject can occupy half an edge strip), hence the dedicated
// alpha test. Fully transparent pixels don't occur incidentally in photos, so
// a small fraction is already a strong signal.
const WALLPAPER_CUTOUT_ALPHA = 8;
const WALLPAPER_CUTOUT_MIN_FRACTION = 0.02;

// Inspect a strip at one edge (top/bottom/left/right) of a raw RGB buffer and
// return a fill {r,g,b} when the edge reads as a solid colour, else null.
// `data` is tightly packed 3-channel RGB (alpha already flattened out).
function detectSolidEdge(data, width, height, edge) {
  const strip = WALLPAPER_EDGE_STRIP;
  let x0 = 0, x1 = width, y0 = 0, y1 = height;
  if (edge === 'top') y1 = Math.min(strip, height);
  else if (edge === 'bottom') y0 = Math.max(0, height - strip);
  else if (edge === 'left') x1 = Math.min(strip, width);
  else x0 = Math.max(0, width - strip); // right

  // Per-channel histograms → median, robust to outlier pixels (a sticker
  // subject clipping the edge) that would wreck a mean or a min/max spread.
  const hist = [new Uint32Array(256), new Uint32Array(256), new Uint32Array(256)];
  let n = 0;
  for (let y = y0; y < y1; y += 1) {
    for (let x = x0; x < x1; x += 1) {
      const i = (y * width + x) * 3;
      hist[0][data[i]] += 1;
      hist[1][data[i + 1]] += 1;
      hist[2][data[i + 2]] += 1;
      n += 1;
    }
  }
  if (n === 0) return null;
  const median = hist.map((h) => {
    const mid = n / 2;
    let acc = 0;
    for (let v = 0; v < 256; v += 1) {
      acc += h[v];
      if (acc >= mid) return v;
    }
    return 255;
  });

  // Count pixels near the median and average them for the fill colour, so the
  // outliers that were tolerated don't tint the extended background.
  let conforming = 0;
  let sumR = 0, sumG = 0, sumB = 0;
  for (let y = y0; y < y1; y += 1) {
    for (let x = x0; x < x1; x += 1) {
      const i = (y * width + x) * 3;
      const r = data[i], g = data[i + 1], b = data[i + 2];
      const dev = Math.max(Math.abs(r - median[0]), Math.abs(g - median[1]), Math.abs(b - median[2]));
      if (dev > WALLPAPER_EDGE_TOLERANCE) continue;
      sumR += r; sumG += g; sumB += b; conforming += 1;
    }
  }
  if (conforming / n < WALLPAPER_EDGE_CONFORM) return null;
  return { r: Math.round(sumR / conforming), g: Math.round(sumG / conforming), b: Math.round(sumB / conforming) };
}

// A tightly-packed raw RGB rectangle of one solid colour, for compositing into
// a wallpaper gap. Cheaper than round-tripping a generated image through sharp.
function solidRgbRect(width, height, { r, g, b }) {
  const buf = Buffer.allocUnsafe(width * height * 3);
  for (let i = 0; i < buf.length; i += 3) { buf[i] = r; buf[i + 1] = g; buf[i + 2] = b; }
  return buf;
}

/**
 * Compose an image onto a virtual canvas of exactly `width`×`height` for use
 * as a device wallpaper / lock-screen background. A cutout (sticker) — an
 * image with a meaningful share of fully transparent pixels — is always fit
 * whole with plain black in every gap, matching its flattened transparent
 * background. For everything else the aspect mismatch between image and
 * canvas decides the treatment:
 *
 *  - Mismatch small enough that covering discards ≤ WALLPAPER_MAX_CROP of the
 *    longer side → cover-crop, centered, so the canvas fills edge to edge with
 *    no bars. Avoids letterboxing images that nearly fit the display.
 *  - Larger mismatch → fit the whole image inside and fill the gap, which
 *    falls on one axis: top/bottom for an image wider than the canvas,
 *    left/right for one taller. A solid-coloured image edge extends its colour
 *    across the gap on that side (so flat bars / backgrounds continue
 *    seamlessly instead of ghosting through a blur); any remaining gap is
 *    filled by a blurred cover-copy. A wider-than-canvas image on a portrait
 *    phone is biased downward into the notification region (clock area stays
 *    calm); otherwise it's centered.
 *
 * `bright` applies the same ambient dim as the rest of the pipeline.
 *
 * @param {Buffer} imageBuffer - Decoded image bytes (PNG/JPEG/etc; JXL must
 *   already be decoded via decodeJxlToPng).
 * @param {number} width
 * @param {number} height
 * @param {{ bright?: boolean, quality?: number }} [opts]
 * @returns {Promise<Buffer>}
 */
async function composeWallpaper(imageBuffer, width, height, { bright = false, quality = 95 } = {}) {
  if (imageBuffer instanceof ArrayBuffer) imageBuffer = Buffer.from(imageBuffer);

  const meta = await sharp(imageBuffer).metadata();
  const imgAspect = meta.width / meta.height;
  const canvasAspect = width / height;
  // Fraction of the image's longer side a cover-crop would discard.
  const cropLoss = 1 - Math.min(imgAspect / canvasAspect, canvasAspect / imgAspect);

  // Cutout (sticker) test on the alpha plane. A cutout always takes the
  // fit-inside path with black in every gap: its transparent background is
  // flattened to black, so black fill continues it seamlessly no matter what
  // the subject does at the image edges — and cover-cropping a sticker to
  // dodge bars would chop the subject for no benefit.
  let cutout = false;
  if (meta.hasAlpha) {
    const alpha = await sharp(imageBuffer).ensureAlpha().extractChannel(3).raw().toBuffer();
    let transparent = 0;
    for (let i = 0; i < alpha.length; i += 1) {
      if (alpha[i] <= WALLPAPER_CUTOUT_ALPHA) transparent += 1;
    }
    cutout = transparent / alpha.length >= WALLPAPER_CUTOUT_MIN_FRACTION;
  }

  let canvas;
  if (!cutout && cropLoss <= WALLPAPER_MAX_CROP) {
    // Near-fit: fill the canvas, cropping the small overflow.
    canvas = sharp(imageBuffer).resize(width, height, { fit: 'cover', position: 'centre' });
  } else {
    // Far from the canvas aspect: fit the whole image and fill the gap. fit
    // 'inside' makes exactly one axis short — vertical gap if the image is
    // wider than the canvas, horizontal gap if it's taller.
    const fg = await sharp(imageBuffer)
      .resize(width, height, { fit: 'inside' })
      .toBuffer({ resolveWithObject: true });
    const fgW = fg.info.width;
    const fgH = fg.info.height;
    const verticalGap = imgAspect > canvasAspect;

    let left;
    let top;
    if (verticalGap) {
      left = Math.round((width - fgW) / 2);
      // Portrait canvas (phone) → bias the image's center to ~60% down so it
      // sits in the notification area; landscape → true vertical center.
      const centerFrac = height > width ? 0.60 : 0.50;
      top = Math.max(0, Math.min(height - fgH, Math.round(height * centerFrac - fgH / 2)));
    } else {
      left = Math.round((width - fgW) / 2);
      top = Math.round((height - fgH) / 2);
    }
    const gaps = verticalGap
      ? [
          { edge: 'top', size: top, rect: { w: width, h: top, x: 0, y: 0 } },
          { edge: 'bottom', size: height - top - fgH, rect: { w: width, h: height - top - fgH, x: 0, y: top + fgH } },
        ]
      : [
          { edge: 'left', size: left, rect: { w: left, h: height, x: 0, y: 0 } },
          { edge: 'right', size: width - left - fgW, rect: { w: width - left - fgW, h: height, x: left + fgW, y: 0 } },
        ];

    // Read the resized image once as flat RGB so each gap side can check
    // whether its edge is a solid colour worth extending into the gap.
    const flatRgb = cutout ? null : await sharp(fg.data)
      .flatten({ background: '#000000' })
      .raw()
      .toBuffer({ resolveWithObject: true });

    const fills = [];
    let needBlur = false;
    for (const gap of gaps) {
      if (gap.size <= 0) continue;
      const color = cutout ? { r: 0, g: 0, b: 0 } : detectSolidEdge(flatRgb.data, fgW, fgH, gap.edge);
      if (color) {
        fills.push({ input: solidRgbRect(gap.rect.w, gap.rect.h, color), raw: { width: gap.rect.w, height: gap.rect.h, channels: 3 }, top: gap.rect.y, left: gap.rect.x });
      } else {
        needBlur = true;
      }
    }

    // Blur a cover-copy as the base only when a gap still needs it; otherwise a
    // black base suffices (the solid fills + image cover the whole canvas).
    const backdrop = needBlur
      ? await sharp(imageBuffer).resize(width, height, { fit: 'cover', position: 'centre' }).blur(WALLPAPER_BLUR_SIGMA).toBuffer()
      : await sharp({ create: { width, height, channels: 3, background: '#000000' } }).png().toBuffer();
    canvas = sharp(backdrop).composite([...fills, { input: fg.data, top, left }]);
  }

  if (bright) canvas = canvas.linear(await pickAmbientDim(imageBuffer), 0);
  return canvas.flatten({ background: '#000000' }).jpeg({ quality, mozjpeg: true }).toBuffer();
}

const EXT_MIME = {
  jpg: 'image/jpeg', jpeg: 'image/jpeg', png: 'image/png', apng: 'image/apng',
  gif: 'image/gif', webp: 'image/webp', avif: 'image/avif', heic: 'image/heic',
  heif: 'image/heif', jxl: 'image/jxl', bmp: 'image/bmp', tif: 'image/tiff', tiff: 'image/tiff',
  webm: 'video/webm', mp4: 'video/mp4',
};
// Videos bypass the sharp pipeline and the imageCache — a single clip can be
// up to ~100MB, and they get streamed straight from disk with Range support.
const VIDEO_EXTS = new Set(['webm', 'mp4']);
const MIME_EXT = {
  'image/webp': 'webp', 'image/jpeg': 'jpg', 'image/png': 'png',
  'image/apng': 'apng', 'image/gif': 'gif', 'video/mp4': 'mp4',
};

function lookupPostPath(postId) {
  return new Promise((resolve, reject) => {
    db.all(
      "SELECT p.path, posts.tags FROM file_db.posts_paths p JOIN file_db.posts ON posts._id = p._id WHERE p._id = ? LIMIT 1;",
      [postId],
      (err, rows) => {
        if (err) return reject(err);
        if (!rows.length) return resolve(null);
        resolve(rows[0]);
      }
    );
  });
}

// Encode the variant requested by /get (or the prefetcher). Pure async —
// no req/res. Returns { buffer, mime, ext } or throws.
async function computeVariant({ id, convert, bright, width, height, lowmem, wallpaper, gif }) {
  const row = await lookupPostPath(id);
  if (!row) {
    const err = new Error('Post not found');
    err.code = 'NOT_FOUND';
    throw err;
  }
  const filePath = row.path;
  const isJxl = path.extname(filePath).toLowerCase() === '.jxl';
  let animatedMode = false;
  if (row.tags && row.tags.includes('animated_png')) animatedMode = true;

  let fullFilePath = filePath;
  if (!fs.existsSync(fullFilePath)) {
    fullFilePath = filePath.replace(filesOriginalPath, mirrorFilesPath);
  }
  if (!fs.existsSync(fullFilePath)) {
    const err = new Error(`File not found: ${fullFilePath}`);
    err.code = 'NO_FILE';
    throw err;
  }

  const data = await fs.promises.readFile(fullFilePath);
  if (!animatedMode && isJxl) {
    animatedMode = await isAnimatedJxl(data);
  }

  let finalBuffer = data;
  let finalMimeType = 'application/octet-stream';
  const srcExt = path.extname(filePath).slice(1).toLowerCase();

  if (animatedMode) {
    if (gif) {
      // Decoder-poor clients (PSP kiosk) opt back into GIF: they can't play
      // mp4 and can't know a post is animated before fetching, so `gif=1`
      // rides along on every request and the server returns GIF for animated
      // posts / JPEG for stills, transparently.
      finalBuffer = await convertToAnimatedGif(data, width, height);
      finalMimeType = 'image/gif';
    } else if (convert || lowmem) {
      // Animated posts are delivered as video to every client that can decode
      // it — a short looping 720p30 mp4, the same encode budget as the video
      // posts (see lib/videoTranscode.js). convert (the web kiosk, which can't
      // decode JXL at all) and lowmem (Pi-class decoders) share it.
      const apng = await jxlToApng(data);
      const mp4 = await videoTranscoder.animatedToMp4(apng);
      if (mp4) {
        finalBuffer = mp4;
        finalMimeType = 'video/mp4';
      } else {
        // No usable ffmpeg encoder — fall back to the pre-mp4 animated
        // variants so the post still renders somewhere.
        if (lowmem) {
          finalBuffer = await convertToAnimatedGif(data, width, height);
          finalMimeType = 'image/gif';
        } else {
          finalBuffer = await convertToAnimatedWebP(data);
          finalMimeType = 'image/webp';
        }
      }
    } else {
      finalBuffer = await convertToAnimatedWebP(data);
      finalMimeType = 'image/webp';
    }
  } else if (wallpaper) {
    // Compose onto the requested canvas. JXL sources are decoded first since
    // sharp can't read them; everything else sharp handles directly.
    const src = isJxl ? await decodeJxlToPng(data) : data;
    finalBuffer = await composeWallpaper(src, width, height, { bright, quality: lowmem ? 85 : 95 });
    finalMimeType = 'image/jpeg';
  } else if (convert) {
    finalBuffer = await convertFromJxl(data, width, height, bright);
    finalMimeType = 'image/jpeg';
  } else if (lowmem) {
    finalBuffer = await convertBufferToJpeg(data, width, height, 85);
    finalMimeType = 'image/jpeg';
  } else {
    if (EXT_MIME[srcExt]) finalMimeType = EXT_MIME[srcExt];
  }

  const ext = MIME_EXT[finalMimeType] || srcExt;
  return { buffer: finalBuffer, mime: finalMimeType, ext, animated: animatedMode };
}

function variantKeyParts(query) {
  const id = Number(query.id) || 0;
  return {
    id,
    convert: Boolean(Number(query.convert) || 0),
    bright: Boolean(Number(query.bright) || 0),
    width: Number(query.width) || 3840,
    height: Number(query.height) || 2160,
    lowmem: Boolean(Number(query.lowmem) || 0),
    wallpaper: Boolean(Number(query.wallpaper) || 0),
    gif: Boolean(Number(query.gif) || 0),
  };
}

// Resolve the on-disk path for a post, falling back from the original to the
// mirror location. Shared by the video streaming path and computeVariant.
function resolveFilePath(rawPath) {
  if (fs.existsSync(rawPath)) return rawPath;
  const fallback = rawPath.replace(filesOriginalPath, mirrorFilesPath);
  if (fs.existsSync(fallback)) return fallback;
  return null;
}

// Stream a video file with single-range support. Multi-range and suffix-only
// (`bytes=-N`) requests fall back to a 200 full-body response.
function streamVideo(req, res, filePath, mime, postId, ext) {
  let cancelled = false;
  res.on('close', () => { if (!res.writableEnded) cancelled = true; });

  fs.stat(filePath, (err, stat) => {
    if (cancelled || res.headersSent) return;
    if (err) {
      console.error(`Video stat failed for ${filePath}:`, err.message);
      res.status(500).send('Failed to read video');
      return;
    }
    const size = stat.size;
    const range = req.headers.range;
    res.setHeader('Content-Type', mime);
    res.setHeader('Content-Disposition', `inline; filename="${postId}.${ext}"`);
    res.setHeader('Accept-Ranges', 'bytes');

    let start = 0;
    let end = size - 1;
    let status = 200;
    if (range) {
      const m = /^bytes=(\d+)-(\d*)$/.exec(range);
      if (m) {
        const s = Number(m[1]);
        const e = m[2] === '' ? size - 1 : Number(m[2]);
        if (Number.isFinite(s) && Number.isFinite(e) && s <= e && e < size) {
          start = s;
          end = e;
          status = 206;
          res.setHeader('Content-Range', `bytes ${start}-${end}/${size}`);
        } else {
          res.setHeader('Content-Range', `bytes */${size}`);
          res.status(416).end();
          return;
        }
      }
    }
    res.setHeader('Content-Length', String(end - start + 1));
    res.status(status);
    const stream = fs.createReadStream(filePath, { start, end });
    stream.on('error', (streamErr) => {
      console.error(`Video stream error for ${filePath}:`, streamErr.message);
      if (!res.headersSent) res.status(500).end();
      else res.destroy();
    });
    stream.pipe(res);
  });
}

async function processRequestV2(req, res) {
  let cancelled = false;
  req.on('aborted', () => { cancelled = true; });
  res.on('close', () => {
    if (!res.writableEnded) cancelled = true;
  });

  const parts = variantKeyParts(req.query);
  if (!parts.id) {
    if (!res.headersSent) res.status(400).send('Missing post ID');
    return;
  }

  try {
    // Videos: stream from disk, bypassing the sharp pipeline and the variant
    // cache. They can be up to ~100MB each so we never buffer them in RAM.
    const row = await lookupPostPath(parts.id);
    if (cancelled || res.headersSent) return;
    if (!row) {
      res.status(404).send('Post not found');
      return;
    }
    const srcExt = path.extname(row.path).slice(1).toLowerCase();
    if (VIDEO_EXTS.has(srcExt)) {
      const filePath = resolveFilePath(row.path);
      if (!filePath) {
        res.status(500).send('An error occurred while sending the file.');
        return;
      }
      // Record videos in /history like images. Playback issues many Range
      // requests per view — only the opening request (no Range, or one that
      // starts at byte 0) counts, so mid-file seeks don't re-bump the entry.
      const range = req.headers.range;
      if (req.query.record !== '0' && (!range || /^bytes=0-/.test(range))) {
        history.addEntry({
          id: parts.id,
          ext: srcExt,
          deviceId: req.query.deviceId ? String(req.query.deviceId) : '',
        });
      }
      // vcodec=mjpeg: capped, silent MJPEG for decoder-poor clients (the PSP
      // kiosk splits it on SOI markers and plays via its JPEG decoder). Built
      // fully into the cache before serving, so the response is a complete
      // file with Content-Length. A failed/absent ffmpeg is a 503 the client
      // treats as "skip this post".
      if (req.query.vcodec === 'mjpeg') {
        const clamp = (v, lo, hi, dflt) => Math.min(hi, Math.max(lo, Number(v) || dflt));
        const file = await videoTranscoder.mjpeg(parts.id, filePath, {
          w: clamp(req.query.width, 64, 960, 480),
          h: clamp(req.query.height, 64, 544, 272),
          fps: clamp(req.query.fps, 4, 24, 12),
          sec: clamp(req.query.vmaxsec, 2, 60, 15),
        });
        if (cancelled || res.headersSent) return;
        if (file) streamVideo(req, res, file, 'video/x-motion-jpeg', parts.id, 'mjpeg');
        else res.status(503).send('mjpeg transcode unavailable');
        return;
      }
      // vcodec=h264: serve/build the hardware-decodable variant. Cache hits
      // stream like any file (Range-capable); a miss pipes ffmpeg's output
      // live. Sources already in H.264 within the height cap, a missing
      // ffmpeg, or a saturated transcoder all fall through to the raw file.
      // `vmaxh` caps the output height (default 1080; Pi-class kiosks send
      // 720 — see lib/videoTranscode.js for why resolution is the throttle).
      if (req.query.vcodec === 'h264' && await videoTranscoder.available()) {
        const vmaxh = Math.min(1080, Math.max(240, Number(req.query.vmaxh) || 1080));
        const cached = videoTranscoder.cachedFile(parts.id, vmaxh);
        if (cached) {
          streamVideo(req, res, cached, 'video/mp4', parts.id, 'mp4');
          return;
        }
        if (await videoTranscoder.sourceNeedsTranscode(parts.id, filePath, vmaxh)
            && videoTranscoder.hasFreeSlot()) {
          if (cancelled || res.headersSent) return;
          await videoTranscoder.stream(req, res, parts.id, filePath, vmaxh);
          return;
        }
      }
      if (cancelled || res.headersSent) return;
      streamVideo(req, res, filePath, EXT_MIME[srcExt], parts.id, srcExt);
      return;
    }

    const entry = await imageCache.getOrCompute(parts, () => computeVariant(parts));
    if (cancelled || res.headersSent) return;
    // Record in /history's per-display log. `deviceId` comes from the kiosk's
    // /get query; requests without one (iOS Shortcuts via /random, etc.)
    // bucket under `others`. `record=0` opts out entirely — used by the
    // /history page's own thumbnail fetches (and clients that record via
    // /addtohistory) so viewing history doesn't re-record into `others`.
    if (req.query.record !== '0') {
      history.addEntry({
        id: parts.id,
        ext: entry.ext,
        deviceId: req.query.deviceId ? String(req.query.deviceId) : '',
      });
    }
    res.setHeader('Content-Type', entry.mime);
    res.setHeader('Content-Disposition', `inline; filename="${parts.id}.${entry.ext}"`);
    res.send(entry.buffer);
  } catch (err) {
    if (cancelled || res.headersSent) return;
    if (err.code === 'NOT_FOUND') {
      console.error(`No DB entry for post ID: ${parts.id}`);
      res.status(404).send('Post not found');
    } else if (err.code === 'NO_FILE') {
      console.error(err.message);
      res.status(500).send('An error occurred while sending the file.');
    } else {
      console.error('Error processing image:', err);
      res.status(500).send('Image conversion failed');
    }
  }
}

let searchRef = null;
let brokerRef = null;
let incrementDisplayCountRef = null;

// Connect to DuckDB
const DUCKDB_PATH = pickEnv('DUCKDB_PATH', srv.duckdbPath, 'posts.duckdb');
// Cap DuckDB's intra-query parallelism. A match-set build is a full scan of
// the posts table that DuckDB would otherwise fan out across every core,
// starving sharp/djxl and the event loop; half the cores keeps the box
// responsive while the scan runs. Non-positive / non-finite → DuckDB default
// (all cores). Applied at instance creation, not hot-reloadable.
const DUCKDB_THREADS = pickEnv('DUCKDB_THREADS', srv.duckdbThreads, 4, { type: 'number' });
// How often the in-memory random_ranks table (random ordering + per-post
// display_count) is rebuilt from scratch — reshuffling the deck and zeroing
// view counts so the slideshow doesn't ossify around the same images.
// Configurable in hours; `0` (or any non-positive / non-finite value)
// disables the periodic rebuild entirely, leaving the ranks created at
// startup in place until the next manual reshuffle.
const RANDOM_RANK_REFRESH_HOURS = pickEnv('RANDOM_RANK_REFRESH_HOURS', srv.slideshow?.rankRefreshHours, 24, { type: 'number' });
const RANDOM_RANK_REFRESH_INTERVAL_MS = RANDOM_RANK_REFRESH_HOURS > 0
  ? RANDOM_RANK_REFRESH_HOURS * 60 * 60 * 1000
  : 0;
// Where the in-memory random_ranks deck (shuffle order + per-post view
// counts) is snapshotted on a clean shutdown so a restart — notably the
// deploy git hook — resumes the same deck instead of re-shuffling and
// zeroing every view count. Written only on graceful exit (SIGTERM/SIGINT);
// the hot path stays purely in-memory so ad-hoc/quick slideshows never touch
// disk. Empty string disables persistence entirely (always a fresh deck).
const RANK_STATE_PATH = pickEnv('RANK_STATE_PATH', srv.slideshow?.rankStatePath, path.join(__dirname, 'random_ranks.parquet'));

// Unwrap @duckdb/node-api list values (DuckDBListValue { items: [...] }) into
// plain JS arrays, matching how the old `duckdb` package returned VARCHAR[]
// columns like `tags`. BIGINT columns are left as BigInt — callers already
// handle that via Number()/bigint JSON replacers, so behavior is unchanged.
function normalizeValue(v) {
  if (v && typeof v === 'object' && Array.isArray(v.items)) return v.items.map(normalizeValue);
  return v;
}
function normalizeRow(row) {
  const out = {};
  for (const k of Object.keys(row)) out[k] = normalizeValue(row[k]);
  return out;
}

// Callback-compatible shim over a neo-API connection, preserving the
// db.run(sql, cb) and db.all(sql, [params], cb) signatures that the rest of
// this file — and lib/searchQuery.js, plus its test stubs — depend on.
function wrapConnection(connection) {
  return {
    connection,
    run(sql, cb) {
      connection.run(sql).then(() => cb && cb(null), (err) => cb && cb(err));
    },
    all(sql, paramsOrCb, maybeCb) {
      const cb = typeof paramsOrCb === 'function' ? paramsOrCb : maybeCb;
      const params = typeof paramsOrCb === 'function' ? undefined : paramsOrCb;
      const reader = params === undefined
        ? connection.runAndReadAll(sql)
        : connection.runAndReadAll(sql, params);
      reader.then(
        (r) => cb && cb(null, r.getRowObjects().map(normalizeRow)),
        (err) => cb && cb(err),
      );
    },
  };
}

// In-memory DB is the main connection; assigned in the async init IIFE below
// once the neo-API instance + connection are open (both are created async).
let db;

async function attachReadOnlyFileDb() {
  return new Promise((resolve, reject) => {
    db.run(`ATTACH '${DUCKDB_PATH}' AS file_db (READ_ONLY);`, (err) => {
      if (err) return reject(err);
      console.log("Attached file_db in read-only mode.");
      resolve();
    });
  });
}

function allAsync(sql) {
  return new Promise((resolve, reject) => db.all(sql, (err, rows) => (err ? reject(err) : resolve(rows || []))));
}

// What the attached library ships determines how tag queries run. posts_tags
// (the inverted index) marks the unflattened layout: posts carry only their
// direct tags, so queries MUST expand through the alias/implication tables —
// and the index is what makes those wide expansions cheap (id-list probes).
// Without posts_tags the library is either flattened (implications baked into
// every row, expansion would re-match the same posts through a pathologically
// wide && ARRAY[...] scan) or a folder import with no relations at all; both
// want identity expansion and the array-scan fallback.
async function detectFileDbTables() {
  const rows = await allAsync(`SELECT table_name FROM duckdb_tables() WHERE database_name = 'file_db';`);
  return new Set(rows.map((r) => String(r.table_name)));
}

async function loadTagExpander(tables) {
  if (!tables.has('posts_tags') || (!tables.has('tag_aliases') && !tables.has('tag_implications'))) {
    return identityExpander();
  }
  const aliases = new Map();
  if (tables.has('tag_aliases')) {
    const rows = await allAsync(`SELECT antecedent_name, consequent_name FROM file_db.tag_aliases WHERE status = 'active';`);
    for (const r of rows) aliases.set(String(r.antecedent_name), String(r.consequent_name));
  }
  const implications = new Map();
  if (tables.has('tag_implications')) {
    const rows = await allAsync(`SELECT antecedent_name, consequent_name FROM file_db.tag_implications WHERE status = 'active';`);
    for (const r of rows) {
      const ante = String(r.antecedent_name);
      let arr = implications.get(ante);
      if (!arr) { arr = []; implications.set(ante, arr); }
      arr.push(String(r.consequent_name));
    }
  }
  console.log(`Tag expansion loaded: ${aliases.size} aliases, ${implications.size} implication antecedents`);
  return createTagExpander({ aliases, implications });
}

async function refreshRandomRanks() {
  return new Promise((resolve, reject) => {
    db.run(`DROP TABLE IF EXISTS random_ranks;`, (err) => {
      if (err) return reject(err);

      db.run(`
        CREATE TABLE random_ranks AS
        SELECT _id, RANDOM() AS random_rank, 0 AS display_count
        FROM file_db.posts;
      `, (err) => {
        if (err) return reject(err);
        console.log("Created in-memory random_ranks from file_db.posts");
        resolve();
      });
    });
  });
}

// Tracks whether random_ranks has been created this run, so a shutdown that
// fires before init finishes doesn't try to snapshot a table that isn't there.
let ranksReady = false;

// Boot-time deck load. If a snapshot from a previous clean exit exists, seed
// random_ranks from it — reconciled against the *current* library so posts
// added since the snapshot get a fresh rank + zero count and posts removed
// since drop out. Any read failure (missing/corrupt/schema drift) falls back
// to a fresh deck, so a bad snapshot can never wedge startup.
async function loadRandomRanks() {
  if (!RANK_STATE_PATH || !fs.existsSync(RANK_STATE_PATH)) {
    return refreshRandomRanks();
  }
  try {
    await new Promise((resolve, reject) => {
      db.run(`DROP TABLE IF EXISTS random_ranks;`, (err) => (err ? reject(err) : resolve()));
    });
    await new Promise((resolve, reject) => {
      db.run(`
        CREATE TABLE random_ranks AS
        SELECT p._id,
               COALESCE(s.random_rank, RANDOM()) AS random_rank,
               COALESCE(s.display_count, 0)      AS display_count
        FROM file_db.posts p
        LEFT JOIN read_parquet('${RANK_STATE_PATH.replace(/'/g, "''")}') s ON s._id = p._id;
      `, (err) => (err ? reject(err) : resolve()));
    });
    console.log(`Restored random_ranks deck from ${RANK_STATE_PATH}`);
  } catch (err) {
    console.warn(`[random_ranks] snapshot restore failed (${err.message}) — starting from a fresh deck`);
    await refreshRandomRanks();
  }
}

// Snapshot the live deck to disk. Writes to a temp sibling then renames so a
// crash mid-write can't leave a truncated file the next boot would reject.
// Synchronous-friendly: awaited from the shutdown path before process.exit.
async function saveRandomRanks() {
  if (!RANK_STATE_PATH || !ranksReady || !db) return;
  const tmp = `${RANK_STATE_PATH}.tmp`;
  await new Promise((resolve, reject) => {
    db.run(`COPY random_ranks TO '${tmp.replace(/'/g, "''")}' (FORMAT PARQUET);`, (err) => (err ? reject(err) : resolve()));
  });
  await fs.promises.rename(tmp, RANK_STATE_PATH);
  console.log(`Saved random_ranks deck to ${RANK_STATE_PATH}`);
}


(async () => {
  try {
    const threads = Number(DUCKDB_THREADS);
    const instanceConfig = Number.isFinite(threads) && threads > 0
      ? { threads: String(Math.floor(threads)) }
      : undefined;
    const instance = await DuckDBInstance.create(':memory:', instanceConfig);
    db = wrapConnection(await instance.connect());
    if (instanceConfig) console.log(`DuckDB threads capped at ${instanceConfig.threads}`);
    await attachReadOnlyFileDb();
    await loadRandomRanks();
    ranksReady = true;

    if (RANDOM_RANK_REFRESH_INTERVAL_MS > 0) {
      setInterval(refreshRandomRanks, RANDOM_RANK_REFRESH_INTERVAL_MS);
      console.log(`random_ranks refresh scheduled every ${RANDOM_RANK_REFRESH_HOURS}h`);
    } else {
      console.log('random_ranks periodic refresh disabled (rankRefreshHours <= 0)');
    }

    const fileDbTables = await detectFileDbTables();
    const expander = await loadTagExpander(fileDbTables);
    const hasPostsTags = fileDbTables.has('posts_tags');
    if (hasPostsTags) console.log('posts_tags inverted index found — tag queries route through it');

    // The server is the single DuckDB reader. It feeds the slideshow
    // orchestrator, which broadcasts a `playback` channel over WebSocket
    // and is what every kiosk renders from.
    const search = createSearch({ db, expander, hasPostsTags });
    searchRef = search;

    const reshuffle = async () => {
        await refreshRandomRanks();
        if (search?.clearCache) search.clearCache();
    };

    // No cache interaction: match-set membership doesn't depend on view
    // counts, and page queries read display_count live from random_ranks.
    // Returns a promise that resolves once the UPDATE has committed so a
    // caller can order it before its next deck read — /random awaits it so
    // back-to-back picks never re-draw a post whose bump is still in flight.
    const incrementDisplayCount = (id) => {
        const numeric = Number(id);
        if (!Number.isFinite(numeric)) return Promise.resolve();
        return new Promise((resolve) => {
            db.run(`UPDATE random_ranks SET display_count = display_count + 1 WHERE _id = ${numeric};`, (err) => {
                if (err) console.warn(`[display_count] update failed for _id=${numeric}: ${err.message}`);
                resolve();
            });
        });
    };
    incrementDisplayCountRef = incrementDisplayCount;

    // Wire the WebSocket broker (and HA bridge if configured) onto the same
    // http.Server that serves the image API. One process, one port, no proxy.
    const server = http.createServer(app);
    // Prefetcher needs to invoke computeVariant through the cache so that a
    // /get arriving mid-compute shares the same promise.
    const prefetchVariant = (parts) =>
      imageCache.getOrCompute(parts, () => computeVariant(parts));
    brokerRef = setupBroker({
      server, app, config, dataPath: DATA_PATH, search, reshuffle, incrementDisplayCount,
      imageCache, prefetcher, prefetchVariant,
      expandBlockedTags: (tags) => expander.expandAll(tags),
    });
    server.listen(PORT, HOST, () => {
      console.log(`Server running on http://${HOST}:${PORT}`);
      // Scene producers (server.scenes, off by default): one supervised
      // Chromium per configured stream, publishing WHIP into mediamtx.
      // Started after listen so /scenes/producer.html is reachable.
      sceneProducer.start();
    });
  } catch (err) {
    console.error("Initialization error:", err);
  }
})();


// Express Routes
app.get('/get', (req, res) => {
  processRequestV2(req, res).catch((err) => {
    console.error('Unhandled /get error:', err);
    if (!res.headersSent) res.status(500).end();
  });
});

// Recent request history endpoint — returns an HTML page grouped by display,
// loading thumbnails from /get on the client side. Each display shows its
// HISTORY_VISIBLE most-recent posts up front; the rest stay behind an expand
// button so the page doesn't fire every thumbnail fetch at once.
const HISTORY_VISIBLE = 10;
app.get('/history', (req, res) => {
  const groups = history.listGroups();
  const token = req.query.token || req.headers['x-roboframe-token'] || '';
  const lowmem = Number(req.query.lowmem) === 1 ? 1 : 0;
  res.render('history', { groups, visible: HISTORY_VISIBLE, token, lowmem });
});

// JSON variant of /history for non-browser clients (e.g. the Spatial Stash
// visionOS app) that want to render their own history UI. Returns the same
// rolling window as /history, with id + ext per entry so clients can tell
// images from videos without a second round-trip.
app.get('/history.json', (req, res) => {
  res.json({ history: history.listJson() });
});

// This endpoint allows the user to send a post ID to insert it into history as the newest item
// It looks up the file extension from DuckDB
app.get('/addtohistory', (req, res) => {
  const postId = Number(req.query.id) || 0;

  if (!postId) {
    return res.status(400).send('Missing post ID');
  }

  // Query DuckDB for the post to get the file extension
  db.all(
    "SELECT file_ext FROM file_db.posts WHERE _id = ? LIMIT 1;",
    [postId],
    (err, rows) => {
      if (err) {
        console.error(`DuckDB error: ${err.message}`);
        return res.status(500).send('Database error');
      }
      if (!rows.length) {
        return res.status(404).send('Post not found');
      }

      const postExt = rows[0].file_ext;

      history.addEntry({
        id: postId,
        ext: postExt,
        deviceId: req.query.deviceId ? String(req.query.deviceId) : '',
      });

      return res.status(200).send('Post added to history');
    }
  );
});

// Debugging helper: total number of posts matching a query string. Reuses
// the same parseQuery as /search so syntax stays in sync.
app.get('/count', async (req, res) => {
  if (!searchRef) return res.status(503).send('Search not ready');
  const q = String(req.query.q || '');
  try {
    const n = await searchRef.runCount({ q });
    res.json({ q, count: n });
  } catch (err) {
    console.error(`count error: ${err.message}`);
    res.status(500).send('Count failed');
  }
});

// Debugging helper: run a query string through the same search layer the
// orchestrator uses. `?q=` is the query, `?limit=` optional override.
app.get('/search', async (req, res) => {
  if (!searchRef) return res.status(503).send('Search not ready');
  const q = String(req.query.q || '');
  const limitRaw = Number(req.query.limit);
  // parseQuery already defaults to 40 and honors `limit:N` inside `q`; only
  // pass an override when the caller set `?limit=` explicitly.
  const limit = Number.isFinite(limitRaw) && limitRaw > 0 ? limitRaw : undefined;
  try {
    const value = await searchRef.runSearch({ q, limit });
    res.type('application/json').send(JSON.stringify(value, (_k, v) => (typeof v === 'bigint' ? v.toString() : v)));
  } catch (err) {
    console.error(`search error: ${err.message}`);
    res.status(500).send('Search failed');
  }
});

// Pick one genuinely-random post matching a query and serve it. Built for
// scheduled clients (e.g. an iOS Shortcut that sets a wallpaper).
//
//   q=     raw query (same syntax as /search)
//   list=N join the server-side tag list at index N (combined with q). When
//          omitted, defaults to the active global list index in shared-tag
//          mode, or list 0 otherwise.
//   ratio= bare aspect ratio (width/height); expanded by the same ±window
//          the kiosks use into a `ratio:lo..hi` clause. Special case:
//          `wallpaper=1&ratio=1` instead returns the best-fitting post (by
//          closeness to the canvas aspect width/height) out of a random
//          least-seen chunk — no hard window, ignores ratioWindow — so a
//          9:16 library favours its best fits while still rotating through
//          the whole set least-seen-first.
//   order= `random` for independent uniform draws (with replacement);
//          anything else (default) walks the shared random_ranks deck
//          least-seen-first and bumps the view count, so repeated calls
//          shuffle through the library without replacement — better spread
//          for a scheduled wallpaper.
//   convert/bright/width/height/lowmem/gif  passthrough to the variant pipeline
//   wallpaper=1 compose onto a width×height canvas (see /get) — for setting a
//          device wallpaper / lock screen of a fixed resolution
//   json=1 return { id, ext } instead of the image bytes
app.get('/random', async (req, res) => {
  if (!searchRef) return res.status(503).send('Search not ready');

  const parts = [];
  // `list=` joins the server-side tag list at that index. When omitted, fall
  // back to what the displays are currently showing: in shared-tag mode that's
  // the active global list index; otherwise list 0. This way a bare /random
  // (e.g. an iOS Shortcut with no list param) tracks the slideshow's selection
  // instead of failing on an empty/NaN index.
  const listParam = req.query.list;
  const listOmitted = listParam === undefined || listParam === '';
  let listIdx;
  if (listOmitted) {
    const sharedOn = brokerRef && brokerRef.getSharedTags && brokerRef.getSharedTags();
    listIdx = sharedOn && brokerRef.orchestrator
      ? Number(brokerRef.orchestrator.getActiveTagsList())
      : 0;
  } else {
    listIdx = Number(listParam);
  }
  if (Number.isInteger(listIdx) && listIdx >= 0 && brokerRef) {
    const lists = brokerRef.getTagLists() || [];
    if (Array.isArray(lists[listIdx])) parts.push(...lists[listIdx]);
  }
  if (req.query.q) parts.push(String(req.query.q));

  const ratio = Number(req.query.ratio);
  const wantWallpaper = Number(req.query.wallpaper) === 1;
  const canvasW = Number(req.query.width) || 0;
  const canvasH = Number(req.query.height) || 0;

  // `wallpaper=1&ratio=1` is the fit-bias toggle: soft-prefer posts whose
  // aspect is closest to the wallpaper canvas (width/height), with no hard
  // `ratio:` window and ignoring the configured ratioWindow. A bare `ratio=1`
  // (no wallpaper) keeps its literal meaning — a square (1.0) target with the
  // usual ±window, for a photo frame.
  let ratioOrder = null;
  if (wantWallpaper && ratio === 1 && canvasW > 0 && canvasH > 0) {
    ratioOrder = canvasW / canvasH;
  } else if (Number.isFinite(ratio) && ratio > 0) {
    const rawW = brokerRef ? Number(brokerRef.getRatioWindow()) : 0.15;
    const w = Number.isFinite(rawW) && rawW > 0 && rawW < 1 ? rawW : 0.15;
    parts.push(`ratio:${(ratio * (1 - w)).toFixed(2)}..${(ratio * (1 + w)).toFixed(2)}`);
  }

  const q = parts.filter(Boolean).join(' ');

  // Apply the server-side blocklist in SQL — additive to any `-tag`
  // exclusions in `q` — so a one-shot client gets the same filtering the
  // slideshow's queue does without having to enforce it itself.
  const blockedIds = brokerRef ? brokerRef.getBlockedPosts() : [];
  const blockedTags = brokerRef ? brokerRef.getBlockedTags() : [];

  const pureRandom = String(req.query.order) === 'random';

  try {
    const row = pureRandom
      ? await searchRef.runRandomOne({ q, blockedIds, blockedTags, ratioOrder })
      : await searchRef.runRankedRandomOne({ q, blockedIds, blockedTags, ratioOrder });
    if (!row) return res.status(404).send('No matching post');
    const id = Number(row._id);

    // Advance the shared deck so the next ranked call picks a different post.
    // Awaited (not fire-and-forget) so the bump commits before this response
    // returns — otherwise a client firing the next pick the moment it gets
    // the image can re-draw this post off a deck that hasn't recorded it yet.
    // Skipped for pure-random draws, which intentionally ignore view counts.
    if (!pureRandom && incrementDisplayCountRef) await incrementDisplayCountRef(id);

    if (Number(req.query.json) === 1) {
      const ext = path.extname(row.path || '').slice(1).toLowerCase();
      return res.json({ id, ext });
    }

    // Hand off to the same id-based delivery path /get uses, so videos
    // stream and images flow through the variant cache + prefetch sharing.
    // Express's req.query is a getter that re-parses req.url on each access,
    // so the id has to go on the URL — a property assignment wouldn't survive.
    req.url += (req.url.includes('?') ? '&' : '?') + 'id=' + id;
    return processRequestV2(req, res);
  } catch (err) {
    console.error(`random error: ${err.message}`);
    if (!res.headersSent) res.status(500).send('Random selection failed');
  }
});

// Debugging helper: full DuckDB row for a post (joined with its file path).
// Token-gated like the rest of the image API. Returns JSON.
app.get('/post', (req, res) => {
  const postId = Number(req.query.id) || 0;
  if (!postId) return res.status(400).send('Missing post ID');

  db.all(
    "SELECT posts.*, p.path FROM file_db.posts LEFT JOIN file_db.posts_paths p ON p._id = posts._id WHERE posts._id = ? LIMIT 1;",
    [postId],
    (err, rows) => {
      if (err) {
        console.error(`DuckDB error: ${err.message}`);
        return res.status(500).send('Database error');
      }
      if (!rows.length) return res.status(404).send('Post not found');
      // DuckDB returns BIGINT columns as JS BigInt, which JSON.stringify rejects.
      res.type('application/json').send(JSON.stringify(rows[0], (_k, v) => (typeof v === 'bigint' ? v.toString() : v)));
    }
  );
});

app.get('/save', async (req, res) => {
  const postId = req.query.id;

  if (!postId) {
    return res.status(400).send('Missing post ID');
  }

  console.log(`Saving post ID: ${postId}`);

  // Local-only: resolve the file via its recorded posts_paths entry. No remote
  // fetches, ever, and no path reconstruction — the archive can span volumes,
  // so the stored absolute path is the only authority for where a file lives.
  const row = await lookupPostPath(postId);
  const sourcePath = row && resolveFilePath(row.path);
  if (!sourcePath) {
    return res.status(404).send('File not found');
  }

  // Mirror the file's real extension (e.g. .jxl), not a request hint.
  const saveExt = path.extname(sourcePath).slice(1).toLowerCase() || 'bin';
  const saveFilePath = path.join(SAVE_PATH, `${postId}.${saveExt}`);
  fs.copyFile(sourcePath, saveFilePath, (err) => {
    if (err) {
      console.error('Error saving file:', err);
      if (!res.headersSent) return res.status(500).send('Error saving the file');
      return;
    }
    console.log(`File saved successfully to ${saveFilePath}`);
    return res.status(200).send('File saved successfully');
  });
});

// Pick a random .htm/.html file from CUSTOM_PAGES_PATH and serve it inline.
// The kiosk's P key loads this in a fullscreen iframe and cache-busts the
// request so each toggle yields a fresh random choice. Pages are served
// straight from disk (no template processing) — anything they need
// (images, scripts, fonts) must be inlined or absolute URLs.
app.get('/custom_page', (req, res) => {
  fs.readdir(CUSTOM_PAGES_PATH, (err, entries) => {
    if (err) {
      if (err.code === 'ENOENT') return res.status(404).send('Custom pages folder not configured');
      console.error(`custom_page readdir failed: ${err.message}`);
      return res.status(500).send('Failed to list custom pages');
    }
    const candidates = entries.filter((n) => /\.(html?|HTML?)$/.test(n));
    if (!candidates.length) return res.status(404).send('No custom pages available');
    const pick = candidates[Math.floor(Math.random() * candidates.length)];
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    res.sendFile(path.join(CUSTOM_PAGES_PATH, pick), (sendErr) => {
      if (sendErr && !res.headersSent) {
        console.error(`custom_page sendFile failed: ${sendErr.message}`);
        res.status(500).send('Failed to send custom page');
      }
    });
  });
});
