// Runs each test file in its own process and aggregates the results.
//
// brittle-node can take several files at once, but sharing one process across
// every file made results depend on file order; worker-client timed out only
// when ~48 tests had already run ahead of it. A process per file removes that
// coupling; the extra startup cost is noise next to a testnet handshake.
//
// Usage: node scripts/run-tests.mjs <dir> [...more dirs] [--filter <substring>]

import { spawn } from 'node:child_process';
import { readdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const desktopRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const brittle = path.join(desktopRoot, 'node_modules', '.bin', 'brittle-node');

const args = process.argv.slice(2);
let filter = null;
const positional = [];
for (let i = 0; i < args.length; i++) {
  if (args[i] === '--filter' && i + 1 < args.length) {
    filter = args[i + 1];
    i += 1;
  } else {
    positional.push(args[i]);
  }
}
if (positional.length === 0) {
  console.error('usage: node scripts/run-tests.mjs <dir> [...] [--filter <substring>]');
  process.exit(1);
}

const files = positional.flatMap((dir) => {
  const abs = path.resolve(desktopRoot, dir);
  return readdirSync(abs)
    .filter((name) => name.endsWith('.cjs'))
    .sort()
    .map((name) => path.join(abs, name));
}).filter((file) => {
  if (!filter) return true;
  const rel = path.relative(desktopRoot, file);
  return rel.includes(filter);
});

function run(file) {
  return new Promise((resolve) => {
    // brittle-node resolves its arguments relative to cwd, not as absolute paths.
    const rel = path.relative(desktopRoot, file);
    const child = spawn(brittle, [rel], { stdio: ['ignore', 'pipe', 'pipe'], cwd: desktopRoot });
    let out = '';
    child.stdout.on('data', (d) => (out += d));
    child.stderr.on('data', (d) => (out += d));
    child.on('exit', (code) => resolve({ code, out }));
  });
}

const summary = (out) => {
  const tests = out.match(/# tests = (\d+)\/(\d+)/);
  const skipped = (out.match(/# SKIP/g) ?? []).length;
  if (!tests) return 'no summary — the process died early';
  const detail = `${tests[1]}/${tests[2]} tests`;
  return skipped > 0 ? `${detail}, ${skipped} skipped` : detail;
};

let failed = 0;
const started = Date.now();
const timings = [];

for (const file of files) {
  const name = path.relative(desktopRoot, file);
  const at = Date.now();
  const { code, out } = await run(file);
  const secs = (Date.now() - at) / 1000;

  if (code === 0) {
    console.log(`PASS  ${secs.toFixed(1)}s  ${name}  (${summary(out)})`);
  } else {
    failed++;
    console.log(`FAIL  ${secs.toFixed(1)}s  ${name}  (${summary(out)})`);
    // Only the failing assertions and any crash, not the whole TAP stream.
    const relevant = out
      .split('\n')
      .filter((line) => /^\s*not ok|^Error:|^TypeError:/.test(line))
      .slice(0, 12);
    for (const line of relevant) console.log(`        ${line.trim()}`);
  }
  timings.push({ name, secs });
}

const total = (Date.now() - started) / 1000;
const slowest = [...timings]
  .sort((a, b) => b.secs - a.secs)
  .slice(0, 5);
console.log('');
console.log(`slowest files:`);
for (const { name, secs } of slowest) {
  console.log(`  ${secs.toFixed(1)}s  ${name}`);
}
console.log('');
console.log(`${files.length - failed}/${files.length} files passed in ${total.toFixed(1)}s`);
process.exit(failed > 0 ? 1 : 0);