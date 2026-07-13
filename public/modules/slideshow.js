// Playback-driven slideshow.
//
// The server is in charge: we render whatever `playback` frame says is
// current, preload up to 3 upcoming posts, and crossfade. Visibility-wake is intentionally
// local — we crossfade to the cached `next` immediately and ask the server
// to advance everyone too via `requestNext`.
//
// What this module does NOT do:
//   - query DuckDB (server's job)
//   - run a setInterval timer (server runs the timer; we just receive ticks)
//   - drive a per-client queue (server holds the queue; we hold a bounded local buffer)

import { params, api, buildGetUrl, isVideoExt } from './config.js';
import { state } from './state.js';
import { showToast } from './toast.js';
import { tags } from './tags.js';
import { findSobelFocus } from './sobel-focus.js';

let lastSavedPost = null;

// --- Local "previous" history --------------------------------------------
// Left-arrow walks back through a client-local stack of the posts this
// display has shown, holds the chosen one for one dwell interval while
// ignoring incoming `playback` frames, then lets the first frame after the
// hold resume server-driven playback. The server is never told to go back
// (all displays on a deviceId share one channel — yanking the whole channel
// backwards for one viewer's peek is the wrong scope), so this mirrors
// Spatialstash's history-jump: a local suppression window, per client.
const HISTORY_MAX = 100;
let history = [];               // [{ id, ext }] chronological, newest last
let backSteps = 0;              // how many steps back from newest we're viewing
let playbackSuppressedUntil = 0; // epoch ms; while future, drop server frames
let historySeeded = false;

function recordHistory(cur) {
    if (!cur || !cur.id) return;
    const last = history[history.length - 1];
    if (last && last.id === cur.id) return; // dedup consecutive
    history.push({ id: cur.id, ext: cur.ext });
    if (history.length > HISTORY_MAX) history.shift();
}

// Pre-populate the stack from the server's rolling request log so a display
// that just booted can still step back into what it (or its channel) showed
// before this session. Best-effort and one-shot. /history.json is newest-
// first; our stack is chronological, and locally-recorded posts stay newest.
export function seedHistoryFromServer() {
    if (historySeeded) return;
    historySeeded = true;
    fetch(api('/history.json'))
        .then((r) => (r.ok ? r.json() : null))
        .then((data) => {
            const list = data && Array.isArray(data.history) ? data.history : [];
            if (!list.length) return;
            const seed = list.slice().reverse()
                .filter((e) => e && e.id)
                .map((e) => ({ id: e.id, ext: e.ext }));
            const localIds = new Set(history.map((h) => h.id));
            history = seed.filter((e) => !localIds.has(e.id)).concat(history).slice(-HISTORY_MAX);
        })
        .catch(() => { historySeeded = false; });
}

// Render an arbitrary post immediately (not the server's current). A recent
// post is usually still in the blob cache; otherwise the direct /get URL
// renders fine — a one-off peek isn't worth warming the prefetch cache for.
function renderHistoryPost(post) {
    if (!post || !post.id || !state.mediaContainer) return;
    const entry = mediaCache.get(post.id);
    if (entry) touchCacheEntry(post.id);
    const src = entry ? entry.objectUrl : buildGetUrl(post);
    if (!src) return;
    crossfadeFullscreenMedia(state.mediaContainer, src, post.id, isVideoExt(post.ext));
}
// `lowmem=1` collapses the prefetch window to next-image-only so low-RAM
// kiosks (Pi 3 etc.) don't OOM holding 5+ decoded blobs in memory.
const LOW_MEM = Number(params.lowmem) === 1;
const UPCOMING_CACHE_TARGET = LOW_MEM ? 1 : 3;
const MAX_MEDIA_CACHE_ITEMS = LOW_MEM ? 2 : 8;
const PREFETCH_CONCURRENCY = LOW_MEM ? 1 : 2;

