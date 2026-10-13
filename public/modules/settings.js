// Settings panel: every user-facing kiosk setting in one overlay.
//
// Values come from three places, highest first: what was saved in this panel
// (localStorage `roboframe.settings`, merged into `params` by config.js at
// load), the launch URL, then the built-in default. Kiosks are launched from
// a fixed bookmarked / launcher URL, so a saved choice has to outrank the URL
// to survive a relaunch. Only fields the person changed are stored.
//
// Most settings shape the page at boot (fit, overlay, image variant, night
// light), so they apply with "Save & reload". Brightness, the tag list, mod
// tags and display sync are runtime state and apply immediately; the tag
// list and mod tags keep living in tags.js's own storage.
//
// Connection plumbing (token, endpoint, wsurl, homeendpoint) never appears
// here: it stays in the URL. The device id is shown read-only.
//
// Opened by the ⚙️ button, the `o` key, `a` / `r` (focused on mod tags) and a
// long press on the photo. While open, ui.js's shortcuts stand down.

import {
    params, urlValues, storedSettings, readStoredSettings, writeStoredSettings,
    resolveOpacity, getScreenSize, FITS,
} from './config.js';
import { state } from './state.js';
import { tags } from './tags.js';
import { sendDisplaySync } from './ws-client.js';
import { showToast } from './toast.js';

// ----- Field schema ------------------------------------------------------

const ALIASES = { 'top-offset': ['top-offset', 'topoffset', 'top_offset'] };

const SECTIONS = [
    {
        id: 'slideshow', title: 'Slideshow',
        fields: [
            { key: 'delay', label: 'Seconds per photo', hint: 'The server can still set its own pace for this channel.', type: 'stepper', min: 3, max: 3600, step: 1, unit: 's', default: '15' },
            { key: 'static', label: 'Ken Burns motion', hint: 'Slow zoom toward the most detailed part of each photo.', type: 'toggle', invert: true, default: '0' },
            {
                key: 'fit', label: 'Photo fit', type: 'segmented',
                options: [
                    { value: 'height', label: 'Fill height', hint: 'Fills the height and crops the sides.' },
                    { value: 'contain', label: 'Whole photo', hint: 'Shows the entire photo with bars.' },
                    { value: 'cover', label: 'Fill screen', hint: 'Fills the screen edge to edge, cropping as needed.' },
                ],
                defaultOf: (v) => (Number(v('noclock')) ? 'contain' : 'height'),
            },
            { key: 'blurbg', label: 'Blurred background', hint: 'A soft, dimmed copy of the photo behind the bars. Off by default on low-memory kiosks.', type: 'toggle', defaultOf: (v) => (Number(v('lowmem')) === 1 ? '0' : '1') },
        ],
    },
    {
        id: 'overlay', title: 'Overlay',
        fields: [
            { key: 'noclock', label: 'Clock and date', type: 'toggle', invert: true, default: '0' },
            { key: 'nosensors', label: 'Sensor readout', type: 'toggle', invert: true, default: '0' },
            { key: 'nobutton', label: 'Corner buttons', hint: 'Without them, open settings with O or a long press on the photo.', type: 'toggle', invert: true, default: '0' },
            { key: 'nobg', label: 'Transparent page background', type: 'toggle', default: '0' },
            { key: 'top-offset', label: 'Top offset', hint: 'Room for a notch or TV overscan.', type: 'stepper', min: 0, max: 400, step: 2, unit: 'px', default: '0' },
        ],
    },
    {
        id: 'brightness', title: 'Brightness', live: true,
        fields: [
            { key: 'opacity', label: 'Photo brightness', hint: 'Digit keys 1–9 and 0 set this too.', type: 'range', min: 10, max: 100, step: 5, unit: '%', default: '100', live: true },
        ],
    },
    {
        id: 'image', title: 'Image',
        fields: [
            { key: 'bright', label: 'Ambient dim', hint: 'Darkens every image at the server, for a dim room.', type: 'toggle', default: '0' },
            { key: 'convert', label: 'Convert to JPEG', hint: 'For browsers that can’t decode JPEG XL.', type: 'toggle', default: '0' },
            { key: 'lowmem', label: 'Low-memory mode', hint: 'Prefetches one image ahead and asks for lighter files. For Pi-class kiosks.', type: 'toggle', default: '0' },
            { key: 'wallpaper', label: 'Wallpaper composition', hint: 'The server fits each frame to the screen exactly. Implies the ratio filter.', type: 'toggle', default: '0' },
            { key: 'ratio', label: 'Prefer matching shapes', hint: 'Favours photos close to this screen’s aspect ratio.', type: 'toggle', default: '0' },
            { key: 'width', label: 'Width override', hint: 'Set both, or leave blank to use the screen.', type: 'number', min: 0, max: 16384, unit: 'px', default: '', placeholder: () => String(Math.round(getScreenSize().width)) },
            { key: 'height', label: 'Height override', type: 'number', min: 0, max: 16384, unit: 'px', default: '', placeholder: () => String(Math.round(getScreenSize().height)) },
        ],
    },
    {
        id: 'nightlight', title: 'Night light',
        fields: [
            { key: 'nightlight', label: 'Night light', hint: 'Turns on ambient dim between the two times below.', type: 'toggle', default: '1' },
            { key: 'nightlightstart', label: 'Starts', type: 'time', default: '' },
            { key: 'nightlightend', label: 'Ends', type: 'time', default: '' },
        ],
    },
];

