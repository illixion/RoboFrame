try { require("dotenv").config(); } catch (_) { /* dotenv is optional; env vars from the shell still work */ }
const express = require('express');
const http = require('http');
const fs = require('fs');
const path = require('path');
const axios = require('axios');
const cookieParser = require('cookie-parser');
const sharp = require('sharp');
const { spawn } = require('child_process');
const duckdb = require('duckdb');
const bodyParser = require("body-parser");
const cors = require('cors');
const zlib = require('zlib');
const { loadConfig, pickEnv } = require('@roboframe/shared');
const { setupBroker } = require('./lib/broker');
const { createSearch } = require('./lib/searchQuery');
const { createHistory } = require('./lib/history');

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

app.use(['/get', '/save', '/history', '/history.json', '/addtohistory', '/post', '/search', '/count', '/rpc/tags.json'], requireToken);

// Setup view engine
app.set('views', path.join(__dirname, 'views'));
app.set('view engine', 'ejs');

// Resolved from roboframe.config.json[server] with env-var overrides.
const filesOriginalPath = pickEnv('IMAGE_DB_PATH', srv.imageDbPath, '/Volumes/HDD/imagedb');
const mirrorFilesPath = pickEnv('IMAGE_MIRROR_PATH', srv.imageMirrorPath, '/Volumes/HDD/imagedb_mirror');
// CHUNK_SIZE: 0 = flat layout, >0 = files in subfolders like /0/1.jxl
const CHUNK_SIZE = pickEnv('CHUNK_SIZE', srv.chunkSize, 0, { type: 'number' });
const SAVE_PATH = pickEnv('SAVE_PATH', srv.savePath, '/tmp');
const DJXL_PATH = pickEnv('DJXL_PATH', srv.djxlPath, 'djxl');
const JXLINFO_PATH = pickEnv('JXLINFO_PATH', srv.jxlinfoPath, 'jxlinfo');
const FFMPEG_PATH = pickEnv('FFMPEG_PATH', srv.ffmpegPath, 'ffmpeg');

/**
 * Build the file path for a given post ID and extension.
 * If CHUNK_SIZE > 0, files are organized in subfolders (e.g., /0/123.jxl, /1/1234.jxl)
 * If CHUNK_SIZE is 0, files are in the root folder (e.g., /123.jxl)
 */
function buildFilePath(basePath, postId, ext) {
  if (CHUNK_SIZE > 0) {
    return path.join(basePath, `${Math.floor(postId / CHUNK_SIZE)}`, `${postId}.${ext}`);
  }
  return path.join(basePath, `${postId}.${ext}`);
}
let retryCount = 0;

// Set the default user agent for all Axios requests
axios.defaults.headers.common['User-Agent'] = 'roboframe/1.0';


// Rolling history of post IDs requested (state + dedup/cap logic in lib/history.js)
const history = createHistory({ maxSize: 50 });

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
 * Convert an animated JXL to animated WebP. djxl emits APNG (its only
 * animated output format); we split that into standalone PNG frames in
 * memory and pipe them into ffmpeg via image2pipe (no temp file, no
 * seekable-input requirement). Frame delays are assumed uniform — true
 * for video-sourced APNGs/GIFs in this library.
 * @param {Buffer} imageData - Raw JXL bytes.
 * @returns {Promise<Buffer>}
 */