const mediaCache = new Map(); // id -> { id, ext, url, objectUrl, isVideo, lastUsedAt }
const pendingPrefetch = new Map(); // id -> { controller, promise, post }
let prefetchQueue = [];
let currentRenderToken = 0;
// Post we've committed to crossfade to, but whose animation hasn't finished
// (state.currentPost lags by ~1s — see finishLoad below). Without this guard
// every prefetch finishing inside the 1s window re-triggers the same render
// because state.currentPost still points at the previous post.
let inFlightPostId = null;

// Drop every cached blob and abort in-flight prefetch. Used when a
// kiosk-side parameter that affects the /get URL (e.g. bright) flips
// after URLs were already built — the cache is keyed by post.id, not
// URL, so stale-variant blobs would otherwise be served on the next
// playback tick.
export function invalidateMediaCache() {
    for (const inflight of pendingPrefetch.values()) {
        try { inflight.controller.abort(); } catch (_) {}
    }
    pendingPrefetch.clear();
    prefetchQueue = [];
    for (const entry of mediaCache.values()) revokeCacheEntry(entry);
    mediaCache.clear();
}

export function preloadPostsToCache(posts) {
    if (!posts || posts.length === 0) return;
    syncMediaBuffer(posts);
}

function normalizePlaybackUpcoming(payload) {
    if (!payload) return [];
    const result = [];
    const seen = new Set();
    const list = Array.isArray(payload.upcoming) ? payload.upcoming : (payload.next ? [payload.next] : []);
    for (const item of list) {
        if (!item || !item.id || seen.has(item.id)) continue;
        const url = buildGetUrl(item);
        if (!url) continue;
        seen.add(item.id);
        result.push({ id: item.id, ext: item.ext, url });
        if (result.length >= UPCOMING_CACHE_TARGET) break;
    }
    return result;
}

function touchCacheEntry(id) {
    const entry = mediaCache.get(id);
    if (entry) entry.lastUsedAt = Date.now();
}

function revokeCacheEntry(entry) {
    if (!entry) return;
    try {
        if (entry.objectUrl) URL.revokeObjectURL(entry.objectUrl);
    } catch (_) {
        // Ignore URL revocation failures.
    }
}

function trimCache(keepIds = new Set()) {
    if (mediaCache.size <= MAX_MEDIA_CACHE_ITEMS) return;
    const evictable = Array.from(mediaCache.values())
        .filter((entry) => !keepIds.has(entry.id))
        .sort((a, b) => (a.lastUsedAt || 0) - (b.lastUsedAt || 0));

    while (mediaCache.size > MAX_MEDIA_CACHE_ITEMS && evictable.length) {
        const victim = evictable.shift();
        mediaCache.delete(victim.id);
        revokeCacheEntry(victim);
    }
}

function addToCache(post, objectUrl) {
    if (!post || !post.id || !objectUrl) return;
    const existing = mediaCache.get(post.id);
    if (existing && existing.objectUrl && existing.objectUrl !== objectUrl) {
        revokeCacheEntry(existing);
    }
    mediaCache.set(post.id, {
        id: post.id,
        ext: post.ext,
        url: post.url,
        objectUrl,
        isVideo: isVideoExt(post.ext),
        lastUsedAt: Date.now(),
    });
}

function pruneQueueAndInflight(desiredById) {
    prefetchQueue = prefetchQueue.filter((post) => desiredById.has(post.id));
    for (const [id, inflight] of pendingPrefetch.entries()) {
        if (!desiredById.has(id)) {
            inflight.controller.abort();
            pendingPrefetch.delete(id);
        }
    }
}

function enqueuePrefetch(post) {
    if (!post || !post.id || !post.url) return;
    // Videos stream directly from /get via the <video> element on render —
    // never pulled into the blob cache. A 100MB clip held in RAM only to be
    // cut off mid-loop is pure waste.
    if (isVideoExt(post.ext)) return;
    if (mediaCache.has(post.id) || pendingPrefetch.has(post.id)) return;
    if (prefetchQueue.some((queued) => queued.id === post.id)) return;
    prefetchQueue.push(post);
}

