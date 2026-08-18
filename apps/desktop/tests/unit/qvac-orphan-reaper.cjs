'use strict';

// reapOrphanedQvacWorkers reads the parent PID out of a worker's own socket
// name; these spawn a real process shaped like one to check that logic.

const test = require('brittle');
const { spawn } = require('child_process');
const { reapOrphanedQvacWorkers } = require('../../shared/qvac-orphan-reaper.cjs');

function spawnFakeWorker(parentPid) {
  const script =
    "process.title = '@qvac/sdk/dist/server/worker.js QVAC_IPC_SOCKET_PATH=/tmp/qvac-worker-"
    + parentPid + "-abc123-def.sock'; setInterval(() => {}, 1000);";
  return spawn('node', ['-e', script], { stdio: 'ignore' });
}

function isAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

test('qvac-orphan-reaper - kills a worker whose recorded parent is dead', async (t) => {
  const deadPid = 999999; // not a real, running process
  const worker = spawnFakeWorker(deadPid);
  t.teardown(() => {
    try {
      process.kill(worker.pid, 'SIGKILL');
    } catch {}
  });
  await new Promise((resolve) => setTimeout(resolve, 500));

  const killed = reapOrphanedQvacWorkers();
  t.ok(killed.some((k) => k.pid === worker.pid), 'the fake orphan is in the killed list');

  await new Promise((resolve) => setTimeout(resolve, 300));
  t.absent(isAlive(worker.pid), 'the fake orphan is actually dead');
});

test('qvac-orphan-reaper - leaves a worker whose parent is alive', async (t) => {
  const worker = spawnFakeWorker(process.pid);
  t.teardown(() => {
    try {
      process.kill(worker.pid, 'SIGKILL');
    } catch {}
  });
  await new Promise((resolve) => setTimeout(resolve, 500));

  const killed = reapOrphanedQvacWorkers();
  t.absent(killed.some((k) => k.pid === worker.pid), 'a worker with a live parent is not touched');
  t.ok(isAlive(worker.pid), 'it is still running');
});
