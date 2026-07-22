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

test('animatedToMp4 returns null when no encoder is available', async () => {
    const t = createVideoTranscoder({
        cachePath: tmpDir(),
        ffmpegPath: '/nonexistent/ffmpeg',
        log: quietLog,
    });
    assert.equal(await t.animatedToMp4(Buffer.from('not really apng')), null);
});

test('animatedToMp4 encodes an APNG to fMP4, capped to 720p30', { skip: !hasFfmpeg() }, async () => {
    const dir = tmpDir();
    // A tall, fast animated PNG so the 720p/30fps caps actually bite.
    const apngPath = path.join(dir, 'src.apng');
    let made = true;
    try {
        execFileSync('ffmpeg', [
            '-hide_banner', '-loglevel', 'error',
            '-f', 'lavfi', '-i', 'testsrc=duration=0.5:size=1080x1440:rate=60',
            '-f', 'apng', '-plays', '0', apngPath,
        ], { stdio: 'ignore' });
    } catch {
        made = false; // ffmpeg built without the apng muxer — nothing to assert
    }
    if (!made) return;

    const t = createVideoTranscoder({ cachePath: dir, log: quietLog });
    if (!await t.available()) return; // no H.264 encoder in this ffmpeg

    const probe = (mp4, label) => {
        assert.ok(Buffer.isBuffer(mp4) && mp4.length > 0, `${label}: produced an mp4 buffer`);
        assert.equal(mp4.slice(4, 8).toString('ascii'), 'ftyp', `${label}: starts with an mp4 ftyp box`);
        const probePath = path.join(dir, `out-${label}.mp4`);
        fs.writeFileSync(probePath, mp4);
        const info = execFileSync('ffprobe', [
            '-v', 'error', '-select_streams', 'v:0',
            '-show_entries', 'stream=height,avg_frame_rate', '-of', 'csv=p=0', probePath,
        ]).toString().trim().split(',');
        const [num, den] = info[1].split('/').map(Number);
        return { height: Number(info[0]), fps: num / den };
    };

    // Capped (kiosk profile): 720p30.
    const capped = probe(await t.animatedToMp4(fs.readFileSync(apngPath), { maxHeight: 720, maxFps: 30 }), 'capped');
    assert.ok(capped.height <= 720, `height capped to 720, got ${capped.height}`);
    assert.ok(capped.fps <= 31, `frame rate capped to ~30fps, got ${capped.fps}`);

    // Uncapped (Spatialstash profile): source resolution + frame rate.
    const orig = probe(await t.animatedToMp4(fs.readFileSync(apngPath), { maxHeight: 0, maxFps: 0 }), 'orig');
    assert.equal(orig.height, 1440, `uncapped keeps source height, got ${orig.height}`);
    assert.ok(orig.fps > 31, `uncapped keeps source frame rate, got ${orig.fps}`);
});

