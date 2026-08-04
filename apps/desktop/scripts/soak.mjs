// Pair-and-exec soak. Holds one pairing open and runs repeated execs for a
// configurable duration, reporting sent / received / errors. Run before any
// release that touches pairing or exec; watches a long-lived connection for
// issues that only show up over time.
//
// Usage: node scripts/soak.mjs [--duration <ms>] [--interval <ms>]

import { setTimeout as delay } from 'node:timers/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const desktopRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

const args = process.argv.slice(2);
let durationMs = 30_000;
let intervalMs = 250;
for (let i = 0; i < args.length; i++) {
  if (args[i] === '--duration' && i + 1 < args.length) {
    durationMs = Number(args[i + 1]);
    i += 1;
  } else if (args[i] === '--interval' && i + 1 < args.length) {
    intervalMs = Number(args[i + 1]);
    i += 1;
  }
}

const helpers = await import(
  path.join(desktopRoot, 'tests/helpers/index.cjs')
);

// autoApprove so this script can run unattended; tests already cover the approval path.
const { host, guest, testnet, discoveryKey } = await helpers.pairForExec(
  { teardown() { /* no brittle teardown here */ } },
  'soak',
);

let sent = 0;
let received = 0;
let errors = 0;
const startedAt = Date.now();

const endAt = startedAt + durationMs;
while (Date.now() < endAt) {
  try {
    sent += 1;
    const result = await helpers.runExec(
      guest,
      {
        peerId: discoveryKey,
        code: "console.log('soak ' + Date.now())",
      },
      Math.max(intervalMs * 4, 2000),
    );
    if (result.stdout.includes('soak ')) received += 1;
  } catch (err) {
    errors += 1;
    console.error(`[soak] exec ${sent} failed:`, err.message);
  }
  await delay(intervalMs);
}

const elapsed = (Date.now() - startedAt) / 1000;
console.log(`\nsoak summary:`);
console.log(`  duration:   ${elapsed.toFixed(1)}s`);
console.log(`  execs sent: ${sent}`);
console.log(`  chunks:     ${received}`);
console.log(`  errors:     ${errors}`);

await host.close().catch(() => {});
await guest.close().catch(() => {});
await testnet.destroy().catch(() => {});
process.exit(errors > 0 ? 1 : 0);