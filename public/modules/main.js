// Bootstrap entry. Imported as a single <script type="module"> from
// index.html. Pulls every other module in (their top-level code wires the
// pieces together) and kicks off the page chrome + WebSocket connection.

import { params, api } from './config.js';
import { state } from './state.js';

// Debug helper: `await getPost(123)` from the devtools console returns the
// full DuckDB row for a post. Uses the page's existing token via api().
window.getPost = async function getPost(id) {
    const res = await fetch(api(`/post?id=${encodeURIComponent(id)}`));
    if (!res.ok) throw new Error(`getPost(${id}) ${res.status}: ${await res.text()}`);
    return res.json();
};

// Debug helper: `await searchPosts('cats order:id limit:5')` runs the query
// through the server's search layer.
window.searchPosts = async function searchPosts(q, limit) {
    let url = `/search?q=${encodeURIComponent(q || '')}`;
    if (limit) url += `&limit=${encodeURIComponent(limit)}`;
    const res = await fetch(api(url));
    if (!res.ok) throw new Error(`searchPosts ${res.status}: ${await res.text()}`);
    return res.json();
};

// Debug helper: `await countPosts('file_ext:gif')` returns the total number
// of posts that would match the query.
window.countPosts = async function countPosts(q) {
    const res = await fetch(api(`/count?q=${encodeURIComponent(q || '')}`));
    if (!res.ok) throw new Error(`countPosts ${res.status}: ${await res.text()}`);
    const data = await res.json();
    return data.count;
};
import './tags.js';
import { connectWebSocket } from './ws-client.js';
import { bootUi } from './ui.js';
import { initNightLight } from './nightlight.js';
import { invalidateMediaCache, seedHistoryFromServer } from './slideshow.js';

bootUi();
initNightLight(invalidateMediaCache);

if (params.ws) {
    state.deviceID = params.ws;
    connectWebSocket();
    // Pre-populate the left-arrow "previous" stack from the server's rolling
    // request log so stepping back works right after a page load.
    seedHistoryFromServer();
} else {
    console.warn('No ?ws= param — slideshow requires a WebSocket connection. Add ?ws=<deviceId> to the URL.');
}