const FIELDS = new Map();
for (const section of SECTIONS) for (const f of section.fields) FIELDS.set(f.key, f);

// ----- Value model ------------------------------------------------------

let draft = {};        // the overrides as edited in the panel
let confirmDiscard = false;
let confirmResetAll = false;

function urlValueOf(key) {
    for (const name of ALIASES[key] || [key]) {
        if (urlValues[name] !== undefined) return urlValues[name];
    }
    return undefined;
}

function defaultOf(key) {
    const f = FIELDS.get(key);
    if (f && f.defaultOf) return f.defaultOf(valueOf);
    return f ? f.default : '';
}

function valueOf(key) {
    if (draft[key] !== undefined) return draft[key];
    const u = urlValueOf(key);
    if (u !== undefined) return u;
    return defaultOf(key);
}

function sourceOf(key) {
    if (draft[key] !== undefined) return 'panel';
    if (urlValueOf(key) !== undefined) return 'url';
    return 'default';
}

// Fields whose saved value differs from the one this page was loaded with.
function pendingKeys() {
    const keys = new Set([...Object.keys(draft), ...Object.keys(storedSettings)]);
    return [...keys].filter((k) => !FIELDS.get(k)?.live && k !== 'list' && draft[k] !== storedSettings[k]);
}

// Live fields go to storage straight away, without the unsaved draft.
function persistLive(key, value) {
    const stored = readStoredSettings();
    if (value === undefined) delete stored[key];
    else stored[key] = value;
    if (!writeStoredSettings(stored)) showToast('Couldn’t save on this device');
}

// ----- Live setters -----------------------------------------------------

function applyOpacity(pct) {
    if (state.mediaContainer) state.mediaContainer.style.opacity = String(pct / 100);
}

// Shared with the digit-key shortcuts in ui.js.
export function setOpacity(pct) {
    const value = String(resolveOpacity({ opacity: pct }));
    applyOpacity(Number(value));
    persistLive('opacity', value);
    if (isSettingsOpen()) { draft.opacity = value; renderField('opacity'); }
}

// ----- DOM helpers ------------------------------------------------------

