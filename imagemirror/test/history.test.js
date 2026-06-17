// Tests for the per-display request-history buffers that back /history (HTML)
// and /history.json (JSON). Boots a minimal express app with the same route
// index.js registers, so /history.json is exercised end-to-end.

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

test('addEntry buckets by deviceId, newest-first, deduping within a display', () => {
    const h = createHistory({ maxSize: 5 });
    h.addEntry({ id: 1, ext: 'jpg', deviceId: 'a' });
    h.addEntry({ id: 2, ext: 'png', deviceId: 'a' });
    h.addEntry({ id: 3, ext: 'gif', deviceId: 'b' });

    const groups = h.listGroups();
    // Display b is most-recently-active, so it sorts first.
    assert.deepEqual(groups.map((g) => g.deviceId), ['b', 'a']);
    assert.deepEqual(groups.find((g) => g.deviceId === 'a').posts.map((p) => p.id), [2, 1]);

    // Re-adding id=1 on display a moves it to that display's front only.
    h.addEntry({ id: 1, ext: 'jpg', deviceId: 'a' });
    assert.deepEqual(h.listGroups().find((g) => g.deviceId === 'a').posts.map((p) => p.id), [1, 2]);
});

test('the same id on two displays lives in both buckets', () => {
    const h = createHistory();
    h.addEntry({ id: 9, ext: 'jpg', deviceId: 'a' });
    h.addEntry({ id: 9, ext: 'jpg', deviceId: 'b' });
    const groups = h.listGroups();
    assert.equal(groups.find((g) => g.deviceId === 'a').posts.length, 1);
    assert.equal(groups.find((g) => g.deviceId === 'b').posts.length, 1);
});

test('a missing deviceId buckets under others', () => {
    const h = createHistory();
    h.addEntry({ id: 1, ext: 'jpg' });
    h.addEntry({ id: 2, ext: 'png', deviceId: '' });
    const groups = h.listGroups();
    assert.deepEqual(groups.map((g) => g.deviceId), ['others']);
    assert.deepEqual(groups[0].posts.map((p) => p.id), [2, 1]);
});

test('addEntry caps each bucket independently, dropping that display oldest', () => {
    const h = createHistory({ maxSize: 3 });
    for (let i = 1; i <= 5; i += 1) h.addEntry({ id: i, ext: 'jpg', deviceId: 'a' });
    for (let i = 10; i <= 11; i += 1) h.addEntry({ id: i, ext: 'jpg', deviceId: 'b' });
    const groups = h.listGroups();
    assert.deepEqual(groups.find((g) => g.deviceId === 'a').posts.map((p) => p.id), [5, 4, 3]);
    assert.deepEqual(groups.find((g) => g.deviceId === 'b').posts.map((p) => p.id), [11, 10]);
});

test('listGroups exposes id only (keeps ext out of the HTML template)', () => {
    const h = createHistory();
    h.addEntry({ id: 7, ext: 'jpg', deviceId: 'a' });
    assert.deepEqual(h.listGroups(), [{ deviceId: 'a', posts: [{ id: 7 }] }]);
});

test('findCached returns the entry by id across buckets, or undefined', () => {
    const h = createHistory();
    h.addEntry({ id: 42, ext: 'webp', deviceId: 'a' });
    assert.equal(h.findCached(42)?.ext, 'webp');
    assert.equal(h.findCached(999), undefined);
});

test('listJson flattens buckets newest-first with id + ext, deduped by id', () => {
    const h = createHistory();
    h.addEntry({ id: 7, ext: 'jpg', deviceId: 'a' });
    h.addEntry({ id: 8, ext: 'mp4', deviceId: 'b' });
    h.addEntry({ id: 7, ext: 'jpg', deviceId: 'b' });   // newest; dedupes the id=7 above
    assert.deepEqual(h.listJson(), [{ id: 7, ext: 'jpg' }, { id: 8, ext: 'mp4' }]);
});

test('/history.json returns the JSON contract end-to-end', async () => {
    const h = createHistory();
    h.addEntry({ id: 1, ext: 'jpg', deviceId: 'a' });
    h.addEntry({ id: 2, ext: 'png', deviceId: 'a' });
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
