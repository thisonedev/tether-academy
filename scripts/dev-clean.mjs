// Manual one-off reset for `next dev.
// Wipes .next/.source/.turbo and kills any stale next-server, then returns.

import { execSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { rm } from 'node:fs/promises';

function killStaleDevServers() {
  try {
    execSync('pkill -f "next-server" 2>/dev/null', { stdio: 'ignore' });
    console.log('▸ killed stale next-server processes');
  } catch {
    // pkill exits non-zero when no matches, which is the desired idle case.
  }
  // Give the kernel a beat to release file handles before rm runs, otherwise rm races against the dying process holding .tmp files.
  return new Promise((resolve) => setTimeout(resolve, 400));
}

const CACHE_PATHS = ['.next', '.source', '.turbo'];

await killStaleDevServers();
for (const p of CACHE_PATHS) {
  if (existsSync(p)) {
    await rm(p, { recursive: true, force: true });
    console.log(`▸ cleaned ${p}/`);
  }
}
