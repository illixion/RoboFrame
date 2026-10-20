'use strict';

// Rewrites an HLS encode's playlist so every segment (and the init segment)
// is fetched through the authenticated `/get?vcodec=hlsseg` route.
//
// The URIs are relative (`get?…`, no leading slash): a player resolves them
// against the playlist's own URL, so they keep whatever path prefix a reverse
// proxy mounts the server under (`/wallpaper_slideshow/get?…`). An absolute
// `/get?…` would resolve to the proxy's root instead and 404 every segment.

function rewriteHlsPlaylist(raw, { id, vmaxh, vmaxfps, token }) {
    const base = `get?id=${id}&vcodec=hlsseg&vmaxh=${vmaxh}&vmaxfps=${vmaxfps}`
        + `&token=${encodeURIComponent(token || '')}&seg=`;
    return raw.split('\n').map((line) => {
        if (line.startsWith('#EXT-X-MAP:URI=')) {
            return line.replace(/URI="([^"]+)"/, (_, f) => `URI="${base}${encodeURIComponent(f)}"`);
        }
        if (line && !line.startsWith('#')) return `${base}${encodeURIComponent(line.trim())}`;
        return line;
    }).join('\n');
}

module.exports = { rewriteHlsPlaylist };
