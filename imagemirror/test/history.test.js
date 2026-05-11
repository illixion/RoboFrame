// Tests for the rolling request-history buffer that backs /get's cache,
// /history (HTML), /history.json (JSON), and /addtohistory. Boots a minimal
// express app with the same routes index.js registers, so /history.json
// is exercised end-to-end.

const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const express = require('express');
const { createHistory } = require('../lib/history');

function startApp(history) {
    const app = express();
    app.get('/history.json', (req, res) => {
        res.json({ history: history.listJson() });
    });
    return new Promise((resolve) => {
        const server = app.listen(0, '127.0.0.1', () => {
            const { port } = server.address();
            resolve({ server, port });
        });
    });
}

function get(port, path) {
    return new Promise((resolve, reject) => {
        http.get({ host: '127.0.0.1', port, path }, (res) => {
            let body = '';
            res.on('data', (chunk) => { body += chunk; });
            res.on('end', () => resolve({ status: res.statusCode, body }));
        }).on('error', reject);
    });
}

test('addEntry inserts newest-first and dedupes by id', () => {
    const h = createHistory({ maxSize: 5 });
    h.addEntry({ id: 1, ext: 'jpg' });
    h.addEntry({ id: 2, ext: 'png' });
    h.addEntry({ id: 3, ext: 'gif' });
    assert.deepEqual(h.entries.map((e) => e.id), [3, 2, 1]);

    // Re-adding id=1 moves it back to the front, doesn't duplicate.
    h.addEntry({ id: 1, ext: 'jpg' });
    assert.deepEqual(h.entries.map((e) => e.id), [1, 3, 2]);
});

test('addEntry caps at maxSize, dropping the oldest', () => {
    const h = createHistory({ maxSize: 3 });
    for (let i = 1; i <= 5; i += 1) h.addEntry({ id: i, ext: 'jpg' });
    assert.deepEqual(h.entries.map((e) => e.id), [5, 4, 3]);
});

test('findCached returns the entry by id or undefined', () => {
    const h = createHistory();
    h.addEntry({ id: 42, ext: 'webp', mime_type: 'image/webp', file_contents: Buffer.from('x') });
    const hit = h.findCached(42);
    assert.equal(hit?.ext, 'webp');
    assert.equal(h.findCached(999), undefined);
});

test('listPreview exposes id only (matches the HTML template contract)', () => {
    const h = createHistory();
    h.addEntry({ id: 7, ext: 'jpg', mime_type: 'image/jpeg', file_contents: Buffer.from('x') });
    assert.deepEqual(h.listPreview(), [{ id: 7 }]);
});

test('listJson exposes id + ext (the /history.json contract)', () => {
    const h = createHistory();
    h.addEntry({ id: 7, ext: 'jpg' });
    h.addEntry({ id: 8, ext: 'mp4' });
    assert.deepEqual(h.listJson(), [{ id: 8, ext: 'mp4' }, { id: 7, ext: 'jpg' }]);
});

test('/history.json returns the JSON contract end-to-end', async () => {
    const h = createHistory();
    h.addEntry({ id: 1, ext: 'jpg' });
    h.addEntry({ id: 2, ext: 'png' });
    const { server, port } = await startApp(h);
    try {
        const res = await get(port, '/history.json');
        assert.equal(res.status, 200);
        const parsed = JSON.parse(res.body);
        assert.deepEqual(parsed, { history: [{ id: 2, ext: 'png' }, { id: 1, ext: 'jpg' }] });
    } finally {
        await new Promise((resolve) => server.close(resolve));
    }
});

test('/history.json reflects empty state', async () => {
    const h = createHistory();
    const { server, port } = await startApp(h);
    try {
        const res = await get(port, '/history.json');
        assert.equal(res.status, 200);
        assert.deepEqual(JSON.parse(res.body), { history: [] });
    } finally {
        await new Promise((resolve) => server.close(resolve));
    }
});
