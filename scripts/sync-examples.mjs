// Pure correctness check: every SDK call in each lesson's vendored
// .answer.ts must still be present in the matched upstream file. Fails
// the build on real API drift; never modifies any file.
//
// Vendored .answer.ts files are pedagogical subsets of upstream, not
// verbatim copies, so we don't auto-overwrite them. To refresh a
// vendored copy after an upstream rename, edit the file directly.

import fs from 'node:fs/promises';
import path from 'node:path';

const COURSES_DIR = path.resolve('courses');
// `references/qvac/` is a local gitignored snapshot for offline use.
// CI overrides this with `QVAC_REFERENCES_DIR` pointing at a fresh clone
// of the upstream `github.com/tetherto/qvac` repo.
const REFERENCES_DIR = path.resolve(
  process.env.QVAC_REFERENCES_DIR || 'references/qvac',
);
const EXAMPLES_DIR = path.resolve('examples/qvac');

const args = new Set(process.argv.slice(2));
const QUIET = !args.has('--no-quiet');

async function findLessonFiles(root) {
  const out = [];
  async function walk(dir) {
    let entries;
    try {
      entries = await fs.readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      const full = path.join(dir, e.name);
      if (e.isDirectory()) {
        await walk(full);
      } else if (e.isFile() && e.name.endsWith('.mdx') && e.name !== 'index.mdx') {
        out.push(full);
      }
    }
  }
  await walk(root);
  return out;
}

function parseFrontmatter(raw) {
  const m = raw.match(/^---\r?\n([\s\S]*?)\r?\n---/);
  if (!m) return { data: {} };
  const data = {};
  for (const line of m[1].split(/\r?\n/)) {
    const m2 = line.match(/^([a-zA-Z_][\w-]*)\s*:\s*(.*)$/);
    if (!m2) continue;
    let value = m2[2].trim();
    if (value.startsWith('"') && value.endsWith('"')) value = value.slice(1, -1);
    else if (value.startsWith("'") && value.endsWith("'")) value = value.slice(1, -1);
    data[m2[1]] = value;
  }
  return { data };
}

const NON_API = new Set([
  'if', 'for', 'while', 'switch', 'return', 'await', 'async', 'function',
  'class', 'new', 'typeof', 'instanceof', 'throw', 'try', 'catch',
  'import', 'export', 'from', 'const', 'let', 'var', 'do', 'else',
  'case', 'default', 'break', 'continue', 'delete', 'void', 'yield',
  'in', 'of', 'as', 'is', 'console',
]);

// Built-in class names that show up as `new Foo(...)` or as bare calls but
// aren't real SDK surfaces. Listed explicitly so we don't false-positive
// `new Error(...)`, `new Promise(...)`, `setTimeout(...)`, etc. as drift.
const BUILTIN_NAMES = new Set([
  'Error', 'TypeError', 'RangeError', 'SyntaxError', 'ReferenceError',
  'Promise', 'Symbol', 'BigInt', 'Map', 'Set', 'WeakMap', 'WeakSet',
  'Date', 'RegExp', 'Array', 'Object', 'Number', 'String', 'Boolean',
  'Math', 'JSON', 'Reflect', 'Proxy', 'Intl', 'URL', 'URLSearchParams',
  'ArrayBuffer', 'Uint8Array', 'Uint8ClampedArray', 'Int8Array',
  'Uint16Array', 'Int16Array', 'Uint32Array', 'Int32Array',
  'Float32Array', 'Float64Array', 'BigInt64Array', 'BigUint64Array',
  'DataView', 'Map', 'Set', 'WeakMap', 'WeakSet',
  'setTimeout', 'clearTimeout', 'setInterval', 'clearInterval',
  'setImmediate', 'clearImmediate', 'process', 'console', 'Buffer',
  'globalThis', 'window', 'document',
]);

function extractUserDefined(code) {
  const out = new Set();
  for (const m of code.matchAll(/function\s+([a-zA-Z_$][\w$]*)\s*\(/g)) {
    out.add(m[1]);
  }
  for (const m of code.matchAll(/(?:const|let|var)\s+([a-zA-Z_$][\w$]*)\s*[=:]/g)) {
    out.add(m[1]);
  }
  for (const m of code.matchAll(/(?:const|let|var)\s+([a-zA-Z_$][\w$]*)\s*=\s*(?:async\s*)?\(/g)) {
    out.add(m[1]);
  }
  return out;
}

function stripStrings(code) {
  // Block comments first (including JSDoc). We don't care about
  // descriptive text in comments showing up as fake callables.
  let out = code.replace(/\/\*[\s\S]*?\*\//g, '/* */');
  out = out.replace(/\/\/[^\n]*/g, '//');
  out = out.replace(/`([^`\\]|\\.)*`/g, '`"`');
  out = out.replace(/"([^"\\\n]|\\.)*"/g, '""');
  out = out.replace(/'([^'\\\n]|\\.)*'/g, "''");
  return out;
}

