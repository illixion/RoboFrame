'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { VIDEO_EXTS, VIDEO_MIME, isVideoExt } = require('@roboframe/shared');

test('every video extension has a MIME type', () => {
    for (const ext of VIDEO_EXTS) assert.match(VIDEO_MIME[ext] || '', /^video\//, ext);
});

test('isVideoExt is case-insensitive and rejects stills', () => {
    assert.equal(isVideoExt('MKV'), true);
    assert.equal(isVideoExt('3gp'), true);
    assert.equal(isVideoExt('jpg'), false);
    assert.equal(isVideoExt(undefined), false);
});
