// Regression test for plan item 12 (lesson layout and stop-button parity).
//
// Validates the source file directly because the lesson-workspace component
// depends on next/link and next/dynamic which require a Next.js runtime to
// render. Static checks against the source cover the constraints we care
// about.

import { readFile } from 'node:fs/promises';
import { resolve as pathResolve } from 'node:path';
import assert from 'node:assert/strict';

const repoRoot = process.cwd();
const srcPath = pathResolve(repoRoot, 'packages/ui/src/components/lesson-workspace.tsx');
const cssPath = pathResolve(repoRoot, 'apps/web/src/app/global.css');
const [src, css] = await Promise.all([readFile(srcPath, 'utf8'), readFile(cssPath, 'utf8')]);

const checks = [
  {
    name: 'tutorial pane renders before editor pane in DOM order',
    pass: src.indexOf('workspace-sidebar') < src.indexOf('workspace-runner-section'),
  },
  {
    name: 'footer is sticky at narrow widths (sticky bottom-0 ... lg:static)',
    pass: /sticky bottom-0[^]*lg:static/.test(src),
  },
  {
    name: 'run/stop button has no pairing-mode-only branch (button className)',
    pass: !/runMode === 'remote'\s*\?\s*'inline-flex[^']*bg-red-500/.test(src),
  },
  {
    name: 'editor section has min-width so it stays usable at narrow widths',
    pass: /workspace-runner-section[^>]*min-w-\[640px\]/.test(src),
  },
  {
    name: 'desktop row layout is gated to wide windows so narrow widths mirror the web',
    pass: /@media \(min-width: 960px\)[\s\S]*?html\[data-platform="desktop"\] \.workspace-row/.test(css),
  },
];

let failures = 0;
for (const check of checks) {
  if (check.pass) {
    console.log('PASS', check.name);
  } else {
    console.log('FAIL', check.name);
    failures += 1;
  }
}

assert.equal(failures, 0, `${failures} layout check(s) failed`);
console.log('lesson-layout-narrow: all', checks.length, 'checks passed');