'use strict';

// Schedules `bright` mode to follow a [start, end) clock window so the
// kiosk dims itself during sleeping hours without server-side support.
// Reads `?nightlightstart=HH:MM&nightlightend=HH:MM`. Either missing or
// equal disables the feature.
//
// On every boundary we fire a callback the bootstrap has wired to
// slideshow.invalidateMediaCache. The current image keeps showing
// (already-decoded `<img>` is independent of the blob URL); the next
// playback tick from the server triggers a fresh prefetch with the new
// `bright` value baked into the /get URL.

import { params } from './config.js';

function parseHHMM(s) {
    if (typeof s !== 'string') return null;
    const m = /^(\d{1,2}):(\d{2})$/.exec(s.trim());
    if (!m) return null;
    const h = Number(m[1]);
    const mm = Number(m[2]);
    if (h < 0 || h > 23 || mm < 0 || mm > 59) return null;
    return h * 60 + mm;
}

// Schedule is parsed lazily on first call: config.js imports
// `isNightLightActive` from this module while this module imports
// `params` from config.js, so reading `params` at top level would hit
// the circular-import TDZ and throw.
let cached = null;
function schedule() {
    if (cached) return cached;
    const startMin = parseHHMM(params.nightlightstart);
    const endMin = parseHHMM(params.nightlightend);
    cached = {
        startMin,
        endMin,
        enabled: startMin !== null && endMin !== null && startMin !== endMin,
    };
    return cached;
}

function nowMin(d = new Date()) {
    return d.getHours() * 60 + d.getMinutes();
}

export function isNightLightActive() {
    const { enabled, startMin, endMin } = schedule();
    if (!enabled) return false;
    const m = nowMin();
    // Cross-midnight window (e.g. 22:00–06:00) wraps; same-day window
    // (e.g. 13:00–17:00) doesn't.
    if (startMin < endMin) return m >= startMin && m < endMin;
    return m >= startMin || m < endMin;
}

function msUntilNextBoundary() {
    const { startMin, endMin } = schedule();
    const d = new Date();
    const m = nowMin(d);
    const target = isNightLightActive() ? endMin : startMin;
    let deltaMin = target - m;
    if (deltaMin <= 0) deltaMin += 24 * 60;
    return deltaMin * 60_000 - d.getSeconds() * 1000 - d.getMilliseconds();
}

export function initNightLight(onBoundary) {
    if (!schedule().enabled) return;
    console.log(`Night light: ${params.nightlightstart}–${params.nightlightend} (currently ${isNightLightActive() ? 'active' : 'idle'})`);
    const tick = () => {
        try { onBoundary?.(); } catch (e) { console.warn('nightlight onBoundary threw:', e); }
        setTimeout(tick, msUntilNextBoundary());
    };
    setTimeout(tick, msUntilNextBoundary());
}