test('cachedFile misses then hits, keyed by height and fps', () => {
    const dir = tmpDir();
    const t = createVideoTranscoder({ cachePath: dir, log: quietLog });
    assert.equal(t.cachedFile(42), null); // default 1080p30
    fs.writeFileSync(path.join(dir, '42.h264.1080p.30fps.mp4'), 'x');
    assert.equal(t.cachedFile(42), path.join(dir, '42.h264.1080p.30fps.mp4'));
    // A different height cap is a distinct cache entry, not a hit.
    assert.equal(t.cachedFile(42, 720), null);
    fs.writeFileSync(path.join(dir, '42.h264.720p.30fps.mp4'), 'y');
    assert.equal(t.cachedFile(42, 720), path.join(dir, '42.h264.720p.30fps.mp4'));
    // A different fps cap is also distinct (720p30 vs 720p original/0fps).
    assert.equal(t.cachedFile(42, 720, 0), null);
    fs.writeFileSync(path.join(dir, '42.h264.720p.0fps.mp4'), 'w');
    assert.equal(t.cachedFile(42, 720, 0), path.join(dir, '42.h264.720p.0fps.mp4'));
    // Legacy pre-fps entries are ignored so they re-encode at current settings.
    fs.writeFileSync(path.join(dir, '99.h264.mp4'), 'z');
    fs.writeFileSync(path.join(dir, '99.h264.1080p.mp4'), 'z');
    assert.equal(t.cachedFile(99), null);
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

test('0/0 caps serve any H.264 source raw; an fps cap forces a transcode', { skip: !hasFfmpeg() }, async () => {
    const dir = tmpDir();
    const src = path.join(dir, 'h264_1080_60.mp4');
    let made = true;
    try {
        execFileSync('ffmpeg', [
            '-hide_banner', '-loglevel', 'error',
            '-f', 'lavfi', '-i', 'testsrc=duration=0.5:size=1920x1080:rate=60',
            '-c:v', 'libx264', '-pix_fmt', 'yuv420p', src,
        ], { stdio: 'ignore' });
    } catch {
        made = false; // ffmpeg built without libx264 — nothing to assert
    }
    if (!made) return;
    const t = createVideoTranscoder({ cachePath: dir, log: quietLog });
    // Original caps (0/0): a 1080p60 H.264 source is taken raw, no transcode.
    assert.equal(await t.sourceNeedsTranscode(11, src, 0, 0), false);
    // No height cap but a 30fps cap still forces a resample of the 60fps source.
    assert.equal(await t.sourceNeedsTranscode(11, src, 0, 30), true);
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

test('end-to-end: already-H.264 <=1080p30 source needs no transcode', { skip: !hasFfmpeg() }, async () => {
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
    // ...but a height cap below the source forces a transcode: a 240p source
    // fits raw under 1080 yet not under 200.
    assert.equal(await t.sourceNeedsTranscode(2, src, 200), true);
});

test('end-to-end: 60fps H.264 source is transcoded and capped to 30fps', { skip: !hasFfmpeg() }, async () => {
    const dir = tmpDir();
    const src = path.join(dir, 'src60.mp4');
    let made = true;
    try {
        execFileSync('ffmpeg', [
            '-hide_banner', '-loglevel', 'error',
            '-f', 'lavfi', '-i', 'testsrc=duration=0.5:size=320x240:rate=60',
            '-c:v', 'libx264', '-pix_fmt', 'yuv420p', src,
        ], { stdio: 'ignore' });
    } catch {
        made = false; // ffmpeg built without libx264 — nothing to assert
    }
    if (!made) return;
    const t = createVideoTranscoder({ cachePath: dir, log: quietLog });
    // 60fps overruns the Pi's 1080p30-rated decoder even though the codec
    // and resolution qualify for the raw path.
    assert.equal(await t.sourceNeedsTranscode(3, src), true);

    const res = fakeRes();
    await t.stream({}, res, 3, src);
    await new Promise((resolve) => res.on('end', resolve));
    for (let i = 0; i < 50 && !t.cachedFile(3); i++) {
        await new Promise((r) => setTimeout(r, 100));
    }
    const cached = t.cachedFile(3);
    assert.ok(cached, 'transcode was committed to the cache');
    const rate = execFileSync('ffprobe', [
        '-v', 'error', '-select_streams', 'v:0',
        '-show_entries', 'stream=avg_frame_rate', '-of', 'csv=p=0', cached,
    ]).toString().trim();
    const [num, den] = rate.split('/').map(Number);
    assert.ok(Math.abs(num / den - 30) < 1, `output frame rate is ~30fps, got ${rate}`);
});

test('end-to-end: 60fps source is capped to 30fps even at 720p', { skip: !hasFfmpeg() }, async () => {
    const dir = tmpDir();
    const src = path.join(dir, 'src720_60.mp4');
    let made = true;
    try {
        execFileSync('ffmpeg', [
            '-hide_banner', '-loglevel', 'error',
            '-f', 'lavfi', '-i', 'testsrc=duration=0.5:size=1280x720:rate=60',
            '-c:v', 'libx264', '-pix_fmt', 'yuv420p', src,
        ], { stdio: 'ignore' });
    } catch {
        made = false; // ffmpeg built without libx264 — nothing to assert
    }
    if (!made) return;
    const t = createVideoTranscoder({ cachePath: dir, log: quietLog });
    // 30fps is the budget at every height now, so a 720p60 source no longer
    // fits the raw path — it's resampled to 30fps like the 1080p case.
    assert.equal(await t.sourceNeedsTranscode(7, src, 720), true);
    assert.equal(await t.sourceNeedsTranscode(7, src, 1080), true);

    // Transcoding a non-H.264 60fps source at 720p resamples to 30fps.
    const m4 = path.join(dir, 'src720_60.m4v');
    execFileSync('ffmpeg', [
        '-hide_banner', '-loglevel', 'error',
        '-f', 'lavfi', '-i', 'testsrc=duration=0.5:size=1280x720:rate=60',
        '-c:v', 'mpeg4', m4,
    ], { stdio: 'ignore' });
    const res = fakeRes();
    await t.stream({}, res, 8, m4, 720);
    await new Promise((resolve) => res.on('end', resolve));
    for (let i = 0; i < 50 && !t.cachedFile(8, 720); i++) {
        await new Promise((r) => setTimeout(r, 100));
    }
    const cached = t.cachedFile(8, 720);
    assert.ok(cached, 'transcode was committed to the cache');
    const rate = execFileSync('ffprobe', [
        '-v', 'error', '-select_streams', 'v:0',
        '-show_entries', 'stream=avg_frame_rate', '-of', 'csv=p=0', cached,
    ]).toString().trim();
    const [num, den] = rate.split('/').map(Number);
    assert.ok(Math.abs(num / den - 30) < 1, `output frame rate is ~30fps, got ${rate}`);
});
