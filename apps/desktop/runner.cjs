// Spawned via ELECTRON_RUN_AS_NODE so the CJS main can run an ESM .mts snippet.
//
// Unsandboxed, unlike peer-exec: the source is course content or the user's own
// edit of it. Peer-exec writes the lesson folder this runs in, so a file under
// it is not the user's own input.
const { spawn } = require('node:child_process');
const { rm } = require('node:fs/promises');
const { mkdtempSync, writeFileSync } = require('node:fs');
const { tmpdir } = require('node:os');
const { join } = require('node:path');
const path = require('node:path');

const MAX_RUNTIME_MS = 5 * 60 * 1000;

const { buildLesson } = require('./electron/runner-process.cjs');
const { lessonCwd } = require('./shared/lesson-output.cjs');
const { acceptAll, syncFast } = require('./shared/model-integrity.cjs');

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

  const coursesDir = path.join(__dirname, '..', '..', 'packages', 'courses');
  // Lesson writes are relative, so the child runs in the writable workspace.
  // Fixture reads were made absolute by buildLesson.
  const childCwd = lessonCwd();
  const wrapped = buildLesson({ source, cwd: coursesDir });
  const dir = mkdtempSync(join(tmpdir(), 'ta-run-'));
  const file = join(dir, 'snippet.mts');
  const extraArgv = Array.isArray(argv) ? argv.filter((a) => typeof a === 'string') : [];

  writeFileSync(file, wrapped, 'utf-8');

  // The unsandboxed path, so the one that matters: a cached model altered since
  // the app last saw it gets parsed here with the user's full privileges.
  // Stat-only, and advisory, since the machine is the user's own.
  const changed = (() => {
    try {
      return syncFast().changed;
    } catch {
      return [];
    }
  })();
  if (changed.length > 0 && onChunk) {
    onChunk({
      stream: 'stderr',
      data:
        `[runner] ${changed.length} cached model file(s) changed outside the app ` +
        `since the last run: ${changed.slice(0, 3).join(', ')}\n`,
    });
  }

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
      // Own process group so killGroup reaches the QVAC worker it spawns.
      detached: true,
    },
  );

  const killGroup = (signal) => {
    try {
      process.kill(-child.pid, signal);
    } catch {
      try {
        child.kill(signal);
      } catch {
        // already gone
      }
    }
  };

  const promise = new Promise((resolve) => {
    let output = '';
    let killed = false;
    const timer = setTimeout(() => {
      killed = true;
      killGroup('SIGTERM');
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
      // A lesson that never unloads its model leaves the worker behind.
      killGroup('SIGKILL');
      rm(dir, { recursive: true, force: true }).catch(() => {});
      // This run may have downloaded a model. Re-baseline so peer-exec's
      // integrity check treats the new bytes as the app's own work.
      try {
        acceptAll();
      } catch {
        // advisory only
      }
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
    killGroup('SIGTERM');
    return true;
  };

  return { promise, abort };
}

module.exports = { runExample };