function runPrefetchWorker() {
    while (pendingPrefetch.size < PREFETCH_CONCURRENCY && prefetchQueue.length > 0) {
        const nextPost = prefetchQueue.shift();
        if (!nextPost || !nextPost.id || mediaCache.has(nextPost.id) || pendingPrefetch.has(nextPost.id)) continue;

        const controller = new AbortController();
        const promise = fetch(nextPost.url, { signal: controller.signal })
            .then((response) => {
                if (!response.ok) throw new Error(`HTTP ${response.status}`);
                return response.blob();
            })
            .then((blob) => {
                const objectUrl = URL.createObjectURL(blob);
                addToCache(nextPost, objectUrl);
            })
            .catch((error) => {
                if (error?.name !== 'AbortError') {
                    console.warn(`Prefetch failed for ${nextPost.id}:`, error);
                }
            })
            .finally(() => {
                pendingPrefetch.delete(nextPost.id);
                runPrefetchWorker();
                maybeRenderDesiredCurrent();
            });

        pendingPrefetch.set(nextPost.id, { controller, promise, post: nextPost });
    }
}

function syncMediaBuffer(posts) {
    const desiredById = new Map();
    (posts || []).forEach((post) => {
        if (!post || !post.id || !post.url) return;
        if (!desiredById.has(post.id)) desiredById.set(post.id, post);
    });

    pruneQueueAndInflight(desiredById);
    for (const post of desiredById.values()) enqueuePrefetch(post);

    const keepIds = new Set(desiredById.keys());
    if (state.currentPost) keepIds.add(state.currentPost);
    trimCache(keepIds);
    runPrefetchWorker();
}

function maybeRenderDesiredCurrent() {
    const cur = state.currentPlayback?.current;
    if (!cur || !cur.id) return;
    if (state.currentPost === cur.id) return;
    if (state.tempDisable || state.forceDisable || document.hidden) return;

    if (isVideoExt(cur.ext)) {
        const url = buildGetUrl(cur);
        if (!url) return;
        crossfadeFullscreenMedia(state.mediaContainer, url, cur.id, true);
        return;
    }

    const entry = mediaCache.get(cur.id);
    if (!entry) return;
    touchCacheEntry(cur.id);
    crossfadeFullscreenMedia(state.mediaContainer, entry.objectUrl, cur.id, entry.isVideo);
}

function startCrossfade(currentLayer, nextLayer) {
    nextLayer.style.transition = 'none';
    nextLayer.style.opacity = '0';
    nextLayer.offsetHeight; // force reflow
    nextLayer.style.transition = 'opacity 0.5s ease-in-out';
    nextLayer.style.opacity = '1';
    currentLayer.style.opacity = '0';
    setTimeout(() => {
        currentLayer.classList.remove('current');
        currentLayer.classList.add('next');
        nextLayer.classList.remove('next');
        nextLayer.classList.add('current');
    }, 500);
}

