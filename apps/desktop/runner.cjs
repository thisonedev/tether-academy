// Spawned via ELECTRON_RUN_AS_NODE so the CJS main can run an ESM .mts snippet.
// Unsandboxed (unlike peer-exec) — source is course content or the user's edit of it.
const { spawn } = require('node:child_process');
const { rm } = require('node:fs/promises');
const { mkdtempSync, writeFileSync } = require('node:fs');
const { tmpdir } = require('node:os');
const { join } = require('node:path');
const path = require('node:path');

// Cold music-lesson runs pull ~3.3 GB of ACE-Step models (DiT alone is ~1.45 GB),
// so on slow connections the load alone can take minutes. 10 minutes leaves
// headroom for that without making intentional aborts feel laggy.
const MAX_RUNTIME_MS = 10 * 60 * 1000;

// Electron-as-node (ELECTRON_RUN_AS_NODE) still claims its own Dock icon on
// macOS unless told otherwise; see electron/dock-hide-shim.cjs.
const DOCK_HIDE_SHIM = path.join(__dirname, 'electron', 'dock-hide-shim.cjs');

const { buildLesson } = require('./electron/runner-process.cjs');
const { createAccumulator } = require('./electron/run-accumulator.cjs');
const { lessonCwd, precreateOutputDirs, snapshotOutputs, describeNewOutputs, formatRunError } = require('./shared/lesson-output.cjs');
const { acceptAll, syncFast } = require('./shared/model-integrity.cjs');
const { createNoiseFilter } = require('./workers/peer/exec-noise.cjs');
const { createThinkingFilter } = require('./electron/chat-thinking-filter.cjs');

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
  const childCwd = lessonCwd();
  const outputsBefore = snapshotOutputs(childCwd);
  const wrapped = buildLesson({ source, cwd: coursesDir });
  const dir = mkdtempSync(join(tmpdir(), 'ta-run-'));
  const file = join(dir, 'snippet.mts');
  const extraArgv = Array.isArray(argv) ? argv.filter((a) => typeof a === 'string') : [];
  // Peer-exec precreates output dirs. Mirror that here so a local-run
  // `output/<chapter>/file` doesn't ENOENT.
  precreateOutputDirs(wrapped, childCwd);

  writeFileSync(file, wrapped, 'utf-8');

  // Stat-only and advisory, since this is the unsandboxed local-run path.
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
    [
      '--experimental-strip-types',
      ...(process.platform === 'darwin' ? ['--require', DOCK_HIDE_SHIM] : []),
      file,
      ...extraArgv,
    ],
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
      } catch {}
    }
  };

  const promise = new Promise((resolve) => {
    // Same 1 MiB per-stream cap peer-exec uses.
    const output = createAccumulator();
    let killed = false;
    let stopRequested = false;
    const settle = (value) => {
      if (stopRequested && typeof value === 'object' && value) {
        value.stopRequested = true;
      }
      resolve(value);
    };
    const timer = setTimeout(() => {
      killed = true;
      killGroup('SIGTERM');
    }, MAX_RUNTIME_MS);
    // Strips the same model-loader/sandbox chatter the peer path strips.
    const stderrFilter = createNoiseFilter();
    // Strips <think>...</think> reasoning traces from model output.
    const thinkingFilter = createThinkingFilter();
    const handleChunk = (stream) => (chunk) => {
      let s = chunk.toString();
      if (stream === 'stderr') s = stderrFilter.push(s);
      else s = thinkingFilter.push(s);
      if (!s) return;
      output.append(stream, s);
      if (onChunk) onChunk({ stream, data: s });
    };
    child.stdout.on('data', handleChunk('stdout'));
    child.stderr.on('data', handleChunk('stderr'));
    child.on('error', (err) => {
      clearTimeout(timer);
      rm(dir, { recursive: true, force: true }).catch(() => {});
      settle({ ok: false, output: `[runner] ${formatRunError(err)}\n${output.result('stdout')}${output.result('stderr')}` });
    });
    child.on('exit', (code) => {
      clearTimeout(timer);
      // A lesson that never unloads its model leaves the worker behind.
      killGroup('SIGKILL');
      rm(dir, { recursive: true, force: true }).catch(() => {});
      const note = (() => {
        try {
          return describeNewOutputs(outputsBefore, childCwd);
        } catch {
          return '';
        }
      })();
      if (note) {
        output.append('stderr', note);
        if (onChunk) onChunk({ stream: 'stderr', data: note });
      }
      // A partial line held when the child closed may carry a real error's final word.
      const tail = stderrFilter.end();
      if (tail) {
        output.append('stderr', tail);
        if (onChunk) onChunk({ stream: 'stderr', data: tail });
      }
      // Re-baseline in case this run downloaded a model.
      try {
        acceptAll();
      } catch {}
      const fullOutput = `${output.result('stdout')}${output.result('stderr')}`;
      if (killed)
        settle({
          ok: false,
          output: `${fullOutput}\n[runner] killed after ${MAX_RUNTIME_MS / 1000}s`,
        });
      else settle({ ok: code === 0, output: fullOutput });
    });
  });

  let aborted = false;
  const abort = () => {
    if (aborted || child.killed || child.exitCode !== null) return false;
    aborted = true;
    stopRequested = true;
    killGroup('SIGTERM');
    return true;
  };

  return { promise, abort };
}

module.exports = { runExample };
