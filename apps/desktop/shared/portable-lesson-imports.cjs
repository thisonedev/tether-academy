// @ts-check
'use strict';

// buildLesson()'s require.resolve() paths are only valid on the machine that
// built them; peer-exec runs elsewhere. In portable mode it emits one of
// these tokens instead, and exec-host.cjs resolves each to its own local
// path. Fixed, closed set only: resolving an arbitrary name would let a
// peer probe what's installed on the executing machine.

const TOKEN_PREFIX = 'academy-portable:';

const BARE_BUILTINS = {
  fs: 'bare-fs',
  'fs/promises': 'bare-fs/promises',
  os: 'bare-os',
  path: 'bare-path',
  child_process: 'bare-subprocess',
  process: 'bare-process',
  events: 'bare-events',
  crypto: 'bare-crypto',
};

const BARE_PACKAGE_NAMES = new Set(Object.values(BARE_BUILTINS));

// Lesson-facing replacements for a Bare builtin, living in this app rather
// than node_modules. Closed set, and the path comes from this file's own
// location, so a peer picks a name from the list and never a path.
const LESSON_SHIM_DIR = 'lesson-shims';
const LESSON_SHIMS = { child_process: 'child-process' };
// child-process-node is node-only, reached directly rather than through
// LESSON_SHIMS (bare-only), but still needs to be an accepted token name.
const LESSON_SHIM_NAMES = new Set([...Object.values(LESSON_SHIMS), 'child-process-node']);

// Registered together since which one a snippet needs isn't known until it
// runs. Reached by path because the package's own `./<name>/plugin` exports
// are import-only and a CJS resolve of them fails.
const BARE_PLUGIN_DIR = 'dist/server/bare/plugins';
const BARE_PLUGINS = [
  'llamacpp-completion',
  'llamacpp-embedding',
  'whispercpp-transcription',
  'bci-whispercpp-transcription',
  'parakeet-transcription',
  'nmtcpp-translation',
  'tts-ggml',
  'ggml-ocr',
  'sdcpp-generation',
  'audiogen-ggml',
  'ggml-vla',
  'ggml-classification',
];
const BARE_PLUGIN_NAMES = new Set(BARE_PLUGINS);

// Lessons can import a real npm dependency of this app directly (MCP client
// libraries, etc.), not just @qvac/sdk. Bounded to what this app itself
// already declares, not truly arbitrary: both ends run the same checkout.
let npmDepNamesCache = null;
function npmDepNames() {
  if (npmDepNamesCache) return npmDepNamesCache;
  try {
    const fs = require('fs');
    const path = require('path');
    const pkg = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'package.json'), 'utf8'));
    npmDepNamesCache = new Set(Object.keys(pkg.dependencies ?? {}));
  } catch {
    npmDepNamesCache = new Set();
  }
  return npmDepNamesCache;
}

function npmPackageNameOf(spec) {
  return spec.startsWith('@') ? spec.split('/').slice(0, 2).join('/') : spec.split('/')[0];
}

function qvacSdkToken() {
  return `${TOKEN_PREFIX}qvac-sdk`;
}

function qvacSdkPluginToken(pluginName) {
  return `${TOKEN_PREFIX}qvac-sdk-plugin:${pluginName}`;
}

function bareBuiltinToken(packageName) {
  return `${TOKEN_PREFIX}bare-builtin:${packageName}`;
}

function lessonShimToken(shimName) {
  return `${TOKEN_PREFIX}lesson-shim:${shimName}`;
}

// Absolute path to a shim on this machine; `shimName` must already be known.
function lessonShimPath(shimName) {
  const path = require('path');
  return path.join(__dirname, LESSON_SHIM_DIR, `${shimName}.cjs`);
}

// `spec` carries any subpath (e.g. '@modelcontextprotocol/sdk/client/index.js'),
// since require.resolve needs the exact entry point, not just the package name.
function npmPackageToken(spec) {
  return `${TOKEN_PREFIX}npm-package:${spec}`;
}

// buildLesson makes a lesson's courses-relative fixture path absolute, which
// names the wrong filesystem on a peer run, so portable mode emits this and
// the host resolves it. `rel` is forward-slashed whatever platform built it.
function courseAssetToken(rel) {
  return `${TOKEN_PREFIX}course-asset:${rel}`;
}

/**
 * @param {string} spec
 * @returns {boolean}
 */
function isPortableToken(spec) {
  return typeof spec === 'string' && spec.startsWith(TOKEN_PREFIX);
}

/**
 * Resolves a token to an absolute path on this machine. Resolvers are
 * injected so this runs under both Node and Bare's own require.resolve.
 * @param {string} spec
 * @param {{ resolveSdk: () => string, resolveBuiltin: (pkg: string) => string }} resolvers
 * @returns {string | null} null if `spec` isn't a recognized token, or resolution failed.
 */
