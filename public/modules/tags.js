// Client-side tag list manager.
//
// The server is authoritative on the tag-list catalog and the active list
// index. Local state is a cache of the last server push.
//   - `setLists(arr)` is called by the WS dispatcher on `tagLists` frames.
//   - `applyServer(n)` is called on `currentTagList` / `playback.currentList`.
//   - `set(n)` and `switch()` are user-action paths; they emit `setTagList`
//     to the server and let the server's broadcast confirm the change.
//   - Mod tags are local user choices, forwarded to the server via
//     `setModTags`. The orchestrator uses them in the DuckDB query for
//     this client's channel (last-write-wins among same-channel sessions).

import { api, params } from './config.js';
import { state } from './state.js';
import { showToast } from './toast.js';

class Tags {
    constructor() {
        this._readyResolve = null;
        this.ready = new Promise((resolve) => { this._readyResolve = resolve; });
        this.tagsList = null;

        this.currentTagsList = 0;
        const stored = localStorage.getItem('currentList');
        if (stored !== null) this.currentTagsList = Number(stored);

        // Mod tags persist locally — survive page reloads so the user
        // doesn't have to retype them. Bundled with slideshowConfig on
        // WS open so the orchestrator's first refill query reflects them.
        this.modTags = [];
        try {
            const raw = localStorage.getItem('modTags');
            if (raw) {
                const parsed = JSON.parse(raw);
                if (Array.isArray(parsed)) this.modTags = parsed.map(String).filter(Boolean);
            }
        } catch (_) { /* corrupted entry — start fresh */ }

        // For non-WS launches we still hand the user the list catalog so the
        // UI labels render — but with no socket they can't drive the slideshow.
        if (!params.ws) {
            fetch(api('/rpc/tags.json'))
                .then((r) => r.ok ? r.json() : Promise.reject(new Error(`HTTP ${r.status}`)))
                .then((data) => this.setLists(data))
                .catch((err) => {
                    console.error('Failed to load /rpc/tags.json:', err);
                    this.setLists([['rating:s']]);
                });
        }
    }

    setLists(data) {
        const normalized = Array.isArray(data) ? data.map((entry) =>
            Array.isArray(entry) ? entry.map(String) :
            typeof entry === 'string' ? entry.split(/\s+/).filter(Boolean) :
            []
        ) : [];
        this.tagsList = normalized.length ? normalized : [['rating:s']];
        if (this.currentTagsList >= this.tagsList.length) {
            this.currentTagsList = 0;
            localStorage.setItem('currentList', '0');
        }
        if (this._readyResolve) {
            this._readyResolve();
            this._readyResolve = null;
        }
    }

    addTag(tag) {
        if (!this.modTags.includes(tag)) {
            this.modTags.push(tag);
            this._sendModTags();
        }
    }

    removeTag(tag) {
        const idx = this.modTags.indexOf(tag);
        if (idx === -1) {
            showToast('No such tag to remove.');
            return;
        }
        this.modTags.splice(idx, 1);
        this._sendModTags();
    }

    _sendModTags() {
        try { localStorage.setItem('modTags', JSON.stringify(this.modTags)); }
        catch (_) { /* quota or private-mode failure — keep in-memory copy */ }
        if (state.socket && state.socket.readyState === WebSocket.OPEN) {
            state.socket.send(JSON.stringify({
                sessionId: 'main',
                action: 'setModTags',
                payload: { tags: this.modTags },
            }));
        }
    }

    // Server-driven update — no echo back to the server.
    applyServer(n) {
        const idx = Number(n);
        if (!this.tagsList || idx < 0 || idx >= this.tagsList.length) return;
        if (idx === this.currentTagsList) return;
        this.currentTagsList = idx;
        localStorage.setItem('currentList', String(idx));
    }

    async set(n) {
        if (!this.tagsList) {
            try { await this.ready; } catch (_) { /* ignore */ }
        }
        const idx = Number(n);
        if (idx === this.currentTagsList) return;
        if (idx < 0 || idx >= this.tagsList.length) {
            showToast('Tag list out of bounds.');
            return;
        }
        this.currentTagsList = idx;
        localStorage.setItem('currentList', String(idx));
        if (state.socket && state.socket.readyState === WebSocket.OPEN) {
            state.socket.send(JSON.stringify({ action: 'setTagList', payload: { listNumber: idx } }));
        }
        showToast(`Switched to list ${idx}: ${this.tagsList[idx][0] || ''}`);
    }

    async switch() {
        if (!this.tagsList) {
            try { await this.ready; } catch (_) { /* ignore */ }
        }
        const next = (this.currentTagsList + 1) % this.tagsList.length;
        await this.set(next);
    }

    getTags() {
        const base = (this.tagsList && this.tagsList[this.currentTagsList]) ? this.tagsList[this.currentTagsList] : [];
        return [...this.modTags, ...base].join(' ');
    }
}

export const tags = new Tags();
// Expose for the inline `onclick="tags.switch()"` button handlers in index.html.
window.tags = tags;
