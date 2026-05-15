try { require('dotenv').config(); } catch (_) { /* dotenv is optional; env vars from the shell still work */ }
const fs = require('fs');
const http = require('http');
const path = require('path');
const axios = require('axios');
const WebSocket = require('ws');
const os = require('os');
const { exec, spawn } = require('child_process');
const { loadConfig, pickEnv } = require('@roboframe/shared');

// Resolved from roboframe.config.json[display] with env-var overrides.
const cfg = loadConfig();
const display = cfg.display;
const WS_URL = pickEnv('WS_URL', display.wsUrl, 'ws://localhost:3123/rpc/ws');
const ACCESS_TOKEN = pickEnv('ACCESS_TOKEN', cfg.accessToken, '');
if (!ACCESS_TOKEN) {
  console.error('ERROR: ACCESS_TOKEN is required (set top-level accessToken in roboframe.config.json or ACCESS_TOKEN env var)');
  process.exit(1);
}
const WS_URL_WITH_TOKEN = (() => {
  const sep = WS_URL.includes('?') ? '&' : '?';
  return `${WS_URL}${sep}token=${encodeURIComponent(ACCESS_TOKEN)}`;
})();
const SCREEN_WATCHER_PATH = pickEnv('SCREEN_WATCHER_PATH', display.screenWatcherPath, '');
const PIR_HTTP_PORT = pickEnv('PIR_HTTP_PORT', display.pirHttp.port, 8765, { type: 'number' });

// Night light: when the local clock is inside [start, end), PIR wake
// applies this brightness instead of leaving the panel at whatever value
// HA last pushed. Times are "HH:MM" 24h; window may wrap past midnight.
const nightLight = display.nightLight || {};
const NIGHT_LIGHT_ENABLED = !!nightLight.enabled;
// brightness: null means "keep the display fully off during the window" —
// PIR motion will not wake it, and a boundary entry forces it off.
const NIGHT_LIGHT_OFF = nightLight.brightness === null;
const NIGHT_LIGHT_BRIGHTNESS = NIGHT_LIGHT_OFF ? null : clampUserBrightness(nightLight.brightness, 64);
const NIGHT_LIGHT_START_MIN = parseHHMM(nightLight.start, 0);
const NIGHT_LIGHT_END_MIN = parseHHMM(nightLight.end, 6 * 60);

function clampUserBrightness(v, fallback) {
  const n = Number(v);
  if (!Number.isFinite(n)) return fallback;
  return Math.max(0, Math.min(255, Math.round(n)));
}

function parseHHMM(s, fallback) {
  if (typeof s !== 'string') return fallback;
  const m = /^(\d{1,2}):(\d{2})$/.exec(s.trim());
  if (!m) return fallback;
  const h = Number(m[1]);
  const mm = Number(m[2]);
  if (h < 0 || h > 23 || mm < 0 || mm > 59) return fallback;
  return h * 60 + mm;
}

function isNightLightActive(now = new Date()) {
  if (!NIGHT_LIGHT_ENABLED) return false;
  if (NIGHT_LIGHT_START_MIN === NIGHT_LIGHT_END_MIN) return false;
  const cur = now.getHours() * 60 + now.getMinutes();
  // Wrap-around windows like 22:00 → 06:00 are matched as start..24h ∪ 0..end.
  if (NIGHT_LIGHT_START_MIN < NIGHT_LIGHT_END_MIN) {
    return cur >= NIGHT_LIGHT_START_MIN && cur < NIGHT_LIGHT_END_MIN;
  }
  return cur >= NIGHT_LIGHT_START_MIN || cur < NIGHT_LIGHT_END_MIN;
}

// Last brightness the user/HA asked for, used to restore on window exit.
// Updated only by externally-driven setBrightness commands; the night-light
// path explicitly does not touch it.
let dayBrightness = 255;
let nightLightApplied = false;

// ----- Wake suppressor registry --------------------------------------------
//
// A central gate for "should a PIR motion event wake the panel?". Each entry
// has a name (for logging), a reason, and a `forceOff` flag: when set, motion
// during suppression actively drives the panel off instead of merely ignoring
// the event.
//
// An explicit `displayState` from MQTT/HA always bypasses suppressors — the
// user pressed a button, honour it. The same command lifts the
// `night-light-off` suppressor for the remainder of the window so subsequent
// PIR pulses don't fight HA's choice.
const suppressors = new Map();

