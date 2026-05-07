'use strict';
//
// Tiny HTTP front-end for the V4L2 webcam. Two endpoints:
//
//   GET /stream.mjpg   multipart/x-mixed-replace MJPEG suitable for
//                      Scrypted, HKSV, VLC, browsers.
//   GET /snapshot.jpg  one frame, then close.
//
// The capture process is reference-counted by Webcam.subscribe, so we
// only burn CPU + USB bandwidth while a client is actually attached.
// `setEnabled(false)` closes the listener so external consumers see
// connection refused.

const http = require('http');

const BOUNDARY = 'rfwebcam';

function createStreamServer({ webcam, port, host = '0.0.0.0' }) {
    let server = null;

    function handle(req, res) {
        const path = (req.url || '').split('?')[0];
        if (path === '/stream.mjpg' || path === '/stream.mjpeg') {
            return serveStream(req, res);
        }
        if (path === '/snapshot.jpg' || path === '/snapshot.jpeg') {
            return serveSnapshot(req, res);
        }
        if (path === '/' || path === '/health') {
            res.writeHead(200, { 'Content-Type': 'text/plain' });
            return res.end('roboframe webcam\n');
        }
        res.writeHead(404); res.end();
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
        console.log('[webcam] stopped');
    }

    function setEnabled(enabled) { enabled ? start() : stop(); }

    return { start, stop, setEnabled, isRunning: () => !!server };
}

module.exports = { createStreamServer };
