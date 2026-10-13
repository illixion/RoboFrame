// Page chrome: clock, wake-lock, keyboard shortcuts, cursor auto-hide,
// home-iframe toggle, button positioning. Anything that's neither slideshow
// nor RPC effect lands here.

import { params, homeEndpoint, api, resolveOpacity } from './config.js';
import { state } from './state.js';
import { tags } from './tags.js';
import { showToast } from './toast.js';
import { disable } from './visibility.js';
import { blockPost, saveFileRemote, requestNext, requestPrev, requestReshuffle } from './slideshow.js';
import { sendDisplaySync } from './ws-client.js';
import { openSettings, isSettingsOpen, setOpacity } from './settings.js';

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

// ----- Custom page iframe (P key) -------------------------------------
// P toggles between photo slideshow and a fullscreen iframe pointing at
// /custom_page, which serves a random .htm/.html file from a per-install
// folder. Each toggle-on cache-busts the URL so a new random page lands.
// Slideshow is suspended via state.forceDisable while the iframe is up.
function toggleCustomPage() {
    const iframe = document.getElementById('custom-page-iframe');
    if (!iframe) return;
    const turningOn = !state.forceDisable;
    if (turningOn) {
        iframe.src = api(`/custom_page?_=${Date.now()}`);
        iframe.style.display = 'block';
    } else {
        iframe.style.display = 'none';
        iframe.src = 'about:blank';
    }
    state.forceDisable = turningOn;
    disable(turningOn, true);
}

// ----- Button positioning when noclock is set -------------------------
const CORNER_BUTTONS = ['.toggle-button', '.block-picture-button', '.change-tagset-button', '.settings-button'];

function moveButtonsToTop(spacingTop = '15px', spacingLeft = '15px', spacingBetween = '15px') {
    let top = parseInt(spacingTop, 10);
    for (const selector of CORNER_BUTTONS) {
        const btn = document.querySelector(selector);
        if (!btn) continue;
        btn.style.top = `${top}px`;
        btn.style.left = spacingLeft;
        top += btn.offsetHeight + parseInt(spacingBetween, 10);
    }
}

// ----- Long-press → settings ------------------------------------------
// A touch tablet launched with `nobutton=1` has no ⚙️ and no keyboard, so a
// one-second press on the photo opens the panel too.
function installLongPress() {
    const LONG_PRESS_MS = 1000;
    let timer = null;
    let origin = null;
    const cancel = () => { clearTimeout(timer); timer = null; origin = null; };
    document.addEventListener('pointerdown', (event) => {
        if (!event.target.closest || !event.target.closest('.fullscreen-container')) return;
        cancel();
        origin = { x: event.clientX, y: event.clientY };
        timer = setTimeout(() => { cancel(); openSettings(); }, LONG_PRESS_MS);
    });
    document.addEventListener('pointermove', (event) => {
        if (origin && Math.hypot(event.clientX - origin.x, event.clientY - origin.y) > 12) cancel();
    });
    document.addEventListener('pointerup', cancel);
    document.addEventListener('pointercancel', cancel);
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

        // The settings panel owns the keyboard while it's open (it handles
        // its own Escape), and typing into any field is never a shortcut.
        if (isSettingsOpen()) return;
        const target = event.target;
        if (target && (target.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(target.tagName))) return;
        if (event.metaKey || event.ctrlKey || event.altKey) return;

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
            setOpacity(Number(key) * 10);
            return;
        }
        if (key === '0') {
            setOpacity(100);
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
            case 'o':
                event.preventDefault();
                openSettings();
                break;
            case 'a':
            case 'r':
                // Mod tags are added and removed as chips in the panel.
                event.preventDefault();
                openSettings({ focus: 'modtags' });
                break;
            case 't':
                requestReshuffle();
                showToast('Reshuffling random order');
                break;
            case 'p':
                toggleCustomPage();
                break;
            case 'ArrowRight':
                requestNext();
                break;
            case 'ArrowLeft':
                requestPrev();
                break;
            case 'q':
                if (typeof window.AuthOverlay !== 'undefined' && window.AuthOverlay.show) window.AuthOverlay.show();
                break;
        }
    });
}

// ----- Tab-visibility → display gate ----------------------------------
// A hidden browser tab gates the slideshow off (disable → rf:showingchange →
// ws-client reports `present=false`, so the channel dark-advances/parks). It
// does NOT report `visibility`: tab state says nothing about room occupancy,
// which is the motion sensor's job (driven by the PIR agent only). Keeping
// these separate is the present/visibility separation of concerns.
function installVisibilityHandlers() {
    document.addEventListener('visibilitychange', () => {
        disable(document.hidden);
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
        document.querySelectorAll(CORNER_BUTTONS.join(', '))
            .forEach((el) => { el.style.display = 'none'; });
    } else if (homeEndpoint) {
        const iframe = document.getElementById('ha-iframe');
        if (iframe) iframe.src = homeEndpoint;
    }

    if (Number(params.nobg)) document.body.style.backgroundColor = 'transparent';
    if (state.mediaContainer) state.mediaContainer.style.opacity = String(resolveOpacity() / 100);
    if (Number(params.list)) tags.set(Number(params.list));
    if (Number(params.delay)) state.interval = Number(params.delay) * 1000;

    if (Number(params.static)) {
        const style = document.createElement('style');
        style.innerHTML = `
            .fullscreen-media { animation: none !important; transform: translateX(-50%) !important; }
            .fullscreen-media.fit-contain,
            .fullscreen-media.fit-cover { animation: none !important; transform: none !important; }
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
    installLongPress();

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
window.openSettings = openSettings;
