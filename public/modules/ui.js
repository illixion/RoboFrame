// Page chrome: clock, wake-lock, keyboard shortcuts, cursor auto-hide,
// home-iframe toggle, button positioning. Anything that's neither slideshow
// nor RPC effect lands here.

import { params, homeEndpoint } from './config.js';
import { state } from './state.js';
import { tags } from './tags.js';
import { showToast } from './toast.js';
import { disable } from './visibility.js';
import { blockPost, saveFileRemote, requestNext, requestReshuffle } from './slideshow.js';
import { sendDisplaySync } from './ws-client.js';

let wakeLock = true;
let awaitingTagList = false;

// ----- Clock -----------------------------------------------------------
function updateClock() {
    const now = new Date();
    const clock = now.toLocaleTimeString('en-US', { hourCycle: 'h23', hour: 'numeric', minute: '2-digit', second: '2-digit' });
    const date = now.toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric' });
    const clockEl = document.getElementById('clock');
    const dateEl = document.getElementById('date');
    if (clockEl) { clockEl.setAttribute('datetime', clock); clockEl.textContent = clock; }
    if (dateEl)  { dateEl.setAttribute('datetime', date);   dateEl.textContent = date; }
}

// ----- Wake lock --------------------------------------------------------
export async function requestWakeLock(scheduled = false) {
    try {
        wakeLock = await navigator.wakeLock.request('screen');
        console.log('Wake Lock is active');
        if (!scheduled) showToast('Wake Lock is active');
        wakeLock.addEventListener('release', () => { wakeLock = null; });
    } catch (err) {
        showToast(`${err.name}, ${err.message}`);
        wakeLock = false;
    }
}

// ----- iframe toggle ---------------------------------------------------
let isBackgrounded = true;
export function toggleIframe() {
    if (!homeEndpoint) {
        showToast('No homeEndpoint configured');
        return;
    }
    const iframe = document.getElementById('ha-iframe');
    isBackgrounded = !isBackgrounded;
    iframe.style.display = isBackgrounded ? 'none' : 'block';
    disable(!isBackgrounded);
    iframe.contentWindow.postMessage({ type: 'visibility', hidden: isBackgrounded }, '*');
}

// ----- Button positioning when noclock is set -------------------------
function moveButtonsToTop(spacingTop = '15px', spacingLeft = '15px', spacingBetween = '15px') {
    const toggleBtn = document.querySelector('.toggle-button');
    const blockBtn = document.querySelector('.block-picture-button');
    const tagsetBtn = document.querySelector('.change-tagset-button');
    if (toggleBtn) {
        toggleBtn.style.top = spacingTop;
        toggleBtn.style.left = spacingLeft;
    }
    if (blockBtn) {
        const top = parseInt(spacingTop, 10) + (toggleBtn ? toggleBtn.offsetHeight : 0) + parseInt(spacingBetween, 10);
        blockBtn.style.top = `${top}px`;
        blockBtn.style.left = spacingLeft;
    }
    if (tagsetBtn) {
        const top = parseInt(spacingTop, 10)
            + (toggleBtn ? toggleBtn.offsetHeight : 0)
            + (blockBtn ? blockBtn.offsetHeight : 0)
            + (2 * parseInt(spacingBetween, 10));
        tagsetBtn.style.top = `${top}px`;
        tagsetBtn.style.left = spacingLeft;
    }
}

// ----- Cursor auto-hide ------------------------------------------------
function installCursorHide() {
    let timeoutId;
    const HIDE_DELAY = 5000;
    let isCursorHidden = false;
    function hideCursor() { document.body.style.cursor = 'none'; isCursorHidden = true; }
    function showCursor() {
        if (isCursorHidden) { document.body.style.cursor = ''; isCursorHidden = false; }
    }
    function resetTimer() {
        showCursor();
        clearTimeout(timeoutId);
        timeoutId = setTimeout(hideCursor, HIDE_DELAY);
    }
    document.addEventListener('mousemove', resetTimer);
    timeoutId = setTimeout(hideCursor, HIDE_DELAY);
}

