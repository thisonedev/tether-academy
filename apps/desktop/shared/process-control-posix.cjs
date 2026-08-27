// @ts-check
'use strict';

// POSIX backend. Children spawn detached, so the process group id is the child
// pid and one signal reaches an orphaned QVAC worker grandchild too.

const { execFile } = require('child_process');
const process = require('process');

// Not util.promisify: Bare (the pear-end worker also loads this file) has no
// 'util' module, and that require crashed the whole worker on start.
function execFileAsync(cmd, args, opts) {
  return new Promise((resolve, reject) => {
    execFile(cmd, args, opts, (err, stdout, stderr) => {
      if (err) reject(err);
      else resolve({ stdout, stderr });
    });
  });
}

const spawnFlags = { detached: true };

/**
 * Signal a child and everything it spawned. Falls back to the child alone when
 * it has no group of its own.
 * @param {{ pid?: number, kill?: (signal: string) => boolean } | null} child
 * @param {string} signal
 * @returns {boolean}
 */
function killTree(child, signal) {
  if (!child?.pid) return false;
  try {
    process.kill(-child.pid, signal);
    return true;
  } catch {
    try {
      child.kill(signal);
      return true;
    } catch {
      return false;
    }
  }
}

/**
 * Signal one process, never its group.
 * @param {number} pid
 * @param {string} signal
 * @returns {boolean}
 */
function killPid(pid, signal) {
  try {
    process.kill(pid, signal);
    return true;
  } catch {
    return false;
  }
}

/**
 * Every running process as a `pid command-line` line. Async so both backends
 * share one contract; the Windows side pays for it, this one barely notices.
 * @returns {Promise<string[]>}
 */
async function listProcesses() {
  try {
    const { stdout } = await execFileAsync('ps', ['-eo', 'pid,args'], { encoding: 'utf8' });
    return stdout.split('\n');
  } catch {
    return [];
  }
}

module.exports = { killTree, killPid, listProcesses, spawnFlags };