async function convertToAnimatedWebP(imageData) {
  const apngBuf = await new Promise((resolve, reject) => {
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

  const frames = splitApngFrames(apngBuf);
  // APNG delay_den == 0 is spec shorthand for /100.
  const first = frames[0];
  const num = first.delayNum || 1;
  const den = first.delayDen || 100;
  // image2pipe wants -framerate as N/D where N=ticks/sec; ffmpeg accepts "den/num".
  const framerate = `${den}/${num}`;

  return await new Promise((resolve, reject) => {
    const ffmpeg = spawn(FFMPEG_PATH, [
      '-loglevel', 'error',
      '-f', 'image2pipe',
      '-framerate', framerate,
      '-i', 'pipe:0',
      '-loop', '0',
      '-c:v', 'libwebp_anim',
      '-quality', '90',
      '-f', 'webp',
      'pipe:1',
    ]);
    const out = [];
    let err = '';
    ffmpeg.stdout.on('data', (c) => out.push(c));
    ffmpeg.stderr.on('data', (c) => { err += c.toString(); });
    ffmpeg.on('error', (e) => reject(new Error(`ffmpeg spawn failed: ${e.message}`)));
    ffmpeg.on('close', (code) => {
      if (code !== 0) return reject(new Error(`ffmpeg exit ${code}: ${err.trim()}`));
      resolve(Buffer.concat(out));
    });
    ffmpeg.stdin.on('error', () => {});
    (async () => {
      for (const f of frames) {
        if (!ffmpeg.stdin.write(f.png)) {
          await new Promise((r) => ffmpeg.stdin.once('drain', r));
        }
      }
      ffmpeg.stdin.end();
    })().catch(() => {});
  });
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
 * Decode a JPEG-XL image and emit JPEG (q95, black-flattened). When
 * `bright` is set, also dim the image for ambient/night-light viewing —
 * the dim factor is chosen by image brightness so already-bright photos
 * don't go invisible at the same multiplier as dark ones.
 *
 * @param {Buffer} imageData - Raw JXL bytes.
 * @param {number} width
 * @param {number} height
 * @param {boolean} bright - Apply ambient dim.
 * @returns {Promise<Buffer>}
 */
async function convertFromJxl(imageData, width, height, bright = false) {
  return new Promise((resolve, reject) => {
    const outputChunks = [];
    const djxl = spawn(DJXL_PATH, ['-', '-', '--output_format', 'png']);
    djxl.stdin.write(imageData);
    djxl.stdin.end();
    djxl.stdout.on('data', (chunk) => outputChunks.push(chunk));
    djxl.on('close', async (code) => {
      if (code !== 0) return reject(new Error(`djxl failed with exit code ${code}`));
      try {
        const pngBuffer = Buffer.concat(outputChunks);
        if (bright) {
          // Bumped from 0.30/0.15 since the prior contrast-bump (which is
          // gone now — it was clipping highlights on already-bright
          // images) made the perceived dim feel stronger.
          const dim = (await isImageDark(pngBuffer)) ? 0.32 : 0.20;
          resolve(await applyDimAndConvertToJpeg(pngBuffer, dim, width, height));
        } else {
          resolve(await convertBufferToJpeg(pngBuffer, width, height, 95));
        }
      } catch (e) {
        reject(new Error(`Sharp processing failed: ${e.message}`));
      }
    });
    djxl.on('error', (err) => reject(new Error(`Failed to start djxl: ${err.message}`)));
  });
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

function processRequestV2(req, res) {
  let cancelled = false;
  req.on('aborted', () => { cancelled = true; });
  res.on('close', () => {
    if (!res.writableEnded) cancelled = true;
  });

  const postId = Number(req.query.id) || 0;
  const convert = Boolean(Number(req.query.convert) || 0);
  const screenWidth = Number(req.query.width) || 3840;
  const screenHeight = Number(req.query.height) || 2160;
  const bright = Boolean(Number(req.query.bright) || 0);
  const lowmem = Boolean(Number(req.query.lowmem) || 0);

  if (!postId) {
    if (!res.headersSent) res.status(400).send('Missing post ID');
    return;
  }

  let returnFile, returnMimeType;

  // If file already cached in request history, return it
  const cachedRequest = history.findCached(postId);
  if (cachedRequest) {
    // Validate cached data is present, if not then continue to fetch from disk
    if (!cachedRequest.file_contents || !cachedRequest.mime_type) {
      console.debug(`Cache entry for post ID ${postId} is missing data, refetching from disk.`);
    } else {
      returnFile = cachedRequest.file_contents;
      returnMimeType = cachedRequest.mime_type;
      res.setHeader('Content-Type', returnMimeType || 'application/octet-stream');
      res.send(returnFile);
      return;
    }
  }

  // Query DuckDB for the post with the given _id to get the path
  db.all(
    "SELECT p.path, posts.tags FROM file_db.posts_paths p JOIN file_db.posts ON posts._id = p._id WHERE p._id = ? LIMIT 1;",
    [postId],
    (err, rows) => {
      if (cancelled) return;
      if (err) {
        console.error(`DuckDB error: ${err.message}`);
        if (!res.headersSent) res.status(500).send('Database error');
        return;
      }
      if (!rows.length) {
        console.error(`No DB entry for post ID: ${postId}`);
        if (!res.headersSent) res.status(404).send('Post not found');
        return;
      }

      const row = rows[0];

      const filePath = row.path;

      // Animated JXL → animated WebP for every client. Safari doesn't
      // decode raw JXL animation, so we can't pass it through, and APNG
      // animation isn't supported in Safari either — WebP is the only
      // format that works across the browser kiosk and Spatialstash.
      // Explicit `animated_png` tag forces the animated path; otherwise
      // probe JXL files with jxlinfo.
      let animatedMode = false;
      const isJxl = path.extname(filePath).toLowerCase() === '.jxl';
      if (row.tags && row.tags.includes('animated_png')) {
        animatedMode = true;
      }

      // Check if the file exists in either the original or cloud path, set the filePath accordingly
      let fullFilePath = filePath;
      if (!fs.existsSync(fullFilePath)) {
        fullFilePath = filePath.replace(filesOriginalPath, mirrorFilesPath);
      }
      if (!fs.existsSync(fullFilePath)) {
        console.error(`File not found: ${fullFilePath}`);
        if (!res.headersSent) {
          res.status(500).send('An error occurred while sending the file.');
        }
        return;
      }

      // Handle file response
      fs.readFile(filePath, async (err, data) => {
        if (cancelled) return;
        if (err) {
          console.error(`Error reading file ${filePath}: ${err.message}`);
          if (!res.headersSent) res.status(500).send('Error reading file');
          return;
        }

        let finalBuffer = data;
        let finalMimeType = 'application/octet-stream';

        try {
          if (cancelled) return;
          if (!animatedMode && isJxl) {
            animatedMode = await isAnimatedJxl(data);
          }
          if (cancelled) return;
          if (animatedMode) {
            finalBuffer = await convertToAnimatedWebP(data);
            finalMimeType = 'image/webp';
          } else if (convert) {
            finalBuffer = await convertFromJxl(data, screenWidth, screenHeight, bright);
            finalMimeType = 'image/jpeg';
          } else if (lowmem) {
            // Non-JXL source on a memory-tight kiosk: re-encode to JPEG
            // so the browser hits VideoCore's hardware decoder instead
            // of software-decoding WebP/PNG.
            finalBuffer = await convertBufferToJpeg(data, screenWidth, screenHeight, 85);
            finalMimeType = 'image/jpeg';
          } else {
            finalMimeType = returnMimeType || finalMimeType;
          }
        } catch (conversionError) {
          console.error('Error processing image:', conversionError);
          if (!res.headersSent) res.status(500).send('Image conversion failed');
          return;
        }

        // Log post ID, extension, MIME type, and file contents to request history
        history.addEntry({
          id: postId,
          ext: path.extname(filePath).slice(1),
          mime_type: finalMimeType,
          file_contents: finalBuffer
        });

        if (cancelled || res.headersSent) return;

        res.setHeader('Content-Type', finalMimeType);
        // Filename extension tracks the served MIME (Safari/Finder rely on
        // it), not the on-disk source — animated JXL is re-encoded to WebP,
        // convert/lowmem paths emit JPEG, etc.
        const mimeExt = {
          'image/webp': 'webp',
          'image/jpeg': 'jpg',
          'image/png': 'png',
          'image/apng': 'apng',
          'image/gif': 'gif',
        }[finalMimeType] || path.extname(filePath).slice(1);
        res.setHeader('Content-Disposition', `inline; filename="${postId}.${mimeExt}"`);

        res.send(finalBuffer);
      });
    }
  );
}

let searchRef = null;

// Connect to DuckDB
const DUCKDB_PATH = pickEnv('DUCKDB_PATH', srv.duckdbPath, 'posts.duckdb');
const RANDOM_RANK_REFRESH_INTERVAL_MS = 24 * 60 * 60 * 1000; // 24 hours

// In-memory DB is the main connection
const memDb = new duckdb.Database(':memory:');
const db = memDb.connect();

async function attachReadOnlyFileDb() {
  return new Promise((resolve, reject) => {
    db.run(`ATTACH '${DUCKDB_PATH}' AS file_db (READ_ONLY);`, (err) => {
      if (err) return reject(err);
      console.log("Attached file_db in read-only mode.");
      resolve();
    });
  });
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


(async () => {
  try {
    await attachReadOnlyFileDb();
    await refreshRandomRanks();

    setInterval(refreshRandomRanks, RANDOM_RANK_REFRESH_INTERVAL_MS);

    // The server is the single DuckDB reader. It feeds the slideshow
    // orchestrator, which broadcasts a `playback` channel over WebSocket
    // and is what every kiosk renders from.
    const search = createSearch({ db });
    searchRef = search;

    const reshuffle = async () => {
        await refreshRandomRanks();
        if (search?.clearCache) search.clearCache();
    };

    const incrementDisplayCount = (id) => {
        const numeric = Number(id);
        if (!Number.isFinite(numeric)) return;
        db.run(`UPDATE random_ranks SET display_count = display_count + 1 WHERE _id = ${numeric};`, (err) => {
            if (err) console.warn(`[display_count] update failed for _id=${numeric}: ${err.message}`);
        });
        if (search?.clearCache) search.clearCache();
    };

    // Wire the WebSocket broker (and HA bridge if configured) onto the same
    // http.Server that serves the image API. One process, one port, no proxy.
    const server = http.createServer(app);
    setupBroker({ server, app, config, dataPath: DATA_PATH, search, reshuffle, incrementDisplayCount });
    server.listen(PORT, HOST, () => {
      console.log(`Server running on http://${HOST}:${PORT}`);
    });
  } catch (err) {
    console.error("Initialization error:", err);
  }
})();


// Express Routes
app.get('/get', (req, res) => {
  try {
    processRequestV2(req, res);
  } catch (error) {
    retryCount++;

    if (retryCount <= 3) {
      try {
        processRequestV2(req, res);
      } catch (error) {
        if (retryCount >= 3) {
          res.end();
        }
      }
    } else {
      res.end();
    }
  }
});

// Recent request history endpoint — returns an HTML page that loads thumbnails
// concurrently from /get on the client side.
app.get('/history', (req, res) => {
  const previewList = history.listPreview();
  const token = req.query.token || req.headers['x-roboframe-token'] || '';
  const lowmem = Number(req.query.lowmem) === 1 ? 1 : 0;
  res.render('history', { history: previewList, token, lowmem });
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
        mime_type: null,
        file_contents: null
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
  const postExt = req.query.ext || 'jxl'; // Default to jxl if not provided

  if (!postId) {
    return res.status(400).send('Missing post ID');
  }

  console.log(`Saving post ID: ${postId} with extension: ${postExt}`);

  // Local-only: check the primary path, then fall back to the mirror path. No remote fetches, ever.
  let sourcePath = buildFilePath(filesOriginalPath, postId, postExt);
  if (!fs.existsSync(sourcePath)) {
    sourcePath = buildFilePath(mirrorFilesPath, postId, postExt);
  }
  if (!fs.existsSync(sourcePath)) {
    return res.status(404).send('File not found');
  }

  const saveFilePath = path.join(SAVE_PATH, `${postId}.${postExt}`);
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