function setSuppressor(name, info) {
  const prev = suppressors.get(name);
  suppressors.set(name, info);
  if (!prev) console.log(`suppress[+${name}]: ${info.reason}`);
}

function clearSuppressor(name) {
  if (suppressors.delete(name)) console.log(`suppress[-${name}]`);
}

function suppressionState() {
  if (suppressors.size === 0) return null;
  const entries = [...suppressors.values()];
  return {
    forceOff: entries.some(s => s.forceOff),
    names: [...suppressors.keys()],
    reasons: entries.map(s => s.reason),
  };
}

// The `mqtt-switch` suppressor is the only one driven by the user. We mirror
// its state to a HA switch entity via `reportSuppress`. Other suppressors
// (primary-peer, night-light-off) are internal and don't surface.
function setMqttSuppress(on) {
  const was = suppressors.has('mqtt-switch');
  if (on) setSuppressor('mqtt-switch', { reason: 'HA suppress switch is on', forceOff: true });
  else clearSuppressor('mqtt-switch');
  if (was !== !!on) reportSuppressToHA(!!on);
}

// Effect actions are home-control commands meant to grab the user's
// attention. They always wake the panel, regardless of suppressors —
// the suppress switch only gates ambient/PIR wake, not explicit commands.
const EFFECT_WAKE_ACTIONS = new Set(['playVideo', 'showText', 'playAudio', 'refresh']);

// Import server control functions
const {
  getUserBrightness,
  turnDisplayOn,
  turnDisplayOff,
  setBrightness,
  mapBrightnessToDisplay,
  setBrightnessStateAware,
  emitter,
} = require('./Display');
const displayEmitter = emitter;

// Native webcam streaming (replaces the old mjpg_streamer systemd unit).
// `display.webcam.enabled` gates whether the HTTP listener is bound;
// when false the camera process is never spawned.
const { createWebcam } = require('./Webcam');
const { createStreamServer } = require('./StreamServer');

const webcamCfg = display.webcam || {};
const WEBCAM_CONFIGURED = !!webcamCfg.device || !!webcamCfg.enabled;
const WEBCAM_DEVICE = pickEnv('WEBCAM_DEVICE', webcamCfg.device, '/dev/video0');
const WEBCAM_WIDTH = pickEnv('WEBCAM_WIDTH', webcamCfg.width, 1280, { type: 'number' });
const WEBCAM_HEIGHT = pickEnv('WEBCAM_HEIGHT', webcamCfg.height, 720, { type: 'number' });
const WEBCAM_FRAMERATE = pickEnv('WEBCAM_FRAMERATE', webcamCfg.framerate, 30, { type: 'number' });
const WEBCAM_PORT = pickEnv('WEBCAM_PORT', webcamCfg.port, 8082, { type: 'number' });
const WEBCAM_INITIAL_ENABLED = !!webcamCfg.enabled;

let webcam = null;
let streamServer = null;
let webcamEnabled = WEBCAM_INITIAL_ENABLED;

if (WEBCAM_CONFIGURED && os.platform() === 'linux') {
  webcam = createWebcam({
    device: WEBCAM_DEVICE,
    width: WEBCAM_WIDTH,
    height: WEBCAM_HEIGHT,
    framerate: WEBCAM_FRAMERATE,
  });
  streamServer = createStreamServer({ webcam, port: WEBCAM_PORT });
  if (webcamEnabled) streamServer.start();
}

function setWebcamEnabled(enabled) {
  if (!streamServer) return;
  webcamEnabled = !!enabled;
  streamServer.setEnabled(webcamEnabled);
  reportWebcamToHA(webcamEnabled);
}

function reportWebcamToHA(enabled) {
  if (!deviceId || !streamServer) return;
  sendReport('reportWebcam', { deviceId, state: enabled ? 'on' : 'off' });
}

let ws;
let pingInterval;
let pongTimeout;
let isReconnecting = false;

let tempDisable = false;
let wasOnBattery = null; // null = unknown, true/false = last known state

