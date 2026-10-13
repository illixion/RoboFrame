// URL params, endpoint resolution, render-parameter helpers.
//
// Single-port topology: the kiosk page, image API, and WebSocket all live on
// the same origin by default. `?endpoint=` and `?wsurl=` overrides exist for
// dev / split deployments. The auto-detected `basePath` lets nginx mount the
// server under a sub-path (e.g. /mywallpaperpage/) without code changes.

export const urlParams = new URLSearchParams(window.location.search);

// The URL's own values, lowercased — what the settings panel reports as the
// "URL" source for a field.
export const urlValues = {};
urlParams.forEach((value, key) => { urlValues[key.toLowerCase()] = value; });

// Settings the panel (settings.js) can override. Kiosks launch from a fixed
// bookmarked / launcher URL, so a value saved in the panel outranks the URL:
// panel > URL > default. Connection plumbing and secrets (ws, token,
// endpoint, wsurl, homeendpoint) are deliberately absent — they stay in the
// URL and a stray stored copy is never merged.
export const SETTINGS_STORAGE_KEY = 'roboframe.settings';
export const PANEL_KEYS = new Set([
    'delay', 'static', 'fit', 'blurbg',
    'noclock', 'nosensors', 'nobutton', 'nobg', 'top-offset',
    'bright', 'convert', 'lowmem', 'wallpaper', 'ratio', 'width', 'height',
    'nightlight', 'nightlightstart', 'nightlightend',
    'opacity', 'list',
]);

export function readStoredSettings() {
    try {
        const raw = localStorage.getItem(SETTINGS_STORAGE_KEY);
        if (!raw) return {};
        const parsed = JSON.parse(raw);
        if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return {};
        const out = {};
        for (const [k, v] of Object.entries(parsed)) {
            if (PANEL_KEYS.has(k) && (typeof v === 'string' || typeof v === 'number')) out[k] = String(v);
        }
        return out;
    } catch (_) {
        return {};
    }
}

export function writeStoredSettings(values) {
    try {
        if (!values || Object.keys(values).length === 0) localStorage.removeItem(SETTINGS_STORAGE_KEY);
        else localStorage.setItem(SETTINGS_STORAGE_KEY, JSON.stringify(values));
        return true;
    } catch (_) {
        return false;
    }
}

// The overrides as they stood at page load — the ones `params` reflects.
export const storedSettings = readStoredSettings();

// Every reader in the kiosk goes through `params`, so the merge happens here,
// once, before any other module reads it. (nightlight.js reads it lazily for
// the circular-import reason noted there.)
export const params = { ...urlValues, ...storedSettings };

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

// How a photo fills the screen: `height` fills the height and crops the sides
// (centred), `contain` letterboxes the whole frame, `cover` fills the screen
// edge to edge. An explicit `fit` wins; without one a hidden clock means
// `contain`, which is how `noclock` kiosks have always framed their photos.
export const FITS = ['height', 'contain', 'cover'];
export function resolveFit(p = params) {
    const fit = String(p.fit || '').toLowerCase();
    if (FITS.includes(fit)) return fit;
    return Number(p.noclock) ? 'contain' : 'height';
}

// The blurred backdrop behind a letterboxed photo costs a second full-screen
// decode + blur, so low-memory kiosks leave it off unless asked.
export function resolveBlurBg(p = params) {
    if (p.blurbg !== undefined && p.blurbg !== '') return Number(p.blurbg) ? true : false;
    return Number(p.lowmem) !== 1;
}

// Media-layer opacity in percent (10–100), the persisted form of the 1–9 / 0
// digit keys.
export function resolveOpacity(p = params) {
    const n = Number(p.opacity);
    if (!Number.isFinite(n) || n <= 0) return 100;
    return Math.min(100, Math.max(10, Math.round(n)));
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
    // `?wallpaper=1` composes each frame onto a width×height canvas server-side
    // (cover-crop when the aspect is close, fit-with-fill otherwise). It relies
    // on the ratio filter to bias the queue toward matching-aspect posts —
    // those cover-crop edge-to-edge with no bars — so wallpaper forces the
    // ratio advert on even when `?ratio` is unset or 0.
    const wallpaper = Number(params.wallpaper) ? 1 : 0;
    return {
        screenWidth: width,
        screenHeight: height,
        // Manual `?bright=1` forces ambient mode on; the night-light
        // schedule can also turn it on but never overrides a manual
        // off.
        bright: (manualBright || isNightLightActive()) ? 1 : 0,
        convert: Number(params.convert) ? 1 : 0,
        lowmem: Number(params.lowmem) === 1 ? 1 : 0,
        wallpaper,
        ratio: (Number(params.ratio) || wallpaper) ? calculateDisplayRatio(width, height) : null,
    };
}

// Build the binary fetch URL for a post. The orchestrator pushes `{id, ext}`
// in playback frames; the kiosk supplies its own screen dimensions.
export function buildGetUrl(post) {
    if (!post || !post.id) return null;
    const { screenWidth, screenHeight, bright, convert, lowmem, wallpaper } = getRenderParams();
    // `deviceId` (the ?ws= channel id) tags the request so /history can group
    // this display's images; omitted when the kiosk has no channel id.
    const device = params.ws ? `&deviceId=${encodeURIComponent(params.ws)}` : '';
    const wp = wallpaper ? '&wallpaper=1' : '';
    // A container `<video>` can't open goes through the server's H.264 mp4
    // transcode instead of the raw file.
    const ext = String(post.ext || '').toLowerCase();
    const vc = VIDEO_EXTS.has(ext) && !BROWSER_VIDEO_EXTS.has(ext) ? '&vcodec=h264&vmaxh=0&vmaxfps=0' : '';
    return api(`/get?id=${post.id}&convert=${convert}&bright=${bright}&width=${screenWidth}&height=${screenHeight}&lowmem=${lowmem}${wp}${device}${vc}`);
}

// A toast-sized thumbnail of a post: 72px at 1080p, scaled with the screen,
// doubled for a sharp downscale. `record=0` keeps it out of /history; a
// video post gets its first-frame `poster=1` JPEG.
export function buildPreviewUrl(id, ext) {
    if (!id) return null;
    const { height } = getScreenSize();
    const box = Math.max(64, Math.round((72 / 1080) * height * 2));
    const variant = isVideoExt(ext) ? 'poster=1' : 'convert=1&bright=0';
    return api(`/get?id=${encodeURIComponent(id)}&width=${box}&height=${box}&${variant}&record=0`);
}

// The server's video containers (packages/shared/src/mediaTypes.js), and the
// ones browsers play from the raw file.
const VIDEO_EXTS = new Set(['mp4', 'm4v', 'mov', 'mkv', 'webm', 'avi', 'wmv', 'flv', '3gp']);
const BROWSER_VIDEO_EXTS = new Set(['mp4', 'm4v', 'mov', 'webm']);

export function isVideoExt(ext) {
    return VIDEO_EXTS.has(String(ext || '').toLowerCase());
}
