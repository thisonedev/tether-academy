#!/usr/bin/env node
// Puts one registry model in the cache by hand, for a machine the blob
// transfer keeps timing out on.
//
//   node scripts/sideload-model.mjs QWEN3_4B_Q4_K_M
//   node scripts/sideload-model.mjs --list

import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { readRegistry, sideloadModel, cacheFileName } = require('../shared/model-sideload.cjs');

const args = process.argv.slice(2);
const registry = readRegistry();

if (args.length === 0 || args[0] === '--help') {
  console.log('usage: sideload-model.mjs <REGISTRY_CONSTANT> [...]  |  --list');
  process.exit(args.length === 0 ? 2 : 0);
}

if (args[0] === '--list') {
  for (const [name, entry] of registry) {
    console.log(`${name}\t${(entry.expectedSize / 1e9).toFixed(2)}GB\t${cacheFileName(entry.registryPath)}`);
  }
  process.exit(0);
}

const mb = (n) => (n / 1e6).toFixed(0);
let failed = 0;

for (const name of args) {
  let lastReport = 0;
  try {
    const result = await sideloadModel(name, {
      registry,
      onProgress: (downloaded, total) => {
        // One line a second, so a long transfer does not bury the terminal.
        const now = Date.now();
        if (now - lastReport < 1000) return;
        lastReport = now;
        const percent = total ? Math.floor((downloaded / total) * 100) : 0;
        process.stderr.write(`\r${name}: ${percent}% (${mb(downloaded)}/${mb(total)} MB)`);
      },
    });
    process.stderr.write('\r');
    console.log(
      result.alreadyCached
        ? `${name}: already cached at ${result.path}`
        : `${name}: verified ${mb(result.bytes)} MB into ${result.path}`,
    );
  } catch (err) {
    process.stderr.write('\r');
    console.error(`${name}: ${err.message}`);
    failed++;
  }
}

process.exit(failed > 0 ? 1 : 0);
