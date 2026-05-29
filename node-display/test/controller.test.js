'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { DisplayController } = require('../DisplayController');

function makeHarness(opts = {}) {
  const log = [];
  let now = 1_000_000;
  const timers = [];
  let nlActive = false;
  const advance = (ms) => {
    now += ms;
    for (const t of [...timers]) {
      if (t.fireAt <= now && !t.cancelled) {
        t.cancelled = true;
        t.fn();
      }
    }
  };
  const ctl = new DisplayController({
    turnOn: (cb) => { log.push('on'); cb && cb(); },
    turnOff: (cb) => { log.push('off'); cb && cb(); },
    setBrightness: (v, cb) => { log.push(`b=${v}`); cb && cb(); },
    reportBacklight: (on) => log.push(`report=${on ? 'on' : 'off'}`),
    log: () => {},
    now: () => now,
    setTimeoutFn: (fn, ms) => {
      const t = { fn, fireAt: now + ms, cancelled: false };
      timers.push(t);
      return t;
    },
    clearTimeoutFn: (t) => { if (t) t.cancelled = true; },
    nightLight: {
      off: !!opts.nightLightOff,
      brightness: opts.nightLightBrightness ?? null,
      isActive: () => nlActive,
    },
    initialDayBrightness: 200,
    effectDefaultMs: 60_000,
  });
  return {
    ctl, log,
    advance,
    setNight: (v) => { nlActive = v; ctl.notifyNightLightChanged(); },
  };
}

test('PIR motion wakes display', () => {
  const { ctl, log } = makeHarness();
  ctl.setPir(true);
  assert.deepEqual(log, ['b=200', 'on', 'report=on']);
});

test('suppressWake gates PIR wake', () => {
  const { ctl, log } = makeHarness();
  ctl.setSuppressWake(true);
  ctl.setPir(true);
  assert.equal(log.includes('on'), false);
});

test('toggling suppressWake off with PIR latched true wakes display (the bug)', () => {
  const { ctl, log } = makeHarness();
  ctl.setSuppressWake(true);
  ctl.setPir(true);
  log.length = 0;
  ctl.setSuppressWake(false);
  assert.deepEqual(log, ['b=200', 'on', 'report=on']);
});

test('HA override on while suppressed wakes; subsequent PIR edge clears override', () => {
  const { ctl, log } = makeHarness();
  ctl.setSuppressWake(true);
  ctl.setOverride('on');
  assert.equal(log.includes('on'), true);
  // override-on reason is not in REPORTING_REASONS — silent to HA.
  assert.equal(log.includes('report=on'), false);
  log.length = 0;
  // PIR motion arrives — override should clear; suppress still on so panel goes off.
  ctl.setPir(true);
  assert.equal(ctl.snapshot().override, null);
  assert.equal(log.includes('off'), true);
});

test('effect punches through suppress AND tempDisabled, holds for duration', () => {
  const { ctl, log, advance } = makeHarness();
  ctl.setSuppressWake(true);
  ctl.setTempDisabled(true);
  log.length = 0;
  ctl.startEffect(5000);
  assert.equal(log.includes('on'), true);
  log.length = 0;
  advance(5001);
  assert.equal(log.includes('off'), true);
});

test('night-light-off forces panel off; exit while PIR latched wakes', () => {
  const h = makeHarness({ nightLightOff: true });
  h.ctl.setPir(true);
  h.log.length = 0;
  h.setNight(true);
  assert.equal(h.log.includes('off'), true);
  h.log.length = 0;
  h.setNight(false);
  assert.equal(h.log.includes('on'), true);
});

test('night-light dim brightness applied on wake during window', () => {
  const h = makeHarness({ nightLightBrightness: 32 });
  h.setNight(true);
  h.log.length = 0;
  h.ctl.setPir(true);
  assert.deepEqual(h.log, ['b=32', 'on', 'report=on']);
});

test('idempotent: repeated identical inputs do not re-drive platform', () => {
  const { ctl, log } = makeHarness();
  ctl.setPir(true);
  log.length = 0;
  ctl.setPir(true);
  ctl.setSuppressWake(false);
  assert.deepEqual(log, []);
});

test('tempDisabled forces off but does not consume override', () => {
  const { ctl, log } = makeHarness();
  ctl.setOverride('on');
  log.length = 0;
  ctl.setTempDisabled(true);
  assert.equal(log.includes('off'), true);
  log.length = 0;
  ctl.setTempDisabled(false);
  assert.equal(log.includes('on'), true);
  assert.equal(ctl.snapshot().override, 'on');
});

test('PIR clear edge clears outstanding override', () => {
  const { ctl } = makeHarness();
  ctl.setPir(true);
  ctl.setOverride('off');
  ctl.setPir(false);
  assert.equal(ctl.snapshot().override, null);
});
