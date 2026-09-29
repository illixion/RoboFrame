'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');
const { PassThrough } = require('stream');
const { createVideoTranscoder, fitsRaw, fitSize, bitrateTier } = require('../lib/videoTranscode');

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

    // Uncapped (Hypnos profile): source resolution + frame rate.
    const orig = probe(await t.animatedToMp4(fs.readFileSync(apngPath), { maxHeight: 0, maxFps: 0 }), 'orig');
    assert.equal(orig.height, 1440, `uncapped keeps source height, got ${orig.height}`);
    assert.ok(orig.fps > 31, `uncapped keeps source frame rate, got ${orig.fps}`);
});

test('poster() extracts a first-frame JPEG and caches it', { skip: !hasFfmpeg() }, async () => {
    const dir = tmpDir();
    const src = path.join(dir, 'src.mp4');
    execFileSync('ffmpeg', [
        '-hide_banner', '-loglevel', 'error',
        '-f', 'lavfi', '-i', 'color=c=red:s=320x240:d=1',
        '-c:v', 'libx264', '-pix_fmt', 'yuv420p', src,
    ], { stdio: 'ignore' });

    const t = createVideoTranscoder({ cachePath: dir, log: quietLog });
    const posterPath = await t.poster(42, src);
    assert.ok(posterPath, 'returns a path');
    const jpeg = fs.readFileSync(posterPath);
    assert.ok(jpeg.length > 0, 'wrote a non-empty file');
    assert.equal(jpeg.slice(0, 2).toString('hex'), 'ffd8', 'starts with a JPEG SOI marker');

    // Second call is a cache hit: no new ffmpeg process, same path.
    const cached = await t.poster(42, src);
    assert.equal(cached, posterPath);
});

