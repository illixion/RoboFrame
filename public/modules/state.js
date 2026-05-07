// Shared mutable runtime state. Modules read/write fields directly through
// the exported `state` object so updates cross module boundaries without a
// pub/sub layer. Keep this surface small — anything pure or per-module
// should live in that module instead of here.

import { defaultInterval } from './config.js';

export const state = {
    interval: defaultInterval,
    enabled: true,
    tempDisable: false,
    forceDisable: false,
    disabledAtTime: 0,

    currentPost: null,            // id of the post currently rendered

    mediaContainer: null,         // populated in main.js once the DOM is ready
    socket: null,                 // ws-client.js writes this
    deviceID: null,               // params.ws if set
    isPrimary: false,             // last value sent via displaySync (merge driver claim)

    currentPlayback: null,        // last playback payload, for diagnostics
};
