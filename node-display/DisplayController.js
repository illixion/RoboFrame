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

    this.pirMotion = false;
    this.suppressWake = false;
    this.override = null;        // 'on' | 'off' | null
    this.effectDeadline = 0;
    this.tempDisabled = false;

    this.lastApplied = null;     // 'on' | 'off'
    this.lastBrightness = null;
    this.effectTimer = null;
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
    const t = this.computeTarget();
    if (t.state === this.lastApplied && t.brightness === this.lastBrightness) return;
    const wasOn = this.lastApplied === 'on';
    const shouldReport = REPORTING_REASONS.has(t.reason);
    this.log(`evaluate(${cause}): -> ${t.state}${t.brightness !== null ? `@${t.brightness}` : ''} (${t.reason})`);
    this.lastApplied = t.state;
    this.lastBrightness = t.brightness;

    if (t.state === 'on') {
      const finish = () => this.turnOn((err) => {
        if (err) return this.log(`turnOn error: ${err.message}`);
        if (!wasOn && shouldReport) this.reportBacklight(true, t.brightness);
      });
      if (t.brightness !== null) {
        // setBrightness while off stashes the value for the next wake.
        this.setBrightness(t.brightness, () => finish());
      } else {
        finish();
      }
    } else {
      this.turnOff((err) => {
        if (err) return this.log(`turnOff error: ${err.message}`);
        if (wasOn && shouldReport) this.reportBacklight(false, null);
      });
    }
  }
}

module.exports = { DisplayController };
