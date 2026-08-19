// Pure string-processing for lesson snippets, reused by runner.cjs (spawns
// locally) and main.js (ships to a peer via peer.exec). No I/O, no spawning.
// Two flavours since the callers no longer run the same binary: Bare has no
// `process` global, ships each builtin separately, and needs the QVAC plugins
// registered by hand.

const { createRequire } = require('node:module');
const net = require('node:net');
const path = require('node:path');
const {
  BARE_BUILTINS,
  BARE_PLUGIN_DIR,
  BARE_PLUGINS,
  qvacSdkToken,
  qvacSdkPluginToken,
  bareBuiltinToken,
  npmPackageToken,
  courseAssetToken,
} = require('../shared/portable-lesson-imports.cjs');
const { LESSON_DONE_MARKER } = require('../shared/lesson-done.cjs');

const parentRequire = createRequire(__filename);

// In-process MongoClient drop-in for the rag-mongodb lesson: runs
// $vectorSearch/cosine similarity without a real Atlas server. Inlined as
// source text (see mockPreamble) rather than written to disk, since
// peer-exec ships the wrapped snippet to a device with no shared filesystem.
const MONGO_MOCK_BODY = `
  const STATE = { collections: new Map() };

  function getCollection(dbName, collName) {
    if (!STATE.collections.has(dbName)) STATE.collections.set(dbName, new Map());
    const db = STATE.collections.get(dbName);
    if (!db.has(collName)) db.set(collName, { docs: [], indexes: new Map() });
    return db.get(collName);
  }

  function cosine(a, b) {
    if (!Array.isArray(a) || !Array.isArray(b) || a.length !== b.length) return 0;
    let dot = 0, na = 0, nb = 0;
    for (let i = 0; i < a.length; i++) {
      dot += a[i] * b[i];
      na += a[i] * a[i];
      nb += b[i] * b[i];
    }
    const denom = Math.sqrt(na) * Math.sqrt(nb);
    return denom === 0 ? 0 : dot / denom;
  }

  class AggregateCursor {
    constructor(stages, state) {
      this._stages = stages;
      this._state = state;
    }
    async toArray() {
      let rows = this._state.docs.slice();
      for (const stage of this._stages) {
        if ('$vectorSearch' in stage) {
          const v = stage.$vectorSearch;
          const queryVec = v.queryVector;
          const filter = v.filter || {};
          const numCandidates = v.numCandidates ?? 100;
          const limit = v.limit ?? 10;
          rows = rows.filter((doc) => {
            for (const [field, cond] of Object.entries(filter)) {
              const expected = cond && typeof cond === 'object' && '$eq' in cond ? cond.$eq : cond;
              if (doc[field] !== expected) return false;
            }
            return true;
          });
          const scored = rows.map((doc) => ({
            doc,
            score: typeof doc[v.path] === 'object' && queryVec
              ? cosine(Array.from(doc[v.path]), Array.from(queryVec))
              : 0,
          }));
          scored.sort((a, b) => b.score - a.score);
          const top = scored.slice(0, Math.max(numCandidates, limit)).slice(0, limit);
          rows = top.map(({ doc, score }) => ({ ...doc, score }));
        } else if ('$project' in stage) {
          const proj = stage.$project;
          rows = rows.map((row) => {
            const out = {};
            for (const [field, include] of Object.entries(proj)) {
              if (field === '_id' && include === 0) continue;
              if (include === 1) out[field] = row[field];
              else if (include && typeof include === 'object' && '$meta' in include) {
                if (include.$meta === 'vectorSearchScore') out[field] = row.score;
              }
            }
            return out;
          });
        }
      }
      return rows;
    }
  }

  class Collection {
    constructor(dbName, name) {
      this._dbName = dbName;
      this._name = name;
    }
    get _state() {
      return getCollection(this._dbName, this._name);
    }
    async drop() {
      if (STATE.collections.has(this._dbName)) {
        STATE.collections.get(this._dbName).delete(this._name);
      }
    }
    async insertMany(docs) {
      const state = this._state;
      for (const d of docs) state.docs.push({ ...d });
      return { acknowledged: true, insertedCount: docs.length };
    }
    async createSearchIndex(spec) {
      const state = this._state;
      state.indexes.set(spec.name, { ...spec, queryable: true });
      return spec.name;
    }
    listSearchIndexes(name) {
      const state = this._state;
      const idx = state.indexes.get(name);
      const list = idx ? [{ name, queryable: idx.queryable ?? true }] : [];
      return { toArray: async () => list };
    }
    aggregate(stages) {
      return new AggregateCursor(stages, this._state);
    }
  }

  class Db {
    constructor(name) { this._name = name; }
    collection(name) { return new Collection(this._name, name); }
    async command() { return { ok: 1 }; }
  }

  class MongoClient {
    constructor(_url) { this._url = _url; }
    async connect() { return this; }
    async close() {}
    db(name) { return new Db(name); }
  }
`;

