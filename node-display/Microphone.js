'use strict';
//
// ALSA capture, no native deps. Spawns `arecord` once when the first
// subscriber arrives and stops when the last one leaves; raw little-endian
// PCM bytes arrive on stdout with no container framing (`-t raw`), so the
// HTTP layer can relay them straight to a consumer that's told the format
// out of band (e.g. ffmpeg `-f s16le -ar <rate> -ac <channels>`).
//
// Audio is a continuous byte stream rather than discrete frames, so unlike
// the webcam there's no SOI/EOI scan — chunks are forwarded verbatim.

const { spawn } = require('child_process');
const { EventEmitter } = require('events');

function createMicrophone({ device = 'hw:1,0', rate = 16000, channels = 1, format = 'S16_LE' } = {}) {
    const emitter = new EventEmitter();
    emitter.setMaxListeners(0);

    let proc = null;
    let subscribers = 0;
    let stopping = false;
    let respawnTimer = null;

    function start() {
        if (proc) return;
        stopping = false;
        const args = ['-D', device, '-f', format, '-r', String(rate), '-c', String(channels), '-t', 'raw', '-'];
        console.log(`[mic] starting arecord ${args.join(' ')}`);
        proc = spawn('arecord', args, { stdio: ['ignore', 'pipe', 'pipe'] });
        proc.stdout.on('data', (chunk) => emitter.emit('audio', chunk));
        proc.stderr.on('data', (d) => {
            const s = d.toString().trim();
            // arecord prints the negotiated format to stderr on startup; only
            // surface it if it looks like an actual error.
            if (s && /error|fail|unavailable|busy/i.test(s)) console.warn(`[mic] arecord: ${s}`);
        });
        proc.on('error', (err) => {
            console.error(`[mic] spawn failed: ${err.message}`);
            emitter.emit('error', err);
        });
        proc.on('exit', (code, signal) => {
            console.log(`[mic] arecord exited code=${code} signal=${signal}`);
            proc = null;
            // A USB blip can make arecord exit with an I/O error mid-stream.
            // Respawn while clients are still attached so the audio feed
            // self-heals instead of going silent until the next reconnect.
            if (!stopping && subscribers > 0 && !respawnTimer) {
                respawnTimer = setTimeout(() => { respawnTimer = null; if (subscribers > 0) start(); }, 500);
            }
        });
    }

    function stop() {
        stopping = true;
        if (respawnTimer) { clearTimeout(respawnTimer); respawnTimer = null; }
        if (!proc) return;
        try { proc.kill('SIGTERM'); } catch (_) { /* ignore */ }
        proc = null;
    }

    function subscribe(handler) {
        emitter.on('audio', handler);
        subscribers += 1;
        if (subscribers === 1) start();
        return function unsubscribe() {
            emitter.off('audio', handler);
            subscribers -= 1;
            if (subscribers <= 0) {
                subscribers = 0;
                stop();
            }
        };
    }

    return { subscribe, stop, format: () => ({ rate, channels, format }) };
}

module.exports = { createMicrophone };
