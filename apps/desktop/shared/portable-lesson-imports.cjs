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

// `spec` carries any subpath (e.g. '@modelcontextprotocol/sdk/client/index.js'),
// since require.resolve needs the exact entry point, not just the package name.
function npmPackageToken(spec) {
  return `${TOKEN_PREFIX}npm-package:${spec}`;
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
    return `${head}${quote}${resolved}${quote}`;
  });
  return { code: out, unresolved };
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
  npmPackageToken,
  isPortableToken,
  resolvePortableToken,
  substitutePortableImports,
};
