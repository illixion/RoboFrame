// Integration tests for the WebSocket broker. Boots the server in-process
// against a temporary tags.json and verifies the protocol surface end-to-end:
//   - /rpc/ws upgrades cleanly (no Express 404)
//   - server pushes tagLists, blocked, currentTagList in order on connect
//   - file-watch on tags.json rebroadcasts to live clients
//   - HTTP /rpc/tags.json returns the same data

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const http = require('node:http');
const express = require('express');
const WebSocket = require('ws');
const { setupBroker } = require('../lib/broker');

let tmpDir, dataPath, server, broker, port;

const ACCESS_TOKEN = 'test-access-token';

function startServer({ tagLists = [], rpcToken = 'test-token', accessToken = ACCESS_TOKEN, haDisabled = true } = {}) {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'rf-broker-test-'));
    dataPath = path.join(tmpDir, 'data.json');
    fs.writeFileSync(dataPath, JSON.stringify({
        blockedIds: [],
        blockedTags: [],
        tagLists,
    }));

    const app = express();
    const httpServer = http.createServer(app);
    broker = setupBroker({
        server: httpServer,
        app,
        config: {
            accessToken,
            server: {
                rpcToken,
                ha: { enabled: !haDisabled },
            },
        },
        dataPath,
    });
    return new Promise((resolve) => {
        httpServer.listen(0, '127.0.0.1', () => {
            port = httpServer.address().port;
            server = httpServer;
            resolve();
        });
    });
}

function stopServer() {
    if (broker) broker.close();
    if (server) server.close();
    if (tmpDir) fs.rmSync(tmpDir, { recursive: true, force: true });
    server = null;
    broker = null;
}

// Open a client and start collecting frames immediately. The listener is
// attached BEFORE 'open' fires, so server-pushed initial frames are never
// missed regardless of how the ws library batches the upgrade response and
// the first data frames.
function openClient(token = ACCESS_TOKEN) {
    const ws = new WebSocket(`ws://127.0.0.1:${port}/rpc/ws?token=${encodeURIComponent(token)}`);
    const frames = [];
    const waiters = [];
    ws.on('message', (data) => {
        frames.push(JSON.parse(data.toString()));
        for (const w of waiters.splice(0)) w();
    });
    ws.opened = new Promise((res, rej) => {
        ws.once('open', res);
        ws.once('error', rej);
    });
    ws.frames = frames;
    ws.waitForFrames = (count, timeoutMs = 1000) => new Promise((resolve, reject) => {
        const timer = setTimeout(
            () => reject(new Error(`expected ${count} frames, got ${frames.length}`)),
            timeoutMs,
        );
        const check = () => {
            if (frames.length >= count) {
                clearTimeout(timer);
                resolve(frames.slice(0, count));
                return true;
            }
            return false;
        };
        if (!check()) waiters.push(() => check());
    });
    return ws;
}

test('WebSocket /rpc/ws upgrades and pushes initial state in order', async (t) => {
    await startServer({ tagLists: [['portrait'], ['landscape', 'sunset']] });
    t.after(stopServer);

    const ws = openClient();
    await ws.opened;
    const frames = await ws.waitForFrames(1);
    // Block lists are server-only and currentTagList is per-channel (it
    // arrives in each playback frame's `currentList`), so the only push at
    // connect time is the tagLists catalog.
    assert.deepEqual(frames.map((f) => f.action), ['tagLists']);
    assert.deepEqual(frames[0].payload, [['portrait'], ['landscape', 'sunset']]);

    ws.close();
});

test('Express does NOT 404 on /rpc/ws (real upgrade reaches the broker)', async (t) => {
    // If Express ever takes precedence over the WebSocket.Server upgrade
    // handler, /rpc/ws answers as a regular GET and returns Express's
    // default 404 with X-Powered-By: Express. A correct setup returns 101
    // Switching Protocols on the upgrade. Confirm via raw HTTP that the
    // upgrade path is wired through to ws.
    await startServer();
    t.after(stopServer);

    const handshake = await new Promise((resolve, reject) => {
        const req = http.request({
            host: '127.0.0.1',
            port,
            path: '/rpc/ws',
            method: 'GET',
            headers: {
                'Upgrade': 'websocket',
                'Connection': 'Upgrade',
                'Sec-WebSocket-Key': 'x3JJHMbDL1EzLkh9GBhXDw==',
                'Sec-WebSocket-Version': '13',
            },
        });
        req.on('upgrade', (res, socket) => {
            socket.destroy();
            resolve(res.statusCode);
        });
        req.on('response', (res) => {
            // If we land here, the server answered as plain HTTP — that's the bug.
            res.resume();
            resolve({ wrong: res.statusCode, poweredBy: res.headers['x-powered-by'] });
        });
        req.on('error', reject);
        req.end();
    });
    assert.equal(handshake, 101, `expected 101 Switching Protocols, got ${JSON.stringify(handshake)}`);
});

