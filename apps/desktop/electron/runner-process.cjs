// Pure string-processing for lesson snippets. Reused by:
// - apps/desktop/runner.cjs (writes the wrapped code to a temp file, spawns locally)
// - apps/desktop/electron/main.js (ships the wrapped code to a peer via peer.exec)
// No I/O, no spawning. The caller decides where the code runs.
//
// Two flavours, since the callers no longer run the same binary. Bare has no
// `process` global, ships each builtin separately, and needs the QVAC plugins
// registered by hand; all three are handled here, not in the course samples.

const { createRequire } = require('node:module');
const path = require('node:path');

const parentRequire = createRequire(__filename);

// Node builtins the course samples use, and the Bare package for each. Resolved
// to absolute paths, so the snippet needs no resolution root of its own.
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

// Registered together: which one a snippet needs is not known until it runs.
// 461 ms for the set. Reached by path because the package's own
// `./<name>/plugin` exports are import-only and a CJS resolve of them fails.
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
  'ggml-vla',
  'ggml-classification',
];

function bareBuiltinPath(spec) {
  const target = BARE_BUILTINS[spec.replace(/^node:/, '')];
  if (!target) return null;
  try {
    return parentRequire.resolve(target);
  } catch {
    return null;
  }
}

function resolveImport(spec, runtime) {
  if (spec.startsWith('node:')) {
    return runtime === 'bare' ? bareBuiltinPath(spec) ?? spec : spec;
  }
  if (spec.startsWith('.') || spec.startsWith('/') || spec.startsWith('..')) {
    return spec;
  }
  if (runtime === 'bare') {
    const builtin = bareBuiltinPath(spec);
    if (builtin) return builtin;
  }
  try {
    return parentRequire.resolve(spec);
  } catch {
    return spec;
  }
}

