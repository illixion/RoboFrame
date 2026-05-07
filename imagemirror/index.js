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
const { loadConfig, pickEnv } = require('@roboframe/shared');
const { setupBroker } = require('./lib/broker');
const { createSearch } = require('./lib/searchQuery');

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

app.use(['/get', '/save', '/history', '/addtohistory', '/rpc/tags.json'], requireToken);

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


// Rolling history of post IDs requested
const requestHistory = [];
const maxHistorySize = 50; // Maximum size of the history array

/**
 * Convert an image to APNG format, preserving transparency and animation.
 * @param {Buffer} imageData - The raw image data.
 * @returns {Promise<Buffer>} A promise that resolves with the converted image buffer.
 */
function convertToAPNG(imageData) {
  return new Promise((resolve, reject) => {
    let outputChunks = [];

    // Spawn djxl to decode JXL and output APNG
    const djxl = spawn(DJXL_PATH, ['-', '-', '--output_format', 'apng']);

    // Write input image data (JXL) to stdin of djxl
    djxl.stdin.write(imageData);
    djxl.stdin.end();

    // Collect stdout (APNG output)
    djxl.stdout.on('data', (chunk) => outputChunks.push(chunk));

    // Handle process completion
    djxl.on('close', (code) => {
      if (code === 0) {
        resolve(Buffer.concat(outputChunks));
      } else {
        reject(new Error(`djxl failed with exit code ${code}`));
      }
    });

    // Handle errors
    // djxl.stderr.on('data', (data) => console.error(`djxl error: ${data.toString()}`));
    djxl.on('error', (err) => reject(new Error(`Failed to start djxl: ${err.message}`)));
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
 * Apply CSS-like filters to an image
 * @param {Buffer|ArrayBuffer} imageBuffer - Raw image data (Buffer from fs.readFile)
 * @param {number} opacity - Opacity between 0 and 1
 * @param {number} width - Target width (optional)
 * @param {number} height - Target height (optional)
 * @returns {Promise<Buffer>} A promise that resolves with the modified image buffer in WebP format
 */
async function applyFiltersAndConvertToWebp(imageBuffer, opacity, width, height) {
    if (imageBuffer instanceof ArrayBuffer) {
        imageBuffer = Buffer.from(imageBuffer);
    }

    if (opacity < 0 || opacity > 1) {
        throw new RangeError('Opacity must be between 0 and 1');
    }

    // Step 1: Apply contrast adjustment using .modulate()
    // Note: contrast 1.2 => multiply saturation by 1, brightness by 1, contrast by 1.2
    const { data, info } = await sharp(imageBuffer)
        .ensureAlpha()
        .modulate({ contrast: 1.2 }) // Apply desired contrast
        .raw()
        .toBuffer({ resolveWithObject: true });

    // Step 2: Adjust alpha channel to apply desired opacity
    for (let i = 0; i < data.length; i += 4) {
        data[i + 3] = Math.round(data[i + 3] * opacity); // modify A channel
    }

    // Step 3: Rebuild and resize, then output as WebP
    return sharp(data, {
        raw: {
            width: info.width,
            height: info.height,
            channels: 4
        }
    })
    .resize(width, height, {
        fit: 'inside',
        withoutEnlargement: true
    })
    .webp({ lossless: true })
    .toBuffer();
}
/**
 * Convert a JPEG-XL image to WebP format in lossless mode with specified width and height.
 * @param {Buffer} imageData - The raw JXL image data.
 * @param {number} width - The desired width.
 * @param {number} height - The desired height.
 * @param {boolean} bright - Whether to brighten the image.
 * @returns {Promise<Buffer>} A promise that resolves with the converted image buffer.
 */
async function convertFromJxlToWebP(imageData, width, height, bright = false) {
  return new Promise((resolve, reject) => {
    let outputChunks = [];

    // Spawn djxl to decode JXL and output PNG
    const djxl = spawn(DJXL_PATH, ['-', '-', '--output_format', 'apng']);

    // Write input image data (JXL) to stdin of djxl
    djxl.stdin.write(imageData);
    djxl.stdin.end();

    // Collect stdout (PNG output)
    djxl.stdout.on('data', (chunk) => outputChunks.push(chunk));

    // Handle process completion
    djxl.on('close', async (code) => {
      if (code === 0) {
        try {
          const pngBuffer = Buffer.concat(outputChunks);
          let sharpInstance, webpBuffer;

          // This will be used in overlays
          if (bright) {
            const isDark = await isImageDark(pngBuffer);
            if (isDark) {
              // If the image is dark, apply 30% opacity
              webpBuffer = await applyFiltersAndConvertToWebp(pngBuffer, 0.3, width, height);
            } else {
              // If the image is bright, apply 15% opacity
              webpBuffer = await applyFiltersAndConvertToWebp(pngBuffer, 0.15, width, height);
            }
          } else {
            sharpInstance = sharp(pngBuffer, { animated: true });
            webpBuffer = await sharpInstance
              .resize(width, height, {
                fit: 'inside', // Preserve aspect ratio
                withoutEnlargement: true, // Do not enlarge if the dimensions are smaller
              })
              .webp({ animated: true, lossless: true }) // Use lossless compression
              .toBuffer();
          }

          resolve(webpBuffer);
        } catch (error) {
          reject(new Error(`Sharp processing failed: ${error.message}`));
        }
      } else {
        reject(new Error(`djxl failed with exit code ${code}`));
      }
    });

    // Handle errors
    djxl.on('error', (err) => reject(new Error(`Failed to start djxl: ${err.message}`)));
  });
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

  if (!postId) {
    if (!res.headersSent) res.status(400).send('Missing post ID');
    return;
  }

  let returnFile, returnMimeType;

  // If file already cached in request history, return it
  const cachedRequest = requestHistory.find((entry) => entry.id === postId);
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
    "SELECT path FROM file_db.posts_paths WHERE _id = ? LIMIT 1;",
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

      // Animated JXL isn't uniformly supported, this will convert it to APNG if needed
      let apngMode = false;
      if (row.tags && row.tags.includes('animated_png')) {
        apngMode = true;
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
          // if bright is set, we will convert the image to WebP with opacity always
          if (bright) {
            finalBuffer = await convertFromJxlToWebP(data, screenWidth, screenHeight, bright);
            finalMimeType = 'image/webp';
          } else if (apngMode) {
            finalBuffer = await convertToAPNG(data);
            finalMimeType = 'image/apng';
          } else if (convert) {
            finalBuffer = await convertFromJxlToWebP(data, screenWidth, screenHeight);
            finalMimeType = 'image/webp';
          } else {
            finalMimeType = returnMimeType || finalMimeType;
          }
        } catch (conversionError) {
          console.error('Error processing image:', conversionError);
          // Keep original buffer and default MIME type
        }

        // Log post ID, extension, MIME type, and file contents to request history
        // Prevent duplicate entries by ID
        const existingIndex = requestHistory.findIndex(entry => entry.id === postId);
        if (existingIndex !== -1) {
          // Remove existing entry to update it
          requestHistory.splice(existingIndex, 1);
        }
        // Add new entry to the front of the history
        requestHistory.unshift({
          id: postId,
          ext: path.extname(filePath).slice(1),
          mime_type: finalMimeType,
          file_contents: finalBuffer
        });
        if (requestHistory.length > maxHistorySize) {
          requestHistory.pop();
        }

        if (cancelled || res.headersSent) return;

        res.setHeader('Content-Type', finalMimeType);
        // return original file name
        res.setHeader('Content-Disposition', `inline; filename="${postId}.${path.extname(filePath).slice(1)}"`);

        res.send(finalBuffer);
      });
    }
  );
}

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
  const previewList = requestHistory.map((post) => ({ id: post.id }));
  const token = req.query.token || req.headers['x-roboframe-token'] || '';
  res.render('history', { history: previewList, token });
});

// This endpoint allows the user to send a post ID to insert it into requestHistory as the newest item
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

      // Prevent duplicate entries by ID
      const existingIndex = requestHistory.findIndex(entry => entry.id === postId);
      if (existingIndex !== -1) {
        requestHistory.splice(existingIndex, 1);
      }

      // Add new entry to the front of the history
      requestHistory.unshift({
        id: postId,
        ext: postExt,
        mime_type: null,
        file_contents: null
      });
      if (requestHistory.length > maxHistorySize) {
        requestHistory.pop();
      }

      return res.status(200).send('Post added to history');
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
