'use strict';
//
// DisplayController — a single, idempotent state machine for the panel.
//
// Inputs are *facts*, not actions. Each setter updates a latched value and
// calls evaluate(), which computes the one target state and reconciles it
// against the platform. Spurious re-evaluations are free.
//
// Priority (highest wins):
//   1. effect.active           -> ON   (notifications punch through, even on battery)
//   2. tempDisabled            -> OFF
//   3. override === 'off'      -> OFF  (HA explicit; cleared on next PIR edge)
//   4. override === 'on'       -> ON   (HA explicit; cleared on next PIR edge)
//   5. nightLight.off active   -> OFF
//   6. pirMotion && !suppress  -> ON
//   7. otherwise               -> OFF
//
// Reporting back to HA mirrors the previous behaviour: PIR- and effect-driven
// transitions report (HA's light entity follows the panel), HA-originated
// transitions (override, suppress, night-light) stay silent so the entity
// doesn't echo its own command back.

const REPORTING_REASONS = new Set(['pir', 'pir+nightLight', 'idle', 'effect']);

// Exponential backoff for failed turnOn/turnOff calls. Capped so we don't
// hammer DDC/xrandr forever on a broken bus, but reconcile() can still
// nudge it back to truth periodically once the cap is reached.
const RETRY_BACKOFF_MS = [1_000, 2_000, 4_000, 8_000, 16_000];
const RECONCILE_INTERVAL_MS = 60_000;

class DisplayController {
  constructor(opts) {
    this.turnOn = opts.turnOn;
    this.turnOff = opts.turnOff;
    this.setBrightness = opts.setBrightness;
    this.reportBacklight = opts.reportBacklight || (() => {});
    this.log = opts.log || (() => {});
    this.now = opts.now || (() => Date.now());
    this.setTimeoutFn = opts.setTimeoutFn || setTimeout;
    this.clearTimeoutFn = opts.clearTimeoutFn || clearTimeout;
    this.nightLight = opts.nightLight || { off: false, brightness: null, isActive: () => false };
    this.dayBrightness = opts.initialDayBrightness != null ? opts.initialDayBrightness : 255;
    this.effectDefaultMs = opts.effectDefaultMs != null ? opts.effectDefaultMs : 60_000;
    this.getActualState = opts.getActualState || null; // (cb(err, isOn)) optional
    this.setIntervalFn = opts.setIntervalFn || setInterval;
    this.clearIntervalFn = opts.clearIntervalFn || clearInterval;
    this.reconcileIntervalMs = opts.reconcileIntervalMs != null ? opts.reconcileIntervalMs : RECONCILE_INTERVAL_MS;

    this.pirMotion = false;
    this.suppressWake = false;
    this.override = null;        // 'on' | 'off' | null
    this.effectDeadline = 0;
    this.tempDisabled = false;

    this.lastApplied = null;     // 'on' | 'off' — only set after a confirmed-good platform call
    this.lastBrightness = null;
    this.effectTimer = null;
    this.retryAttempt = 0;
    this.retryTimer = null;
    this.inFlight = false;
    this.reconcileTimer = null;
  }

  start() {
    if (this.reconcileTimer || !this.getActualState) return;
    this.reconcileTimer = this.setIntervalFn(() => this.reconcile(), this.reconcileIntervalMs);
  }

  stop() {
    if (this.reconcileTimer) { this.clearIntervalFn(this.reconcileTimer); this.reconcileTimer = null; }
    if (this.retryTimer) { this.clearTimeoutFn(this.retryTimer); this.retryTimer = null; }
    if (this.effectTimer) { this.clearTimeoutFn(this.effectTimer); this.effectTimer = null; }
  }

  setPir(motion) {
    const v = !!motion;
    if (this.pirMotion === v) return;
    this.pirMotion = v;
    // Per design: any PIR edge clears an outstanding explicit override.
    if (this.override !== null) {
      this.log(`override cleared by PIR ${v ? 'motion' : 'clear'}`);
      this.override = null;
    }
    this.evaluate(`pir:${v ? 'motion' : 'clear'}`);
  }

  setSuppressWake(on) {
    const v = !!on;
    if (this.suppressWake === v) return;
    this.suppressWake = v;
    this.evaluate(`suppress:${v ? 'on' : 'off'}`);
  }

  setOverride(state) {
    if (state !== 'on' && state !== 'off') return;
    this.override = state;
    this.evaluate(`override:${state}`);
  }

  startEffect(durationMs) {
    const ms = Number.isFinite(durationMs) && durationMs > 0 ? durationMs : this.effectDefaultMs;
    this.effectDeadline = this.now() + ms;
    if (this.effectTimer) this.clearTimeoutFn(this.effectTimer);
    this.effectTimer = this.setTimeoutFn(() => {
      this.effectTimer = null;
      this.effectDeadline = 0;
      this.evaluate('effect:expire');
    }, ms);
    this.evaluate('effect:start');
  }

  endEffect() {
    if (this.effectTimer) { this.clearTimeoutFn(this.effectTimer); this.effectTimer = null; }
    if (this.effectDeadline === 0) return;
    this.effectDeadline = 0;
    this.evaluate('effect:end');
  }

  setTempDisabled(on) {
    const v = !!on;
    if (this.tempDisabled === v) return;
    this.tempDisabled = v;
    this.evaluate(`tempDisabled:${v}`);
  }