// load device ID from file
const deviceIdFilePath = path.join(__dirname, 'id');
let deviceId;
try {
  deviceId = fs.readFileSync(deviceIdFilePath, 'utf8').trim();
}
catch (err) {
  console.error(`Error reading device ID from file: ${err.message}`);
}

console.log(`Device ID: "${deviceId}"`);

// Peers we've heard from via `displayState`. A `<deviceId>_primary` peer
// owns waking the panel for this display; while one is connected we install
// a suppressor so local PIR motion doesn't fight it.
const knownPeers = new Set();

function primaryPeerId() { return deviceId ? `${deviceId}_primary` : null; }

function syncPrimarySuppressor() {
  const pid = primaryPeerId();
  if (pid && knownPeers.has(pid)) {
    setSuppressor('primary-peer', { reason: `${pid} is connected`, forceOff: false });
  } else {
    clearSuppressor('primary-peer');
  }
}

function connectWebSocket() {
  if (isReconnecting) return;
  if (ws && ws.readyState === WebSocket.OPEN) {
    return;
  }
  isReconnecting = true;


  console.log(`Attempting to connect to ${WS_URL}...`);
  ws = new WebSocket(WS_URL_WITH_TOKEN);

  ws.on('open', () => {
    console.log('Connected to WebSocket server');
    isReconnecting = false;
    startHeartbeat();
    // Drop stale peers learned in the previous session — they may have
    // disconnected while we were offline. The broker replays cached
    // `displayState` frames shortly after connect, repopulating this.
    knownPeers.clear();
    syncPrimarySuppressor();
    // Seed HA's suppress switch with our current local state so the entity
    // appears (via auto-discovery on first publish) for every connected
    // display, even when the user has never toggled it.
    reportSuppressToHA(suppressors.has('mqtt-switch'));
    if (streamServer) reportWebcamToHA(webcamEnabled);
  });

  ws.on('message', (event) => {
    let message;
    try {
      // Parse message, handle both string and Buffer
      if (typeof event === 'string') {
        message = JSON.parse(event);
      } else {
        message = JSON.parse(event.toString());
      }
    } catch (err) {
      console.error('Failed to parse WebSocket message:', err);
      return;
    }

    // Only log actions node-display actually handles. The broker fans out
    // many slideshow-related frames (playback, tagLists, blockedIds,
    // displaySync, ...) that this daemon ignores; logging them is noise.
    const HANDLED = new Set([
      'displayState', 'setWebcam', 'setBrightness',
      'setBrightnessStateAware', 'displayDisconnect',
      'setSuppress', ...EFFECT_WAKE_ACTIONS,
    ]);
    if (HANDLED.has(message.action)) {
      console.log('Received message of type:', message.action + ' with payload:', message.payload);
    }

    switch (message.action) {
      case 'pong':
        clearTimeout(pongTimeout);
        break;
      case 'displayState':
        if (message.payload?.target) {
          knownPeers.add(message.payload.target);
          syncPrimarySuppressor();
        }
        if (
          !tempDisable &&
          message.payload &&
          (typeof message.payload.state === 'boolean' || typeof message.payload.state === 'string') &&
          message.payload.target === deviceId
        ) {
          let state;
          if (typeof message.payload.state === 'boolean') {
            state = message.payload.state;
          } else if (typeof message.payload.state === 'string') {
            state = message.payload.state.toLowerCase() === 'on';
          }
          // Explicit HA command wins. While the night-light-off window is
          // active, an "on" lifts the suppressor (so subsequent PIR pulses
          // don't undo it); an "off" reinstates it.
          if (state) clearSuppressor('night-light-off');
          else if (NIGHT_LIGHT_OFF && isNightLightActive()) {
            setSuppressor('night-light-off', { reason: 'night light window (off mode)', forceOff: true });
          }
          (state ? turnDisplayOn : turnDisplayOff)((error) => {
            if (error) {
              console.error(`Error turning display ${state ? 'on' : 'off'}: ${error.message}`);
              return;
            }
            reportBacklightToHA(state);
          });
        }
        break;

      case 'setWebcam':
        if (message.payload && message.payload.target === deviceId) {
          const wantOn = message.payload.state === true
            || message.payload.state === 'on'
            || message.payload.state === 'ON';
          setWebcamEnabled(wantOn);
        }
        break;

      case 'setBrightness':
        if (!tempDisable && message.payload && typeof message.payload.brightness === 'number' && message.payload.target === deviceId) {
          const userValue = Number(message.payload.brightness);
          // HA / user just set a brightness — that's the value we want to
          // restore once the night-light window ends.
          dayBrightness = clampUserBrightness(userValue, dayBrightness);
          nightLightApplied = false;
          setBrightness(userValue, (error) => {
            if (error) console.error(`Error setting brightness: ${error.message}`);
          });
        }
        break;

      case 'setBrightnessStateAware':
        if (!tempDisable && message.payload && typeof message.payload.brightness === 'number') {
          const userValue = Number(message.payload.brightness);
          setBrightnessStateAware(userValue, (error) => {
            if (error) console.error(`Error setting brightness state aware: ${error.message}`);
          });
        }
        break;

      case 'displayDisconnect':
        if (message.payload?.target) {
          knownPeers.delete(message.payload.target);
          syncPrimarySuppressor();
        }
        break;

      case 'setSuppress':
        if (message.payload && message.payload.target === deviceId) {
          const raw = message.payload.state;
          const on = raw === true || raw === 'on' || raw === 'ON';
          setMqttSuppress(on);
          // Engaging the switch should make the current state match
          // immediately — otherwise the user sees the toggle flip in HA
          // but the panel only goes off on the next PIR clear.
          if (on && !tempDisable) {
            turnDisplayOff((err) => {
              if (err) console.error(`Error force-off on setSuppress: ${err.message}`);
            });
          }
        }
        break;

      default:
        if (EFFECT_WAKE_ACTIONS.has(message.action) && !tempDisable) {
          // Home-control commands override suppressors. They don't *clear*
          // the suppressor — once the effect ends, ambient PIR is still
          // gated — they just punch through this one wake.
          console.log(`effect[${message.action}]: bypassing suppressors, waking panel`);
          turnDisplayOn((err) => {
            if (err) return console.error(`Error waking on ${message.action}: ${err.message}`);
            reportBacklightToHA(true);
          });
        }
        break;
    }
  });

  ws.on('close', () => {
    console.log('Disconnected from server.');
    scheduleReconnect();
  });

  ws.on('error', (error) => {
    console.error('WebSocket error:', error.message);
    ws.terminate(); // force close
    scheduleReconnect();
  });

  ws.on('ping', () => {
    ws.pong();
  });
}

