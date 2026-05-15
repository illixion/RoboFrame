// Unit tests for the MQTT bridge. We don't spin up a real broker — the
// `mqtt` module's exported `connect` returns an EventEmitter-shaped client,
// so we substitute a fake one and verify the publish/subscribe surface and
// the inbound command → broadcast routing.

const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('events');
const Module = require('module');

// Replace `require('mqtt')` with a stub that hands out a fake client we can
// drive directly. The bridge calls mqtt.connect(url, opts).
const originalResolve = Module._resolveFilename;
const originalLoad = Module._load;
const fakeClients = [];

function makeFakeClient() {
    const ee = new EventEmitter();
    ee.published = []; // [{topic, payload, options}]
    ee.subscribed = [];
    ee.publish = (topic, payload, options) => {
        ee.published.push({ topic, payload: typeof payload === 'string' ? payload : payload.toString(), options });
    };
    ee.subscribe = (topic, options, cb) => {
        ee.subscribed.push(topic);
        if (typeof cb === 'function') cb(null);
    };
    ee.end = () => {};
    return ee;
}

Module._load = function (request, parent, ...rest) {
    if (request === 'mqtt') {
        return {
            connect: () => {
                const c = makeFakeClient();
                fakeClients.push(c);
                return c;
            },
        };
    }
    return originalLoad.call(this, request, parent, ...rest);
};
const { createMqttBridge } = require('../lib/mqtt-bridge');
Module._resolveFilename = originalResolve;
Module._load = originalLoad;

function freshBridge({ broadcast } = {}) {
    fakeClients.length = 0;
    const broadcasts = [];
    const bridge = createMqttBridge({
        config: { url: 'mqtt://stub', topicPrefix: 'rf', discoveryPrefix: 'ha' },
        broadcast: broadcast || ((m) => broadcasts.push(m)),
    });
    const client = fakeClients[0];
    return { bridge, client, broadcasts };
}

function fireConnect(client) {
    client.emit('connect');
}

test('disabled bridge (empty url) is fully no-op', () => {
    const broadcasts = [];
    const bridge = createMqttBridge({
        config: { url: '' },
        broadcast: (m) => broadcasts.push(m),
    });
    assert.equal(bridge.enabled, false);
    bridge.publishLight('a', { state: 'on', brightness: 100 });
    bridge.publishMotion('a', true);
    bridge.publishSensor('a', 'als', 12);
    bridge.close();
    assert.equal(broadcasts.length, 0);
});

test('publishLight publishes discovery on first call, then state', () => {
    const { bridge, client } = freshBridge();
    fireConnect(client);
    bridge.publishLight('kiosk1', { state: 'on', brightness: 200 });
    const topics = client.published.map((p) => p.topic);
    assert.ok(topics.includes('ha/light/roboframe_kiosk1_backlight/config'),
        `expected discovery topic, got ${topics.join(',')}`);
    assert.ok(topics.includes('rf/light/kiosk1/backlight/state'));
    const state = client.published.find((p) => p.topic === 'rf/light/kiosk1/backlight/state');
    assert.equal(JSON.parse(state.payload).state, 'ON');
    assert.equal(JSON.parse(state.payload).brightness, 200);
});

test('publishMotion publishes ON / OFF after discovery', () => {
    const { bridge, client } = freshBridge();
    fireConnect(client);
    bridge.publishMotion('kiosk1', true);
    bridge.publishMotion('kiosk1', false);
    const states = client.published
        .filter((p) => p.topic === 'rf/binary_sensor/kiosk1/motion/state')
        .map((p) => p.payload);
    assert.deepEqual(states, ['ON', 'OFF']);
});

test('publishSensor("als") publishes a numeric reading', () => {
    const { bridge, client } = freshBridge();
    fireConnect(client);
    bridge.publishSensor('kiosk1', 'als', 4321);
    const sensor = client.published.find((p) => p.topic === 'rf/sensor/kiosk1/als/state');
    assert.ok(sensor, 'expected sensor state publish');
    assert.equal(sensor.payload, '4321');
});

test('publishWebcam emits switch discovery + state', () => {
    const { bridge, client } = freshBridge();
    fireConnect(client);
    bridge.publishWebcam('kiosk1', { state: 'on' });
    const cfg = client.published.find((p) => p.topic === 'ha/switch/roboframe_kiosk1_webcam/config');
    assert.ok(cfg, 'expected webcam discovery publish');
    const body = JSON.parse(cfg.payload);
    assert.equal(body.command_topic, 'rf/switch/kiosk1/webcam/set');
    assert.equal(body.state_topic, 'rf/switch/kiosk1/webcam/state');
    const state = client.published.find((p) => p.topic === 'rf/switch/kiosk1/webcam/state');
    assert.ok(state);
    assert.equal(state.payload, 'ON');
});

test('inbound webcam set broadcasts setWebcam action', () => {
    const broadcasts = [];
    const { client } = freshBridge({ broadcast: (m) => broadcasts.push(m) });
    fireConnect(client);
    client.emit('message', 'rf/switch/kiosk1/webcam/set', Buffer.from('OFF'));
    const msg = broadcasts.find((m) => m.action === 'setWebcam');
    assert.ok(msg, 'expected setWebcam broadcast');
    assert.equal(msg.payload.target, 'kiosk1');
    assert.equal(msg.payload.state, 'off');
});

