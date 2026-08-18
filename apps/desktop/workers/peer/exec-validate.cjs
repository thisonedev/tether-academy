// Input validation for peer-exec, checked before anything reaches spawn.
'use strict';

const { isPortableToken, TOKEN_PREFIX } = require('../../shared/portable-lesson-imports.cjs');

const MAX_EXEC_ARGV = 32;
const MAX_EXEC_ARGV_ENTRY = 4096;
const MAX_EXEC_SOURCE_BYTES = 1_000_000;
const MAX_EXEC_FILENAME_LENGTH = 128;
const SAFE_EXEC_FILENAME_EXTS = ['.mts', '.mjs', '.js', '.ts', '.cjs'];

function isSafeExecFileName(name) {
  if (typeof name !== 'string' || !name) return false;
  if (name.length > MAX_EXEC_FILENAME_LENGTH) return false;
  if (name.includes('/') || name.includes('\\') || name.includes('\0')) return false;
  if (name.includes('..')) return false;
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(name)) return false;
  return SAFE_EXEC_FILENAME_EXTS.some((ext) => name.endsWith(ext));
}

function sanitizeExecFileName(fileName) {
  if (!isSafeExecFileName(fileName)) {
    throw new Error(
      'exec: fileName must be a safe basename with an allowed extension ' +
        `(${SAFE_EXEC_FILENAME_EXTS.join(', ')})`,
    );
  }
  return fileName;
}

function sanitizeExecArgv(argv) {
  if (!Array.isArray(argv)) {
    throw new Error('exec: argv must be an array of strings');
  }
  if (argv.length > MAX_EXEC_ARGV) {
    throw new Error(`exec: argv exceeds max length (${MAX_EXEC_ARGV})`);
  }
  for (const a of argv) {
    if (typeof a !== 'string') {
      throw new Error('exec: argv entries must be strings');
    }
    if (a.length > MAX_EXEC_ARGV_ENTRY) {
      throw new Error(`exec: argv entry exceeds max length (${MAX_EXEC_ARGV_ENTRY})`);
    }
  }
  return argv;
}

function sanitizeExecCode(code) {
  if (typeof code !== 'string' || !code) {
    throw new Error('exec: code is required');
  }
  if (Buffer.byteLength(code, 'utf8') > MAX_EXEC_SOURCE_BYTES) {
    throw new Error(`exec: code exceeds max size (${MAX_EXEC_SOURCE_BYTES} bytes)`);
  }
  return code;
}

// Generous on purpose: a false positive costs one prompt, a false negative costs silence.
const MICROPHONE_PATTERNS = [
  /\bavfoundation\b/,
  /\bdshow\b/,
  /['"`]pulse['"`]/,
  /['"`]alsa['"`]/,
  /\bstartMicrophone\b/,
];

/**
 * @param {string} code
 * @returns {string[]}
 */
function detectDeviceNeeds(code) {
  if (typeof code !== 'string' || !code) return [];
  return MICROPHONE_PATTERNS.some((re) => re.test(code)) ? ['microphone'] : [];
}

// buildLesson can't rewrite imports inside a dependency, so the rule is the
// package, not the symptom: anything but the QVAC SDK and Bare shims is refused.
const BARE_SAFE_PACKAGES = [/^@qvac\/sdk$/, /^bare-[a-z0-9-]+$/];

const IMPORT_SPECIFIER = /\bfrom\s+["']([^"']+)["']/g;
// Everything after the last node_modules segment, i.e. the installed name.
const PACKAGE_NAME = /.*\/node_modules\/((?:@[^/]+\/)?[^/]+)/;

// In portable mode a specifier is one of our own tokens, not an absolute
// path; PACKAGE_NAME can't read a package name out of that on its own.
function packageNameFromSpec(spec) {
  if (!isPortableToken(spec)) return PACKAGE_NAME.exec(spec)?.[1] ?? null;
  const rest = spec.slice(TOKEN_PREFIX.length);
  if (!rest.startsWith('npm-package:')) return null; // qvac-sdk/bare-builtin tokens are already bare-safe
  const importSpec = rest.slice('npm-package:'.length);
  return importSpec.startsWith('@') ? importSpec.split('/').slice(0, 2).join('/') : importSpec.split('/')[0];
}

/**
 * Run on the built source, where every specifier is either an absolute path
 * (local run) or one of our portable tokens (peer-exec).
 * @param {string} code
 * @returns {string[]}
 */
function nodeOnlyPackages(code) {
  if (typeof code !== 'string' || !code) return [];
  const out = [];
  for (const [, spec] of code.matchAll(IMPORT_SPECIFIER)) {
    const name = packageNameFromSpec(spec);
    if (!name || BARE_SAFE_PACKAGES.some((re) => re.test(name))) continue;
    if (!out.includes(name)) out.push(name);
  }
  return out;
}

// Read out so the host can check against its shipped list before installing.
const NPX_PACKAGE = /["'](?:-y|--yes|-p|--package)["']\s*,\s*["']([^"']+)["']/g;

/**
 * @param {string} code
 * @returns {string[]}
 */
function npxPackages(code) {
  if (typeof code !== 'string' || !code) return [];
  const out = [];
  for (const [, pkg] of code.matchAll(NPX_PACKAGE)) {
    if (!out.includes(pkg)) out.push(pkg);
  }
  return out;
}

/**
 * Null when Bare can take it.
 * @param {string} code
 * @returns {string | null}
 */
function detectNodeOnly(code) {
  const packages = nodeOnlyPackages(code);
  if (packages.length === 0) return null;
  return `it imports ${packages.join(', ')}, which needs a Node runtime`;
}

module.exports = {
  detectDeviceNeeds,
  detectNodeOnly,
  npxPackages,
  nodeOnlyPackages,
  isSafeExecFileName,
  sanitizeExecFileName,
  sanitizeExecArgv,
  sanitizeExecCode,
  MAX_EXEC_ARGV,
  MAX_EXEC_ARGV_ENTRY,
  MAX_EXEC_SOURCE_BYTES,
  SAFE_EXEC_FILENAME_EXTS,
};
