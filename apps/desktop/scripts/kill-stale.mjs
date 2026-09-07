#!/usr/bin/env node
'use strict';

// A stale window fails main.js's single-instance lock and quits silently,
// leaving the old code running. Killing any prior instance first makes every
// dev/start/capture a guaranteed-fresh restart.
//
// Two children survive that kill, reparented: its ffmpeg mic capture (matched
// by MIC_FILTER_SIGNATURE, which only this app passes) and @qvac/sdk's `bare`
// worker, which holds the real model registry.

import { execSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const MIC_FILTER_SIGNATURE = 'highpass=f=80,afftdn=nf=-25';

try {
  if (process.platform === 'win32') {
    const out = execSync('wmic process get ProcessId,CommandLine', { encoding: 'utf8' });
    for (const line of out.split('\n')) {
      const isElectron = line.includes(`${repoRoot}\\node_modules`) && /electron\.exe/i.test(line);
      const isMic = /ffmpeg\.exe/i.test(line) && line.includes(MIC_FILTER_SIGNATURE);
      const isQvacWorker = line.includes(`${repoRoot}\\node_modules`) && line.includes('@qvac') && /worker\.js/i.test(line);
      if (!isElectron && !isMic && !isQvacWorker) continue;
      const pid = line.trim().match(/(\d+)\s*$/)?.[1];
      if (pid) execSync(`taskkill /PID ${pid} /F`, { stdio: 'ignore' });
    }
  } else {
    const out = execSync('ps -eo pid,command', { encoding: 'utf8' });
    // Match the electron binary's own resolved path, not a bare "Electron"
    // substring: a script that merely mentions the word (this one included)
    // would otherwise get killed as a false positive.
    const binaryPath = `${repoRoot}/node_modules`;
    for (const line of out.split('\n')) {
      const isElectron = line.includes(binaryPath) && /\/electron\/dist\/Electron/.test(line);
      const isMic = line.includes('ffmpeg') && line.includes(MIC_FILTER_SIGNATURE);
      const isQvacWorker = line.includes(binaryPath) && line.includes('@qvac') && line.includes('server/worker.js');
      if (!isElectron && !isMic && !isQvacWorker) continue;
      const pid = line.trim().split(/\s+/)[0];
      if (pid) process.kill(Number(pid), 'SIGTERM');
    }
  }
} catch {
  // No matching process, or the platform's process-list command isn't
  // available; either way the actual dev/start/capture command still runs.
}