export function crossfadeFullscreenMedia(container, newMediaUrl, postId, isVideo = false) {
    // Idempotent for callers that may re-fire for the same post within the
    // ~1s state.currentPost-update window: bail if we're already rendering
    // (or have just rendered) this id.
    if (postId && (postId === inFlightPostId || postId === state.currentPost)) return;

    const renderToken = ++currentRenderToken;
    inFlightPostId = postId;
    const currentLayer = container.querySelector('.fullscreen-layer.current');
    const nextLayer = container.querySelector('.fullscreen-layer.next');
    nextLayer.innerHTML = '';

    const finishLoad = (durationMs) => {
        if (renderToken !== currentRenderToken) return;
        if (nextLayer.children.length > 1) {
            console.error('More than one child in nextLayer:', nextLayer.children);
            nextLayer.removeChild(nextLayer.children[0]);
        }
        startCrossfade(currentLayer, nextLayer);
        // The image is on screen now — tell the server immediately so its
        // 15s dwell starts from render time, not render+crossfade time.
        // Holding this until the crossfade settles added ~1s of slop to
        // every cycle (15s interval → ~16s wall-clock cadence).
        // For videos we also report the clip length: the server dwells for
        // max(interval, durationMs), so a clip longer than the interval
        // delays the advance until it has played through.
        reportImageReady(postId, durationMs);
        setTimeout(() => {
            if (renderToken !== currentRenderToken) return;
            state.currentPost = postId;
            if (inFlightPostId === postId) inFlightPostId = null;
            console.log('Current post:', postId);
        }, 1000);
    };

    const handleError = () => {
        if (renderToken !== currentRenderToken) return;
        if (inFlightPostId === postId) inFlightPostId = null;
        console.warn(`Failed to render post ${postId}`);
    };

    if (isVideo) {
        const video = document.createElement('video');
        video.src = newMediaUrl;
        video.autoplay = true;
        video.muted = true;
        video.playsInline = true;
        video.classList.add('fullscreen-media');
        if (Number(params.noclock)) video.classList.add('alt-fit');
        video.onloadeddata = () => {
            if (renderToken !== currentRenderToken) return;
            const durSec = video.duration;
            const durationMs = Number.isFinite(durSec) && durSec > 0 ? Math.round(durSec * 1000) : 0;
            // Loop a clip that fits inside the dwell interval; let a longer
            // clip play once and freeze on its last frame until the server
            // advances (dwell ≈ duration). Looping a long clip would restart
            // it just before the advance and flash the opening frame.
            video.loop = durationMs === 0 || durationMs <= state.interval;
            finishLoad(durationMs);
        };
        video.onerror = handleError;
        nextLayer.appendChild(video);
    } else {
        const img = new Image();
        img.classList.add('fullscreen-media');
        if (Number(params.noclock)) img.classList.add('alt-fit');
        img.addEventListener('load', async () => {
            if (renderToken !== currentRenderToken) return;
            if (!Number(params.static)) {
                try {
                    const { focusX, focusY } = await findSobelFocus(img);
                    if (renderToken !== currentRenderToken) return;
                    img.style.transformOrigin = `${focusX * 100}% ${focusY * 100}%`;
                    const kenburnsName = Number(params.noclock) ? 'kenburns-zoom-alt' : 'kenburns-zoom';
                    img.style.animation = `${kenburnsName} ${state.interval / 1000}s ease-in-out forwards`;
                } catch (e) {
                    console.warn('Sobel focus failed; rendering without Ken Burns:', e);
                }
            }
            nextLayer.appendChild(img);
            finishLoad();
        });
        img.addEventListener('error', handleError);
        img.src = newMediaUrl;
    }
}

// Apply a `playback` frame from the server. While the local display is off
// (visibility hidden, iframe overlaying, forceDisable, etc.) we skip both
// the crossfade and the preload — there's no point pulling binaries we
// won't render, especially if the kiosk has been off for hours. We still
// store the metadata so the wake path can re-apply and catch up.
export function applyPlayback(payload) {
    if (!payload) return;
    // Holding a "previous" view: ignore server frames entirely — no metadata
    // update, no prefetch, no render — until the hold expires. The first
    // frame at/after the deadline clears the hold and resumes live playback.
    if (playbackSuppressedUntil) {
        if (Date.now() < playbackSuppressedUntil) return;
        playbackSuppressedUntil = 0;
        backSteps = 0;
    }
    state.currentPlayback = payload;
    if (typeof payload.interval === 'number' && payload.interval > 0) {
        state.interval = payload.interval;
    }
    if (typeof payload.currentList === 'number') {
        tags.applyServer(payload.currentList);
    }

    const isHidden = state.tempDisable || state.forceDisable || document.hidden;

    const cur = payload.current;
    const upcoming = normalizePlaybackUpcoming(payload);

    if (!isHidden) {
        const desired = [];
        if (cur && cur.id) {
            const currentUrl = buildGetUrl(cur);
            if (currentUrl) desired.push({ id: cur.id, ext: cur.ext, url: currentUrl });
        }
        desired.push(...upcoming);
        syncMediaBuffer(desired);
    }

    if (cur && cur.id && cur.id !== state.currentPost && !isHidden) {
        // The server filters blocked posts from its queue; whatever
        // arrives here is intended to be rendered.
        recordHistory(cur);
        maybeRenderDesiredCurrent();
    }
}