const RECONNECT_INTERVAL_MS = 5000;

function scheduleReconnect() {
  if (isReconnecting) return;
  isReconnecting = true;
  stopHeartbeat();
  console.error(`WebSocket disconnected. Reconnecting in ${RECONNECT_INTERVAL_MS}ms...`);
  setTimeout(() => {
    isReconnecting = false;
    connectWebSocket();
  }, RECONNECT_INTERVAL_MS);
}

function startHeartbeat() {
  stopHeartbeat();
  pingInterval = setInterval(() => {
    if (ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify({ action: 'ping' }));
      pongTimeout = setTimeout(() => {
        console.log('No pong received. Reconnecting...');
        ws.terminate(); // triggers 'close', which triggers reconnect
      }, 5000);
    }
  }, 10000);
}

function stopHeartbeat() {
  if (pingInterval) { clearInterval(pingInterval); pingInterval = null; }
  if (pongTimeout) { clearTimeout(pongTimeout); pongTimeout = null; }
}

// Additional features
function checkBatteryStatus() {
  if (os.platform() !== 'darwin') return; // only needed on macOS

  exec('pmset -g batt', (error, stdout) => {
    if (error) {
      console.error(`Error checking battery status: ${error.message}`);
      return;
    }

    const isCharging = stdout.includes('AC Power');
    const isOnBattery = stdout.includes('Battery Power') && !isCharging;

    // Only act when we transition from not-on-battery -> on-battery.
    if (isOnBattery) {
      if (!wasOnBattery) {
        console.log('Device is on battery.');
        tempDisable = true;
        turnDisplayOff((error) => {
          if (error) {
            console.error(`Error turning display off due to battery: ${error.message}`);
          }
        });
      } // else: already on battery, don't re-trigger
    } else if (isCharging) {
      if (wasOnBattery) {
        console.log('Device is charging.');
      }
      tempDisable = false;
    } else {
      // Not obviously on battery or charging; clear tempDisable just in case.
      tempDisable = false;
    }

    // Remember last seen state so we only act on transitions.
    wasOnBattery = isOnBattery;
  });
}

