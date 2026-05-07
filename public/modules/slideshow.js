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
import { findSobelFocus } from './sobel-focus.js';

let lastSavedPost = null;
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

    const finishLoad = () => {
        if (renderToken !== currentRenderToken) return;
        if (nextLayer.children.length > 1) {
            console.error('More than one child in nextLayer:', nextLayer.children);
            nextLayer.removeChild(nextLayer.children[0]);
        }
        startCrossfade(currentLayer, nextLayer);
        setTimeout(() => {
            if (renderToken !== currentRenderToken) return;
            state.currentPost = postId;
            if (inFlightPostId === postId) inFlightPostId = null;
            console.log('Current post:', postId);
            reportImageReady(postId);
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
        video.loop = true;
        video.muted = true;
        video.playsInline = true;
        video.classList.add('fullscreen-media');
        if (Number(params.noclock)) video.classList.add('alt-fit');
        video.onloadeddata = () => {
            if (renderToken !== currentRenderToken) return;
            finishLoad();
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
                    img.style.animation = `kenburns-zoom ${state.interval / 1000}s ease-in-out forwards`;
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
    state.currentPlayback = payload;
    if (typeof payload.interval === 'number' && payload.interval > 0) {
        state.interval = payload.interval;
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
        maybeRenderDesiredCurrent();
    }
}

export function requestNext() {
    if (state.socket && state.socket.readyState === WebSocket.OPEN) {
        state.socket.send(JSON.stringify({ action: 'requestNext' }));
    }
}

export function requestReshuffle() {
    if (state.socket && state.socket.readyState === WebSocket.OPEN) {
        state.socket.send(JSON.stringify({ action: 'reshuffle' }));
    }
}

// Tell the server we've finished transitioning to `postId`. The server's
// readiness barrier waits for every visible client on the channel before
// starting the dwell timer, so without this report the channel stalls for
// up to 10 s on its bad-network fallback.
function reportImageReady(postId) {
    if (!postId) return;
    if (state.socket && state.socket.readyState === WebSocket.OPEN) {
        state.socket.send(JSON.stringify({ action: 'imageReady', payload: { id: postId } }));
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