function h(tag, attrs = {}, ...children) {
    const el = document.createElement(tag);
    for (const [k, v] of Object.entries(attrs)) {
        if (v === undefined || v === null || v === false) continue;
        if (k === 'class') el.className = v;
        else if (k === 'text') el.textContent = v;
        else if (k.startsWith('on')) el.addEventListener(k.slice(2), v);
        else if (v === true) el.setAttribute(k, '');
        else el.setAttribute(k, String(v));
    }
    for (const c of children.flat(Infinity)) {
        if (c === null || c === undefined || c === false) continue;
        el.appendChild(typeof c === 'string' ? document.createTextNode(c) : c);
    }
    return el;
}

let root = null;
let bodyEl = null;
let statusEl = null;
let saveBtn = null;
let resetAllBtn = null;

const SOURCE_LABEL = { panel: 'Saved here', url: 'From URL', default: 'Default' };

function sourceBadge(key) {
    const src = sourceOf(key);
    const unsaved = !FIELDS.get(key)?.live && draft[key] !== storedSettings[key];
    return h('span', { class: `rf-source rf-source-${src}`, title: sourceTitle(key, src) },
        SOURCE_LABEL[src], unsaved ? h('span', { class: 'rf-unsaved', 'aria-label': 'unsaved' }, ' •') : null);
}

function sourceTitle(key, src) {
    if (src === 'panel') {
        const u = urlValueOf(key);
        return u !== undefined ? `Overrides the URL value “${u}”` : 'Overrides the default';
    }
    if (src === 'url') return 'Set by the launch URL';
    return 'Built-in default';
}

function setDraft(key, value) {
    draft[key] = value;
    confirmDiscard = false;
    const f = FIELDS.get(key);
    if (f && f.live) persistLive(key, value);
    if (key === 'opacity') applyOpacity(resolveOpacity({ opacity: value }));
    // Dependent defaults (fit follows the clock, blur follows low-memory).
    renderField(key);
    if (key === 'noclock') renderField('fit');
    if (key === 'lowmem') renderField('blurbg');
    updateFooter();
}

function resetField(key) {
    delete draft[key];
    confirmDiscard = false;
    const f = FIELDS.get(key);
    if (f && f.live) persistLive(key, undefined);
    if (key === 'opacity') applyOpacity(resolveOpacity({ opacity: valueOf('opacity') }));
    renderField(key);
    if (key === 'noclock') renderField('fit');
    if (key === 'lowmem') renderField('blurbg');
    updateFooter();
}

