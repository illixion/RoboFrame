'use strict';

// The Pi backend caches a power stage and skips the hardware call when the
// target matches it. These tests drive it against a fake xrandr whose CRTC
// can be flipped from outside, the way an X/kiosk restart does.

const test = require('node:test');
const assert = require('node:assert');
const childProcess = require('node:child_process');

function loadBackend() {
    const screen = { on: true, commands: [] };
    const realExec = childProcess.exec;
    const realExecSync = childProcess.execSync;

    childProcess.execSync = (cmd) => {
        if (cmd.startsWith('xrandr') && cmd.includes('--query')) {
            return Buffer.from('HDMI-1 connected primary 1920x1080+0+0 (normal) 509mm x 286mm\n');
        }
        if (cmd.startsWith('ddcutil')) throw new Error('no DDC');
        return Buffer.from('');
    };
    childProcess.exec = (cmd, cb) => {
        setImmediate(() => {
            if (cmd.includes('--query')) {
                const line = screen.on
                    ? 'HDMI-1 connected primary 1920x1080+0+0 (normal) 509mm x 286mm'
                    : 'HDMI-1 connected primary (normal) 509mm x 286mm';
                return cb(null, `Screen 0: minimum 320 x 200\n${line}\n`, '');
            }
            screen.commands.push(cmd);
            if (cmd.includes('--off')) screen.on = false;
            else if (cmd.includes('--mode')) screen.on = true;
            cb(null, '', '');
        });
    };

    const modulePath = require.resolve('../platforms/raspberry-pi');
    delete require.cache[modulePath];
    const backend = require(modulePath).create({});
    childProcess.exec = realExec;
    childProcess.execSync = realExecSync;
    // `create` captured the stubbed `exec` binding at require time.
    return { backend, screen };
}

const call = (fn, ...args) => new Promise((resolve, reject) => {
    fn(...args, (err, value) => (err ? reject(err) : resolve(value)));
});

test('off re-drive reaches xrandr after the CRTC was re-enabled externally', async () => {
    const { backend, screen } = loadBackend();
    await call(backend.turnOff);
    assert.strictEqual(screen.on, false);

    screen.on = true; // X restart brings the output back up
    assert.strictEqual(await call(backend.getActualPowerState), true);

    screen.commands.length = 0;
    await call(backend.turnOff);
    assert.strictEqual(screen.on, false);
    assert.ok(screen.commands.some((c) => c.includes('--off')));
});

test('on re-drive reaches xrandr after the CRTC was disabled externally', async () => {
    const { backend, screen } = loadBackend();
    await call(backend.turnOff);
    await call(backend.turnOn);
    assert.strictEqual(screen.on, true);

    screen.on = false;
    assert.strictEqual(await call(backend.getActualPowerState), false);

    screen.commands.length = 0;
    await call(backend.turnOn);
    assert.strictEqual(screen.on, true);
    assert.ok(screen.commands.some((c) => c.includes('--mode')));
});

test('a probe while an op is queued leaves the cached stage alone', async () => {
    const { backend, screen } = loadBackend();
    const off = call(backend.turnOff); // queued, not yet run
    assert.strictEqual(await call(backend.getActualPowerState), true);
    await off;
    assert.strictEqual(screen.on, false);

    // Had the stale "on" probe flipped the stage, the next off would be a
    // no-op on a cache that already matches; here it must still be deduped.
    screen.commands.length = 0;
    await call(backend.turnOff);
    assert.deepStrictEqual(screen.commands, []);
});
