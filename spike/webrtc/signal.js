'use strict';

// Minimal WebRTC signaling relay + static file server for the streaming spike.
// This is throwaway code to derisk the "render on the Mac, decode on the Pi"
// pipeline before wiring anything into the real broker. It never touches media
// frames — it only relays JSON signaling between one producer and N consumers,
// keyed by streamId. The eventual production version of this lives as an
// `rtcSignal` action inside imagemirror/lib/broker.js.

const http = require('http');
const fs = require('fs');
const path = require('path');
const { WebSocketServer } = require('ws');

const PORT = Number(process.env.PORT || 9000);
const ROOT = __dirname;

const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css' };

const server = http.createServer((req, res) => {
    const url = new URL(req.url, 'http://x');
    let file = decodeURIComponent(url.pathname);
    if (file === '/') file = '/consumer.html';
    const full = path.join(ROOT, path.normalize(file));
    if (!full.startsWith(ROOT)) { res.writeHead(403); return res.end('no'); }
    fs.readFile(full, (err, buf) => {
        if (err) { res.writeHead(404); return res.end('not found'); }
        res.writeHead(200, { 'content-type': MIME[path.extname(full)] || 'application/octet-stream' });
        res.end(buf);
    });
});

const wss = new WebSocketServer({ server, path: '/signal' });

// streamId -> producer ws
const producers = new Map();
// peerId -> consumer ws
const consumers = new Map();
let nextPeerId = 1;

function send(ws, obj) {
    if (ws && ws.readyState === ws.OPEN) ws.send(JSON.stringify(obj));
}

wss.on('connection', (ws) => {
    ws._peerId = null;
    ws._streamId = null;

    ws.on('message', (raw) => {
        let msg;
        try { msg = JSON.parse(raw); } catch { return; }
        const { type, streamId } = msg;

        switch (type) {
            case 'publish': {
                ws._streamId = streamId;
                producers.set(streamId, ws);
                console.log(`[publish] producer for "${streamId}"`);
                send(ws, { type: 'published', streamId });
                break;
            }
            case 'subscribe': {
                const peerId = String(nextPeerId++);
                ws._peerId = peerId;
                ws._streamId = streamId;
                consumers.set(peerId, ws);
                const prod = producers.get(streamId);
                console.log(`[subscribe] peer ${peerId} -> "${streamId}" (producer ${prod ? 'present' : 'MISSING'})`);
                if (!prod) { send(ws, { type: 'no-producer', streamId }); break; }
                // Ask the producer to start a session for this consumer.
                send(prod, { type: 'subscribe', streamId, peerId });
                break;
            }
            // offer/answer/ice are relayed verbatim between producer and the
            // specific consumer identified by peerId.
            case 'offer': {           // producer -> consumer
                send(consumers.get(msg.peerId), msg);
                break;
            }
            case 'answer': {          // consumer -> producer
                send(producers.get(streamId), msg);
                break;
            }
            case 'ice': {             // either direction; route by role
                if (msg.role === 'producer') send(consumers.get(msg.peerId), msg);
                else send(producers.get(streamId), msg);
                break;
            }
            default:
                break;
        }
    });

    ws.on('close', () => {
        if (ws._peerId) {
            consumers.delete(ws._peerId);
            const prod = producers.get(ws._streamId);
            send(prod, { type: 'peer-gone', peerId: ws._peerId });
        }
        if (ws._streamId && producers.get(ws._streamId) === ws) {
            producers.delete(ws._streamId);
            console.log(`[close] producer for "${ws._streamId}" gone`);
        }
    });
});

server.listen(PORT, () => {
    console.log(`signaling+static on http://0.0.0.0:${PORT}`);
    console.log(`  producer: http://<this-host>:${PORT}/producer.html?effect=trippy.html&stream=scene`);
    console.log(`  consumer: http://<this-host>:${PORT}/consumer.html?stream=scene`);
});