function extractCallables(code, userDefined) {
  const stripped = stripStrings(code);
  const calls = new Set();
  for (const m of stripped.matchAll(/\b([a-zA-Z_$][\w$]*)\s*\(/g)) {
    const name = m[1];
    if (NON_API.has(name)) continue;
    if (BUILTIN_NAMES.has(name)) continue;
    if (userDefined.has(name)) continue;
    const start = m.index;
    // Method call: `obj.foo(`
    if (start > 0 && stripped[start - 1] === '.') continue;
    // Type assertion: `x: foo(`
    if (start > 0 && stripped[start - 1] === ':') continue;
    // Constructor: `new Foo(`. We need at least one space between `new` and
    // the name; the regex above already matched the name itself, so
    // `start - 4` is the position of `n` in `new ` and we check the slice.
    if (start >= 4 && stripped.slice(start - 4, start) === 'new ') continue;
    calls.add(name);
  }
  return calls;
}

async function checkLesson(lessonPath) {
  const raw = await fs.readFile(lessonPath, 'utf-8');
  const { data } = parseFrontmatter(raw);

  if (!data.sourceExample) {
    return { lesson: lessonPath, status: 'skip' };
  }

  const upstreamRel = data.sourceExample;
  const upstreamPath = path.join(REFERENCES_DIR, upstreamRel);
  let upstream;
  try {
    upstream = (await fs.readFile(upstreamPath, 'utf-8')).trim();
  } catch {
    return {
      lesson: lessonPath,
      status: 'missing-upstream',
      sourceExample: upstreamRel,
    };
  }

  const basename = path.basename(lessonPath, '.mdx');
  // Lesson MDX lives at courses/qvac/en/<chapter>/<basename>.mdx; the vendored
  // example mirrors that path under examples/qvac/<chapter>/<basename>.answer.ts.
  const chapter = path.basename(path.dirname(lessonPath));
  const vendoredAnswerPath = path.join(EXAMPLES_DIR, chapter, `${basename}.answer.ts`);
  let vendored;
  try {
    vendored = await fs.readFile(vendoredAnswerPath, 'utf-8');
  } catch {
    return {
      lesson: lessonPath,
      status: 'missing-vendored',
      sourceExample: upstreamRel,
      vendored: vendoredAnswerPath,
    };
  }

  const upstreamCalls = extractCallables(upstream, new Set());
  const userDefined = extractUserDefined(vendored);
  const vendoredCalls = extractCallables(vendored, userDefined);
  const drift = [...vendoredCalls].filter((c) => !upstreamCalls.has(c));

  return {
    lesson: lessonPath,
    basename,
    status: drift.length > 0 ? 'api-drift' : 'ok',
    sourceExample: upstreamRel,
    vendored: vendoredAnswerPath,
    drift,
    vendoredCallCount: vendoredCalls.size,
    upstreamCallCount: upstreamCalls.size,
  };
}

async function main() {
  const files = await findLessonFiles(COURSES_DIR);
  const results = [];
  for (const f of files) {
    results.push(await checkLesson(f));
  }

  const problems = results.filter((r) =>
    ['api-drift', 'missing-upstream', 'missing-vendored'].includes(r.status),
  );

  if (!QUIET || problems.length > 0) {
    console.log('Sample-sync report');
    console.log('=================');
    for (const r of results) {
      const rel = path.relative(process.cwd(), r.lesson);
      const vendoredRel = r.vendored
        ? path.relative(process.cwd(), r.vendored)
        : '';
      if (r.status === 'ok') {
        console.log(
          `  ✓ ${rel}  [${r.sourceExample}]  → ${vendoredRel}  (${r.vendoredCallCount}/${r.upstreamCallCount} calls)`,
        );
      } else if (r.status === 'api-drift') {
        console.log(
          `  ✗ ${rel}  [${r.sourceExample}]  API DRIFT in vendored copy: ${r.drift.join(', ')}`,
        );
      } else if (r.status === 'missing-upstream') {
        console.log(`  ✗ ${rel}  MISSING UPSTREAM: ${r.sourceExample}`);
      } else if (r.status === 'missing-vendored') {
        console.log(
          `  ✗ ${rel}  MISSING VENDORED COPY: ${path.relative(process.cwd(), r.vendored)}`,
        );
      } else if (r.status === 'skip') {
        if (!QUIET) console.log(`  - ${rel}  skipped (no sourceExample)`);
      }
    }
  }

  if (problems.length > 0) {
    console.error(`\n${problems.length} problem(s) detected.`);
    process.exit(1);
  }
  console.log('\nAll lessons in sync.');
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
