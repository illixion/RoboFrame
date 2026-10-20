'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { rewriteHlsPlaylist } = require('../lib/hlsPlaylist');

const RAW = [
    '#EXTM3U',
    '#EXT-X-VERSION:7',
    '#EXT-X-TARGETDURATION:2',
    '#EXT-X-MAP:URI="init.mp4"',
    '#EXTINF:2.000000,',
    'seg_000.m4s',
    '#EXT-X-ENDLIST',
    '',
].join('\n');

test('segments and the init segment go through the authenticated hlsseg route', () => {
    const out = rewriteHlsPlaylist(RAW, { id: 42, vmaxh: 0, vmaxfps: 0, token: 'a b' });
    const base = 'get?id=42&vcodec=hlsseg&vmaxh=0&vmaxfps=0&token=a%20b&seg=';
    assert.ok(out.includes(`#EXT-X-MAP:URI="${base}init.mp4"`));
    assert.ok(out.split('\n').includes(`${base}seg_000.m4s`));
    assert.ok(out.includes('#EXT-X-ENDLIST'));
});

// A reverse proxy that mounts the server under a prefix
// (nginx `location /wallpaper_slideshow/`) must keep it for segment fetches.
test('segment URIs resolve under the path the playlist was fetched from', () => {
    const out = rewriteHlsPlaylist(RAW, { id: 42, vmaxh: 0, vmaxfps: 0, token: 't' });
    const segment = out.split('\n').find((l) => l.includes('seg_000'));
    const proxied = new URL(segment, 'https://host/wallpaper_slideshow/get?id=42&vcodec=hls&token=t');
    assert.equal(proxied.pathname, '/wallpaper_slideshow/get');
    const direct = new URL(segment, 'http://host:3123/get?id=42&vcodec=hls&token=t');
    assert.equal(direct.pathname, '/get');
    assert.equal(direct.searchParams.get('seg'), 'seg_000.m4s');
});