// Single-session client: every session-scoped frame uses a constant id.
const KIOSK_SESSION_ID = 'main';

export function requestNext() {
    // Forward exits any "previous" hold and returns to live server playback.
    playbackSuppressedUntil = 0;
    backSteps = 0;
    if (state.socket && state.socket.readyState === WebSocket.OPEN) {
        state.socket.send(JSON.stringify({ sessionId: KIOSK_SESSION_ID, action: 'requestNext' }));
    }
}

// Step one post back through the local history stack and hold it for one
// dwell interval, ignoring server playback frames, then resume. Repeated
// presses walk further back; each press re-arms the hold.
export function requestPrev() {
    const targetIdx = history.length - 1 - (backSteps + 1);
    if (targetIdx < 0) {
        showToast('No earlier image');
        seedHistoryFromServer(); // fill the stack so a later press works
        return;
    }
    backSteps += 1;
    const post = history[targetIdx];
    const holdMs = Math.max(2000, Number(state.interval) || 15000);
    playbackSuppressedUntil = Date.now() + holdMs;
    renderHistoryPost(post);
}

export function requestReshuffle() {
    if (state.socket && state.socket.readyState === WebSocket.OPEN) {
        state.socket.send(JSON.stringify({ sessionId: KIOSK_SESSION_ID, action: 'reshuffle' }));
    }
}

// Tell the server we've finished transitioning to `postId`. The server's
// readiness barrier waits for every visible client on the channel before
// starting the dwell timer, so without this report the channel stalls for
// up to 10 s on its bad-network fallback.
function reportImageReady(postId, durationMs) {
    if (!postId) return;
    if (state.socket && state.socket.readyState === WebSocket.OPEN) {
        const payload = { id: postId };
        if (Number.isFinite(durationMs) && durationMs > 0) payload.durationMs = durationMs;
        state.socket.send(JSON.stringify({
            sessionId: KIOSK_SESSION_ID,
            action: 'imageReady',
            payload,
        }));
    }
}

export function blockPost() {
    if (!state.currentPost) return;
    if (state.socket && state.socket.readyState === WebSocket.OPEN) {
        state.socket.send(JSON.stringify({ action: 'block', payload: { id: state.currentPost } }));
    }
    showToast(`🛑 Blocked post ${state.currentPost}`);
    // The server's notifyBlockedChange advances the channel for us when
    // the currently-displayed post is blocked; a local requestNext would
    // double-skip.
}

export function saveFileRemote(postId) {
    if (!postId) {
        console.error('No post ID provided for saving.');
        return;
    }
    if (postId === lastSavedPost) return;
    lastSavedPost = postId;

    showToast(`⬇️ Saving ${postId}`);
    fetch(api(`/save?id=${encodeURIComponent(postId)}`), { method: 'GET' })
        .then((response) => {
            if (response.ok) return response.text();
            showToast(`❌ Error: ${response.status} ${response.statusText}`);
            throw new Error(`Error: ${response.status} ${response.statusText}`);
        })
        .then((text) => { showToast(text); console.log('Save success:', text); })
        .catch((error) => {
            showToast(`❌ Error saving image: ${error}`);
            console.error('Fetch error:', error);
        });
}

export function addToHistory(postId) {
    if (!postId) return;
    fetch(api(`/addtohistory?id=${encodeURIComponent(postId)}`), { method: 'GET' })
        .then((response) => {
            if (response.ok) return response.text();
            throw new Error(`Error: ${response.status} ${response.statusText}`);
        })
        .then((text) => console.log('Added to history:', text))
        .catch((error) => console.error('addToHistory failed:', error));
}