function controlFor(f) {
    const value = valueOf(f.key);
    const id = `rf-set-${f.key}`;
    switch (f.type) {
        case 'toggle': {
            const on = f.invert ? !Number(value) : !!Number(value);
            return h('label', { class: 'rf-switch' },
                h('input', {
                    type: 'checkbox', id, role: 'switch', checked: on,
                    onchange: (e) => setDraft(f.key, (e.target.checked !== !!f.invert) ? '1' : '0'),
                }),
                h('span', { class: 'rf-switch-track', 'aria-hidden': 'true' }, h('span', { class: 'rf-switch-knob' })));
        }
        case 'segmented': {
            const current = FITS.includes(String(value)) ? String(value) : defaultOf(f.key);
            return h('div', { class: 'rf-segmented', role: 'radiogroup', 'aria-labelledby': `${id}-label` },
                f.options.map((o) => h('button', {
                    type: 'button', role: 'radio', class: o.value === current ? 'is-selected' : '',
                    'aria-checked': o.value === current ? 'true' : 'false', title: o.hint,
                    onclick: () => setDraft(f.key, o.value),
                }, o.label)));
        }
        case 'range': {
            const n = resolveOpacity({ opacity: value });
            const out = h('output', { class: 'rf-range-value', for: id }, `${n}${f.unit}`);
            return h('div', { class: 'rf-range' },
                h('input', {
                    type: 'range', id, min: f.min, max: f.max, step: f.step, value: n,
                    oninput: (e) => {
                        out.textContent = `${e.target.value}${f.unit}`;
                        applyOpacity(Number(e.target.value));
                    },
                    onchange: (e) => setDraft(f.key, String(e.target.value)),
                }),
                out);
        }
        case 'stepper': {
            const clamp = (n) => Math.min(f.max, Math.max(f.min, n));
            const input = h('input', {
                type: 'number', id, inputmode: 'numeric', min: f.min, max: f.max, step: f.step,
                value: Number(value) || 0,
                onchange: (e) => {
                    const n = Number(e.target.value);
                    setDraft(f.key, String(clamp(Number.isFinite(n) ? n : Number(defaultOf(f.key)))));
                },
            });
            const bump = (dir) => () => {
                const base = Number(input.value) || 0;
                const big = f.unit === 's' && base >= 60 ? 15 : f.step;
                setDraft(f.key, String(clamp(base + dir * big)));
            };
            return h('div', { class: 'rf-stepper' },
                h('button', { type: 'button', 'aria-label': `Decrease ${f.label}`, onclick: bump(-1) }, '−'),
                input,
                h('span', { class: 'rf-unit' }, f.unit),
                h('button', { type: 'button', 'aria-label': `Increase ${f.label}`, onclick: bump(1) }, '+'));
        }
        case 'number': {
            return h('div', { class: 'rf-number' },
                h('input', {
                    type: 'number', id, inputmode: 'numeric', min: f.min, max: f.max,
                    value: value === '' ? '' : Number(value) || '',
                    placeholder: f.placeholder ? f.placeholder() : '',
                    onchange: (e) => {
                        const n = Number(e.target.value);
                        setDraft(f.key, e.target.value === '' || !(n > 0) ? '' : String(Math.round(n)));
                    },
                }),
                h('span', { class: 'rf-unit' }, f.unit));
        }
        case 'time': {
            return h('input', {
                type: 'time', id, class: 'rf-time', value: /^\d{1,2}:\d{2}$/.test(value) ? value.padStart(5, '0') : '',
                onchange: (e) => setDraft(f.key, e.target.value || ''),
            });
        }
        default:
            return h('span', {}, String(value));
    }
}

function fieldRow(f) {
    const canReset = draft[f.key] !== undefined;
    const fallback = urlValueOf(f.key) !== undefined ? 'the URL value' : 'the default';
    return h('div', { class: 'rf-row', 'data-key': f.key },
        h('div', { class: 'rf-label' },
            h('div', { class: 'rf-label-line' },
                h('label', { id: `rf-set-${f.key}-label`, for: f.type === 'segmented' ? null : `rf-set-${f.key}` }, f.label),
                sourceBadge(f.key)),
            f.hint ? h('div', { class: 'rf-hint' }, f.hint) : null),
        h('div', { class: 'rf-control' }, controlFor(f)),
        h('button', {
            type: 'button', class: 'rf-reset', disabled: !canReset,
            title: canReset ? `Reset to ${fallback}` : 'Nothing saved here',
            'aria-label': `Reset ${f.label}`,
            onclick: () => resetField(f.key),
        }, '↺'));
}

function renderField(key) {
    if (!bodyEl) return;
    const f = FIELDS.get(key);
    const old = bodyEl.querySelector(`.rf-row[data-key="${CSS.escape(key)}"]`);
    if (!f || !old) return;
    // Re-rendering replaces the controls, so carry focus over to the same
    // position in the new row (a stepper's + keeps focus across presses).
    const focusables = (el) => [...el.querySelectorAll('input, button')];
    const focusIdx = focusables(old).indexOf(document.activeElement);
    const row = fieldRow(f);
    old.replaceWith(row);
    if (focusIdx >= 0) {
        const el = focusables(row)[focusIdx];
        if (el && !el.disabled) el.focus({ preventScroll: true });
        else if (bodyEl) root.querySelector('.rf-close')?.focus({ preventScroll: true });
    }
}

// ----- Runtime sections (tags, sync, device) ----------------------------