test('HTTP /rpc/tags.json returns the same tagLists as the WebSocket push', async (t) => {
    await startServer({ tagLists: [['cats'], ['dogs', 'happy']] });
    t.after(stopServer);

    const body = await new Promise((resolve, reject) => {
        http.get(`http://127.0.0.1:${port}/rpc/tags.json`, (res) => {
            let data = '';
            res.on('data', (c) => data += c);
            res.on('end', () => resolve(JSON.parse(data)));
        }).on('error', reject);
    });
    assert.deepEqual(body, [['cats'], ['dogs', 'happy']]);
});

test('HTTP /block persists the id to the blocklist (access tier)', async (t) => {
    await startServer();
    t.after(stopServer);

    const status = await new Promise((resolve, reject) => {
        http.get(`http://127.0.0.1:${port}/block?id=555&token=${encodeURIComponent(ACCESS_TOKEN)}`, (res) => {
            res.resume();
            res.on('end', () => resolve(res.statusCode));
        }).on('error', reject);
    });
    assert.equal(status, 200);

    const onDisk = JSON.parse(fs.readFileSync(dataPath, 'utf-8'));
    assert.deepEqual(onDisk.blockedIds, [555]);
});

test('HTTP /block rejects a missing or invalid token', async (t) => {
    await startServer();
    t.after(stopServer);

    const status = await new Promise((resolve, reject) => {
        http.get(`http://127.0.0.1:${port}/block?id=555&token=wrong`, (res) => {
            res.resume();
            res.on('end', () => resolve(res.statusCode));
        }).on('error', reject);
    });
    assert.equal(status, 401);

    const onDisk = JSON.parse(fs.readFileSync(dataPath, 'utf-8'));
    assert.deepEqual(onDisk.blockedIds, []);
});

test('HTTP /block requires a post id', async (t) => {
    await startServer();
    t.after(stopServer);

    const status = await new Promise((resolve, reject) => {
        http.get(`http://127.0.0.1:${port}/block?token=${encodeURIComponent(ACCESS_TOKEN)}`, (res) => {
            res.resume();
            res.on('end', () => resolve(res.statusCode));
        }).on('error', reject);
    });
    assert.equal(status, 400);
});

test('Editing data.json rebroadcasts tagLists to live clients', async (t) => {
    await startServer({ tagLists: [['initial']] });
    t.after(stopServer);

    const ws = openClient();
    await ws.opened;
    await ws.waitForFrames(1); // initial tagLists (currentTagList is per-channel now)

    fs.writeFileSync(dataPath, JSON.stringify({
        blockedIds: [],
        blockedTags: [],
        tagLists: [['changed', 'live']],
    }));

    // fs.watch is debounced 200ms in the broker; allow some headroom.
    await ws.waitForFrames(2, 1500);

    const seen = ws.frames.filter((f) => f.action === 'tagLists').map((f) => f.payload);
    assert.deepEqual(seen, [[['initial']], [['changed', 'live']]]);

    ws.close();
});

test('Hand-edit to tagLists survives a concurrent block action (read-modify-write)', async (t) => {
    await startServer({ tagLists: [['initial']] });
    t.after(stopServer);

    const ws = openClient();
    await ws.opened;
    await ws.waitForFrames(1);

    // Simulate the scenario where the user hand-edits the data file while
    // the broker still has its own writes coming in. With an in-memory
    // cache + watcher debounce, the broker's next save would clobber the
    // hand-edited tagLists. With read-modify-write the edit is preserved.
    fs.writeFileSync(dataPath, JSON.stringify({
        blockedIds: [],
        blockedTags: [],
        tagLists: [['hand-edit', 'wins']],
    }));

    // Fire a block action immediately, BEFORE the watcher has a chance
    // to fire (its 50 ms debounce starts on the file change above).
    ws.send(JSON.stringify({ action: 'block', payload: { id: 7 } }));

    // Give both the watcher and the block save a moment to settle.
    await new Promise((res) => setTimeout(res, 300));

    const onDisk = JSON.parse(fs.readFileSync(dataPath, 'utf-8'));
    assert.deepEqual(onDisk.tagLists, [['hand-edit', 'wins']],
        'broker must not clobber a hand-edited field when saving an unrelated one');
    assert.deepEqual(onDisk.blockedIds, [7]);

    ws.close();
});

test('Block lists are server-only — neither file edits nor `block` action emit a `blocked` frame', async (t) => {
    await startServer({ tagLists: [['initial']] });
    t.after(stopServer);

    const ws = openClient();
    await ws.opened;
    await ws.waitForFrames(1);

    // 1. Hand-edit the data store: blocklist changes should NOT broadcast.
    fs.writeFileSync(dataPath, JSON.stringify({
        blockedIds: [42, 99],
        blockedTags: ['gore'],
        tagLists: [['initial']],
    }));
    await new Promise((res) => setTimeout(res, 250));

    // 2. Send `block` over the WS: the persisted id grows, but again no
    //    client-visible `blocked` frame.
    ws.send(JSON.stringify({ action: 'block', payload: { id: 7 } }));
    await new Promise((res) => setTimeout(res, 200));

    assert.equal(
        ws.frames.filter((f) => f.action === 'blocked').length,
        0,
        'no client-visible blocked frame should ever appear',
    );

    const onDisk = JSON.parse(fs.readFileSync(dataPath, 'utf-8'));
    assert.deepEqual(onDisk.blockedIds, [42, 99, 7], 'block action persisted server-side');
    assert.deepEqual(onDisk.blockedTags, ['gore']);

    ws.close();
});

