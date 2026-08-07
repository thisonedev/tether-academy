#!/usr/bin/env node
// Copy apps/cli/install.sh into public assets so the static export serves it at
// https://tetheracademy.cc/install.sh. The CLI copy stays the source of truth,
// so the served script cannot drift from the one in the repo.

import { copyFile, mkdir } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));

const src = resolve(__dirname, '..', '..', 'cli', 'install.sh');
const dest = resolve(__dirname, '..', 'public', 'install.sh');

await mkdir(dirname(dest), { recursive: true });
// copyFile, not cp: a missing source should fail the build rather than
// silently ship a 404 at the URL the README tells people to curl.
await copyFile(src, dest);
console.log(`[install.sh] copied ${src} -> ${dest}`);
