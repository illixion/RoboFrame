'use strict';

// Container extensions that make a post a video. The CLI indexes these, and
// the server streams, transcodes and posters them. Clients keep a copy of the
// same list (public/modules/config.js, native-kiosk, psp-kiosk, Hypnos's
// SlideshowEngine.videoExtensions) so a playback frame's `ext` classifies
// identically everywhere.
const VIDEO_EXTS = new Set(['mp4', 'm4v', 'mov', 'mkv', 'webm', 'avi', 'wmv', 'flv', '3gp']);

const VIDEO_MIME = {
    mp4: 'video/mp4',
    m4v: 'video/x-m4v',
    mov: 'video/quicktime',
    mkv: 'video/x-matroska',
    webm: 'video/webm',
    avi: 'video/x-msvideo',
    wmv: 'video/x-ms-wmv',
    flv: 'video/x-flv',
    '3gp': 'video/3gpp',
};

function isVideoExt(ext) {
    return VIDEO_EXTS.has(String(ext || '').toLowerCase());
}

module.exports = { VIDEO_EXTS, VIDEO_MIME, isVideoExt };
