// @ts-check
'use strict';

// Native addon crashes on Linux (missing .so at dlopen time) surface as
// opaque errors ("Cannot find addon", generic RPC timeouts) with the real
// cause buried in a stderr line or not shown at all. This maps known
// missing libraries to their apt package, for a startup preflight check
// and for enriching individual crash messages when one slips through.

const { execFileSync } = require('node:child_process');
const fs = require('node:fs');
const { fileURLToPath } = require('node:url');

const KNOWN_LIBS = {
  'libatomic.so.1': 'sudo apt-get install -y libatomic1',
  'libvulkan.so.1': 'sudo apt-get install -y libvulkan1 mesa-vulkan-drivers',
};

const MISSING_LIB_RE = /([\w.+-]+\.so(?:\.\d+)*): cannot open shared object file/g;

/**
 * @param {string} text
 * @returns {string | null}
 */
function hintForMissingLib(text) {
  if (typeof text !== 'string' || !text) return null;
  const libs = new Set();
  for (const m of text.matchAll(MISSING_LIB_RE)) libs.add(m[1]);
  if (libs.size === 0) return null;

  const lines = [];
  for (const lib of libs) {
    const install = KNOWN_LIBS[lib];
    lines.push(
      install
        ? `${lib} is missing. Install it with: ${install}`
        : `${lib} is missing. Install the package that provides it (see temp/linux.md for the known ones).`,
    );
  }
  return lines.join('\n');
}

/**
 * require-addon's "Cannot find addon" error lists candidate .node paths but
 * drops the dlopen failure that ruled them out. ldd each candidate that
 * exists on disk to recover it.
 * @param {Error} err
 * @returns {string | null}
 */
function diagnoseNativeAddonError(err) {
  if (process.platform !== 'linux') return null;
  const message = (err && err.message) || '';
  if (!/Cannot find addon/.test(message)) return null;

  const candidates = [...message.matchAll(/file:\/\/\/\S+\.node\b/g)].map((m) => m[0]);
  for (const url of candidates) {
    let candidatePath;
    try {
      candidatePath = fileURLToPath(url);
    } catch {
      continue;
    }
    if (!fs.existsSync(candidatePath)) continue;
    let lddOutput;
    try {
      lddOutput = execFileSync('ldd', [candidatePath], { encoding: 'utf8' });
    } catch (lddErr) {
      lddOutput = /** @type {{ stdout?: string }} */ (lddErr)?.stdout ?? '';
    }
    const hint = hintForMissingLib(lddOutput);
    if (hint) return hint;
  }
  return null;
}

/**
 * A missing library can crash startup from several different native addons
 * (rocksdb-native, sodium-native, ...) with a different error shape each
 * time, so catching individual require sites doesn't generalize. Checked
 * once at startup instead of chasing every crash site.
 * @returns {string | null}
 */
function checkRequiredLinuxLibs() {
  if (process.platform !== 'linux') return null;
  let installed;
  try {
    installed = execFileSync('ldconfig', ['-p'], { encoding: 'utf8' });
  } catch {
    return null; // ldconfig missing/unavailable: nothing to check against.
  }
  const missing = Object.keys(KNOWN_LIBS).filter((lib) => !installed.includes(lib));
  if (missing.length === 0) return null;
  return missing.map((lib) => `${lib} is missing. Install it with: ${KNOWN_LIBS[lib]}`).join('\n');
}

module.exports = { hintForMissingLib, diagnoseNativeAddonError, checkRequiredLinuxLibs, KNOWN_LIBS };