function tagListSection() {
    const wrap = h('div', { class: 'rf-row rf-row-block' });
    const fill = () => {
        wrap.replaceChildren(
            h('div', { class: 'rf-label' },
                h('div', { class: 'rf-label-line' }, h('span', { class: 'rf-label-text' }, 'Tag list')),
                h('div', { class: 'rf-hint' }, 'Which of the server’s lists this display draws from.')));
        if (!tags.tagsList) {
            wrap.appendChild(h('div', { class: 'rf-hint' }, 'Loading lists…'));
            tags.ready.then(() => { if (isSettingsOpen()) fill(); });
            return;
        }
        wrap.appendChild(h('div', { class: 'rf-chooser', role: 'radiogroup', 'aria-label': 'Tag list' },
            tags.tagsList.map((list, i) => {
                const selected = i === tags.currentTagsList;
                return h('button', {
                    type: 'button', role: 'radio', class: selected ? 'is-selected' : '',
                    'aria-checked': selected ? 'true' : 'false', title: list.join(' '),
                    onclick: async () => {
                        await tags.set(i);
                        // A URL `list=` is applied on every boot; a saved
                        // copy keeps that from undoing this choice.
                        if (urlValues.list !== undefined) { draft.list = String(i); persistLive('list', String(i)); }
                        fill();
                        refreshQueryPreview();
                    },
                }, h('span', { class: 'rf-chooser-index' }, String(i)), h('span', { class: 'rf-chooser-label' }, list[0] || '(empty)'));
            })));
    };
    fill();
    return wrap;
}

let queryPreviewEl = null;
function refreshQueryPreview() {
    if (queryPreviewEl) queryPreviewEl.textContent = tags.getTags() || '—';
}

function modTagsSection() {
    const chips = h('div', { class: 'rf-chips', 'aria-live': 'polite' });
    const input = h('input', {
        type: 'text', id: 'rf-modtag-input', class: 'rf-text', placeholder: 'Add a tag, e.g. rating:s',
        autocomplete: 'off', autocapitalize: 'off', spellcheck: 'false', enterkeyhint: 'done',
        onkeydown: (e) => { if (e.key === 'Enter') { e.preventDefault(); add(); } },
    });
    const renderChips = () => {
        chips.replaceChildren(...(tags.modTags.length ? tags.modTags.map((t) => h('span', { class: 'rf-chip' },
            h('span', { class: 'rf-chip-text' }, t),
            h('button', {
                type: 'button', class: 'rf-chip-remove', 'aria-label': `Remove ${t}`,
                onclick: () => { tags.removeTag(t); renderChips(); refreshQueryPreview(); input.focus(); },
            }, '×'))) : [h('span', { class: 'rf-hint' }, 'No mod tags. They narrow or extend the list’s query on this display.')]));
    };
    const add = () => {
        const words = input.value.split(/\s+/).map((w) => w.trim()).filter(Boolean);
        for (const w of words) tags.addTag(w);
        input.value = '';
        renderChips();
        refreshQueryPreview();
    };
    renderChips();
    queryPreviewEl = h('code', { class: 'rf-query' });
    refreshQueryPreview();
    return h('div', { class: 'rf-row rf-row-block', id: 'rf-modtags' },
        h('div', { class: 'rf-label' },
            h('div', { class: 'rf-label-line' }, h('label', { for: 'rf-modtag-input' }, 'Mod tags')),
            h('div', { class: 'rf-hint' }, 'Prefix a tag with - to exclude it.')),
        chips,
        h('div', { class: 'rf-add' }, input, h('button', { type: 'button', class: 'rf-btn', onclick: add }, 'Add')),
        h('div', { class: 'rf-hint rf-query-line' }, 'Query: ', queryPreviewEl));
}

