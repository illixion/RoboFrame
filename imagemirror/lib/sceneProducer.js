'use strict';

// Scene producer supervisor (`server.scenes`, disabled by default).
//
// A "scene" is an animation-heavy page rendered on this host — which has a
// real GPU and hardware H.264 encode — and published as WebRTC into a
// mediamtx instance (WHIP). Kiosks are told to show it via the `playScene`
// effect action and consume mediamtx's outputs: RTSP for the native kiosk
// (Pi-class hardware decode), WHEP for the web kiosk.
//
// This module only supervises the producer side: one Chromium per
// configured stream, loading /scenes/producer.html pointed at the effect
// page and the WHIP endpoint. mediamtx itself is deployed separately (see
// README); the producer page reconnects on its own if mediamtx restarts,
// and this supervisor respawns Chromium (with backoff) if the process dies.

const os = require('os');
const path = require('path');
const { spawn: nodeSpawn } = require('child_process');

const RESPAWN_MIN_MS = 2000;
const RESPAWN_MAX_MS = 60000;
// Uptime past this resets the backoff — the crash was not a crash loop.
const STABLE_MS = 60000;

function producerUrl({ producerBase, whipBase, stream }) {
  const params = new URLSearchParams({
    effect: stream.effect,
    whip: `${whipBase.replace(/\/$/, '')}/${stream.id}/whip`,
  });
  if (stream.fps) params.set('fps', String(stream.fps));
  if (stream.kbps) params.set('kbps', String(stream.kbps));
  if (stream.capture) params.set('capture', stream.capture);
  return `${producerBase.replace(/\/$/, '')}/scenes/producer.html?${params}`;
}

function chromiumArgs({ stream, url }) {
  return [
    `--user-data-dir=${path.join(os.tmpdir(), `roboframe-scene-${stream.id}`)}`,
    // Render at 1080p, not the display's retina scale — a dpr=2 canvas
    // quadruples the encode load and pushes VideoToolbox into software.
    '--force-device-scale-factor=1',
    '--autoplay-policy=no-user-gesture-required',
    // Auto-accept the tab-capture picker for capture=tab producers; there
    // is no user in front of this Chromium to click it.
    '--use-fake-ui-for-media-stream',
    '--auto-accept-this-tab-capture',
    '--no-first-run', '--no-default-browser-check',
    '--disable-session-crashed-bubble', '--noerrdialogs',
    '--new-window', url,
  ];
}

function createSceneProducer({
  enabled = false,
  chromiumPath = '',
  whipBase = 'http://127.0.0.1:8889',
  producerBase = 'http://127.0.0.1:3123',
  streams = [],
  spawn = nodeSpawn,
  log = console,
} = {}) {
  const running = new Map(); // stream id -> { proc, timer, backoff, startedAt }
  let closed = false;

  function launch(stream) {
    if (closed) return;
    const url = producerUrl({ producerBase, whipBase, stream });
    const proc = spawn(chromiumPath, chromiumArgs({ stream, url }),
                       { stdio: 'ignore' });
    const entry = running.get(stream.id) || { backoff: RESPAWN_MIN_MS };
    entry.proc = proc;
    entry.startedAt = Date.now();
    running.set(stream.id, entry);
    log.log(`[scenes] producer "${stream.id}" -> ${url}`);

    proc.on('error', (err) => {
      log.error(`[scenes] producer "${stream.id}" spawn failed: ${err.message}`);
      scheduleRespawn(stream, entry);
    });
    proc.on('exit', (code) => {
      if (closed) return;
      log.warn(`[scenes] producer "${stream.id}" exited (${code}), respawning in ${entry.backoff}ms`);
      scheduleRespawn(stream, entry);
    });
  }

  function scheduleRespawn(stream, entry) {
    if (closed || entry.timer) return;
    if (Date.now() - entry.startedAt > STABLE_MS) entry.backoff = RESPAWN_MIN_MS;
    entry.timer = setTimeout(() => {
      entry.timer = null;
      launch(stream);
    }, entry.backoff);
    entry.backoff = Math.min(entry.backoff * 2, RESPAWN_MAX_MS);
  }

  function start() {
    if (!enabled) return false;
    if (!chromiumPath) {
      log.warn('[scenes] enabled but scenes.chromiumPath is not set — producers not started');
      return false;
    }
    if (!streams.length) {
      log.warn('[scenes] enabled but scenes.streams is empty — nothing to produce');
      return false;
    }
    for (const stream of streams) {
      if (!stream.id || !stream.effect) {
        log.warn('[scenes] skipping stream without id/effect');
        continue;
      }
      launch(stream);
    }
    return true;
  }

  function close() {
    closed = true;
    for (const entry of running.values()) {
      if (entry.timer) clearTimeout(entry.timer);
      if (entry.proc && entry.proc.exitCode === null) {
        try { entry.proc.kill(); } catch { /* already gone */ }
      }
    }
    running.clear();
  }

  return { start, close, producerUrl: (stream) => producerUrl({ producerBase, whipBase, stream }) };
}

module.exports = { createSceneProducer, chromiumArgs };
