try { require('dotenv').config(); } catch (_) { /* dotenv is optional; env vars from the shell still work */ }
const fs = require('fs');
const http = require('http');
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

// Effect actions are home-control commands meant to grab the user's
// attention. They wake the panel even while suppressed or tempDisabled —
// the controller holds the panel on for EFFECT_HOLD_MS so the user can
// see the notification, then normal priority takes over.
const EFFECT_WAKE_ACTIONS = new Set(['playVideo', 'showText', 'playAudio', 'refresh']);
const EFFECT_HOLD_MS = 60_000;

// Import server control functions
const {
  getUserBrightness,
  turnDisplayOn,
  turnDisplayOff,
  setBrightness,
  mapBrightnessToDisplay,
  setBrightnessStateAware,
  getActualState,
  emitter,
} = require('./Display');
const displayEmitter = emitter;

const { DisplayController } = require('./DisplayController');

const controller = new DisplayController({
  turnOn: turnDisplayOn,
  turnOff: turnDisplayOff,
  setBrightness,
  reportBacklight: (on /*, brightness */) => reportBacklightToHA(on),
  log: (msg) => console.log(`[display] ${msg}`),
  effectDefaultMs: EFFECT_HOLD_MS,
  getActualState,
  nightLight: {
    off: NIGHT_LIGHT_OFF,
    brightness: NIGHT_LIGHT_BRIGHTNESS,
    isActive: () => isNightLightActive(),
  },
});

// Native webcam streaming (replaces the old mjpg_streamer systemd unit).
// `display.webcam.enabled` gates whether the HTTP listener is bound;
// when false the camera process is never spawned.
const { createWebcam } = require('./Webcam');
const { createMicrophone } = require('./Microphone');
const { createStreamServer } = require('./StreamServer');

const webcamCfg = display.webcam || {};
const audioCfg = webcamCfg.audio || {};
const WEBCAM_CONFIGURED = !!webcamCfg.device || !!webcamCfg.enabled;
const WEBCAM_DEVICE = pickEnv('WEBCAM_DEVICE', webcamCfg.device, '/dev/video0');
const WEBCAM_WIDTH = pickEnv('WEBCAM_WIDTH', webcamCfg.width, 1280, { type: 'number' });
const WEBCAM_HEIGHT = pickEnv('WEBCAM_HEIGHT', webcamCfg.height, 720, { type: 'number' });
const WEBCAM_FRAMERATE = pickEnv('WEBCAM_FRAMERATE', webcamCfg.framerate, 30, { type: 'number' });
const WEBCAM_PORT = pickEnv('WEBCAM_PORT', webcamCfg.port, 8082, { type: 'number' });
const WEBCAM_CONTROLS = (webcamCfg.controls && typeof webcamCfg.controls === 'object') ? webcamCfg.controls : {};
const WEBCAM_TOKENS = Array.isArray(webcamCfg.tokens) ? webcamCfg.tokens.filter(Boolean) : [];
const WEBCAM_INITIAL_ENABLED = !!webcamCfg.enabled;

const AUDIO_ENABLED = !!audioCfg.enabled;
const AUDIO_DEVICE = pickEnv('WEBCAM_AUDIO_DEVICE', audioCfg.device, 'hw:1,0');
const AUDIO_RATE = pickEnv('WEBCAM_AUDIO_RATE', audioCfg.rate, 16000, { type: 'number' });
const AUDIO_CHANNELS = pickEnv('WEBCAM_AUDIO_CHANNELS', audioCfg.channels, 1, { type: 'number' });

let webcam = null;
let mic = null;
let streamServer = null;
let webcamEnabled = WEBCAM_INITIAL_ENABLED;