function extractImportedNames(src) {
  const m = src.match(/^import\s*\{([^}]+)\}\s*from\s*['"]@qvac\/sdk['"]\s*;?/m);
  if (!m) return [];
  return m[1]
    .split(',')
    .map((s) => s.trim().split(/\s+as\s+/)[0].trim())
    .filter(Boolean);
}

function resolveAllImports(src, runtime) {
  return src.replace(
    /(\bimport\s+(?:[\w*\s{},]+\s+from\s+)?|\bexport\s+(?:[\w*\s{},]+\s+from\s+)?)(['"])([^'"]+)\2/g,
    (match, head, quote, spec) => {
      const resolved = resolveImport(spec, runtime);
      return resolved === spec ? match : `${head}${quote}${resolved}${quote}`;
    },
  );
}

function stripForNode(src) {
  const sdkPath = parentRequire.resolve('@qvac/sdk');
  const sdkPathRe = sdkPath.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return src
    .replace(/^import\s+type\s+.+?from\s+['"][^'"]+['"];?\s*$/gm, '')
    .replace(
      new RegExp(
        `^import\\s+\\{[^}]+\\}\\s+from\\s+['"]@qvac/sdk['"];?\\s*$`,
        'gm',
      ),
      '',
    )
    .replace(
      new RegExp(
        `^import\\s+\\{[^}]+\\}\\s+from\\s+['"]${sdkPathRe}['"];?\\s*$`,
        'gm',
      ),
      '',
    )
    .replace(
      new RegExp(`^import\\s+.+?from\\s+['"]@qvac/sdk['"];?\\s*$`, 'gm'),
      '',
    )
    .replace(
      new RegExp(`^import\\s+.+?from\\s+['"]${sdkPathRe}['"];?\\s*$`, 'gm'),
      '',
    )
    .replace(/^export\s+(?:default\s+)?[^=].*;?\s*$/gm, '')
    .replace(/^export\s+default\s+[^=].*;?\s*$/gm, '')
    .replace(/^export\s+\{[^}]*\};?\s*$/gm, '');
}

function hookMainCatch(src) {
  const marker = 'main().catch(';
  const start = src.indexOf(marker);
  if (start === -1) return src;
  let i = start + marker.length;
  let depth = 1;
  let inSingle = false;
  let inDouble = false;
  let inTemplate = false;
  let inLineComment = false;
  let inBlockComment = false;
  while (i < src.length && depth > 0) {
    const ch = src[i];
    const next = src[i + 1];
    if (inLineComment) {
      if (ch === '\n') inLineComment = false;
    } else if (inBlockComment) {
      if (ch === '*' && next === '/') {
        inBlockComment = false;
        i++;
      }
    } else if (inSingle) {
      if (ch === '\\') i++;
      else if (ch === "'") inSingle = false;
    } else if (inDouble) {
      if (ch === '\\') i++;
      else if (ch === '"') inDouble = false;
    } else if (inTemplate) {
      if (ch === '\\') i++;
      else if (ch === '`') inTemplate = false;
    } else {
      if (ch === '/' && next === '/') {
        inLineComment = true;
        i++;
      } else if (ch === '/' && next === '*') {
        inBlockComment = true;
        i++;
      } else if (ch === "'") inSingle = true;
      else if (ch === '"') inDouble = true;
      else if (ch === '`') inTemplate = true;
      else if (ch === '(') depth++;
      else if (ch === ')') {
        depth--;
        if (depth === 0) break;
      }
    }
    i++;
  }
  if (depth !== 0) return src;
  const handler = src.slice(start + marker.length, i);
  let j = i + 1;
  while (j < src.length && (src[j] === ' ' || src[j] === '\t' || src[j] === '\n' || src[j] === '\r')) j++;
  if (src[j] === ';') j++;
  const replacement = `main().catch(${handler}).finally(() => close().catch(() => {})).then(() => process.exit(0));`;
  return src.slice(0, start) + replacement + src.slice(j);
}

function resolveFixturePaths(src, coursesDir) {
  return src.replace(/(['"])(\.?\/?examples\/[^'"]+)\1/g, (match, quote, rel) => {
    const clean = rel.replace(/^\.\//, '');
    return `${quote}${path.join(coursesDir, clean)}${quote}`;
  });
}

// Never clobber: add _1, _2 like a browser download. The lesson calls
// writeFileSync inside the sandbox, so the swap happens at the call site.
const dedupePreamble = (runtime) => `import { writeFileSync as __academyWrite, existsSync as __academyExists, mkdirSync as __academyMkdir } from ${JSON.stringify(resolveImport('node:fs', runtime))};
import { dirname as __academyDirname, extname as __academyExt, join as __academyJoin, basename as __academyBase, resolve as __academyResolve } from ${JSON.stringify(resolveImport('node:path', runtime))};
function __academyFreePath(target) {
  const p = String(target);
  __academyMkdir(__academyDirname(p), { recursive: true });
  if (!__academyExists(p)) return p;
  const dir = __academyDirname(p);
  const ext = __academyExt(p);
  const stem = __academyBase(p, ext);
  for (let i = 1; ; i++) {
    const next = __academyJoin(dir, stem + "_" + i + ext);
    if (!__academyExists(next)) return next;
  }
}
function __academyWriteFile(target, data, opts) {
  const p = __academyFreePath(target);
  __academyWrite(p, data, opts);
  console.log("[saved] " + __academyResolve(p));
  return p;
}
`;

function routeWritesThroughDedupe(src) {
  return src.replace(/\b(?:fs\s*\.\s*)?writeFileSync\s*\(/g, '__academyWriteFile(');
}

/**
 * What Bare does not hand a snippet for free: a `process` global and an SDK with
 * its plugins loaded. Module-scoped, so they cover the snippet untouched.
 * Skipped when the snippet binds `process` itself, which would be a syntax error.
 */
function barePreamble(source) {
  // resolve() lands on dist/index.js; the plugin tree hangs off the package root.
  const sdkRoot = path.resolve(path.dirname(parentRequire.resolve('@qvac/sdk')), '..');
  const lines = [];
  if (!/^\s*import\s[^;]*\bprocess\b[^;]*\bfrom\b/m.test(source)) {
    lines.push(`import process from ${JSON.stringify(resolveImport('node:process', 'bare'))};`);
  }
  const names = [];
  for (const [i, plugin] of BARE_PLUGINS.entries()) {
    const name = `__academyPlugin${i}`;
    names.push(name);
    lines.push(
      `import * as ${name} from ${JSON.stringify(path.join(sdkRoot, BARE_PLUGIN_DIR, plugin, 'plugin.js'))};`,
    );
  }
  lines.push(
    `import { plugins as __academyPlugins } from ${JSON.stringify(parentRequire.resolve('@qvac/sdk'))};`,
    // Each module names its export differently, so take the objects.
    `__academyPlugins([${names.join(', ')}].flatMap((m) => Object.values(m).filter((v) => v && typeof v === "object")));`,
  );
  return `${lines.join('\n')}\n`;
}

/**
 * @param {{ source: string, cwd: string, runtime?: 'node' | 'bare' }} opts
 *   `runtime` is where the result runs: Bare for peer-exec, Node locally.
 * @returns {string}
 */
function buildLesson({ source, cwd, runtime = 'node' }) {
  const resolvedSource = routeWritesThroughDedupe(
    resolveFixturePaths(resolveAllImports(source, runtime), cwd),
  );
  const importedNames = extractImportedNames(source);
  const namesForImport = Array.from(new Set([...importedNames, 'close']));
  const importLine = `import { ${namesForImport.join(', ')} } from ${JSON.stringify(parentRequire.resolve('@qvac/sdk'))};\n`;
  const hooked = hookMainCatch(stripForNode(resolvedSource));
  const runtimePreamble = runtime === 'bare' ? barePreamble(source) : '';
  return `${runtimePreamble}${importLine}${dedupePreamble(runtime)}${hooked}\n`;
}

module.exports = {
  buildLesson,
  BARE_BUILTINS,
  BARE_PLUGINS,
};