// ----- Keyboard shortcuts ----------------------------------------------
function installKeyboard() {
    document.addEventListener('keydown', (event) => {
        const key = event.key;

        if (typeof window.AuthOverlay !== 'undefined' && window.AuthOverlay.isVisible && window.AuthOverlay.isVisible()) {
            if (key === 'Escape') window.AuthOverlay.hide();
            return;
        }

        if (awaitingTagList) {
            if (key >= '0' && key <= '9') {
                tags.set(parseInt(key, 10));
            } else {
                showToast(`Please press a number (0-${(tags.tagsList || []).length - 1}) for the tag list.`);
            }
            awaitingTagList = false;
            return;
        }

        if (key >= '1' && key <= '9') {
            state.mediaContainer.style.opacity = String(Number(key) / 10 || 1);
            return;
        }
        if (key === '0') {
            state.mediaContainer.style.opacity = '1';
            return;
        }

        switch (key) {
            case ' ': saveFileRemote(state.currentPost); break;
            case 'w': requestWakeLock(); break;
            case 'h': toggleIframe(); break;
            case 'b': blockPost(); break;
            case 's':
                awaitingTagList = true;
                showToast(`Enter tag list number (0-${(tags.tagsList || []).length - 1}):`);
                break;
            case 'd':
                state.isPrimary = !state.isPrimary;
                sendDisplaySync(state.isPrimary);
                showToast(`Display Sync ${state.isPrimary ? 'ON' : 'OFF'}`);
                break;
            case 'a': {
                const addThis = prompt('Enter tag to add');
                if (addThis) tags.addTag(addThis);
                break;
            }
            case 'r':
                if (tags.modTags.length === 0) {
                    showToast('No mod tags to remove');
                } else if (tags.modTags.length === 1) {
                    tags.removeTag(tags.modTags[0]);
                    showToast('Removed mod tag');
                } else {
                    const list = tags.modTags.map((t, i) => `${i}: ${t}`).join('\n');
                    const rmIdx = prompt(`Enter the number of the tag to remove:\n\n${list}`);
                    const idx = parseInt(rmIdx, 10);
                    if (!isNaN(idx) && idx >= 0 && idx < tags.modTags.length) {
                        tags.removeTag(tags.modTags[idx]);
                        showToast('Removed mod tag');
                    } else {
                        showToast('Invalid tag number');
                    }
                }
                break;
            case 't':
                requestReshuffle();
                showToast('Reshuffling random order');
                break;
            case 'p':
                state.forceDisable = !state.forceDisable;
                disable(state.forceDisable, true);
                break;
            case 'ArrowRight':
                requestNext();
                break;
            case 'q':
                if (typeof window.AuthOverlay !== 'undefined' && window.AuthOverlay.show) window.AuthOverlay.show();
                break;
        }
    });
}

// ----- Visibility-change forwarding -----------------------------------
function installVisibilityHandlers() {
    document.addEventListener('visibilitychange', () => {
        if (document.hidden) {
            disable(true);
            if (state.socket && state.socket.readyState === WebSocket.OPEN && state.deviceID) {
                state.socket.send(JSON.stringify({
                    action: 'visibility',
                    payload: { deviceId: state.deviceID, visible: false },
                }));
            }
        } else {
            disable(false);
            if (state.socket && state.socket.readyState === WebSocket.OPEN && state.deviceID) {
                state.socket.send(JSON.stringify({
                    action: 'visibility',
                    payload: { deviceId: state.deviceID, visible: true },
                }));
            }
        }
    });
}

// ----- iframe-postMessage hook ----------------------------------------
function installIframeBridge() {
    window.addEventListener('message', (event) => {
        if (event.data && event.data.type === 'notification' && event.data.message === 'toggle') {
            toggleIframe();
        }
        if (event.data === 'save') {
            event.source.postMessage({ type: 'response', payload: 'Saving now via origin ' + event.origin }, event.origin);
            saveFileRemote(state.currentPost);
        }
    });
}

// ----- One-time page setup driven by URL params -----------------------
function applyParamFlags() {
    const rawTopOffset = params['top-offset'] || params['topoffset'] || params['top_offset'];
    document.documentElement.style.setProperty('--top-offset', `${Number(rawTopOffset) || 0}px`);

    if (Number(params.noclock)) {
        const clockEl = document.getElementById('clock');
        const dateEl = document.getElementById('date');
        if (clockEl) clockEl.style.display = 'none';
        if (dateEl) dateEl.style.display = 'none';
        moveButtonsToTop('15px', '15px');
    }

    if (Number(params.nosensors)) {
        const sensorsEl = document.getElementById('sensors');
        if (sensorsEl) sensorsEl.style.display = 'none';
    }

    if (Number(params.nobutton)) {
        document.querySelectorAll('.toggle-button, .block-picture-button, .change-tagset-button')
            .forEach((el) => { el.style.display = 'none'; });
    } else if (homeEndpoint) {
        const iframe = document.getElementById('ha-iframe');
        if (iframe) iframe.src = homeEndpoint;
    }

    if (Number(params.nobg)) document.body.style.backgroundColor = 'transparent';
    if (Number(params.list)) tags.set(Number(params.list));
    if (Number(params.delay)) state.interval = Number(params.delay) * 1000;

    if (Number(params.static)) {
        const style = document.createElement('style');
        style.innerHTML = `
            .fullscreen-media { animation: none !important; transform: translateX(-50%) !important; }
            .fullscreen-media.alt-fit { animation: none !important; transform: none !important; }
        `;
        document.head.appendChild(style);
    }
}

export function bootUi() {
    state.mediaContainer = document.querySelector('.fullscreen-container');
    if (state.mediaContainer) {
        state.mediaContainer.onclick = () => {
            if (wakeLock === null) requestWakeLock();
        };
    }

    applyParamFlags();
    installKeyboard();
    installVisibilityHandlers();
    installIframeBridge();
    installCursorHide();

    updateClock();
    if (!Number(params.noclock)) {
        setInterval(updateClock, 1000);
    }

    window.addEventListener('unload', () => {
        if (state.deviceID) {
            navigator.sendBeacon(
                // /rpc/deviceDC is on the server; the api() helper isn't
                // imported here on purpose — sendBeacon uses raw URLs only.
                `${location.origin}${location.pathname.replace(/\/[^\/]*$/, '')}/rpc/deviceDC`,
                JSON.stringify({ target: state.deviceID }),
            );
        }
    });
}

// Inline button handlers in the HTML reach these via window.* bindings.
window.toggleIframe = toggleIframe;
window.blockPost = blockPost;