if (WEBCAM_CONFIGURED && os.platform() === 'linux') {
  webcam = createWebcam({
    device: WEBCAM_DEVICE,
    width: WEBCAM_WIDTH,
    height: WEBCAM_HEIGHT,
    framerate: WEBCAM_FRAMERATE,
    controls: WEBCAM_CONTROLS,
  });
  if (AUDIO_ENABLED) {
    mic = createMicrophone({ device: AUDIO_DEVICE, rate: AUDIO_RATE, channels: AUDIO_CHANNELS });
  }
  streamServer = createStreamServer({ webcam, mic, port: WEBCAM_PORT, tokens: WEBCAM_TOKENS });
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

let wasOnBattery = null; // null = unknown, true/false = last known state

const deviceId = pickEnv('DEVICE_ID', cfg.deviceId, '');
if (!deviceId) {
  console.error('ERROR: deviceId is required (set top-level deviceId in roboframe.config.json or DEVICE_ID env var)');
  process.exit(1);
}
console.log(`Device ID: "${deviceId}"`);

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
    // Seed HA's suppress switch with our current local state so the entity
    // appears (via auto-discovery on first publish) for every connected
    // display, even when the user has never toggled it.
    reportSuppressToHA(controller.snapshot().suppressWake);
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
      'setBrightnessStateAware',
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
        if (
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
          controller.setOverride(state ? 'on' : 'off');
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
        if (message.payload && typeof message.payload.brightness === 'number' && message.payload.target === deviceId) {
          const userValue = Number(message.payload.brightness);
          // HA / user just set a brightness — that's the value the
          // controller should restore on wake / night-light exit.
          controller.setDayBrightness(userValue);
          setBrightness(userValue, (error) => {
            if (error) console.error(`Error setting brightness: ${error.message}`);
          });
        }
        break;

      case 'setBrightnessStateAware':
        if (message.payload && typeof message.payload.brightness === 'number') {
          const userValue = Number(message.payload.brightness);
          setBrightnessStateAware(userValue, (error) => {
            if (error) console.error(`Error setting brightness state aware: ${error.message}`);
          });
        }
        break;

      case 'setSuppress':
        if (message.payload && message.payload.target === deviceId) {
          const raw = message.payload.state;
          const on = raw === true || raw === 'on' || raw === 'ON';
          const was = controller.snapshot().suppressWake;
          controller.setSuppressWake(on);
          if (was !== on) reportSuppressToHA(on);
        }
        break;

      default:
        if (EFFECT_WAKE_ACTIONS.has(message.action)) {
          console.log(`effect[${message.action}]: holding panel on for ${EFFECT_HOLD_MS}ms`);
          controller.startEffect();
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

    if (isOnBattery) {
      if (!wasOnBattery) console.log('Device is on battery.');
      controller.setTempDisabled(true);
    } else if (isCharging) {
      if (wasOnBattery) console.log('Device is charging.');
      controller.setTempDisabled(false);
    } else {
      controller.setTempDisabled(false);
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
      console.log('Screensaver started, releasing display control.');
      controller.setTempDisabled(false);
    } else if (message === 'screensaver_stopped') {
      console.log('Screensaver stopped, parking display control.');
      controller.setTempDisabled(true);
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
  // Mirror PIR presence onto the same `visibility` channel that the
  // browser kiosk page uses for scenePhase. The broker republishes this
  // to the HA motion binary_sensor and pauses peer clients' slideshows.
  if (deviceId && (state === 'motion' || state === 'clear')) {
    sendReport('visibility', { deviceId, visible: state === 'motion' });
  }
  if (state === 'motion') controller.setPir(true);
  else if (state === 'clear') controller.setPir(false);
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

controller.start();
connectWebSocket();

if (os.platform() === 'linux') {
  startPirHttpServer();
}

// Catch boundary transitions that happen without a PIR event — e.g. the
// window ends while the display is already on after a late-night wake.
// setBrightnessStateAware is a no-op when the panel is off, so an idle
// boundary tick won't accidentally drive the screen.
if (NIGHT_LIGHT_ENABLED) {
  controller.notifyNightLightChanged();
  let prevNight = isNightLightActive();
  setInterval(() => {
    const now = isNightLightActive();
    if (now === prevNight) return;
    prevNight = now;
    controller.notifyNightLightChanged();
  }, 60_000);
}

displayEmitter.on('alsStateChanged', (newState) => {
  // The broker republishes this to sensor.roboframe_<deviceId>_als so HA
  // can drive its own automation logic from ambient light readings.
  sendReport('reportSensor', { deviceId, sensor: 'als', value: newState });
});
