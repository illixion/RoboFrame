// Bootstrap entry. Imported as a single <script type="module"> from
// index.html. Pulls every other module in (their top-level code wires the
// pieces together) and kicks off the page chrome + WebSocket connection.

import { params } from './config.js';
import { state } from './state.js';
import './tags.js';
import { connectWebSocket } from './ws-client.js';
import { bootUi } from './ui.js';

bootUi();

if (params.ws) {
    state.deviceID = params.ws;
    connectWebSocket();
} else {
    console.warn('No ?ws= param — slideshow requires a WebSocket connection. Add ?ws=<deviceId> to the URL.');
}
