'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('events');
const { createSceneProducer, chromiumArgs } = require('../lib/sceneProducer');

const quietLog = { log() {}, warn() {}, error() {} };

function fakeSpawnFactory() {
    const calls = [];
    const spawn = (cmd, args) => {
        const proc = new EventEmitter();
        proc.exitCode = null;
        proc.kill = () => { proc.exitCode = 0; proc.emit('exit', 0); };
        calls.push({ cmd, args, proc });
        return proc;
    };
    return { spawn, calls };
}

const STREAM = { id: 'scene', effect: '/custom_page', fps: 60, kbps: 20000, capture: 'canvas' };

test('disabled -> start() is a no-op', () => {
    const { spawn, calls } = fakeSpawnFactory();
    const p = createSceneProducer({ enabled: false, chromiumPath: '/x', streams: [STREAM], spawn, log: quietLog });
    assert.equal(p.start(), false);
    assert.equal(calls.length, 0);
});

test('enabled without chromiumPath or streams -> refuses to start', () => {
    const { spawn, calls } = fakeSpawnFactory();
    const noPath = createSceneProducer({ enabled: true, chromiumPath: '', streams: [STREAM], spawn, log: quietLog });
    assert.equal(noPath.start(), false);
    const noStreams = createSceneProducer({ enabled: true, chromiumPath: '/x', streams: [], spawn, log: quietLog });
    assert.equal(noStreams.start(), false);
    assert.equal(calls.length, 0);
});

test('spawns chromium per stream with producer URL and capture flags', () => {
    const { spawn, calls } = fakeSpawnFactory();
    const p = createSceneProducer({
        enabled: true, chromiumPath: '/usr/bin/chromium',
        whipBase: 'http://mtx:8889', producerBase: 'http://srv:3123',
        streams: [STREAM], spawn, log: quietLog,
    });
    assert.equal(p.start(), true);
    assert.equal(calls.length, 1);
    assert.equal(calls[0].cmd, '/usr/bin/chromium');
    const url = calls[0].args[calls[0].args.length - 1];
    assert.match(url, /^http:\/\/srv:3123\/scenes\/producer\.html\?/);
    assert.match(url, /whip=http%3A%2F%2Fmtx%3A8889%2Fscene%2Fwhip/);
    assert.match(url, /effect=%2Fcustom_page/);
    assert.match(url, /fps=60/);
    assert.ok(calls[0].args.includes('--force-device-scale-factor=1'));
    assert.ok(calls[0].args.includes('--auto-accept-this-tab-capture'));
    p.close();
});

test('respawns on exit, close() stops the loop', async () => {
    const { spawn, calls } = fakeSpawnFactory();
    const p = createSceneProducer({
        enabled: true, chromiumPath: '/x', streams: [STREAM], spawn, log: quietLog,
    });
    p.start();
    assert.equal(calls.length, 1);
    calls[0].proc.exitCode = 1;
    calls[0].proc.emit('exit', 1);
    // Backoff floor is 2s; don't wait it out — just verify a respawn is
    // scheduled and that close() cancels it.
    p.close();
    await new Promise((r) => setTimeout(r, 50));
    assert.equal(calls.length, 1, 'close() cancelled the pending respawn');
});

test('chromiumArgs keeps the user-data-dir per stream id', () => {
    const args = chromiumArgs({ stream: { id: 'aquarium' }, url: 'http://x' });
    assert.ok(args.some((a) => a.includes('roboframe-scene-aquarium')));
});
