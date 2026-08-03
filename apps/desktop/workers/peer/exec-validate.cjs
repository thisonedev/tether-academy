// Input validation for peer-exec. Everything a remote peer can influence passes
// through here before it reaches spawn: the filename it lands in, the argv, and
// the source itself.
//
// Pure functions with no module state, so they are cheap to reason about and to
// test in isolation. Keep them that way.
'use strict';

const MAX_EXEC_ARGV = 32;
const MAX_EXEC_ARGV_ENTRY = 4096;
const MAX_EXEC_SOURCE_BYTES = 1_000_000;
const MAX_EXEC_FILENAME_LENGTH = 128;
const SAFE_EXEC_FILENAME_EXTS = ['.mts', '.mjs', '.js', '.ts', '.cjs'];

// Basename only, no path separators/traversal, allowed extensions only.
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

// ffmpeg capture backends and the helper the course samples wrap them in.
// Generous on purpose: a false positive costs one prompt, a false negative
// costs silence.
const MICROPHONE_PATTERNS = [
  /\bavfoundation\b/,
  /\bdshow\b/,
  /['"`]pulse['"`]/,
  /['"`]alsa['"`]/,
  /\bstartMicrophone\b/,
];

/**
 * Devices this source will need, for the per-run consent prompt.
 * @param {string} code
 * @returns {string[]}
 */
function detectDeviceNeeds(code) {
  if (typeof code !== 'string' || !code) return [];
  return MICROPHONE_PATTERNS.some((re) => re.test(code)) ? ['microphone'] : [];
}

// buildLesson rewrites the lesson's own node: imports to Bare packages, but it
// cannot reach inside a dependency: @modelcontextprotocol/sdk pulls cross-spawn,
// which requires 'child_process', and @sqliteai/sqlite-wasm imports 'module'.
// So the rule is the package, not the symptom — anything but the QVAC SDK and
// the Bare shims is refused, and a lesson importing something new is caught the
// first time rather than failing with a resolver error from inside node_modules.
const BARE_SAFE_PACKAGES = [/^@qvac\/sdk$/, /^bare-[a-z0-9-]+$/];

const IMPORT_SPECIFIER = /\bfrom\s+["']([^"']+)["']/g;
// Everything after the last node_modules segment, i.e. the installed name.
const PACKAGE_NAME = /.*\/node_modules\/((?:@[^/]+\/)?[^/]+)/;

/**
 * Packages this source pulls in beyond the ones the Bare child can load. Run on
 * the built source, where every specifier is already an absolute path.
 * @param {string} code
 * @returns {string[]}
 */
function nodeOnlyPackages(code) {
  if (typeof code !== 'string' || !code) return [];
  const out = [];
  for (const [, spec] of code.matchAll(IMPORT_SPECIFIER)) {
    const name = PACKAGE_NAME.exec(spec)?.[1];
    if (!name || BARE_SAFE_PACKAGES.some((re) => re.test(name))) continue;
    if (!out.includes(name)) out.push(name);
  }
  return out;
}

// Read out so the host can check them against its shipped list before
// installing any of them. See mcp-warm.cjs.
const NPX_PACKAGE = /["'](?:-y|--yes|-p|--package)["']\s*,\s*["']([^"']+)["']/g;

/**
 * Packages this source asks npx to fetch.
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
 * Why this source needs the Node runtime rather than Bare, or null when Bare
 * can take it.
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
