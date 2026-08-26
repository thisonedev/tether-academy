// @ts-check
'use strict';

// Windows backend. There is no process-group signal, so killTree shells out to
// taskkill, and `detached` stays off because it would open a console window.

const { execFile, execFileSync } = require('child_process');
const { promisify } = require('util');

const execFileAsync = promisify(execFile);

const spawnFlags = { detached: false, windowsHide: true };

/**
 * Kill a child and everything it spawned. Windows has no graceful tree signal,
 * so SIGTERM and SIGKILL both force.
 * @param {{ pid?: number, kill?: (signal: string) => boolean } | null} child
 * @param {string} signal
 * @returns {boolean}
 */
function killTree(child, signal) {
  if (!child?.pid) return false;
  try {
    execFileSync('taskkill', ['/PID', String(child.pid), '/T', '/F'], {
      stdio: 'ignore',
      windowsHide: true,
    });
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
 * Kill one process, never its tree.
 * @param {number} pid
 * @param {string} _signal Accepted for parity with the POSIX backend.
 * @returns {boolean}
 */
function killPid(pid, _signal) {
  try {
    execFileSync('taskkill', ['/PID', String(pid), '/F'], {
      stdio: 'ignore',
      windowsHide: true,
    });
    return true;
  } catch {
    return false;
  }
}

/**
 * Every running process as a `pid command-line` line. Uses CIM rather than
 * wmic, which Windows 11 24H2 removed. Async: spawning powershell.exe here
 * measured 4+ seconds (mostly its own startup), which would otherwise block
 * the event loop for every caller that runs this after each exec.
 * @returns {Promise<string[]>}
 */
async function listProcesses() {
  try {
    const { stdout } = await execFileAsync(
      'powershell',
      [
        '-NoProfile',
        '-NonInteractive',
        '-Command',
        'Get-CimInstance Win32_Process | ForEach-Object { "$($_.ProcessId) $($_.CommandLine)" }',
      ],
      { encoding: 'utf8', windowsHide: true },
    );
    return stdout.split(/\r?\n/);
  } catch {
    return [];
  }
}

module.exports = { killTree, killPid, listProcesses, spawnFlags };
