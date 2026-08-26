// A SIGKILL'd run never runs its own JS cleanup, so its QVAC worker can run
// for days undetected. The worker's own socket name (qvac-worker-<parentPid>-...)
// records its spawning PID; this kills any whose recorded parent is gone.
'use strict';

const process = require('process');

const { killPid, listProcesses } = require('./process-control.cjs');

const SOCKET_PID_RE = /qvac-worker-(\d+)-/;

function parentAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

/**
 * @returns {Array<{ pid: number, parentPid: number }>} workers that were killed
 */
function reapOrphanedQvacWorkers() {
  const killed = [];
  for (const raw of listProcesses()) {
    // Windows reports the module path with backslashes and names the socket as
    // a \\.\pipe\ path, so both checks below run against forward slashes.
    const line = raw.replace(/\\/g, '/');
    if (!line.includes('@qvac/sdk') || !line.includes('worker.js')) continue;
    const socketMatch = line.match(SOCKET_PID_RE);
    if (!socketMatch) continue;
    const parentPid = Number(socketMatch[1]);
    if (parentAlive(parentPid)) continue;
    const pidMatch = line.trim().match(/^(\d+)/);
    if (!pidMatch) continue;
    const workerPid = Number(pidMatch[1]);
    if (killPid(workerPid, 'SIGKILL')) killed.push({ pid: workerPid, parentPid });
  }
  return killed;
}

module.exports = { reapOrphanedQvacWorkers };