function adjustBrightnessBasedOnTime() {
  const now = new Date();
  const hours = now.getHours();

  if (hours >= 0 && hours < 8) {
    const brightness = 64; // 25% of 255
    setBrightnessStateAware(brightness, (error) => {
      if (error) {
        console.error(`Error setting brightness to 25%: ${error.message}`);
      } else {
        console.log('Brightness set to 25% (00:00 - 08:00)');
      }
    });
  }
}

// Periodically check battery status and adjust brightness
setInterval(checkBatteryStatus, 60000); // Check every minute
setInterval(adjustBrightnessBasedOnTime, 60000); // Check every minute

if (os.platform() === 'darwin' && SCREEN_WATCHER_PATH && fs.existsSync(SCREEN_WATCHER_PATH)) { // Only run watcher on macOS
  // Watch for screensaver events, should disconnect the WebSocket when it's not active
  console.log('Starting screensaver watcher...');
  const watcher = spawn(SCREEN_WATCHER_PATH);

  watcher.stdout.on('data', (data) => {
    const message = data.toString().trim();
    console.log('Received event:', message);

    if (message === 'screensaver_started') {
      // handle screensaver start
      console.log('Screensaver started, disabling display control.');
      tempDisable = false;
    } else if (message === 'screensaver_stopped') {
      // handle screensaver stop
      console.log('Screensaver stopped, enabling display control.');
      tempDisable = true;
    }
  });

  watcher.stderr.on('data', (data) => {
    console.error(`watcher stderr: ${data}`);
  });

  watcher.on('close', (code) => {
    console.log(`watcher process exited with code ${code}`);
  });
}

// Send a state report to the broker. The broker republishes to MQTT so
// Home Assistant's auto-discovered light/sensor entities reflect what the
// kiosk is actually doing.
function sendReport(action, payload) {
  if (!ws || ws.readyState !== WebSocket.OPEN) return;
  ws.send(JSON.stringify({ action, payload }));
}

// Report local backlight on/off back upstream. The broker publishes to the
// `light.roboframe_<deviceId>_backlight` state topic so HA reflects the
// current state. Brightness is included when known so HA's slider tracks it.
function reportBacklightToHA(on) {
  if (!deviceId) return;
  getUserBrightness((err, brightness) => {
    sendReport('reportDisplay', {
      deviceId,
      state: on ? 'on' : 'off',
      brightness: !err && typeof brightness === 'number' ? brightness : undefined,
    });
  });
}

function reportSuppressToHA(on) {
  if (!deviceId) return;
  sendReport('reportSuppress', { deviceId, state: on ? 'on' : 'off' });
}

// Local HTTP listener for an on-device PIR agent (e.g. a small script wired to a GPIO).
// Posts to /pir/motion turn the display on; /pir/clear turns it off. Both paths
// also push the new state up to HA via reportBacklightToHA.
function handlePirEvent(state) {
  if (tempDisable) return;
  // Mirror PIR presence onto the same `visibility` channel that the
  // browser kiosk page uses for scenePhase. The broker republishes this
  // to the HA motion binary_sensor and pauses peer clients' slideshows.
  if (deviceId && (state === 'motion' || state === 'clear')) {
    sendReport('visibility', { deviceId, visible: state === 'motion' });
  }
  if (state === 'motion') {
    const sup = suppressionState();
    if (sup) {
      console.log(`PIR webhook: motion suppressed by [${sup.names.join(', ')}] — ${sup.reasons.join('; ')}`);
      if (sup.forceOff) {
        // Force off silently — no HA report, so the kiosk's light entity
        // keeps whatever state HA last set rather than flapping on every PIR.
        turnDisplayOff((err) => {
          if (err) console.error(`Error keeping display off (suppressed): ${err.message}`);
        });
      }
      return;
    }
    const night = isNightLightActive();
    const target = night ? NIGHT_LIGHT_BRIGHTNESS : (nightLightApplied ? dayBrightness : null);
    if (night) nightLightApplied = true;
    else if (target !== null) nightLightApplied = false;
    console.log(`PIR webhook: motion -> display on${
      night ? ` (night light ${NIGHT_LIGHT_BRIGHTNESS}/255)`
            : (target !== null ? ` (restoring day ${target}/255)` : '')}`);
    // setBrightness while the panel is off only stashes lastOnBrightness on
    // the Pi backend, so the value is applied via DDC the moment turnOn
    // re-enables the output.
    const proceed = () => turnDisplayOn((err) => {
      if (err) return console.error(`Error turning display on (PIR): ${err.message}`);
      reportBacklightToHA(true);
    });
    if (target !== null) {
      setBrightness(target, (err) => {
        if (err) console.error(`Error setting wake brightness: ${err.message}`);
        proceed();
      });
    } else {
      proceed();
    }
  } else if (state === 'clear') {
    console.log('PIR webhook: clear -> display off');
    turnDisplayOff((err) => {
      if (err) return console.error(`Error turning display off (PIR): ${err.message}`);
      reportBacklightToHA(false);
    });
  }
}

