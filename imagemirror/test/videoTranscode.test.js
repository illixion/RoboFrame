'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');
const { PassThrough } = require('stream');
const { createVideoTranscoder } = require('../lib/videoTranscode');

const quietLog = { log() {}, warn() {}, error() {} };

function tmpDir() {
    return fs.mkdtempSync(path.join(os.tmpdir(), 'rf-vt-'));
}

function hasFfmpeg() {
    try {
        execFileSync('ffmpeg', ['-version'], { stdio: 'ignore' });
        return true;
    } catch {
        return false;
    }
}

// A writable that quacks enough like an Express res for stream().
function fakeRes() {
    const res = new PassThrough();
    res.headers = {};
    res.setHeader = (k, v) => { res.headers[k] = v; };
    res.chunks = [];
    res.on('data', (d) => res.chunks.push(d));
    return res;
}

test('unusable ffmpeg -> unavailable, never throws', async () => {
    const t = createVideoTranscoder({
        cachePath: tmpDir(),
        ffmpegPath: '/nonexistent/ffmpeg',
        log: quietLog,
    });
    assert.equal(await t.available(), false);
});

test('cachedFile misses then hits', () => {
    const dir = tmpDir();
    const t = createVideoTranscoder({ cachePath: dir, log: quietLog });
    assert.equal(t.cachedFile(42), null);
    fs.writeFileSync(path.join(dir, '42.h264.mp4'), 'x');
    assert.equal(t.cachedFile(42), path.join(dir, '42.h264.mp4'));
});

test('prune drops oldest entries beyond the byte cap', async () => {
    const dir = tmpDir();
    const t = createVideoTranscoder({ cachePath: dir, maxCacheBytes: 250, log: quietLog });
    for (let i = 0; i < 3; i++) {
        const p = path.join(dir, `${i}.h264.mp4`);
        fs.writeFileSync(p, Buffer.alloc(100));
        // Distinct mtimes, oldest first.
        fs.utimesSync(p, new Date(1000000 + i * 1000), new Date(1000000 + i * 1000));
    }
    t.prune();
    await new Promise((r) => setTimeout(r, 200));
    const left = fs.readdirSync(dir).sort();
    assert.deepEqual(left, ['1.h264.mp4', '2.h264.mp4']);
});

test('hasFreeSlot respects maxConcurrent', () => {
    const t = createVideoTranscoder({ cachePath: tmpDir(), maxConcurrent: 0, log: quietLog });
    assert.equal(t.hasFreeSlot(), false);
});

test('end-to-end: transcode streams fMP4 and commits the cache', { skip: !hasFfmpeg() }, async () => {
    const dir = tmpDir();
    // mpeg4-in-mp4 source: fast to synthesize, and NOT h264 so
    // sourceNeedsTranscode must say yes.
    const src = path.join(dir, 'src.mp4');
    execFileSync('ffmpeg', [
        '-hide_banner', '-loglevel', 'error',
        '-f', 'lavfi', '-i', 'testsrc=duration=0.5:size=320x242:rate=10',
        '-c:v', 'mpeg4', src,
    ]);

    const t = createVideoTranscoder({ cachePath: dir, log: quietLog });
    assert.equal(await t.available(), true);
    assert.equal(await t.sourceNeedsTranscode(1, src), true);

    const res = fakeRes();
    await t.stream({}, res, 1, src);
    await new Promise((resolve) => res.on('end', resolve));

    const body = Buffer.concat(res.chunks);
    assert.ok(body.length > 0, 'streamed bytes to the client');
    assert.equal(res.headers['Content-Type'], 'video/mp4');
    // Fragmented MP4 carries moof boxes; a classic MP4 would not.
    assert.ok(body.includes(Buffer.from('moof')), 'output is fragmented MP4');

    // Cache commit happens on ffmpeg exit; res `end` precedes the rename by
    // a tick, so poll briefly.
    for (let i = 0; i < 50 && !t.cachedFile(1); i++) {
        await new Promise((r) => setTimeout(r, 100));
    }
    const cached = t.cachedFile(1);
    assert.ok(cached, 'transcode was committed to the cache');
    assert.deepEqual(fs.readFileSync(cached), body, 'cache tee matches the streamed bytes');
});

test('end-to-end: already-H.264 <=1080p source needs no transcode', { skip: !hasFfmpeg() }, async () => {
    const dir = tmpDir();
    const src = path.join(dir, 'src264.mp4');
    let made = true;
    try {
        execFileSync('ffmpeg', [
            '-hide_banner', '-loglevel', 'error',
            '-f', 'lavfi', '-i', 'testsrc=duration=0.5:size=320x240:rate=10',
            '-c:v', 'libx264', '-pix_fmt', 'yuv420p', src,
        ], { stdio: 'ignore' });
    } catch {
        made = false; // ffmpeg built without libx264 — nothing to assert
    }
    if (!made) return;
    const t = createVideoTranscoder({ cachePath: dir, log: quietLog });
    assert.equal(await t.sourceNeedsTranscode(2, src), false);
});