function syncRow() {
    const connected = state.socket && state.socket.readyState === WebSocket.OPEN;
    return h('div', { class: 'rf-row' },
        h('div', { class: 'rf-label' },
            h('div', { class: 'rf-label-line' }, h('label', { for: 'rf-sync' }, 'Display sync')),
            h('div', { class: 'rf-hint' }, connected
                ? 'Every display follows this one’s slideshow until turned off.'
                : 'Not connected to the server.')),
        h('div', { class: 'rf-control' },
            h('label', { class: 'rf-switch' },
                h('input', {
                    type: 'checkbox', id: 'rf-sync', role: 'switch', checked: !!state.isPrimary, disabled: !connected,
                    onchange: (e) => {
                        state.isPrimary = e.target.checked;
                        sendDisplaySync(state.isPrimary);
                        showToast(`Display Sync ${state.isPrimary ? 'ON' : 'OFF'}`);
                    },
                }),
                h('span', { class: 'rf-switch-track', 'aria-hidden': 'true' }, h('span', { class: 'rf-switch-knob' })))),
        h('span', { class: 'rf-reset-spacer' }));
}

function deviceRow() {
    const { width, height } = getScreenSize();
    return h('div', { class: 'rf-row rf-row-info' },
        h('div', { class: 'rf-label' },
            h('div', { class: 'rf-label-line' }, h('span', { class: 'rf-label-text' }, 'Device id')),
            h('div', { class: 'rf-hint' }, 'Token and server addresses come from the launch URL.')),
        h('div', { class: 'rf-control' }, h('code', { class: 'rf-readonly' }, params.ws || 'not set'),
            h('span', { class: 'rf-hint rf-screen' }, `${Math.round(width)}×${Math.round(height)}`)),
        h('span', { class: 'rf-reset-spacer' }));
}

// ----- Panel ------------------------------------------------------------

function section(title, { live = false, id } = {}, ...rows) {
    return h('section', { class: 'rf-section', 'data-section': id },
        h('h3', {}, title, live ? h('span', { class: 'rf-live' }, 'Applies now') : null),
        h('div', { class: 'rf-card' }, rows));
}

function renderBody() {
    const fieldSection = (s) => section(s.title, { live: s.live, id: s.id }, s.fields.map(fieldRow));
    bodyEl.replaceChildren(
        fieldSection(SECTIONS[0]),
        fieldSection(SECTIONS[2]),
        section('Tags', { live: true, id: 'tags' }, tagListSection(), modTagsSection()),
        fieldSection(SECTIONS[1]),
        fieldSection(SECTIONS[3]),
        fieldSection(SECTIONS[4]),
        section('Sync', { live: true, id: 'sync' }, syncRow()),
        section('Device', { id: 'device' }, deviceRow()),
    );
}

function updateFooter() {
    const pending = pendingKeys();
    saveBtn.disabled = pending.length === 0;
    if (confirmResetAll) {
        statusEl.textContent = 'Clears everything saved here and reloads. Tap again to confirm.';
    } else if (confirmDiscard) {
        statusEl.textContent = 'Unsaved changes. Close again to discard them.';
    } else if (pending.length) {
        statusEl.textContent = pending.length === 1 ? '1 change applies on reload' : `${pending.length} changes apply on reload`;
    } else {
        statusEl.textContent = 'Saved on this device; outranks the launch URL.';
    }
    resetAllBtn.classList.toggle('is-armed', confirmResetAll);
    resetAllBtn.textContent = confirmResetAll ? 'Confirm reset' : 'Reset all';
    const anything = Object.keys(draft).length > 0 || Object.keys(readStoredSettings()).length > 0;
    resetAllBtn.disabled = !anything && !confirmResetAll;
}

function saveAndReload() {
    if (!writeStoredSettings(draft)) {
        showToast('Couldn’t save on this device');
        return;
    }
    location.reload();
}

function resetAll() {
    if (!confirmResetAll) {
        confirmResetAll = true;
        updateFooter();
        return;
    }
    writeStoredSettings({});
    location.reload();
}

