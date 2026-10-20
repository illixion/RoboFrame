#!/usr/bin/env node
'use strict';

// Move the tokens and passwords out of roboframe.config.json into
// roboframe.secrets.json beside it (mode 0600), which every config loader
// merges back over the config. Prints the key paths it moved, never a value.
//
//   node scripts/split-secrets.js [path/to/roboframe.config.json]
//
// A key the secrets file already holds wins: the loaders already prefer it,
// so the config's copy is just dropped. Running it twice is a no-op.

const fs = require('fs');
const path = require('path');
const { findConfigFile } = require('../packages/shared/src/config');

const SECRET_KEYS = [
    ['accessToken'],
    ['server', 'rpcToken'],
    ['server', 'ha', 'token'],
    ['server', 'mqtt', 'password'],
    ['display', 'webcam', 'tokens'],
];

function isSet(v) {
    if (v === undefined || v === null || v === '') return false;
    return !Array.isArray(v) || v.length > 0;
}

function get(obj, keys) {
    return keys.reduce((o, k) => (o && typeof o === 'object' ? o[k] : undefined), obj);
}

function set(obj, keys, value) {
    let o = obj;
    for (const k of keys.slice(0, -1)) {
        if (!o[k] || typeof o[k] !== 'object') o[k] = {};
        o = o[k];
    }
    o[keys[keys.length - 1]] = value;
}

function remove(obj, keys) {
    const parent = get(obj, keys.slice(0, -1));
    if (parent && typeof parent === 'object') delete parent[keys[keys.length - 1]];
}

// Keep the file's own indentation when rewriting it.
function indentOf(text) {
    const m = text.match(/\n([ \t]+)"/);
    return m ? m[1] : '  ';
}

function readJson(file, label) {
    try {
        return JSON.parse(fs.readFileSync(file, 'utf8'));
    } catch (err) {
        // A JSON.parse message can quote the text around the error, so only
        // the kind of failure is reported.
        console.error(`Can't read the ${label} at ${file} (${err.code || err.name}); nothing changed.`);
        process.exit(1);
    }
}

const configPath = process.argv[2] ? path.resolve(process.argv[2]) : findConfigFile();
if (!configPath || !fs.existsSync(configPath)) {
    console.error('No roboframe.config.json found; pass its path.');
    process.exit(1);
}
const secretsPath = path.join(path.dirname(configPath), 'roboframe.secrets.json');

const configText = fs.readFileSync(configPath, 'utf8');
const config = readJson(configPath, 'config');
const secrets = fs.existsSync(secretsPath) ? readJson(secretsPath, 'secrets file') : {};

const moved = [];
const dropped = [];
for (const keys of SECRET_KEYS) {
    const value = get(config, keys);
    if (!isSet(value)) continue;
    if (isSet(get(secrets, keys))) dropped.push(keys.join('.'));
    else { set(secrets, keys, value); moved.push(keys.join('.')); }
    remove(config, keys);
}

if (moved.length === 0 && dropped.length === 0) {
    console.log(`No secrets left in ${configPath}.`);
    process.exit(0);
}

// Secrets first, so a failure part-way never leaves a token in neither file.
const tmp = `${secretsPath}.${process.pid}.tmp`;
fs.writeFileSync(tmp, `${JSON.stringify(secrets, null, indentOf(configText))}\n`, { mode: 0o600 });
fs.renameSync(tmp, secretsPath);
// The config is rewritten in place: the server's fs.watch follows the file,
// and a rename would replace the inode it watches.
fs.writeFileSync(configPath, `${JSON.stringify(config, null, indentOf(configText))}\n`);

for (const key of moved) console.log(`moved   ${key}`);
for (const key of dropped) console.log(`dropped ${key} (the secrets file already has it)`);
console.log(`Secrets are in ${secretsPath}.`);