function startPirHttpServer() {
  const server = http.createServer((req, res) => {
    if (req.method !== 'POST') {
      res.writeHead(405); return res.end();
    }
    let body = '';
    req.on('data', (chunk) => {
      body += chunk;
      if (body.length > 4096) { req.destroy(); }
    });
    req.on('end', () => {
      let state = null;
      if (req.url === '/pir/motion') state = 'motion';
      else if (req.url === '/pir/clear') state = 'clear';
      else { res.writeHead(404); return res.end(); }

      // Body is optional; if present and JSON with .state, prefer that.
      if (body) {
        try {
          const parsed = JSON.parse(body);
          if (parsed && typeof parsed.state === 'string') state = parsed.state;
        } catch (_) { /* ignore, use URL-derived state */ }
      }
      handlePirEvent(state);
      res.writeHead(204);
      res.end();
    });
  });
  server.on('error', (err) => {
    console.error(`PIR HTTP server error: ${err.message}`);
  });
  server.listen(PIR_HTTP_PORT, '127.0.0.1', () => {
    console.log(`PIR HTTP listener on http://127.0.0.1:${PIR_HTTP_PORT}`);
  });
}

connectWebSocket();

if (os.platform() === 'linux') {
  startPirHttpServer();
}

// Catch boundary transitions that happen without a PIR event — e.g. the
// window ends while the display is already on after a late-night wake.
// setBrightnessStateAware is a no-op when the panel is off, so an idle
// boundary tick won't accidentally drive the screen.
if (NIGHT_LIGHT_ENABLED) {
  // Seed the suppressor if we boot up inside the window.
  if (NIGHT_LIGHT_OFF && isNightLightActive()) {
    setSuppressor('night-light-off', { reason: 'night light window (off mode)', forceOff: true });
    nightLightApplied = true;
  }
  let prevNight = isNightLightActive();
  setInterval(() => {
    const now = isNightLightActive();
    if (now === prevNight) return;
    prevNight = now;
    if (now) {
      nightLightApplied = true;
      if (NIGHT_LIGHT_OFF) {
        setSuppressor('night-light-off', { reason: 'night light window (off mode)', forceOff: true });
        // Silent off — don't report to HA so the light entity's state is
        // preserved and HA can still drive an explicit displayState=on.
        turnDisplayOff((err) => {
          if (err) console.error(`night-light enter (off) failed: ${err.message}`);
        });
      } else {
        setBrightnessStateAware(NIGHT_LIGHT_BRIGHTNESS, (err) => {
          if (err) console.error(`night-light enter failed: ${err.message}`);
        });
      }
    } else if (nightLightApplied) {
      clearSuppressor('night-light-off');
      nightLightApplied = false;
      setBrightnessStateAware(dayBrightness, (err) => {
        if (err) console.error(`night-light exit failed: ${err.message}`);
      });
    }
  }, 60_000);
}

displayEmitter.on('alsStateChanged', (newState) => {
  // The broker republishes this to sensor.roboframe_<deviceId>_als so HA
  // can drive its own automation logic from ambient light readings.
  sendReport('reportSensor', { deviceId, sensor: 'als', value: newState });
});
