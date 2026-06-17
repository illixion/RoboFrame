// URL params, endpoint resolution, render-parameter helpers.
//
// Single-port topology: the kiosk page, image API, and WebSocket all live on
// the same origin by default. `?endpoint=` and `?wsurl=` overrides exist for
// dev / split deployments. The auto-detected `basePath` lets nginx mount the
// server under a sub-path (e.g. /mywallpaperpage/) without code changes.

export const urlParams = new URLSearchParams(window.location.search);
export const params = {};
urlParams.forEach((value, key) => { params[key.toLowerCase()] = value; });

export const endpoint = params.endpoint || '';
export const homeEndpoint = params.homeendpoint || '';

export const basePath = (() => {
    const p = location.pathname || '/';
    return p.replace(/\/[^\/]*$/, '');
})();

export function api(path) {
    const base = endpoint ? endpoint + path : basePath + path;
    const token = params.token || '';
    if (!token) return base;
    const sep = base.includes('?') ? '&' : '?';
    return `${base}${sep}token=${encodeURIComponent(token)}`;
}

export function wsUrl() {
    const base = (() => {
        if (params.wsurl) return params.wsurl;
        if (endpoint) return endpoint.replace(/^http/, 'ws') + '/rpc/ws';
        const proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
        return `${proto}//${location.host}${basePath}/rpc/ws`;
    })();
    const token = params.token || '';
    if (!token) return base;
    const sep = base.includes('?') ? '&' : '?';
    return `${base}${sep}token=${encodeURIComponent(token)}`;
}

export const defaultInterval = Number(params.delay) > 0 ? Number(params.delay) * 1000 : 15000;

export function getScreenSize() {
    if (params.height && params.width) {
        return { width: Number(params.width), height: Number(params.height) };
    }
    return {
        width: window.screen.width * window.devicePixelRatio,
        height: window.screen.height * window.devicePixelRatio,
    };
}

// Advertise the display's raw aspect ratio (width/height). The server owns
// the matching tolerance and expands this into a `ratio:lo..hi` query range,
// so the client doesn't bake in a window of its own.
export function calculateDisplayRatio(width, height) {
    const ratio = width / height;
    return Number.isFinite(ratio) && ratio > 0 ? Number(ratio.toFixed(4)) : null;
}

import { isNightLightActive } from './nightlight.js';

export function getRenderParams() {
    const { width, height } = getScreenSize();
    const manualBright = Number(params.bright) ? 1 : 0;
    return {
        screenWidth: width,
        screenHeight: height,
        // Manual `?bright=1` forces ambient mode on; the night-light
        // schedule can also turn it on but never overrides a manual
        // off.
        bright: (manualBright || isNightLightActive()) ? 1 : 0,
        convert: Number(params.convert) ? 1 : 0,
        lowmem: Number(params.lowmem) === 1 ? 1 : 0,
        ratio: Number(params.ratio) ? calculateDisplayRatio(width, height) : null,
    };
}

// Build the binary fetch URL for a post. The orchestrator pushes `{id, ext}`
// in playback frames; the kiosk supplies its own screen dimensions.
export function buildGetUrl(post) {
    if (!post || !post.id) return null;
    const { screenWidth, screenHeight, bright, convert, lowmem } = getRenderParams();
    // `deviceId` (the ?ws= channel id) tags the request so /history can group
    // this display's images; omitted when the kiosk has no channel id.
    const device = params.ws ? `&deviceId=${encodeURIComponent(params.ws)}` : '';
    return api(`/get?id=${post.id}&convert=${convert}&bright=${bright}&width=${screenWidth}&height=${screenHeight}&lowmem=${lowmem}${device}`);
}

export function isVideoExt(ext) {
    const e = String(ext || '').toLowerCase();
    return e === 'webm' || e === 'mp4';
}