test('poster() resolves null when ffmpeg is missing', async () => {
    const t = createVideoTranscoder({ cachePath: tmpDir(), ffmpegPath: '/nonexistent/ffmpeg', log: quietLog });
    const result = await t.poster(1, '/nonexistent/source.mp4');
    assert.equal(result, null);
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

test('prune ages out poster files like any other cache entry', async () => {
    const dir = tmpDir();
    const t = createVideoTranscoder({ cachePath: dir, maxCacheBytes: 150, log: quietLog });
    fs.writeFileSync(path.join(dir, '1.poster.jpg'), Buffer.alloc(100));
    fs.utimesSync(path.join(dir, '1.poster.jpg'), new Date(1000000), new Date(1000000));
    fs.writeFileSync(path.join(dir, '2.poster.jpg'), Buffer.alloc(100));
    fs.utimesSync(path.join(dir, '2.poster.jpg'), new Date(2000000), new Date(2000000));
    t.prune();
    await new Promise((r) => setTimeout(r, 200));
    assert.deepEqual(fs.readdirSync(dir), ['2.poster.jpg']);
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

test('H.264 outside an ISO BMFF container is transcoded to mp4 even at 0/0', { skip: !hasFfmpeg() }, async () => {
    const dir = tmpDir();
    const t = createVideoTranscoder({ cachePath: dir, log: quietLog });
    const make = (name) => {
        const src = path.join(dir, name);
        execFileSync('ffmpeg', [
            '-hide_banner', '-loglevel', 'error',
            '-f', 'lavfi', '-i', 'testsrc=duration=0.5:size=640x360:rate=30',
            '-c:v', 'libx264', '-pix_fmt', 'yuv420p', src,
        ], { stdio: 'ignore' });
        return src;
    };
    try {
        make('probe.mp4');
    } catch {
        return; // ffmpeg built without libx264
    }
    let id = 20;
    for (const name of ['clip.mov', 'clip.m4v', 'clip.3gp']) {
        assert.equal(await t.sourceNeedsTranscode(id++, make(name), 0, 0), false, `${name} plays raw`);
    }
    for (const name of ['clip.mkv', 'clip.avi', 'clip.flv']) {
        assert.equal(await t.sourceNeedsTranscode(id++, make(name), 0, 0), true, `${name} is re-encoded`);
    }
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

test('end-to-end: hls() produces a playable fMP4 playlist + segments, ENDLIST on finish', { skip: !hasFfmpeg() }, async () => {
    const dir = tmpDir();
    // mpeg4 source (not H.264) so a transcode is genuinely required.
    const src = path.join(dir, 'srchls.mp4');
    execFileSync('ffmpeg', [
        '-hide_banner', '-loglevel', 'error',
        '-f', 'lavfi', '-i', 'testsrc=duration=2:size=320x240:rate=30',
        '-c:v', 'mpeg4', src,
    ]);

    const t = createVideoTranscoder({ cachePath: dir, log: quietLog });
    if (!await t.available()) return; // no H.264 encoder in this ffmpeg build

    const hlsPath = await t.hls(7, src, 0, 0);
    assert.ok(hlsPath, 'hls returned a dir');
    assert.equal(hlsPath, t.hlsDir(7, 0, 0));

    // The startable set exists as soon as hls() resolves.
    assert.ok(fs.existsSync(path.join(hlsPath, 'index.m3u8')), 'playlist exists');
    assert.ok(fs.existsSync(path.join(hlsPath, 'init.mp4')), 'init segment exists');
    assert.ok(fs.existsSync(path.join(hlsPath, 'seg_000.m4s')), 'first segment exists');

    const m3u8 = fs.readFileSync(path.join(hlsPath, 'index.m3u8'), 'utf8');
    assert.ok(m3u8.includes('#EXTM3U'), 'valid playlist header');
    assert.ok(m3u8.includes('#EXT-X-MAP:URI="init.mp4"'), 'declares the fMP4 init segment');
    assert.ok(m3u8.includes('.m4s'), 'references media segments');
    assert.ok(fs.readFileSync(path.join(hlsPath, 'init.mp4')).includes(Buffer.from('ftyp')), 'init is fMP4');

    // The `event` playlist gets ENDLIST once ffmpeg finishes — the VOD-replay marker.
    for (let i = 0; i < 100; i++) {
        if (fs.readFileSync(path.join(hlsPath, 'index.m3u8'), 'utf8').includes('#EXT-X-ENDLIST')) break;
        await new Promise((r) => setTimeout(r, 100));
    }
    assert.ok(
        fs.readFileSync(path.join(hlsPath, 'index.m3u8'), 'utf8').includes('#EXT-X-ENDLIST'),
        'playlist completes with ENDLIST',
    );

    // A second call with the same caps reuses the existing dir (cache hit).
    assert.equal(await t.hls(7, src, 0, 0), hlsPath);
});

test('hls() returns null when no encoder is available', async () => {
    const t = createVideoTranscoder({
        cachePath: tmpDir(),
        ffmpegPath: '/nonexistent/ffmpeg',
        log: quietLog,
    });
    assert.equal(await t.hls(1, '/nope.mp4', 0, 0), null);
});

// Collect a fakeRes body once the stream ends (or is destroyed).
function drained(res) {
    return new Promise((resolve) => {
        res.on('end', () => resolve(Buffer.concat(res.chunks)));
        res.on('close', () => resolve(Buffer.concat(res.chunks)));
    });
}

function makeSource(dir, name, args) {
    const src = path.join(dir, name);
    try {
        execFileSync('ffmpeg', ['-hide_banner', '-loglevel', 'error', ...args, src], { stdio: 'ignore' });
        return src;
    } catch {
        return null; // this ffmpeg build lacks the encoder — caller skips
    }
}

test('fitsRaw only passes hardware-decodable H.264 within the cap box', () => {
    const base = { codec: 'h264', width: 1280, height: 720, fps: 30, pixFmt: 'yuv420p', isoBmff: true };
    assert.equal(fitsRaw(base, 720, 30), true);
    assert.equal(fitsRaw({ ...base, isoBmff: false }, 720, 30), false, 'H.264 in Matroska/AVI');
    assert.equal(fitsRaw({ ...base, isoBmff: false }, 0, 0), false, '0/0 still needs an mp4 container');
    assert.equal(fitsRaw({ ...base, pixFmt: 'yuv420p10le' }, 720, 30), false, '10-bit H.264');
    assert.equal(fitsRaw({ ...base, pixFmt: 'yuv444p' }, 720, 30), false, '4:4:4 H.264');
    assert.equal(fitsRaw({ ...base, width: 2560 }, 720, 30), false, 'wider than the 16:9 box');
    assert.equal(fitsRaw({ ...base, codec: 'vp9' }, 720, 30), false);
    assert.equal(fitsRaw({ ...base, pixFmt: 'yuv420p10le', width: 3840 }, 0, 0), true,
        '0/0 caps take any H.264');
});

test('fitSize fits inside the cap box, never upscales, keeps even dims', () => {
    assert.deepEqual(fitSize(3840, 2160, 720), { width: 1280, height: 720 });
    const portrait = fitSize(1080, 1920, 720);
    assert.equal(portrait.height, 720);
    assert.ok(portrait.width <= 406 && portrait.width % 2 === 0);
    assert.deepEqual(fitSize(641, 361, 720), { width: 640, height: 360 });
    assert.deepEqual(fitSize(3841, 2161, 0), { width: 3840, height: 2160 });
});

test('bitrateTier drops the budget for Pi-sized outputs', () => {
    assert.equal(bitrateTier(720).rate, '5M');
    assert.equal(bitrateTier(1080).rate, '12M');
    assert.equal(bitrateTier(0).rate, '12M', 'unknown height keeps the large tier');
});

test('a cache dir under a missing parent disables transcoding instead of creating it', async () => {
    const cachePath = path.join(tmpDir(), 'not-mounted', 'video_cache');
    const t = createVideoTranscoder({ cachePath, log: quietLog });
    assert.equal(await t.available(), false);
    assert.equal(await t.stream({}, fakeRes(), 1, '/nope.mp4', 720, 30), false);
    assert.equal(fs.existsSync(path.dirname(cachePath)), false, 'nothing was created');
});

test('concurrent requests for one video share a single encode; a late joiner gets the whole file', { skip: !hasFfmpeg() }, async () => {
    const dir = tmpDir();
    const src = makeSource(dir, 'share.mp4', ['-f', 'lavfi', '-i', 'testsrc=duration=3:size=1280x720:rate=30', '-c:v', 'mpeg4']);
    const t = createVideoTranscoder({ cachePath: dir, log: quietLog });
    if (!src || !await t.available()) return;

    const a = fakeRes();
    const b = fakeRes();
    const bodies = Promise.all([drained(a), drained(b)]);
    const started = [t.stream({}, a, 21, src, 720, 30), t.stream({}, b, 21, src, 720, 30)];
    await new Promise((r) => setTimeout(r, 50));
    assert.equal(t.stats().encodes.length, 1, 'one encode for both viewers');
    // Joins after output has started flowing, still from byte 0.
    const late = fakeRes();
    const lateBody = drained(late);
    started.push(t.stream({}, late, 21, src, 720, 30));
    await Promise.all(started);
    const [bodyA, bodyB] = await bodies;
    assert.ok(bodyA.length > 0);
    assert.deepEqual(bodyB, bodyA);
    assert.deepEqual(await lateBody, bodyA, 'late joiner received the full stream');
    for (let i = 0; i < 50 && !t.cachedFile(21, 720, 30); i++) await new Promise((r) => setTimeout(r, 50));
    assert.deepEqual(fs.readFileSync(t.cachedFile(21, 720, 30)), bodyA);
});

// An ffmpeg that holds every encode open for `delaySec` before running it,
// so a test can observe encodes while they are deterministically in flight.
// The encoder probe passes straight through; ffprobe sits beside it because
// the transcoder derives its path from ffmpeg's.
function slowFfmpeg(dir, delaySec) {
    const binDir = path.join(dir, 'bin');
    fs.mkdirSync(binDir);
    const real = execFileSync('/bin/sh', ['-c', 'command -v ffmpeg']).toString().trim();
    const realProbe = execFileSync('/bin/sh', ['-c', 'command -v ffprobe']).toString().trim();
    const wrapper = path.join(binDir, 'ffmpeg');
    fs.writeFileSync(wrapper, `#!/bin/sh\n[ "$2" = "-encoders" ] || sleep ${delaySec}\nexec "${real}" "$@"\n`);
    fs.chmodSync(wrapper, 0o755);
    fs.symlinkSync(realProbe, path.join(binDir, 'ffprobe'));
    return wrapper;
}

test('a viewer preempts an orphaned encode; busy slots with live viewers refuse', { skip: !hasFfmpeg() }, async () => {
    const dir = tmpDir();
    const src = makeSource(dir, 'src.mp4', ['-f', 'lavfi', '-i', 'testsrc=duration=1:size=640x360:rate=30', '-c:v', 'mpeg4']);
    if (!src) return;
    const t = createVideoTranscoder({
        cachePath: dir, ffmpegPath: slowFfmpeg(dir, 1), maxConcurrent: 1, log: quietLog,
    });
    if (!await t.available()) return;

    // A: the viewer leaves at once, leaving an orphaned encode on the slot.
    const a = fakeRes();
    const aDone = t.stream({}, a, 31, src, 720, 30);
    await new Promise((r) => setTimeout(r, 200));
    a.destroy();
    await aDone;
    assert.equal(t.stats().encodes[0].orphan, true);

    // B takes the slot by killing A.
    const b = fakeRes();
    const bBody = drained(b);
    const bServed = t.stream({}, b, 32, src, 720, 30);
    await new Promise((r) => setTimeout(r, 200));
    assert.deepEqual(t.stats().encodes.map((e) => e.id), [32]);
    // C arrives while B's viewer is live: nothing to preempt.
    assert.equal(await t.stream({}, fakeRes(), 33, src, 720, 30), false);
    assert.equal(await bServed, true);
    assert.ok((await bBody).length > 0);
    await new Promise((r) => setTimeout(r, 200));
    assert.equal(t.cachedFile(31, 720, 30), null, 'the preempted encode never committed');
    assert.ok(!fs.readdirSync(dir).some((n) => n.startsWith('.31.')), 'its temp file was removed');
    assert.ok(t.cachedFile(32, 720, 30), 'the viewer\'s encode committed');
});

test('a codec VideoToolbox cannot decode falls back to software decode', { skip: !hasFfmpeg() }, async () => {
    const dir = tmpDir();
    const src = makeSource(dir, 'av1.mkv', ['-f', 'lavfi', '-i', 'testsrc=duration=1:size=640x360:rate=30', '-c:v', 'libsvtav1', '-preset', '12']);
    const t = createVideoTranscoder({ cachePath: dir, log: quietLog });
    if (!src || !await t.available()) return;
    const res = fakeRes();
    const body = drained(res);
    assert.equal(await t.stream({}, res, 41, src, 720, 30), true);
    assert.ok((await body).includes(Buffer.from('moof')), 'produced fragmented MP4');
    // Only hosts whose VT lacks AV1 record the failure (M1/M2 do; M3+ decode it).
    const failed = t.stats().hwDecodeFailed;
    assert.ok(failed.length === 0 || failed.includes('av1'));
});
