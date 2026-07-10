// Verifies every lesson's frontmatter tests pass against the matching .answer.ts.
// Catches broken patterns and missing `contains` strings before they reach the runner.
// Flags: --check (exit non-zero on fail, for CI).

import fs from 'node:fs/promises';
import path from 'node:path';

const COURSES_DIR = path.resolve('courses');
const EXAMPLES_DIR = path.resolve('examples/qvac');

const args = new Set(process.argv.slice(2));
const CHECK_ONLY = args.has('--check');

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

// Minimal frontmatter parser for the subset this project uses: top-level scalars plus the `tests:` array of objects.
function parseFrontmatter(raw) {
  const m = raw.match(/^---\r?\n([\s\S]*?)\r?\n---/);
  if (!m) return { data: {}, tests: [] };
  const block = m[1];
  const data = {};
  const tests = [];

  const lines = block.split(/\r?\n/);
  let i = 0;
  while (i < lines.length) {
    const line = lines[i];
    const scalarMatch = line.match(/^([a-zA-Z_][\w-]*)\s*:\s*(.*)$/);
    if (!scalarMatch) {
      i++;
      continue;
    }
    const key = scalarMatch[1];
    const value = scalarMatch[2].trim();

    if (key === 'tests' && value === '') {
      // Array of objects follows, each starting with `- `.
      i++;
      while (i < lines.length) {
        const itemLine = lines[i];
        const itemStart = itemLine.match(/^\s*-\s+(.*)$/);
        if (!itemStart) break;
        const obj = {};
        // First key may be on the same line as `- `.
        const firstInline = itemStart[1].match(/^([a-zA-Z_][\w-]*)\s*:\s*(.*)$/);
        if (firstInline) {
          obj[firstInline[1]] = stripQuotes(firstInline[2].trim());
        }
        i++;
        while (i < lines.length) {
          const contLine = lines[i];
          if (/^\s*-\s+/.test(contLine)) break;
          if (!/^\s{2,}/.test(contLine)) break;
          const contMatch = contLine.match(
            /^\s+([a-zA-Z_][\w-]*)\s*:\s*(.*)$/,
          );
          if (contMatch) {
            obj[contMatch[1]] = stripQuotes(contMatch[2].trim());
          }
          i++;
        }
        tests.push(obj);
      }
      continue;
    }

    data[key] = stripQuotes(value);
    i++;
  }

  return { data, tests };
}

function stripQuotes(value) {
  let v = value;
  if (v.startsWith('"') && v.endsWith('"')) {
    v = v.slice(1, -1);
    // YAML double-quoted string escapes, only the ones we actually use.
    v = v.replace(/\\\\/g, '__BACKSLASH__');
    v = v.replace(/\\"/g, '"');
    v = v.replace(/__BACKSLASH__/g, '\\');
    return v;
  }
  if (v.startsWith("'") && v.endsWith("'")) return v.slice(1, -1);
  return v;
}

// Mirror of `runTests` in src/components/lesson-workspace.tsx: same regex semantics so a passing check here matches the runner.
function runTest(test, code) {
  let passed = false;
  let error = null;
  if (test.pattern) {
    try {
      passed = new RegExp(test.pattern, 'm').test(code);
    } catch (e) {
      passed = false;
      error = e instanceof Error ? e.message : String(e);
    }
  } else if (test.contains) {
    passed = code.includes(test.contains);
  }
  return { passed, error };
}

async function checkLesson(lessonPath) {
  const raw = await fs.readFile(lessonPath, 'utf-8');
  const { tests } = parseFrontmatter(raw);

  if (tests.length === 0) {
    return { lesson: lessonPath, status: 'no-tests', results: [] };
  }

  const basename = path.basename(lessonPath, '.mdx');
  // Strip a per-chapter numeric prefix when matching the example file:
  // "01-load-model.mdx" → "load-model.answer.ts"; "thinking-content.mdx" → unchanged.
  const exampleBasename = basename.replace(/^\d{2}-/, '');
  // Vendored examples mirror the lesson path under examples/qvac/<chapter>/.
  const chapter = path.basename(path.dirname(lessonPath));
  const answerPath = path.join(EXAMPLES_DIR, chapter, `${exampleBasename}.answer.ts`);
  let answer;
  try {
    answer = await fs.readFile(answerPath, 'utf-8');
  } catch {
    return {
      lesson: lessonPath,
      status: 'missing-answer',
      results: tests.map((t) => ({ ...t, passed: false, error: 'answer file missing' })),
    };
  }

  const results = tests.map((t) => {
    const { passed, error } = runTest(t, answer);
    return { ...t, passed, error };
  });

  return {
    lesson: lessonPath,
    basename,
    status: results.every((r) => r.passed) ? 'ok' : 'fail',
    results,
  };
}

function fmtResult(r) {
  if (r.passed) return `✓ ${r.id}`;
  const reason = r.error ? ` (${r.error})` : '';
  const detail = r.pattern
    ? `\n      pattern: ${r.pattern}`
    : r.contains
      ? `\n      contains: ${r.contains}`
      : '';
  return `✗ ${r.id} — ${r.description}${reason}${detail}`;
}

async function main() {
  const files = await findLessonFiles(COURSES_DIR);
  const reports = [];
  for (const f of files) {
    reports.push(await checkLesson(f));
  }

  console.log('Lesson test verification');
  console.log('========================');
  let totalTests = 0;
  let totalPassed = 0;
  let totalFailed = 0;
  const failing = [];

  for (const r of reports) {
    const rel = path.relative(process.cwd(), r.lesson);
    if (r.status === 'no-tests') {
      console.log(`  - ${rel}  (no tests in frontmatter)`);
      continue;
    }
    if (r.status === 'missing-answer') {
      console.log(`  ✗ ${rel}  MISSING .answer.ts`);
      failing.push(r);
      continue;
    }
    totalTests += r.results.length;
    for (const t of r.results) {
      if (t.passed) totalPassed++;
      else totalFailed++;
    }
    if (r.status === 'ok') {
      console.log(`  ✓ ${rel}  (${r.results.length}/${r.results.length} pass)`);
    } else {
      console.log(`  ✗ ${rel}  (${r.results.filter((x) => x.passed).length}/${r.results.length} pass)`);
      for (const t of r.results) {
        if (!t.passed) console.log(`      ${fmtResult(t)}`);
      }
      failing.push(r);
    }
  }

  console.log(
    `\nTotal: ${totalPassed}/${totalTests} pass, ${totalFailed} fail across ${reports.length} lesson(s).`,
  );

  if (CHECK_ONLY && totalFailed > 0) {
    console.error(`\n${totalFailed} test(s) fail against the matching .answer.ts.`);
    process.exit(1);
  }

  if (!CHECK_ONLY && totalFailed > 0) {
    process.exit(1);
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});