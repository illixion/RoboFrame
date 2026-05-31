'use strict';
//
// Tiny HTTP front-end for the V4L2 webcam. Two endpoints:
//
//   GET /stream.mjpg   multipart/x-mixed-replace MJPEG suitable for
//                      Scrypted, HKSV, VLC, browsers.
//   GET /snapshot.jpg  one frame, then close.
//   GET /audio.pcm     raw little-endian PCM from the mic, if configured.
//                      Pair it with the video URL in a consumer that muxes
//                      separate A/V inputs (e.g. Scrypted's FFmpeg camera).
//
// The capture processes are reference-counted by Webcam/Microphone, so we
// only burn CPU + USB bandwidth while a client is actually attached.
// `setEnabled(false)` closes the listener so external consumers see
// connection refused.
//
// When `tokens` is non-empty every media endpoint requires a matching
// token via `?token=` or `Authorization: Bearer`. This gates the LAN port
// and the tailscale-serve path alike — `/health` stays open for liveness.

const http = require('http');

const BOUNDARY = 'rfwebcam';

function createStreamServer({ webcam, mic = null, port, host = '0.0.0.0', tokens = [] }) {
    let server = null;
    const tokenSet = new Set((tokens || []).filter(Boolean));

    function authorized(req) {
        if (tokenSet.size === 0) return true;
        const q = (req.url.split('?')[1] || '')
            .split('&').map((kv) => kv.split('='))
            .find(([k]) => k === 'token');
        if (q && tokenSet.has(decodeURIComponent(q[1] || ''))) return true;
        const m = /^Bearer\s+(.+)$/i.exec(req.headers['authorization'] || '');
        if (m && tokenSet.has(m[1].trim())) return true;
        return false;
    }

    function handle(req, res) {
        const path = (req.url || '').split('?')[0];
        if (path === '/' || path === '/health') {
            res.writeHead(200, { 'Content-Type': 'text/plain' });
            return res.end('roboframe webcam\n');
        }
        if (!authorized(req)) {
            res.writeHead(401, { 'WWW-Authenticate': 'Bearer' });
            return res.end();
        }
        if (path === '/stream.mjpg' || path === '/stream.mjpeg') {
            return serveStream(req, res);
        }
        if (path === '/snapshot.jpg' || path === '/snapshot.jpeg') {
            return serveSnapshot(req, res);
        }
        if (path === '/audio.pcm') {
            if (!mic) { res.writeHead(404); return res.end(); }
            return serveAudio(req, res);
        }
        res.writeHead(404); res.end();
    }

    function serveAudio(req, res) {
        const { rate, channels } = mic.format();
        res.writeHead(200, {
            // No standard MIME for raw PCM; consumers are told the format out
            // of band. The rate/channels params are advisory breadcrumbs.
            'Content-Type': `application/octet-stream; rate=${rate}; channels=${channels}`,
            'Cache-Control': 'no-cache, private',
            'Connection': 'close',
        });
        const onAudio = (chunk) => {
            if (!res.writable || res.writableNeedDrain) return;
            res.write(chunk);
        };
        const unsub = mic.subscribe(onAudio);
        const close = () => { unsub(); };
        req.on('close', close);
        res.on('close', close);
    }

    function serveStream(req, res) {
        res.writeHead(200, {
            'Content-Type': `multipart/x-mixed-replace; boundary=${BOUNDARY}`,
            'Cache-Control': 'no-cache, private',
            'Pragma': 'no-cache',
            'Connection': 'close',
        });
        const onFrame = (jpeg) => {
            // If the socket is backed up we'd grow the kernel send buffer
            // forever; drop frames when write() returns false.
            if (!res.writable || res.writableNeedDrain) return;
            res.write(`--${BOUNDARY}\r\nContent-Type: image/jpeg\r\nContent-Length: ${jpeg.length}\r\n\r\n`);
            res.write(jpeg);
            res.write('\r\n');
        };
        const unsub = webcam.subscribe(onFrame);
        const close = () => { unsub(); };
        req.on('close', close);
        res.on('close', close);
    }

    function serveSnapshot(req, res) {
        let done = false;
        let unsub = null;
        const finish = (jpeg, statusCode = 200) => {
            if (done) return;
            done = true;
            if (unsub) unsub();
            if (statusCode !== 200) {
                res.writeHead(statusCode); return res.end();
            }
            res.writeHead(200, {
                'Content-Type': 'image/jpeg',
                'Content-Length': jpeg.length,
                'Cache-Control': 'no-cache',
            });
            res.end(jpeg);
        };
        const cached = webcam.getLastFrame && webcam.getLastFrame();
        if (cached) return finish(cached);
        const timer = setTimeout(() => finish(null, 504), 5000);
        unsub = webcam.subscribe((jpeg) => {
            clearTimeout(timer);
            finish(jpeg);
        });
        req.on('close', () => { clearTimeout(timer); if (!done) { done = true; if (unsub) unsub(); } });
    }

    function start() {
        if (server) return;
        server = http.createServer(handle);
        server.on('error', (err) => {
            console.error(`[webcam] HTTP error: ${err.message}`);
        });
        server.listen(port, host, () => {
            console.log(`[webcam] streaming on http://${host}:${port}/stream.mjpg`);
        });
    }

    function stop() {
        if (!server) return;
        try { server.close(); } catch (_) { /* ignore */ }
        server = null;
        webcam.stop();
        if (mic) mic.stop();
        console.log('[webcam] stopped');
    }

    function setEnabled(enabled) { enabled ? start() : stop(); }

    return { start, stop, setEnabled, isRunning: () => !!server };
}

module.exports = { createStreamServer };