function resolvePortableToken(spec, { resolveSdk, resolveBuiltin }) {
  if (!isPortableToken(spec)) return null;
  const rest = spec.slice(TOKEN_PREFIX.length);
  try {
    if (rest === 'qvac-sdk') {
      return resolveSdk();
    }
    if (rest.startsWith('qvac-sdk-plugin:')) {
      const pluginName = rest.slice('qvac-sdk-plugin:'.length);
      if (!BARE_PLUGIN_NAMES.has(pluginName)) return null;
      // Bare has no node: prefix; every other file in this worker-side
      // codebase requires 'path' unprefixed, so this matches that.
      const path = require('path');
      const sdkRoot = path.resolve(path.dirname(resolveSdk()), '..');
      return path.join(sdkRoot, BARE_PLUGIN_DIR, pluginName, 'plugin.js');
    }
    if (rest.startsWith('lesson-shim:')) {
      const shimName = rest.slice('lesson-shim:'.length);
      if (!LESSON_SHIM_NAMES.has(shimName)) return null;
      return lessonShimPath(shimName);
    }
    if (rest.startsWith('bare-builtin:')) {
      const packageName = rest.slice('bare-builtin:'.length);
      if (!BARE_PACKAGE_NAMES.has(packageName)) return null;
      return resolveBuiltin(packageName);
    }
    if (rest.startsWith('npm-package:')) {
      const importSpec = rest.slice('npm-package:'.length);
      if (!npmDepNames().has(npmPackageNameOf(importSpec))) return null;
      return resolveBuiltin(importSpec);
    }
  } catch {
    return null;
  }
  return null;
}

/**
 * ESM specifier for an absolute path. Node reads `C:\...` as a URL with scheme
 * "c:", so a Windows path is never a usable specifier on its own; Node and Bare
 * both accept the file:// form on every platform.
 * @param {string} abs
 * @returns {string}
 */
function fileSpecifier(abs) {
  const slashed = String(abs).replace(/\\/g, '/');
  const rooted = slashed.startsWith('/') ? slashed : `/${slashed}`;
  // encodeURI leaves ? and # alone, and both would end the URL's path early.
  return `file://${encodeURI(rooted).replace(/\?/g, '%3F').replace(/#/g, '%23')}`;
}

// Matches runner-process.cjs's resolveAllImports, so substitution only
// touches actual import/export specifiers.
const IMPORT_SPECIFIER_RE =
  /(\bimport\s+(?:[\w*\s{},]+\s+from\s+)?|\bexport\s+(?:[\w*\s{},]+\s+from\s+)?)(['"])([^'"]+)\2/g;

/**
 * Resolves every token in `code` to this machine's own path.
 * @param {string} code
 * @param {{ resolveSdk: () => string, resolveBuiltin: (pkg: string) => string }} resolvers
 * @returns {{ code: string, unresolved: string[] }} `unresolved`: refuse the run rather than spawn it.
 */
function substitutePortableImports(code, resolvers) {
  const unresolved = [];
  const out = code.replace(IMPORT_SPECIFIER_RE, (match, head, quote, spec) => {
    if (!isPortableToken(spec)) return match;
    const resolved = resolvePortableToken(spec, resolvers);
    if (resolved == null) {
      unresolved.push(spec);
      return match;
    }
    // JSON.stringify, not raw interpolation: a Windows path carries
    // backslashes that a JS string literal would read as escapes.
    return `${head}${JSON.stringify(fileSpecifier(resolved))}`;
  });
  return { code: out, unresolved };
}

const ASSET_TOKEN_RE = new RegExp(`(['"])${TOKEN_PREFIX}course-asset:([^'"]+)\\1`, 'g');

/**
 * Resolves every course-asset token in `code` against this machine's courses
 * directory.
 * @param {string} code
 * @param {{ coursesDir: string }} opts
 * @returns {{ code: string, missing: string[], refused: string[] }}
 *   `missing`: named a file this device does not have. `refused`: pointed
 *   outside the courses directory, which no lesson has cause to do.
 */
function substitutePortableAssets(code, { coursesDir }) {
  const fs = require('fs');
  const path = require('path');
  const root = path.resolve(coursesDir);
  const missing = [];
  const refused = [];
  const out = code.replace(ASSET_TOKEN_RE, (match, quote, rel) => {
    const abs = path.resolve(root, rel);
    if (abs !== root && !abs.startsWith(root + path.sep)) {
      refused.push(rel);
      return match;
    }
    // Checked here rather than left to the run: the SDK's own error names a
    // path from a filesystem the reader is not looking at.
    if (!fs.existsSync(abs)) {
      missing.push(rel);
      return match;
    }
    // Stays a filesystem path (the lesson hands it to fs), so only the
    // escaping changes.
    return JSON.stringify(abs);
  });
  return { code: out, missing, refused };
}

module.exports = {
  TOKEN_PREFIX,
  BARE_BUILTINS,
  BARE_PACKAGE_NAMES,
  BARE_PLUGIN_DIR,
  BARE_PLUGINS,
  BARE_PLUGIN_NAMES,
  qvacSdkToken,
  qvacSdkPluginToken,
  bareBuiltinToken,
  lessonShimToken,
  lessonShimPath,
  LESSON_SHIMS,
  npmPackageToken,
  courseAssetToken,
  isPortableToken,
  resolvePortableToken,
  substitutePortableImports,
  substitutePortableAssets,
  fileSpecifier,
};