function build() {
    bodyEl = h('div', { class: 'rf-body' });
    statusEl = h('span', { class: 'rf-status', 'aria-live': 'polite' });
    saveBtn = h('button', { type: 'button', class: 'rf-btn rf-btn-primary', onclick: saveAndReload }, 'Save & reload');
    resetAllBtn = h('button', { type: 'button', class: 'rf-btn rf-btn-quiet', onclick: resetAll }, 'Reset all');
    const panel = h('div', { class: 'rf-panel', role: 'dialog', 'aria-modal': 'true', 'aria-labelledby': 'rf-title' },
        h('header', { class: 'rf-header' },
            h('div', {},
                h('h2', { id: 'rf-title' }, 'Settings'),
                h('div', { class: 'rf-subtitle' }, 'Photo frame on this screen')),
            h('button', { type: 'button', class: 'rf-close', 'aria-label': 'Close settings', onclick: () => closeSettings() }, '×')),
        bodyEl,
        h('footer', { class: 'rf-footer' }, resetAllBtn, statusEl, saveBtn));
    root = h('div', {
        class: 'rf-overlay', hidden: true,
        onclick: (e) => { if (e.target === root) closeSettings(); },
    }, panel);
    // On the document, not the panel: focus can sit on <body> after a click
    // on a non-focusable part of the panel.
    document.addEventListener('keydown', (e) => { if (isSettingsOpen()) onPanelKey(e); });
    // Keep presses inside the panel from starting the photo long-press.
    root.addEventListener('pointerdown', (e) => e.stopPropagation());
    document.body.appendChild(root);
}

function onPanelKey(e) {
    if (e.key === 'Escape') {
        e.preventDefault();
        if (confirmResetAll) { confirmResetAll = false; updateFooter(); return; }
        closeSettings();
        return;
    }
    if (e.key === 'Tab') {
        // Keep focus inside the dialog.
        const focusable = [...root.querySelectorAll('button:not([disabled]), input:not([disabled]), [tabindex]:not([tabindex="-1"])')]
            .filter((el) => el.offsetParent !== null);
        if (!focusable.length) return;
        const first = focusable[0];
        const last = focusable[focusable.length - 1];
        if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last.focus(); }
        else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); }
    }
}

export function isSettingsOpen() {
    return !!root && !root.hidden;
}

export function openSettings({ focus } = {}) {
    if (!root) build();
    const reopening = isSettingsOpen();
    if (!reopening) {
        draft = readStoredSettings();
        confirmDiscard = false;
        confirmResetAll = false;
        renderBody();
        updateFooter();
        root.hidden = false;
        document.body.classList.add('rf-settings-open');
    }
    if (focus === 'modtags') {
        const target = root.querySelector('#rf-modtags');
        if (target) target.scrollIntoView({ block: 'center', behavior: reopening ? 'smooth' : 'auto' });
        const input = root.querySelector('#rf-modtag-input');
        if (input) input.focus({ preventScroll: true });
    } else if (!reopening) {
        bodyEl.scrollTop = 0;
        const close = root.querySelector('.rf-close');
        if (close) close.focus({ preventScroll: true });
    }
}

export function closeSettings({ force = false } = {}) {
    if (!isSettingsOpen()) return;
    if (!force && pendingKeys().length && !confirmDiscard) {
        confirmDiscard = true;
        updateFooter();
        return;
    }
    // Discarded edits to boot-time fields fall back to what's applied; live
    // brightness is already stored, so re-apply that.
    applyOpacity(resolveOpacity({ opacity: readStoredSettings().opacity ?? valueOfUrlOrDefault('opacity') }));
    root.hidden = true;
    document.body.classList.remove('rf-settings-open');
    draft = {};
    queryPreviewEl = null;
    // Leave nothing focused: a focused corner button would turn the next
    // Space (save) into a click.
    if (document.activeElement && document.activeElement !== document.body) document.activeElement.blur();
}

function valueOfUrlOrDefault(key) {
    const u = urlValueOf(key);
    return u !== undefined ? u : defaultOf(key);
}

window.openSettings = openSettings;
