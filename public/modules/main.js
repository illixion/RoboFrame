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
import './tags.js';
import { connectWebSocket } from './ws-client.js';
import { bootUi } from './ui.js';
import { initNightLight } from './nightlight.js';
import { invalidateMediaCache } from './slideshow.js';

bootUi();
initNightLight(invalidateMediaCache);

if (params.ws) {
    state.deviceID = params.ws;
    connectWebSocket();
} else {
    console.warn('No ?ws= param — slideshow requires a WebSocket connection. Add ?ws=<deviceId> to the URL.');
}
