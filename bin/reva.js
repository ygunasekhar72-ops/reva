#!/usr/bin/env node
// REVA CLI entry point.
import { main } from '../src/core/cli.js';

main(process.argv.slice(2)).then(
  (code) => {
    // Natural exit (exitCode, not process.exit) — process.exit during pending
    // handle teardown triggers a libuv fail-fast on Windows.
    process.exitCode = code ?? 0;
  },
  (err) => {
    console.error('fatal:', err?.stack || err?.message || err);
    process.exitCode = 1;
  }
);