test('cached displayState persists past disconnect and replays on reconnect', async (t) => {
    await startServer();
    t.after(stopServer);

    // RPC-tier client publishes a displayState for kiosk1, then drops.
    const sender = openClient('test-token');
    await sender.opened;
    sender.send(JSON.stringify({
        action: 'rpcsend',
        token: 'test-token',
        payload: {
            action: 'displayState',
            payload: { target: 'kiosk1', state: 'off' },
        },
    }));
    await new Promise((res) => setTimeout(res, 50));
    sender.close();
    await new Promise((res) => setTimeout(res, 100));

    // A fresh client connecting with no live kiosk1 session must still
    // receive the cached displayState during the connect-time replay.
    const ws = openClient();
    await ws.opened;
    const deadline = Date.now() + 3000;
    let ds;
    while (Date.now() < deadline) {
        ds = ws.frames.find((f) => f.action === 'displayState' && f.payload?.target === 'kiosk1');
        if (ds) break;
        await new Promise((res) => setTimeout(res, 50));
    }
    assert.ok(ds, 'expected cached displayState to be replayed on reconnect');
    assert.equal(ds.payload.state, 'off');

    ws.close();
});

test('getDisplayState echoes only the cached panel state, never visibility', async (t) => {
    await startServer();
    t.after(stopServer);

    const ws = openClient();
    await ws.opened;
    await ws.waitForFrames(1); // drain initial frames

    // Visibility is known but no panel displayState is cached yet. The reply
    // must NOT synthesize a (state-less) displayState carrying visibility —
    // clients read a missing `state` as off=false and would re-enable a
    // panel PIR had turned off.
    ws.send(JSON.stringify({ action: 'visibility', payload: { deviceId: 'kiosk1', visible: false } }));
    await new Promise((res) => setTimeout(res, 50));
    ws.frames.length = 0;
    ws.send(JSON.stringify({ action: 'getDisplayState', payload: { target: 'kiosk1' } }));
    await new Promise((res) => setTimeout(res, 200));
    assert.ok(
        !ws.frames.some((f) => f.action === 'displayState' && f.payload?.target === 'kiosk1'),
        'no displayState reply should be sent when only visibility is known',
    );

    // Once a panel state is cached, getDisplayState echoes it verbatim — with
    // `state`, and without any visibility fields folded in.
    ws.send(JSON.stringify({ action: 'reportDisplay', payload: { deviceId: 'kiosk1', state: 'off' } }));
    await new Promise((res) => setTimeout(res, 50));
    ws.frames.length = 0;
    ws.send(JSON.stringify({ action: 'getDisplayState', payload: { target: 'kiosk1' } }));
    const deadline = Date.now() + 1000;
    let ds;
    while (Date.now() < deadline) {
        ds = ws.frames.find((f) => f.action === 'displayState' && f.payload?.target === 'kiosk1');
        if (ds) break;
        await new Promise((res) => setTimeout(res, 25));
    }
    assert.ok(ds, 'getDisplayState should echo the cached panel displayState');
    assert.equal(ds.payload.state, 'off');
    assert.equal(ds.payload.visible, undefined, 'reply must not carry visibility');
    assert.equal(ds.payload.visibilitySince, undefined);

    ws.close();
});

test('visibility:false no longer cascades a displayState:off (visibility is telemetry only)', async (t) => {
    await startServer();
    t.after(stopServer);

    const a = openClient();
    const b = openClient();
    await a.opened; await b.opened;
    await a.waitForFrames(1); await b.waitForFrames(1); // drain initial pushes

    // Cache a panel 'on' state for kiosk1 (the pre-condition the old cascade
    // checked before flipping the panel off).
    a.send(JSON.stringify({ action: 'reportDisplay', payload: { deviceId: 'kiosk1', state: 'on' } }));
    await new Promise((r) => setTimeout(r, 80));

    const before = a.frames.length;
    // The room empties. Under the old coupling this broadcast a displayState:off
    // + light-off; now visibility feeds only the motion sensor.
    b.send(JSON.stringify({ action: 'visibility', payload: { deviceId: 'kiosk1', visible: false } }));
    await new Promise((r) => setTimeout(r, 150));

    const offFrame = a.frames.slice(before).find(
        (f) => f.action === 'displayState' && f.payload?.target === 'kiosk1'
            && (f.payload.state === 'off' || f.payload.state === false));
    assert.equal(offFrame, undefined, 'visibility:false must not trigger a displayState:off cascade');

    a.close(); b.close();
});
