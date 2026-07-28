// Spawned via ELECTRON_RUN_AS_NODE so the CJS main can run an ESM .mts snippet.
const { spawn } = require('node:child_process');
const { rm } = require('node:fs/promises');
const { mkdtempSync, writeFileSync } = require('node:fs');
const { tmpdir } = require('node:os');
const { join } = require('node:path');
const path = require('node:path');

const MAX_RUNTIME_MS = 5 * 60 * 1000;

const { buildLesson } = require('./electron/runner-process.cjs');

function runExample({ source, language, argv, onChunk }) {
  const isJsLike =
    language === 'javascript' ||
    language === 'typescript' ||
    language === 'tsx' ||
    language === 'jsx';
  if (!isJsLike) {
    return {
      promise: Promise.resolve({
        ok: false,
        output: `[runner] language "${language}" is not executable in this shell.`,
      }),
      abort: () => false,
    };
  }

  const childCwd = path.join(__dirname, '..', '..', 'packages', 'courses');
  const wrapped = buildLesson({ source, cwd: childCwd });
  const dir = mkdtempSync(join(tmpdir(), 'ta-run-'));
  const file = join(dir, 'snippet.mts');
  const extraArgv = Array.isArray(argv) ? argv.filter((a) => typeof a === 'string') : [];

  writeFileSync(file, wrapped, 'utf-8');

  const child = spawn(
    process.execPath,
    ['--experimental-strip-types', file, ...extraArgv],
    {
      cwd: childCwd,
      env: {
        ...process.env,
        ELECTRON_RUN_AS_NODE: '1',
        NODE_NO_WARNINGS: '1',
        QVAC_LOG_LEVEL: 'warn',
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    },
  );

  const promise = new Promise((resolve) => {
    let output = '';
    let killed = false;
    const timer = setTimeout(() => {
      killed = true;
      child.kill('SIGTERM');
    }, MAX_RUNTIME_MS);
    const handleChunk = (stream) => (chunk) => {
      const s = chunk.toString();
      output += s;
      if (onChunk) onChunk({ stream, data: s });
    };
    child.stdout.on('data', handleChunk('stdout'));
    child.stderr.on('data', handleChunk('stderr'));
    child.on('error', (err) => {
      clearTimeout(timer);
      rm(dir, { recursive: true, force: true }).catch(() => {});
      resolve({ ok: false, output: `[runner] ${err.message}\n${output}` });
    });
    child.on('exit', (code) => {
      clearTimeout(timer);
      rm(dir, { recursive: true, force: true }).catch(() => {});
      if (killed)
        resolve({
          ok: false,
          output: `${output}\n[runner] killed after ${MAX_RUNTIME_MS / 1000}s`,
        });
      else resolve({ ok: code === 0, output });
    });
  });

  let aborted = false;
  const abort = () => {
    if (aborted || child.killed || child.exitCode !== null) return false;
    aborted = true;
    child.kill('SIGTERM');
    return true;
  };

  return { promise, abort };
}

module.exports = { runExample };
