// @ts-check
'use strict';

// Drop known-harmless Electron/Chromium stderr under the macOS sandbox so
// lesson UI is not flooded when exit code is 0 and QVAC succeeded.

const NOISE_LINE = [
  /codesign_util\.cc/i,
  /task_name_for_pid/i,
  /mach_port_rendezvous/i,
  /MachPortRendezvousServer/i,
  /bootstrap_check_in/i,
  /Permission denied \(1100\)/,
];

function isNoiseLine(line) {
  const s = String(line);
  if (!s.trim()) return false;
  return NOISE_LINE.some((re) => re.test(s));
}

/**
 * Streaming line filter: returns text ready to forward; call end() for remainder.
 * @returns {{ push: (chunk: string) => string, end: () => string }}
 */
function createNoiseFilter() {
  let buf = '';
  return {
    push(chunk) {
      buf += String(chunk ?? '');
      const parts = buf.split('\n');
      buf = parts.pop() ?? '';
      const kept = [];
      for (const line of parts) {
        if (!isNoiseLine(line)) kept.push(line);
      }
      if (kept.length === 0) return '';
      return `${kept.join('\n')}\n`;
    },
    end() {
      if (!buf) return '';
      const rest = buf;
      buf = '';
      return isNoiseLine(rest) ? '' : rest;
    },
  };
}

module.exports = {
  isNoiseLine,
  createNoiseFilter,
};
