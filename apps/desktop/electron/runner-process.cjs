// Pure string-processing for lesson snippets, reused by runner.cjs (spawns
// locally) and main.js (ships to a peer via peer.exec). No I/O, no spawning.
// Two flavours since the callers no longer run the same binary: Bare has no
// `process` global, ships each builtin separately, and needs the QVAC plugins
// registered by hand.

const { createRequire } = require('node:module');
const path = require('node:path');

const parentRequire = createRequire(__filename);

// Node builtins the course samples use, mapped to their Bare package, resolved
// to absolute paths so the snippet needs no resolution root of its own.
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

// Registered together (461 ms for the set) since which one a snippet needs
// isn't known until it runs. Reached by path because the package's own
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
  'audiogen-ggml',
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

// A lesson's entry call on its own line, with whatever the sample hangs off it.
const ENTRY_CALL = /^[ \t]*(?:void[ \t]+|await[ \t]+)?main[ \t]*\([ \t]*\)/gm;

/**
 * Index just past the statement starting at `from`, or -1 when it does not end.
 * Quotes, template literals, comments and nested brackets are skipped.
 */
function statementEnd(src, from) {
  let depth = 0;
  let inSingle = false;
  let inDouble = false;
  let inTemplate = false;
  let inLineComment = false;
  let inBlockComment = false;
  for (let i = from; i < src.length; i++) {
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
    } else if (ch === '/' && next === '/') {
      inLineComment = true;
      i++;
    } else if (ch === '/' && next === '*') {
      inBlockComment = true;
      i++;
    } else if (ch === "'") inSingle = true;
    else if (ch === '"') inDouble = true;
    else if (ch === '`') inTemplate = true;
    else if (ch === '(' || ch === '[' || ch === '{') depth++;
    else if (ch === ')' || ch === ']' || ch === '}') {
      depth--;
      if (depth < 0) return -1;
    } else if (depth === 0 && ch === ';') return i + 1;
    else if (depth === 0 && ch === '\n') {
      // A chain can carry on to the next line; anything else ends the statement.
      if (!/^\s*(?:\.|\?\.|\()/.test(src.slice(i))) return i;
    }
  }
  return depth === 0 ? src.length : -1;
}

function isTrivia(src) {
  return src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '').trim() === '';
}

/**
 * Hands the lesson's entry call to __academyFinish so teardown runs once it
 * settles. A lesson that loaded a model won't end on its own otherwise, since
 * the SDK's worker holds the process open. Only wrapped when it's the last
 * statement, so exiting early can't cut off whatever came after it.
 */
function hookLessonExit(src) {
  let match = null;
  ENTRY_CALL.lastIndex = 0;
  for (let m = ENTRY_CALL.exec(src); m; m = ENTRY_CALL.exec(src)) match = m;
  if (!match) return src;

  const callAt = match.index + match[0].indexOf('main');
  const end = statementEnd(src, callAt);
  if (end === -1 || !isTrivia(src.slice(end))) return src;

  const expr = src.slice(callAt, end).replace(/;\s*$/, '').trim();
  return `${src.slice(0, match.index)}__academyFinish(${expr});${src.slice(end)}`;
}

function resolveFixturePaths(src, coursesDir) {
  // path.join collapses `..` silently, so the resolved path is checked against coursesDir.
  const root = path.resolve(coursesDir);
  const rootWithSep = root + path.sep;
  return src.replace(/(['"])(\.?\/?examples\/[^'"]+)\1/g, (match, quote, rel) => {
    const clean = rel.replace(/^\.\//, '');
    const abs = path.resolve(root, clean);
    if (abs !== root && !abs.startsWith(rootWithSep)) {
      throw new Error(`buildLesson: refused path outside coursesDir: ${rel}`);
    }
    return `${quote}${abs}${quote}`;
  });
}

// Never clobber: add _1, _2 like a browser download, swapped in at the call site.
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
function __academyExit(code) {
  process.exitCode = code;
  // stdout is a pipe here, so a queued write can still be in flight; process.exit
  // would drop it. The timer covers a runtime whose write takes no callback.
  let pending = 2;
  const bail = setTimeout(() => process.exit(code), 250);
  if (typeof bail.unref === "function") bail.unref();
  const flushed = () => { if (--pending === 0) { clearTimeout(bail); process.exit(code); } };
  try { process.stdout.write("", flushed); } catch { flushed(); }
  try { process.stderr.write("", flushed); } catch { flushed(); }
}
function __academyEnd(code) {
  Promise.resolve().then(() => close()).catch(() => {}).then(() => __academyExit(code));
}
function __academyFinish(p) {
  Promise.resolve(p).then(() => __academyEnd(0), (err) => { console.error(err); __academyEnd(1); });
}
// Lesson snippets install their own uncaughtException filter for these. If
// one slips through the host shouldn't pass on a stack for it.
process.on('unhandledRejection', () => { __academyEnd(1); });
// Swallow teardown-time errors entirely so the lesson output panel only
// shows what the lesson chose to print. Voice-assistant loops can produce
// dozens of these (model unloaded, in-flight RPC aborted) on Stop; surfacing
// them red-as-an-error would undo the "you clicked Stop" UX. The allowlists
// are mirrored from electron/teardown-noise.cjs so the unit tests stay the
// single source of truth.
const TEARDOWN_NAMES = new Set(['WorkerShutdownError', 'WorkerCrashedError', 'BareRuntimeBinaryNotFoundError', 'InferenceCancelledError', 'TranscriptionFailedError', 'TranslationFailedError', 'TextToSpeechStreamFailedError', 'TextToSpeechFailedError']);
const TEARDOWN_CODES = new Set(['ABORT_ERR', 'CHANNEL_CLOSED', 'MODEL_NOT_LOADED', 'MODEL_WAS_UNLOADED', 'WORKER_SHUTDOWN', 'RPC_CONNECTION_FAILED']);
function __academyIsTeardownNoise(err) {
  if (!err) return true;
  const name = (err.name || '').toString();
  const code = (err.code || '').toString();
  if (TEARDOWN_NAMES.has(name)) return true;
  if (TEARDOWN_CODES.has(code)) return true;
  if (/^abort/i.test(name)) return true;
  const m = (err.message || String(err) || '').toString();
  if (/\bis shutting down\b/i.test(m)) return true;
  if (/\bin-flight rpc\b/i.test(m)) return true;
  if (/^Worker exited mid-request\b/i.test(m)) return true;
  return false;
}
process.on('uncaughtException', (err) => {
  if (__academyIsTeardownNoise(err)) return;
  // Real error worth surfacing as a one-liner.
  const m = ((err && err.message) || String(err) || '').toString().trim();
  console.error(m);
});
`;

function routeWritesThroughDedupe(src) {
  return src.replace(/\b(?:fs\s*\.\s*)?writeFileSync\s*\(/g, '__academyWriteFile(');
}

/**
 * What Bare doesn't hand a snippet for free: a `process` global and an SDK with
 * its plugins loaded. Skipped when the snippet binds `process` itself, which
 * would be a syntax error.
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
  const hooked = hookLessonExit(stripForNode(resolvedSource));
  const runtimePreamble = runtime === 'bare' ? barePreamble(source) : '';
  return `${runtimePreamble}${importLine}${dedupePreamble(runtime)}${hooked}\n`;
}

module.exports = {
  buildLesson,
  BARE_BUILTINS,
  BARE_PLUGINS,
};