  notifyNightLightChanged() {
    this.evaluate('nightLight:boundary');
  }

  setDayBrightness(value) {
    const n = Number(value);
    if (!Number.isFinite(n)) return;
    this.dayBrightness = Math.max(0, Math.min(255, Math.round(n)));
    // If panel is on and not under nightLight, push the new brightness.
    if (this.lastApplied === 'on') this.evaluate('dayBrightness');
  }

  effectActive() {
    return this.effectDeadline > 0 && this.now() < this.effectDeadline;
  }

  // Exposed for tests / introspection.
  snapshot() {
    return {
      pirMotion: this.pirMotion,
      suppressWake: this.suppressWake,
      override: this.override,
      effectActive: this.effectActive(),
      tempDisabled: this.tempDisabled,
      lastApplied: this.lastApplied,
      lastBrightness: this.lastBrightness,
    };
  }

  computeTarget() {
    const nlActive = this.nightLight.isActive();
    const wakeBrightness = (nlActive && this.nightLight.brightness !== null)
      ? this.nightLight.brightness
      : this.dayBrightness;

    if (this.effectActive()) return { state: 'on', brightness: wakeBrightness, reason: 'effect' };
    if (this.tempDisabled) return { state: 'off', brightness: null, reason: 'tempDisabled' };
    if (this.override === 'off') return { state: 'off', brightness: null, reason: 'override-off' };
    if (this.override === 'on') return { state: 'on', brightness: wakeBrightness, reason: 'override-on' };
    if (nlActive && this.nightLight.off) return { state: 'off', brightness: null, reason: 'night-light-off' };
    if (this.pirMotion && !this.suppressWake) {
      return { state: 'on', brightness: wakeBrightness, reason: nlActive ? 'pir+nightLight' : 'pir' };
    }
    return { state: 'off', brightness: null, reason: this.suppressWake ? 'suppressed' : 'idle' };
  }

  evaluate(cause) {
    // A new input preempts any pending retry — the target may have changed.
    if (this.retryTimer) { this.clearTimeoutFn(this.retryTimer); this.retryTimer = null; }
    this.retryAttempt = 0;
    this._drive(cause, /* fromRetry */ false);
  }

  // Periodic reconciliation: ask the platform for ground truth and re-drive
  // if it disagrees with what we believe we last applied. Covers transient
  // platform failures, external commands (e.g. xset dpms force off), and
  // DDC monitors that reset themselves.
  reconcile() {
    if (!this.getActualState || this.lastApplied === null || this.inFlight) return;
    this.getActualState((err, isOn) => {
      if (err) { this.log(`reconcile: getActualState error: ${err.message}`); return; }
      // null = platform can't probe reliably (Wayland with wlopm, no xset,
      // etc). Trust our cached state rather than chasing a lie.
      if (isOn === null || isOn === undefined) return;
      const expected = this.lastApplied === 'on';
      if (!!isOn === expected) return;
      this.log(`reconcile: drift detected (expected=${expected ? 'on' : 'off'}, actual=${isOn ? 'on' : 'off'}); re-driving`);
      this.lastApplied = null; // force re-drive past dedup
      this._drive('reconcile', false);
    });
  }

  _scheduleRetry(cause) {
    const idx = Math.min(this.retryAttempt, RETRY_BACKOFF_MS.length - 1);
    const delay = RETRY_BACKOFF_MS[idx];
    this.retryAttempt += 1;
    this.log(`retry[${this.retryAttempt}] in ${delay}ms (cause=${cause})`);
    if (this.retryTimer) this.clearTimeoutFn(this.retryTimer);
    this.retryTimer = this.setTimeoutFn(() => {
      this.retryTimer = null;
      this._drive(`retry:${cause}`, true);
    }, delay);
  }

  _drive(cause, fromRetry) {
    const t = this.computeTarget();
    if (!fromRetry && t.state === this.lastApplied && t.brightness === this.lastBrightness) return;
    const wasOn = this.lastApplied === 'on';
    const shouldReport = REPORTING_REASONS.has(t.reason);
    this.log(`evaluate(${cause}): -> ${t.state}${t.brightness !== null ? `@${t.brightness}` : ''} (${t.reason})`);
    this.inFlight = true;

    const commit = () => {
      this.inFlight = false;
      this.retryAttempt = 0;
      const transitioned = this.lastApplied !== t.state;
      this.lastApplied = t.state;
      this.lastBrightness = t.brightness;
      if (transitioned && shouldReport) this.reportBacklight(t.state === 'on', t.brightness);
    };
    const fail = (op, err) => {
      this.inFlight = false;
      this.log(`${op} error: ${err.message}`);
      if (this.retryAttempt < RETRY_BACKOFF_MS.length) this._scheduleRetry(cause);
      else this.log(`${op}: backoff cap reached; relying on reconcile`);
    };

    if (t.state === 'on') {
      const finish = () => this.turnOn((err) => {
        if (err) return fail('turnOn', err);
        commit();
      });
      if (t.brightness !== null) {
        this.setBrightness(t.brightness, (err) => {
          // Brightness errors are non-fatal — proceed to turnOn anyway.
          if (err) this.log(`setBrightness error (non-fatal): ${err.message}`);
          finish();
        });
      } else {
        finish();
      }
    } else {
      this.turnOff((err) => {
        if (err) return fail('turnOff', err);
        commit();
      });
    }
  }
}

module.exports = { DisplayController };