test('messages buffered before connect are flushed on connect', () => {
    const { bridge, client } = freshBridge();
    bridge.publishLight('kiosk1', { state: 'off' });
    assert.equal(client.published.length, 0, 'should not publish before connect');
    fireConnect(client);
    const topics = client.published.map((p) => p.topic);
    assert.ok(topics.includes('rf/light/kiosk1/backlight/state'));
});

test('subscribed to light, rpc/cmd, and dismiss topics on connect', () => {
    const { client } = freshBridge();
    fireConnect(client);
    // mqtt.subscribe accepts an array; we record exactly what was passed.
    assert.deepEqual(client.subscribed[0], [
        'rf/light/+/backlight/set',
        'rf/switch/+/webcam/set',
        'rf/switch/+/suppress/set',
        'rf/cmd/dismiss',
        'rf/rpc/cmd',
    ]);
});

test('dismiss button discovery is published on connect', () => {
    const { client } = freshBridge();
    fireConnect(client);
    const cfg = client.published.find((p) => p.topic === 'ha/button/roboframe_dismiss/config');
    assert.ok(cfg, 'expected dismiss discovery publish');
    const body = JSON.parse(cfg.payload);
    assert.equal(body.command_topic, 'rf/cmd/dismiss');
    assert.equal(body.unique_id, 'roboframe_dismiss');
});

test('dismiss command broadcasts stopVideo + dismissText + stopAudio', () => {
    const broadcasts = [];
    const { client } = freshBridge({ broadcast: (m) => broadcasts.push(m) });
    fireConnect(client);
    client.emit('message', 'rf/cmd/dismiss', Buffer.from('PRESS'));
    const actions = broadcasts.map((m) => m.action);
    assert.deepEqual(actions, ['stopVideo', 'dismissText', 'stopAudio']);
});

test('rpc/cmd broadcasts the JSON {action, payload} verbatim', () => {
    const broadcasts = [];
    const { client } = freshBridge({ broadcast: (m) => broadcasts.push(m) });
    fireConnect(client);
    const body = { action: 'playVideo', payload: { url: 'https://example.com/v.mp4' } };
    client.emit('message', 'rf/rpc/cmd', Buffer.from(JSON.stringify(body)));
    assert.equal(broadcasts.length, 1);
    assert.equal(broadcasts[0].action, 'playVideo');
    assert.deepEqual(broadcasts[0].payload, { url: 'https://example.com/v.mp4' });
});

test('rpc/cmd ignores malformed JSON and missing action field', () => {
    const broadcasts = [];
    const { client } = freshBridge({ broadcast: (m) => broadcasts.push(m) });
    fireConnect(client);
    client.emit('message', 'rf/rpc/cmd', Buffer.from('{not json'));
    client.emit('message', 'rf/rpc/cmd', Buffer.from(JSON.stringify({ payload: { x: 1 } })));
    assert.equal(broadcasts.length, 0, 'malformed/missing-action messages should drop silently');
});

test('inbound command broadcasts setBrightness + displayState targeted by deviceId', () => {
    const broadcasts = [];
    const { client } = freshBridge({ broadcast: (m) => broadcasts.push(m) });
    fireConnect(client);
    client.emit('message', 'rf/light/kiosk1/backlight/set', Buffer.from(JSON.stringify({ state: 'ON', brightness: 180 })));
    const setBrightness = broadcasts.find((m) => m.action === 'setBrightness');
    const displayState = broadcasts.find((m) => m.action === 'displayState');
    assert.ok(setBrightness, 'expected setBrightness broadcast');
    assert.equal(setBrightness.payload.target, 'kiosk1');
    assert.equal(setBrightness.payload.brightness, 180);
    assert.ok(displayState);
    assert.equal(displayState.payload.target, 'kiosk1');
    assert.equal(displayState.payload.state, 'on');
});

test('inbound OFF for any deviceId broadcasts a displayState off frame', () => {
    const broadcasts = [];
    const { client } = freshBridge({ broadcast: (m) => broadcasts.push(m) });
    fireConnect(client);
    client.emit('message', 'rf/light/unknown/backlight/set', Buffer.from(JSON.stringify({ state: 'OFF' })));
    const displayState = broadcasts.find((m) => m.action === 'displayState');
    assert.ok(displayState, 'expected displayState broadcast');
    assert.equal(displayState.payload.target, 'unknown');
    assert.equal(displayState.payload.state, 'off');
});

test('discovery is re-published on reconnect', () => {
    const { bridge, client } = freshBridge();
    fireConnect(client);
    bridge.publishLight('kiosk1', { state: 'on' });
    const firstPublishCount = client.published.length;
    // simulate disconnect + reconnect
    client.emit('close');
    fireConnect(client);
    const discoveryTopics = client.published
        .slice(firstPublishCount)
        .map((p) => p.topic)
        .filter((t) => t.startsWith('ha/'));
    assert.ok(discoveryTopics.includes('ha/light/roboframe_kiosk1_backlight/config'),
        'expected discovery re-publish on reconnect');
});
