'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { loadConfig } = require('@roboframe/shared');

function withConfigDir(files, fn) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'roboframe-config-'));
    for (const [name, body] of Object.entries(files)) {
        fs.writeFileSync(path.join(dir, name), JSON.stringify(body));
    }
    const saved = { config: process.env.ROBOFRAME_CONFIG, secrets: process.env.ROBOFRAME_SECRETS };
    process.env.ROBOFRAME_CONFIG = path.join(dir, 'roboframe.config.json');
    delete process.env.ROBOFRAME_SECRETS;
    try {
        return fn(dir);
    } finally {
        for (const [key, value] of [['ROBOFRAME_CONFIG', saved.config], ['ROBOFRAME_SECRETS', saved.secrets]]) {
            if (value === undefined) delete process.env[key];
            else process.env[key] = value;
        }
        fs.rmSync(dir, { recursive: true, force: true });
        loadConfig({ reload: true });
    }
}

test('the secrets file beside the config is merged over it', () => {
    withConfigDir({
        'roboframe.config.json': {
            accessToken: 'stale', deviceId: 'den',
            server: { port: 3123, rpcToken: 'stale', ha: { url: 'http://ha', filterEntities: ['a'] } },
        },
        'roboframe.secrets.json': {
            accessToken: 'a', server: { rpcToken: 'r', ha: { token: 'h' } },
        },
    }, (dir) => {
        const config = loadConfig({ reload: true });
        assert.equal(config.accessToken, 'a');
        assert.equal(config.deviceId, 'den');
        assert.equal(config.server.rpcToken, 'r');
        assert.equal(config.server.port, 3123);
        // Nested blocks merge key by key rather than replacing each other.
        assert.deepEqual(config.server.ha, { url: 'http://ha', filterEntities: ['a'], token: 'h' });
        assert.equal(config.secretsPath, path.join(dir, 'roboframe.secrets.json'));
    });
});

test('ROBOFRAME_SECRETS names the secrets file; a config alone still loads', () => {
    withConfigDir({ 'roboframe.config.json': { accessToken: 'only' }, 'elsewhere.json': { accessToken: 'env' } }, (dir) => {
        assert.equal(loadConfig({ reload: true }).accessToken, 'only');
        assert.equal(loadConfig({ reload: true }).secretsPath, null);
        process.env.ROBOFRAME_SECRETS = path.join(dir, 'elsewhere.json');
        assert.equal(loadConfig({ reload: true }).accessToken, 'env');
    });
});
