'use strict';
//
// V4L2 MJPG capture, no native deps. Spawns `v4l2-ctl` once when the
// first subscriber arrives and stops when the last one leaves; frames
// arrive as concatenated raw JPEGs on stdout, split at SOI/EOI markers.
//
// `v4l2-ctl --stream-to=-` writes baseline JPEG frames back-to-back
// without any framing — JPEG's structural rules (FF stuffed in entropy
// data, EOI only at the boundary) make a simple byte scan unambiguous.

const { spawn } = require('child_process');
const { EventEmitter } = require('events');

const SOI = Buffer.from([0xff, 0xd8]);
const EOI = Buffer.from([0xff, 0xd9]);

function createWebcam({ device = '/dev/video0', width = 1280, height = 720, framerate = 30, controls = {} } = {}) {
    const emitter = new EventEmitter();
    emitter.setMaxListeners(0);

    let proc = null;
    let subscribers = 0;
    let buf = Buffer.alloc(0);
    let lastFrame = null;

    // V4L2 controls (e.g. exposure_dynamic_framerate, power_line_frequency)
    // are device state that resets across capture restarts and USB
    // re-enumeration, so reapply them every time the stream starts.
    // Insertion order is preserved — list dependent controls accordingly
    // (e.g. auto_exposure before exposure_time_absolute).
    function applyControls() {
        const pairs = Object.entries(controls).map(([k, v]) => `${k}=${v}`);
        if (pairs.length === 0) return;
        const args = ['-d', device, `--set-ctrl=${pairs.join(',')}`];
        const ctl = spawn('v4l2-ctl', args, { stdio: ['ignore', 'ignore', 'pipe'] });
        ctl.stderr.on('data', (d) => {
            const s = d.toString().trim();
            if (s) console.warn(`[webcam] set-ctrl: ${s}`);
        });
        ctl.on('error', (err) => console.error(`[webcam] set-ctrl failed: ${err.message}`));
    }

    function start() {
        if (proc) return;
        const args = [
            '-d', device,
            `--set-fmt-video=width=${width},height=${height},pixelformat=MJPG`,
            `--set-parm=${framerate}`,
            '--stream-mmap=4',
            '--stream-count=0',
            '--stream-to=-',
        ];
        console.log(`[webcam] starting v4l2-ctl ${args.join(' ')}`);
        applyControls();
        proc = spawn('v4l2-ctl', args, { stdio: ['ignore', 'pipe', 'pipe'] });
        proc.stdout.on('data', onData);
        proc.stderr.on('data', (d) => {
            const s = d.toString().trim();
            if (s) console.warn(`[webcam] v4l2-ctl: ${s}`);
        });
        proc.on('error', (err) => {
            console.error(`[webcam] spawn failed: ${err.message}`);
            emitter.emit('error', err);
        });
        proc.on('exit', (code, signal) => {
            console.log(`[webcam] v4l2-ctl exited code=${code} signal=${signal}`);
            proc = null;
            buf = Buffer.alloc(0);
        });
    }

    function stop() {
        if (!proc) return;
        try { proc.kill('SIGTERM'); } catch (_) { /* ignore */ }
        proc = null;
        buf = Buffer.alloc(0);
        lastFrame = null;
    }

    function onData(chunk) {
        buf = buf.length === 0 ? chunk : Buffer.concat([buf, chunk]);
        let cursor = 0;
        while (true) {
            const soi = buf.indexOf(SOI, cursor);
            if (soi < 0) {
                cursor = buf.length;
                break;
            }
            const eoi = buf.indexOf(EOI, soi + 2);
            if (eoi < 0) {
                // Drop everything before this incomplete frame.
                cursor = soi;
                break;
            }
            const end = eoi + 2;
            const frame = buf.slice(soi, end);
            lastFrame = frame;
            emitter.emit('frame', frame);
            cursor = end;
        }
        buf = cursor === 0 ? buf : buf.slice(cursor);
        // Sanity cap so a stuck stream can't grow unbounded.
        if (buf.length > 8 * 1024 * 1024) buf = Buffer.alloc(0);
    }

    function subscribe(handler) {
        emitter.on('frame', handler);
        subscribers += 1;
        if (subscribers === 1) start();
        return function unsubscribe() {
            emitter.off('frame', handler);
            subscribers -= 1;
            if (subscribers <= 0) {
                subscribers = 0;
                stop();
            }
        };
    }

    function getLastFrame() { return lastFrame; }

    return { subscribe, stop, getLastFrame };
}

module.exports = { createWebcam };
