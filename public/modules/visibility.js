// Page-level "show / hide the slideshow" gate.
//
// `disable(true)` hides the fullscreen container (used when iframe is open,
// when displayState reports off, when an RPC text/video overlay is up, etc.).
// `disable(false)` brings it back and re-applies the latest server-pushed
// playback, which by then reflects whatever the channel advanced to during
// the hidden period — no client-side wake-advance needed.

import { state } from './state.js';
import { addToHistory, applyPlayback } from './slideshow.js';

function pauseVideos(pause) {
    const videos = document.querySelectorAll('video');
    videos.forEach((v) => pause ? v.pause() : v.play().catch(() => {}));
}

export function disable(newState, override = false) {
    if (!override && state.forceDisable) return;
    if (newState === state.tempDisable) return;
    state.tempDisable = newState;
    pauseVideos(newState);

    const fullscreenContainer = document.querySelector('.fullscreen-container');
    if (newState) {
        state.disabledAtTime = Date.now();
        // visionOS limits audio to one source; pull video elements out
        // entirely so the media session is released even if pause()'d.
        fullscreenContainer.querySelectorAll('video').forEach((video) => {
            video.pause();
            video.removeAttribute('src');
            video.load();
            video.remove();
        });
        fullscreenContainer.style.display = 'none';
    } else {
        fullscreenContainer.style.display = 'block';
        // Re-run the latest playback now that we're visible: render the
        // current image (which we deferred while hidden) and fire the next
        // preload (which we also skipped to avoid junk traffic). The server
        // owns advancing — its dwell deadline ticks against wall-clock
        // regardless of our visibility, so a wake just picks up whatever's
        // current, never bumps the timer.
        if (state.currentPlayback) applyPlayback(state.currentPlayback);
        if (state.currentPost) addToHistory(state.currentPost);
    }

    // The on-screen "showing" state just changed (displayState off/on, overlay,
    // custom page). ws-client listens and reports `present` so the channel
    // dark-advances while nothing is shown and resumes fresh when it is.
    document.dispatchEvent(new CustomEvent('rf:showingchange'));
}
