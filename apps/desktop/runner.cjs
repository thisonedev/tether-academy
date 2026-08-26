// Spawned via ELECTRON_RUN_AS_NODE so the CJS main can run an ESM .mts snippet.
// Unsandboxed (unlike peer-exec) — source is course content or the user's edit of it.
const { spawn } = require('node:child_process');
const { rm } = require('node:fs/promises');
const { mkdtempSync, writeFileSync } = require('node:fs');
const { tmpdir } = require('node:os');
const { join } = require('node:path');
const path = require('node:path');

// Measured from the last thing the run printed. A video render on a slow
// machine outlasts any fixed cap, and reports a step at a time while it works,
// so the useful question is how long it has been quiet.
const IDLE_TIMEOUT_MS = 10 * 60 * 1000;

// Native inference ignores SIGTERM (see exec-host.cjs's SIGKILL_GRACE_MS), so
// Stop needs a follow-up SIGKILL after this grace window.
const SIGKILL_GRACE_MS = 3_000;

// SIGKILL can't reap a child stuck in an uninterruptible kernel wait (e.g. a
// GPU driver call). Past this, stop waiting for a real exit and settle anyway.
const FORCE_REAP_MS = 5_000;

// Electron-as-node (ELECTRON_RUN_AS_NODE) still claims its own Dock icon on
// macOS unless told otherwise; see electron/dock-hide-shim.cjs.
const DOCK_HIDE_SHIM = path.join(__dirname, 'electron', 'dock-hide-shim.cjs');

const { buildLesson, decideMockImports } = require('./electron/runner-process.cjs');
const { createAccumulator } = require('./electron/run-accumulator.cjs');
const { lessonCwd, precreateOutputDirs, snapshotOutputs, describeNewOutputs, formatRunError } = require('./shared/lesson-output.cjs');
const { acceptAll, syncFast, pruneTruncatedModels } = require('./shared/model-integrity.cjs');
const { createNoiseFilter } = require('./workers/peer/exec-noise.cjs');
const { createThinkingFilter } = require('./electron/chat-thinking-filter.cjs');
const { hintForMissingLib } = require('./electron/linux-lib-hint.cjs');
const { killTree, spawnFlags } = require('./shared/process-control.cjs');

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

  // Stop may land while the mock-vs-real probe is still pending; bail before
  // spawning if so.
  let aborted = false;
  let abortHandler = () => false;
  const promise = (async () => {
    const { mockImports, note } = await decideMockImports(source);
    if (aborted) {
      return { ok: false, output: '[runner] aborted before spawn', stopRequested: true };
    }
    const spawned = runSpawn({ source, argv, mockImports, mockNote: note, onChunk, registerAbort: (fn) => { abortHandler = fn; } });
    return spawned.promise;
  })();
  return {
    promise,
    abort: () => {
      if (aborted) return false;
      aborted = true;
      return abortHandler();
    },
  };
}

function runSpawn({ source, argv, mockImports, mockNote, onChunk, registerAbort }) {
  const coursesDir = path.join(__dirname, '..', '..', 'packages', 'courses');
  // Lesson writes are relative, so the child runs in the writable workspace.
  const childCwd = lessonCwd();
  const outputsBefore = snapshotOutputs(childCwd);
  const wrapped = buildLesson({ source, cwd: coursesDir, mockImports, mockNote });
  const dir = mkdtempSync(join(tmpdir(), 'ta-run-'));
  const file = join(dir, 'snippet.mts');
  const extraArgv = Array.isArray(argv) ? argv.filter((a) => typeof a === 'string') : [];
  // Peer-exec precreates output dirs. Mirror that here so a local-run
  // `output/<chapter>/file` doesn't ENOENT.
  precreateOutputDirs(wrapped, childCwd);

  writeFileSync(file, wrapped, 'utf-8');

  // A prior run killed mid-download can leave a truncated model at its final
  // name; catch it here before this run tries to load the same one.
  try {
    pruneTruncatedModels();
  } catch {}

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
      // The spawn flags killGroup needs to reach the QVAC worker on this platform.
      ...spawnFlags,
    },
  );

  const killGroup = (signal) => killTree(child, signal);

  let stopRequested = false;
  // Same 1 MiB per-stream cap peer-exec uses. Hoisted out of the Promise
  // executor so abort()'s force-reap can settle without a real exit event.
  const output = createAccumulator();
  let settle = () => {};
  const promise = new Promise((resolve) => {
    let killed = false;
    settle = (value) => {
      if (stopRequested && typeof value === 'object' && value) {
        value.stopRequested = true;
      }
      resolve(value);
    };
    let timer = null;
    const armIdle = () => {
      if (timer) clearTimeout(timer);
      timer = setTimeout(() => {
        killed = true;
        killGroup('SIGTERM');
      }, IDLE_TIMEOUT_MS);
    };
    armIdle();
    // Strips the same model-loader/sandbox chatter the peer path strips.
    const stderrFilter = createNoiseFilter();
    // Strips <think>...</think> reasoning traces from model output.
    const thinkingFilter = createThinkingFilter();
    // Collapses multi-space indent from util.inspect / JSON.stringify output
    // so SDK log lines print with single-space separators.
    const collapseIndent = (s) => s.replace(/[ \t]{2,}/g, ' ');
    const handleChunk = (stream) => (chunk) => {
      let s = chunk.toString();
      if (stream === 'stderr') s = stderrFilter.push(s);
      else s = collapseIndent(thinkingFilter.push(s));
      if (!s) return;
      output.append(stream, s);
      armIdle();
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
      // A SIGKILL'd run never runs its own JS-level cleanup, so its QVAC
      // worker can outlive it; a moment later lets the OS reap `child` first.
      const reapTimer = setTimeout(() => {
        try {
          require('./shared/qvac-orphan-reaper.cjs').reapOrphanedQvacWorkers();
        } catch {}
      }, 500);
      if (typeof reapTimer.unref === 'function') reapTimer.unref();
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
      let fullOutput = `${output.result('stdout')}${output.result('stderr')}`;
      // Missing shared libraries (e.g. no Vulkan loader) crash the QVAC
      // worker with a message that names the .so but gives no next step.
      if (process.platform === 'linux' && code !== 0) {
        const hint = hintForMissingLib(fullOutput);
        if (hint) fullOutput += `\n[runner] ${hint}`;
      }
      if (killed)
        settle({
          ok: false,
          output: `${fullOutput}\n[runner] no output for ${IDLE_TIMEOUT_MS / 60_000}m; ended the run`,
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
    const killTimer = setTimeout(() => {
      if (child.exitCode === null && !child.killed) killGroup('SIGKILL');
      const reapTimer = setTimeout(() => {
        if (child.exitCode !== null) return;
        settle({
          ok: false,
          output: `${output.result('stdout')}${output.result('stderr')}\n[runner] stop sent but the process did not exit; treating the run as stopped`,
        });
      }, FORCE_REAP_MS);
      if (typeof reapTimer.unref === 'function') reapTimer.unref();
    }, SIGKILL_GRACE_MS);
    if (typeof killTimer.unref === 'function') killTimer.unref();
    return true;
  };
  registerAbort(abort);

  return { promise, abort };
}

module.exports = { runExample };