// Per-lesson mock modules, matched against the lesson source and inlined by
// mockPreamble in place of the real import.
const MOCKS_BY_TRIGGER = [
  {
    trigger: /from\s+["']mongodb["']/,
    spec: 'mongodb',
    note: 'No MongoDB at localhost:27017; running against the in-process mock.',
    realNote: 'MongoDB at localhost:27017 reachable; running against the real driver.',
    exports: ['MongoClient'],
    inlineSource: MONGO_MOCK_BODY,
  },
];

function detectMockImports(source) {
  for (const entry of MOCKS_BY_TRIGGER) {
    if (entry.trigger.test(source)) return entry.spec;
  }
  return null;
}

function probeTcp(port, host = '127.0.0.1', deadlineMs = 250) {
  return new Promise((resolve) => {
    const socket = new net.Socket();
    let settled = false;
    const finish = (ok) => {
      if (settled) return;
      settled = true;
      socket.removeAllListeners();
      socket.destroy();
      resolve(ok);
    };
    socket.once('connect', () => finish(true));
    socket.once('error', () => finish(false));
    socket.setTimeout(deadlineMs, () => finish(false));
    socket.connect(port, host);
  });
}

/**
 * @param {{ forceMock?: boolean }} opts `forceMock` skips the reachability
 *   probe and always mocks — for peer-exec, where the probe would only ever
 *   describe the initiating device's own localhost, not the peer's.
 */
async function decideMockImports(source, opts = {}) {
  const spec = detectMockImports(source);
  if (spec === null) {
    return { mockImports: {}, note: null, real: false };
  }
  const entry = MOCKS_BY_TRIGGER.find((e) => e.spec === spec);
  if (!opts.forceMock) {
    const reachable = await probeTcp(27017);
    if (reachable) {
      return { mockImports: {}, note: entry.realNote, real: true };
    }
  }
  return { mockImports: { [spec]: entry }, note: entry.note, real: false };
}

// Absolute path so the snippet needs no resolution root of its own; in
// portable mode (peer-exec), a token instead, since the sender's own path
// is wrong on the receiver. See shared/portable-lesson-imports.cjs.
function bareBuiltinPath(spec, portable) {
  const target = BARE_BUILTINS[spec.replace(/^node:/, '')];
  if (!target) return null;
  if (portable) return bareBuiltinToken(target);
  try {
    return parentRequire.resolve(target);
  } catch {
    return null;
  }
}

function resolveImport(spec, runtime, portable) {
  if (spec.startsWith('node:')) {
    return runtime === 'bare' ? bareBuiltinPath(spec, portable) ?? spec : spec;
  }
  if (spec.startsWith('.') || spec.startsWith('/') || spec.startsWith('..')) {
    return spec;
  }
  if (runtime === 'bare') {
    const builtin = bareBuiltinPath(spec, portable);
    if (builtin) return builtin;
  }
  // @qvac/sdk already gets one combined import (buildLesson injects it,
  // stripForNode removes this original line); the generic branch below
  // would otherwise tokenize it too, redeclaring the same names.
  if (spec === '@qvac/sdk') {
    return portable ? qvacSdkToken() : parentRequire.resolve(spec);
  }
  // A real npm dependency of a lesson (e.g. an MCP client library), not a
  // builtin. In portable mode this machine's resolved path is meaningless on
  // the receiver, so hand off a token instead of the sender's own path.
  if (portable) return npmPackageToken(spec);
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
    .map((s) => s.trim())
    // A type has no runtime binding, so keeping it emitted
    // `const { type RagEmbeddedDoc } = ...` and the lesson died on a SyntaxError.
    .filter((s) => s && !/^type\s/.test(s))
    .map((s) => s.split(/\s+as\s+/)[0].trim())
    .filter(Boolean);
}

function resolveAllImports(src, runtime, portable) {
  return src.replace(
    /(\bimport\s+(?:[\w*\s{},]+\s+from\s+)?|\bexport\s+(?:[\w*\s{},]+\s+from\s+)?)(['"])([^'"]+)\2/g,
    (match, head, quote, spec) => {
      const resolved = resolveImport(spec, runtime, portable);
      return resolved === spec ? match : `${head}${quote}${resolved}${quote}`;
    },
  );
}

function escapeRegExp(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

// Removes the named import for each mocked specifier and records the bound
// names for mockPreamble() to rebind.
function stripMockedImports(src, mockMap) {
  let out = src;
  const bindingsBySpec = {};
  for (const spec of Object.keys(mockMap)) {
    const re = new RegExp(
      `^[ \\t]*import\\s+\\{([^}]+)\\}\\s+from\\s+(['"])${escapeRegExp(spec)}\\2;?[ \\t]*$`,
      'm',
    );
    const m = out.match(re);
    if (!m) continue;
    bindingsBySpec[spec] = m[1]
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean)
      .map((s) => s.replace(/\s+as\s+/, ': '));
    out = out.replace(re, '');
  }
  return { src: out, bindingsBySpec };
}

function mockPreamble(mockMap, bindingsBySpec) {
  let out = '';
  for (const [spec, entry] of Object.entries(mockMap)) {
    const bindings = bindingsBySpec[spec];
    if (!bindings || bindings.length === 0) continue;
    const safeName = spec.replace(/[^a-zA-Z0-9_]/g, '_');
    out += `const __academyMock_${safeName} = (() => {\n${entry.inlineSource}\n  return { ${entry.exports.join(', ')} };\n})();\n`;
    out += `const { ${bindings.join(', ')} } = __academyMock_${safeName};\n`;
  }
  return out;
}

function stripForNode(src) {
  const sdkPath = parentRequire.resolve('@qvac/sdk');
  const sdkPathRe = sdkPath.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  // In portable mode resolveAllImports already rewrote the original @qvac/sdk
  // specifier to this token, not the sender's own path; strip that form too,
  // or the token's names collide with the freshly injected importLine below.
  const tokenRe = qvacSdkToken().replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return src
    .replace(/^import\s+type\s+.+?from\s+['"][^'"]+['"];?\s*$/gm, '')
    .replace(
      new RegExp(
        `^import\\s+\\{[^}]+\\}\\s+from\\s+['"](?:@qvac/sdk|${sdkPathRe}|${tokenRe})['"];?\\s*$`,
        'gm',
      ),
      '',
    )
    .replace(
      new RegExp(`^import\\s+.+?from\\s+['"](?:@qvac/sdk|${sdkPathRe}|${tokenRe})['"];?\\s*$`, 'gm'),
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
  // A lesson written as top-level await has no entry call to wrap. Module
  // evaluation runs statements in order, so a finish appended after the body
  // waits on everything above it.
  if (!match) return `${src}\n__academyFinish(Promise.resolve());\n`;

  const callAt = match.index + match[0].indexOf('main');
  const end = statementEnd(src, callAt);
  if (end === -1 || !isTrivia(src.slice(end))) return src;

  const expr = src.slice(callAt, end).replace(/;\s*$/, '').trim();
  return `${src.slice(0, match.index)}__academyFinish(${expr});${src.slice(end)}`;
}

function resolveFixturePaths(src, coursesDir, portable) {
  // path.join collapses `..` silently, so the resolved path is checked against coursesDir.
  const root = path.resolve(coursesDir);
  const rootWithSep = root + path.sep;
  return src.replace(/(['"])(\.?\/?examples\/[^'"]+)\1/g, (match, quote, rel) => {
    const clean = rel.replace(/^\.\//, '');
    const abs = path.resolve(root, clean);
    if (abs !== root && !abs.startsWith(rootWithSep)) {
      throw new Error(`buildLesson: refused path outside coursesDir: ${rel}`);
    }
    // A peer run opens the file on the other machine, where this checkout's
    // path means nothing, so the host resolves the token against its own.
    if (portable) {
      return `${quote}${courseAssetToken(path.relative(root, abs).split(path.sep).join('/'))}${quote}`;
    }
    return `${quote}${abs}${quote}`;
  });
}

// Never clobber: add _1, _2 like a browser download, swapped in at the call site.
const dedupePreamble = (runtime, portable) => `import { writeFileSync as __academyWrite, existsSync as __academyExists, mkdirSync as __academyMkdir } from ${JSON.stringify(resolveImport('node:fs', runtime, portable))};
import { dirname as __academyDirname, extname as __academyExt, join as __academyJoin, basename as __academyBase, resolve as __academyResolve } from ${JSON.stringify(resolveImport('node:path', runtime, portable))};
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
  // The host cannot tell a lesson still computing from one whose worker is
  // holding the process open after the work ended, so say which this is.
  try { process.stderr.write(${JSON.stringify(LESSON_DONE_MARKER)}); } catch {}
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
  // The SDK worker logs teardown chatter as plain text via console.error
  // ("Transcription failed: Model was unloaded" and similar). Match the
  // common patterns so the lesson panel doesn't turn red on a deliberate Stop.
  if (/\bmodel was unloaded\b|\bmodel.*unloaded\b/i.test(m)) return true;
  if (/\b(transcription|translation|tts|text-to-speech) failed\b/i.test(m)) return true;
  if (/\bstream aborted\b|\bstream.*aborted\b/i.test(m)) return true;
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

// A lesson parked in loadModel for two minutes prints nothing and reads as a
// hang. The wrap already hands the lesson its SDK bindings, so these are the
// timed ones, reported in the same `→`/`✓` lines the host uses for its stages.
const tracePreamble = `
// A call that returns inside this window is not the one anyone is waiting on,
// so it prints nothing at all.
const __ACADEMY_TRACE_AFTER_MS = 200;
// Setup every lesson performs, never the call a lesson is about. It always
// outruns the window above, so tracing it repeated one uninformative row on
// every run. A cold load still shows up as download progress.
const __ACADEMY_UNTRACED = new Set(["loadModel", "unloadModel"]);
// Keys, counts and lengths only: enough to tell two calls apart, without
// putting a prompt or a document in the output.
function __academyDescribeArg(v) {
  if (v === null || v === undefined) return String(v);
  if (typeof v === "string") return JSON.stringify(v.length > 32 ? v.slice(0, 32) + "…" : v);
  if (typeof v === "number" || typeof v === "boolean") return String(v);
  if (Array.isArray(v)) return "[" + v.length + " items]";
  if (typeof v === "object") {
    const keys = Object.keys(v);
    return "{ " + keys.slice(0, 4).join(", ") + (keys.length > 4 ? ", …" : "") + " }";
  }
  return typeof v;
}
function __academyTrace(bindings) {
  const out = {};
  for (const name of Object.keys(bindings)) {
    const value = bindings[name];
    // Constants pass through, and a class needs \`new\`, which a plain
    // function wrapper would break.
    const isClass = typeof value === "function" && /^class[\\s{]/.test(Function.prototype.toString.call(value));
    if (typeof value !== "function" || isClass || __ACADEMY_UNTRACED.has(name)) {
      out[name] = value;
      continue;
    }
    const traced = function (...args) {
      const startedAt = Date.now();
      let announced = false;
      const timer = setTimeout(() => {
        announced = true;
        console.error("→ " + name + "(" + args.map(__academyDescribeArg).join(", ") + ")");
      }, __ACADEMY_TRACE_AFTER_MS);
      if (typeof timer.unref === "function") timer.unref();
      const settled = () => {
        clearTimeout(timer);
        if (!announced) return;
        console.error("  ✓ " + name + " (" + ((Date.now() - startedAt) / 1000).toFixed(1) + "s)");
      };
      let result;
      try {
        result = value.apply(this, args);
      } catch (err) {
        settled();
        throw err;
      }
      // A streaming call returns its handle at once; the tick says the call
      // came back, not that the stream is drained.
      if (result && typeof result.then === "function") {
        return result.then((v) => { settled(); return v; }, (err) => { settled(); throw err; });
      }
      settled();
      return result;
    };
    try { Object.assign(traced, value); } catch {}
    out[name] = traced;
  }
  return out;
}
`;

/**
 * What Bare doesn't hand a snippet for free: a `process` global and an SDK with
 * its plugins loaded. Skipped when the snippet binds `process` itself, which
 * would be a syntax error.
 */
function barePreamble(source, portable) {
  // resolve() lands on dist/index.js; the plugin tree hangs off the package root.
  const sdkRoot = portable ? null : path.resolve(path.dirname(parentRequire.resolve('@qvac/sdk')), '..');
  const lines = [];
  if (!/^\s*import\s[^;]*\bprocess\b[^;]*\bfrom\b/m.test(source)) {
    lines.push(`import process from ${JSON.stringify(resolveImport('node:process', 'bare', portable))};`);
  }
  const names = [];
  for (const [i, plugin] of BARE_PLUGINS.entries()) {
    const name = `__academyPlugin${i}`;
    names.push(name);
    const pluginPath = portable ? qvacSdkPluginToken(plugin) : path.join(sdkRoot, BARE_PLUGIN_DIR, plugin, 'plugin.js');
    lines.push(`import * as ${name} from ${JSON.stringify(pluginPath)};`);
  }
  const sdkPath = portable ? qvacSdkToken() : parentRequire.resolve('@qvac/sdk');
  lines.push(
    `import { plugins as __academyPlugins } from ${JSON.stringify(sdkPath)};`,
    // Each module names its export differently, so take the objects.
    `__academyPlugins([${names.join(', ')}].flatMap((m) => Object.values(m).filter((v) => v && typeof v === "object")));`,
  );
  return `${lines.join('\n')}\n`;
}

/**
 * @param {{ source: string, cwd: string, runtime?: 'node' | 'bare', mockImports?: Record<string, object>, mockNote?: string|null, portable?: boolean }} opts
 *   `mockImports` is the decision `decideMockImports` already made (this
 *   function is sync and can't run that probe itself). `mockNote`, when set,
 *   prints as a stderr line at the top of the wrap. `portable`: peer-exec
 *   builds on the sender and runs on a different machine, so emit tokens for
 *   require.resolve()'d paths instead of this machine's own; see
 *   shared/portable-lesson-imports.cjs.
 * @returns {string}
 */
function buildLesson({ source, cwd, runtime = 'node', mockImports = {}, mockNote, portable = false }) {
  const { src: unmockedSource, bindingsBySpec } = stripMockedImports(source, mockImports);
  const resolvedSource = routeWritesThroughDedupe(
    resolveFixturePaths(resolveAllImports(unmockedSource, runtime, portable), cwd, portable),
  );
  const importedNames = extractImportedNames(unmockedSource);
  const namesForImport = Array.from(new Set([...importedNames, 'close']));
  const sdkPath = portable ? qvacSdkToken() : parentRequire.resolve('@qvac/sdk');
  const aliased = namesForImport.map((n) => `${n} as __academySdk_${n}`).join(', ');
  const importLine = `import { ${aliased} } from ${JSON.stringify(sdkPath)};\n`;
  // Same names the lesson wrote, so nothing below this line knows the difference.
  const traceBinding = `${tracePreamble}const { ${namesForImport.join(', ')} } = __academyTrace({ ${namesForImport
    .map((n) => `${n}: __academySdk_${n}`)
    .join(', ')} });\n`;
  const hooked = hookLessonExit(stripForNode(resolvedSource));
  const runtimePreamble = runtime === 'bare' ? barePreamble(source, portable) : '';
  // stdout, not stderr: the lesson's own console.log lines are on stdout, and
  // the two streams don't interleave in true chronological order once captured.
  const noteLine = mockNote ? `console.log(${JSON.stringify('▸ ' + mockNote)});\n` : '';
  const mockPre = mockPreamble(mockImports, bindingsBySpec);
  return `${runtimePreamble}${importLine}${traceBinding}${dedupePreamble(runtime, portable)}${noteLine}${mockPre}${hooked}\n`;
}

module.exports = {
  buildLesson,
  BARE_BUILTINS,
  BARE_PLUGINS,
  detectMockImports,
  decideMockImports,
  probeTcp,
};
