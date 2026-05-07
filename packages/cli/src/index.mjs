#!/usr/bin/env node
import { parseArgs } from 'node:util';

const HELP = `roboframe-cli — tools for managing a RoboFrame posts.duckdb

Usage:
  roboframe-cli bootstrap <imageDir> [options]
  roboframe-cli doctor [--db ./posts.duckdb]
  roboframe-cli --help

Run \`roboframe-cli <command> --help\` for command-specific options.`;

const [, , command, ...rest] = process.argv;

if (!command || command === '--help' || command === '-h') {
    console.log(HELP);
    process.exit(command ? 0 : 1);
}

try {
    if (command === 'bootstrap') {
        const { run } = await import('./commands/bootstrap.mjs');
        await run(rest);
    } else if (command === 'doctor') {
        const { run } = await import('./commands/doctor.mjs');
        await run(rest);
    } else {
        console.error(`Unknown command: ${command}\n`);
        console.error(HELP);
        process.exit(1);
    }
} catch (err) {
    console.error(`Error: ${err.message}`);
    if (process.env.DEBUG) console.error(err.stack);
    process.exit(1);
}

export { parseArgs };
