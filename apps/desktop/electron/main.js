// apps/cli installs a raw source checkout, so the app always runs
// unpackaged and would otherwise show Electron's dev-only warnings to users.
process.env.ELECTRON_DISABLE_SECURITY_WARNINGS = 'true';

const { app, BrowserWindow, clipboard, dialog, ipcMain, net, protocol, shell } = require('electron');
const os = require('node:os');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const FramedStream = require('framed-stream');
const { isMac, isLinux, isWindows } = require('which-runtime');
const { command, flag } = require('paparam');
const { promises: fs } = require('node:fs');
const { diagnoseNativeAddonError, checkRequiredLinuxLibs } = require('./linux-lib-hint.cjs');

// A missing library (e.g. no Vulkan loader) can crash several unrelated native
// addons the moment their require chain gets touched, each with a different,
// unhelpful error, so this checks once before any of them load.
const missingLibHint = checkRequiredLinuxLibs();
if (missingLibHint) {
  // dialog.showErrorBox is explicitly documented as safe pre-ready, for
  // exactly this: reporting a fatal error before the rest of startup runs.
  dialog.showErrorBox('Tether Academy: missing system library', missingLibHint);
  app.exit(1);
  return; // Stop this module's own requires from ever reaching the fragile ones below.
}

// Before anything below can touch @qvac/sdk (chat.cjs's model auto-load in
// particular): it spawns its `bare` worker with no windowsHide, popping a
// console window per model load. See windows-spawn-hide-shim.cjs.
require('./windows-spawn-hide-shim.cjs');

// Same lazy-require guard as state-store.cjs's loadCorestore().
function loadPearRuntime() {
  try {
    return require('pear-runtime');
  } catch (err) {
    const hint = diagnoseNativeAddonError(err);
    if (hint) err.message = `${err.message}\n${hint}`;
    throw err;
  }
}

// Has to run before whenReady; registration after that is silently ignored.
protocol.registerSchemesAsPrivileged([
  {
    scheme: 'academy',
    privileges: {
      // standard gives the renderer a stable origin; secure enables crypto APIs.
      standard: true,
      secure: true,
      supportFetchAPI: true,
      stream: true,
    },
  },
]);

// Chromium only auto-picks a keyring backend via XDG_CURRENT_DESKTOP, unset
// on headless/minimal Linux even with a real keyring running, which silently
// drops identity sealing to a file key and blocks peer-exec.
if (isLinux && !process.env.XDG_CURRENT_DESKTOP) {
  app.commandLine.appendSwitch('password-store', 'gnome-libsecret');
}

const { runExample } = require('../runner.cjs');
const { createThinkingFilter } = require('./chat-thinking-filter.cjs');
const {
  listModels,
  removeModel,
  removeAllModels,
  pruneIncompleteDownloads,
  catalogue,
  recommend,
  forLesson,
} = require('./models.cjs');
const { getDeviceInfo } = require('./device.cjs');
const chat = require('./chat.cjs');
const { buildLesson } = require('./runner-process.cjs');
const { createPearEnd } = require('./pear-end/index.cjs');
const { createAccumulator } = require('./run-accumulator.cjs');
const { formatRunError } = require('../shared/lesson-output.cjs');
const IPC_CHANNELS = require('../shared/ipc-channels.cjs');

// A channel not in IPC_CHANNELS throws at startup. The dynamic
// `pear:worker:writeIPC:*` channel falls back to a longest-prefix match.
function handle(channel, fn) {
  const exact = Object.hasOwn(IPC_CHANNELS, channel) ? IPC_CHANNELS[channel] : undefined;
  const schemaName =
    exact !== undefined
      ? exact
      : channel.startsWith(IPC_CHANNELS.PEAR_WORKER_PREFIX)
        ? IPC_CHANNELS[IPC_CHANNELS.PEAR_WORKER_PREFIX]
        : undefined;
  if (schemaName === undefined) {
    throw new Error(`unregistered IPC channel: ${channel}`);
  }
  ipcMain.handle(channel, async (evt, payload) => {
    const args =
      schemaName === null ? undefined : await parseIpc(schemaName, payload, channel);
    try {
      return await fn(args, evt);
    } catch (err) {
      // Fires for any call in flight when the worker is torn down (e.g.
      // Ctrl+C); without this, Electron logs the full RPC stack per call.
      if (err?.code === 'CHANNEL_CLOSED') {
        console.warn(`[tether-academy-desktop] ${channel}: worker channel closed (shutting down)`);
        return null;
      }
      throw err;
    }
  });
}

// Shared Zod schemas from @academy/validation (ESM). Cached after first load.
let _ipcValidation = null;
async function loadIpcValidation() {
  if (!_ipcValidation) {
    _ipcValidation = await import('@academy/validation');
  }
  return _ipcValidation;
}

async function parseIpc(schemaName, value, label) {
  const v = await loadIpcValidation();
  const schema = v[schemaName];
  if (!schema) throw new Error(`unknown IPC schema: ${schemaName}`);
  return v.parseIpc(schema, value, label);
}

const pkg = require('../package.json');
const { name, productName, version, upgrade } = pkg;
const WORKER_PATH = require.resolve('hello-pear-worker');
const appName = productName ?? name;
const mainWorkerSpecifier = '/workers/main.js';

// Unset, this defaults to Electron's own name/icon: shows as "Electron" in
// the dock/menu bar/Activity Monitor for an unpackaged app. Set as early as
// possible (before app.whenReady()) to shrink the window where the OS shows
// Electron's own defaults during launch.
const ICON_PATH = path.join(__dirname, '..', 'assets', 'icon.png');
app.setName(appName);
if (isMac) app.dock?.setIcon(ICON_PATH);

const workers = new Map();
// Raw PearRuntime.run() process objects, tracked separately from `workers`
// (which stores the FramedStream `pipe` callers actually use) so before-quit
// can force-kill anything still alive instead of leaking it as an orphan.
const workerProcesses = new Set();

const cmd = command(
  appName,
  flag('--storage <dir>', 'pass custom storage to pear-runtime'),
  flag('--no-updates', 'start without OTA updates'),
);
try {
  cmd.parse(app.isPackaged ? process.argv.slice(1) : process.argv.slice(2));
} catch (err) {
  console.warn('[tether-academy-desktop] flag parse warning:', err.message);
}

const pearStore = cmd.flags.storage;
const updates = cmd.flags.updates;
if (pearStore) app.setPath('userData', pearStore);

ipcMain.on('pkg', (evt) => {
  evt.returnValue = pkg;
});

function getAppPath() {
  if (!app.isPackaged) return null;
  if (isLinux && process.env.APPIMAGE) return process.env.APPIMAGE;
  if (isWindows) return process.execPath;
  return path.join(process.resourcesPath, '..', '..');
}

function sendToAll(channel, data) {
  for (const win of BrowserWindow.getAllWindows()) {
    if (!win.isDestroyed()) win.webContents.send(channel, data);
  }
}

function getWorker(specifier) {
  if (workers.has(specifier)) return workers.get(specifier);
  const appPath = getAppPath();
  let dir = null;
  if (pearStore) {
    dir = pearStore;
  } else if (appPath === null) {
    dir = path.join(os.tmpdir(), 'pear', appName);
  } else {
    const linuxConfigHome = process.env.XDG_CONFIG_HOME || path.join(os.homedir(), '.config');
    dir = isMac
      ? path.join(os.homedir(), 'Library', 'Application Support', appName)
      : isLinux
        ? path.join(linuxConfigHome, appName)
        : path.join(os.homedir(), 'AppData', 'Roaming', appName);
  }
  const extension = isLinux ? '.AppImage' : isMac ? '.app' : '.msix';
  const PearRuntime = loadPearRuntime();
  const worker = PearRuntime.run(WORKER_PATH, [
    updates,
    version,
    upgrade,
    productName + extension,
    dir,
    appPath,
  ]);
  workerProcesses.add(worker);
  const pipe = new FramedStream(worker);
  const sendIPC = (data) => sendToAll(`pear:worker:ipc:${specifier}`, data);
  const sendOut = (data) => sendToAll(`pear:worker:stdout:${specifier}`, data);
  const sendErr = (data) => sendToAll(`pear:worker:stderr:${specifier}`, data);
  pipe.on('data', sendIPC);
  worker.stdout.on('data', sendOut);
  worker.stderr.on('data', sendErr);
  worker.once('exit', (code) => {
    workerProcesses.delete(worker);
    pipe.removeListener('data', sendIPC);
    worker.stdout.removeListener('data', sendOut);
    worker.stderr.removeListener('data', sendErr);
    sendToAll(`pear:worker:exit:${specifier}`, code);
    workers.delete(specifier);
  });
  handle(`pear:worker:writeIPC:${specifier}`, async (data) => {
    pipe.write(data);
  });
  workers.set(specifier, pipe);
  return pipe;
}

handle('pear:startWorker', async (filename) => {
  if (filename === mainWorkerSpecifier) getWorker(filename);
  return true;
});

// One slot for the in-flight run so the stop button can kill it.
let currentRun = null;

const COURSES_DIR = path.join(app.getAppPath(), '..', '..', 'packages', 'courses');

// How long a peer run may go without saying anything before the guest gives up.
// Matches the local runner's window, since the same lesson on the same machine
// should not be judged dead sooner just because a peer sent it.
const PEER_EXEC_IDLE_MS = 10 * 60_000;

handle('academy:run', async (parsed, evt) => {
  return runAcademy(parsed, evt);
});

async function runAcademy(parsed, evt) {
  await ensureQVACSeed();
  const sender = evt.sender;
  const sendChunk = (chunk) => {
    if (!sender.isDestroyed()) sender.send('academy:run:chunk', chunk);
  };

  if (parsed.peerId) {
    // Runtime must match the host: a Bare build rewrites node: imports to Bare
    // packages, which a Node child cannot load, and vice versa. Checked on the
    // wrapped source so the `mongodb`-mock rewrite counts as Bare-safe.
    // Uses detectNodeOnly, not nodeOnlyImports: buildLesson resolves specifiers
    // to absolute paths, which nodeOnlyImports skips as local files.
    // forceMock: true — a probe of this host says nothing about the peer's.
    // portable: true, since the peer runs this on its own filesystem, not
    // this one; see shared/portable-lesson-imports.cjs.
    const { buildLesson, decideMockImports } = require('./runner-process.cjs');
    const { detectNodeOnly } = require('../workers/peer/exec-validate.cjs');
    const { mockImports, note } = await decideMockImports(parsed.source, { forceMock: true });
    let runtime;
    let wrapped;
    for (const candidate of ['bare', 'node']) {
      wrapped = buildLesson({ source: parsed.source, cwd: COURSES_DIR, runtime: candidate, mockImports, mockNote: note, portable: true });
      if (detectNodeOnly(wrapped) === null) {
        runtime = candidate;
        break;
      }
    }
    if (runtime === undefined) {
      runtime = 'node';
    }
    let emitter;
    try {
      emitter = pearEnd.peer.exec({
        peerId: parsed.peerId,
        code: wrapped,
        mode: 'file',
        fileName: parsed.fileName || 'snippet.mts',
        label: parsed.label || null,
        argv: parsed.argv ?? [],
        cwd: COURSES_DIR,
        // Hint only, for the receiver's security scan and code preview; the
        // structural checks stay authoritative against the wrapped `code` above.
        declared: {
          ...(parsed.lessonReference ? { lessonReference: parsed.lessonReference } : {}),
          // Pre-buildLesson() source, so review sees what was written.
          rawSource: parsed.source,
        },
      });
    } catch (err) {
      return { ok: false, output: `[peer-exec] ${formatRunError(err)}` };
    }
    // Capped so a run that prints in a loop cannot grow main-process memory unbounded.
    const collected = createAccumulator();
    // Strips <think>...</think> reasoning traces from model output.
    const thinkingFilter = createThinkingFilter();
    // Collapses multi-space indent from util.inspect / JSON.stringify output
    // so SDK log lines print with single-space separators.
    const collapseIndent = (s) => s.replace(/[ \t]{2,}/g, ' ');
    // Measured from the last output, not the start: a first run downloads the model
    // and streams progress for as long as that takes.
    let noteActivity = () => {};
    emitter.on('stdout', (data) => {
      const cleaned = collapseIndent(thinkingFilter.push(data.toString()));
      collected.append('stdout', cleaned);
      noteActivity();
      sendChunk({ stream: 'stdout', data: cleaned });
    });
    emitter.on('stderr', (data) => {
      collected.append('stderr', data);
      noteActivity();
      sendChunk({ stream: 'stderr', data });
    });
    const run = {
      promise: new Promise((resolve) => {
        let idleTimer = null;
        let stopRequested = false;
        const settle = (value) => {
          if (idleTimer) clearTimeout(idleTimer);
          idleTimer = null;
          if (stopRequested && typeof value === 'object' && value) {
            value.stopRequested = true;
          }
          resolve(value);
        };
        noteActivity = () => {
          if (idleTimer) clearTimeout(idleTimer);
          idleTimer = setTimeout(() => {
            // Leaving the run going on the host holds the registry lock every
            // other model load on that machine needs.
            pearEnd.peer.cancelExec(parsed.peerId).catch(() => {});
            settle({
              ok: false,
              output: `${collected.result('stdout')}${collected.result('stderr')}\n[peer-exec] no output from peer for ${PEER_EXEC_IDLE_MS / 60_000}m; cancelled the run`,
            });
          }, PEER_EXEC_IDLE_MS);
        };
        emitter.on('exit', (info) => {
          // `info.cancelled` arrives from the peer when it was instructed to
          // stop; treat it the same as a renderer-initiated Stop so the lesson
          // output renders as `[stopped]` instead of `[stopped by SIGTRAP]`
          // when the Bare runtime trap-fires during cleanup.
          if (info?.cancelled) stopRequested = true;
          settle({
            ok: info.code === 0 && !info.cancelled,
            output: collected.result('stdout'),
            remoteExit: { code: info.code, signal: info.signal },
          });
        });
        emitter.on('error', (err) => {
          settle({ ok: false, output: `${collected.result('stdout')}${collected.result('stderr')}\n[peer-exec] ${formatRunError(err)}` });
        });
        noteActivity();
      }),
      abort: () => {
        stopRequested = true;
        return pearEnd.peer.cancelExec(parsed.peerId);
      },
    };
    currentRun = run;
    return run.promise.finally(() => {
      if (currentRun === run) currentRun = null;
    });
  }

  // The chat model's worker holds the registry corestore's fd-lock open for
  // as long as it's loaded, so a lesson's own model load only gets a 10s
  // budget to win it. Release it first.
  try {
    await chat.unload();
  } catch (err) {
    console.warn('[tether-academy-desktop] chat.unload before lesson run failed:', err?.message ?? err);
  }

  await ensureLessonModels(parsed.source, sendChunk);

  const run = runExample({
    ...parsed,
    onChunk: sendChunk,
  });
  currentRun = run;
  return run.promise.finally(() => {
    if (currentRun === run) currentRun = null;
  });
}

// Registry constants the lesson names, fetched before the run starts.
async function ensureLessonModels(source, sendChunk) {
  try {
    const { referencedModels } = require('../workers/peer/exec-network.cjs');
    const { ensureModels } = require('../shared/model-fetch.cjs');
    const wanted = referencedModels(source ?? '');
    if (wanted.length === 0) return;
    let announced = false;
    await ensureModels(wanted, {
      onEvent: (e) => {
        if (e.phase === 'start' && !announced) {
          announced = true;
          sendChunk({ stream: 'stderr', data: '[runner] fetching a model this lesson needs\n' });
        }
      },
    });
  } catch (err) {
    console.warn('[tether-academy-desktop] ensureLessonModels:', err?.message ?? err);
  }
}

// Confined to the lesson folder: the renderer must not point Finder anywhere.
handle('academy:reveal', async (filePath) => {
  const { lessonHomeDir } = require('../shared/lesson-output.cjs');
  const root = path.resolve(lessonHomeDir());
  const abs = path.resolve(filePath);
  if (abs !== root && !abs.startsWith(root + path.sep)) return false;
  if (!require('node:fs').existsSync(abs)) return false;
  shell.showItemInFolder(abs);
  return true;
});

// Read a lesson's saved file as base64 so the renderer can inline preview an
// image or video without poking the OS file manager. Same containment check
// as academy:reveal; nothing else on disk is reachable through this channel.
// Capped at 64 MiB to leave room for a generated MP4 clip; bigger files return null.
const { mimeFor, canPreviewFile, MAX_READ_SAVED_BYTES } = require('../shared/lesson-preview.cjs');
handle('academy:read-saved', async (filePath) => {
  const fs = require('node:fs');
  const { lessonHomeDir } = require('../shared/lesson-output.cjs');
  const root = path.resolve(lessonHomeDir());
  const abs = path.resolve(filePath);
  if (abs !== root && !abs.startsWith(root + path.sep)) return null;
  let stat;
  try {
    stat = await fs.promises.stat(abs);
  } catch {
    return null;
  }
  if (!stat.isFile() || stat.size > MAX_READ_SAVED_BYTES) return null;
  if (!canPreviewFile(abs)) return null;
  const buf = await fs.promises.readFile(abs);
  return { base64: buf.toString('base64'), mime: mimeFor(abs), bytes: stat.size };
});

handle('academy:stop', () => {
  if (!currentRun) return false;
  return currentRun.abort();
});

function getSafeStorage() {
  try {
    const { safeStorage } = require('electron');
    if (safeStorage?.isEncryptionAvailable?.()) return safeStorage;
  } catch {
    // not Electron
  }
  return null;
}

// Pear-end: identity, state (Corestore under userData/corestore), and peer/mesh.
const pearEnd = createPearEnd(app.getPath('userData'), { getSafeStorage });

// Derived from the device identity, the only identity this app has. A device
// with no identity yet leaves the variable unset and the SDK decides what to
// do about that, rather than minting a standalone key here.
async function ensureQVACSeed() {
  const device = pearEnd.identity().getDeviceIdentity();
  if (!device?.privateKey) return;
  // HKDF with a QVAC domain, distinct from the mesh swarm seed.
  const { deriveSwarmSeedHex, QVAC_SWARM_INFO } = require('../workers/peer/swarm-seed.cjs');
  const seedHex = deriveSwarmSeedHex(device.privateKey, QVAC_SWARM_INFO);
  if (process.env.QVAC_HYPERSWARM_SEED !== seedHex) {
    process.env.QVAC_HYPERSWARM_SEED = seedHex;
  }
}

handle('academy:state:get', async (key) => {
  const store = await pearEnd.store();
  return store.get(key);
});

handle('academy:state:set', async ({ key, value }) => {
  const store = await pearEnd.store();
  return store.set(key, value);
});

handle('academy:state:remove', async (key) => {
  const store = await pearEnd.store();
  return store.remove(key);
});

handle('academy:state:list', async () => {
  const store = await pearEnd.store();
  return store.list();
});

handle('academy:window:minimize', (_args, evt) => {
  BrowserWindow.fromWebContents(evt.sender)?.minimize();
});

handle('academy:window:maximize', (_args, evt) => {
  const win = BrowserWindow.fromWebContents(evt.sender);
  if (!win) return;
  if (win.isMaximized()) win.unmaximize();
  else win.maximize();
});

handle('academy:window:close', (_args, evt) => {
  BrowserWindow.fromWebContents(evt.sender)?.close();
});

// Timer lives in the main process so closing the panel doesn't cancel the scrub.
handle('academy:clipboard:copy', async ({ text, scrubAfterMs }) => {
  clipboard.writeText(text);
  if (scrubAfterMs > 0) {
    const timer = setTimeout(() => {
      // Only clear if the clipboard still holds what we put there.
      if (clipboard.readText() === text) clipboard.clear();
    }, scrubAfterMs);
    // A pending scrub is not a reason to keep the app alive.
    if (typeof timer.unref === 'function') timer.unref();
  }
  return true;
});

handle('academy:models:list', async () => listModels());

// Read-only twin of academy:chat:configured-model, without that handler's
// side effect of picking and persisting a default when none is set yet.
async function configuredChatModelName() {
  if (chat.currentModel()) return chat.currentModel();
  const store = await pearEnd.store();
  const existing = await store.get('ai.chat.model');
  return existing && chat.isChatPreset(existing) ? existing : null;
}

handle('academy:models:remove', async (id) => {
  const items = await listModels();
  const target = items.find((it) => it.id === id);
  if (target && target.name === (await configuredChatModelName())) {
    throw new Error('The AI bot is set to use this model. Select a different one first.');
  }
  // Unload first so ensureLoaded()'s "already loaded" shortcut doesn't hand out a deleted model forever.
  const result = await removeModel(id);
  if (target && chat.currentModel() === target.name) {
    await chat
      .unload()
      .catch((err) => console.warn('[tether-academy-desktop] unload after remove failed:', err?.message ?? err));
  }
  return result;
});

handle('academy:models:removeAll', async () => {
  // The active chat model is always the one configuredChatModelName() names
  // (it checks chat.currentModel() first), so keeping it here means removeAll
  // never actually deletes a loaded model, and never needs to unload one.
  const keepName = await configuredChatModelName();
  return removeAllModels(keepName ? new Set([keepName]) : undefined);
});

handle('academy:models:verify', async () => {
  const { verifyAllAsync } = require('../shared/model-integrity.cjs');
  const { verified, mismatched, recorded } = await verifyAllAsync();
  return { verified: verified.length, mismatched, recorded: recorded.length };
});

handle('academy:models:catalogue', async () => catalogue());

handle('academy:models:recommend', async (lessonKey) => {
  const hardware = await getDeviceInfo().catch(() => null);
  return recommend(lessonKey, hardware);
});

handle('academy:models:for-lesson', async (lessonKey) => forLesson(lessonKey));

// AI assistant chat. The renderer subscribes once on mount to academy:chat:chunk
// and routes by requestId.
handle('academy:chat:ready', async () => chat.isReady());
handle('academy:chat:current-model', async () => chat.currentModel());
handle('academy:chat:configured-model', async () => {
  if (chat.currentModel()) return chat.currentModel();
  const store = await pearEnd.store();
  const existing = await store.get('ai.chat.model');
  // A preset can go away (as Llama-3.2-1B did) and a chosen model can be
  // deleted afterwards, so check the name and the file before handing it back.
  if (existing && chat.isChatPreset(existing) && (await chat.isChatModelInstalled(existing))) {
    return existing;
  }
  const picked = await chat.pickDefaultChatModel();
  if (picked && picked !== existing) {
    await store.set('ai.chat.model', picked);
  }
  return picked;
});
handle('academy:chat:load', async (modelHint) => {
  const result = await chat.load(modelHint);
  const store = await pearEnd.store();
  await store.set('ai.chat.model', result.modelName);
  return result;
});
handle('academy:chat:send', async (parsed) => {
  const result = await chat.send({
    messages: parsed.messages,
    lessonKey: parsed.lessonKey,
    lessonReference: parsed.lessonReference,
    useFullDocs: parsed.useFullDocs,
    modelHint: parsed.modelHint,
  });
  return result;
});
handle('academy:chat:verify', async (parsed) => {
  const result = await chat.verify({
    code: parsed.code,
    tests: parsed.tests,
    lessonKey: parsed.lessonKey,
    lessonReference: parsed.lessonReference,
    answer: parsed.answer,
    modelHint: parsed.modelHint,
  });
  return result;
});
handle('academy:chat:security-scan', async (parsed) => {
  const result = await chat.securityScan({
    code: parsed.code,
    lessonKey: parsed.lessonKey,
    lessonReference: parsed.lessonReference,
    modelHint: parsed.modelHint,
  });
  return result;
});
handle('academy:chat:stop', async (requestId) => chat.stop(requestId));
handle('academy:chat:docs-status', async () => chat.docsStatus());
handle('academy:chat:docs-refresh', async () => chat.docsRefresh());

handle('academy:device:info', async () => getDeviceInfo());

// Forward chat events from the host process to every open BrowserWindow. The
// renderer subscribes once on mount and dispatches by requestId. We register
// the listeners at module load so they're live for the lifetime of the app;
// late subscribers pick up chunks from any in-flight requests.
chat.onChunk((chunk) => sendToAll('academy:chat:chunk', chunk));
chat.onVerifyResult((result) => sendToAll('academy:chat:verify-result', result));
chat.onSecurityResult((result) => sendToAll('academy:chat:security-result', result));
chat.onLoadProgress((progress) => sendToAll('academy:chat:load-progress', progress));

handle('academy:peer:identity', async () => {
  const idm = pearEnd.identity();
  const view = idm.publicView();
  if (view.ready) {
    return {
      publicKey: view.devicePublicKey,
      identityPublicKey: view.identityPublicKey,
      source: view.source,
      createdAt: view.createdAt,
      status: view.status,
      ready: true,
      holdsRoot: view.holdsRoot,
      devices: view.devices,
    };
  }
  return {
    publicKey: null,
    identityPublicKey: null,
    source: null,
    createdAt: null,
    status: view.status,
    ready: false,
    holdsRoot: false,
    devices: [],
  };
});

// --- Identity onboarding / multi-device (never returns private material) ---
handle('academy:identity:status', () => pearEnd.identity().publicView());

handle('academy:identity:create', async () => {
  const result = await pearEnd.identity().createNew();
  // Mnemonic returned once for backup UI; not logged.
  return result;
});

handle('academy:identity:confirm-backup', async () => {
  const view = pearEnd.identity().confirmBackup();
  await pearEnd.ensureReady();
  return view;
});

handle('academy:identity:recover', async (mnemonic) => {
  const view = await pearEnd.identity().recoverFromMnemonic(mnemonic);
  await pearEnd.ensureReady();
  return view;
});

// No begin-link / complete-link handlers: the device-link flow was removed because
// its proof wasn't bound to the challenge it handed out. It returns once fixed.

handle('academy:identity:begin-attest', async (payload) => {
  return pearEnd.identity().beginAttestSession(payload.devicePublicKey, { label: payload.label ?? null });
});

handle('academy:identity:finish-attest', async (payload) => {
  return pearEnd.identity().finishAttest(payload.sessionId, { confirm: true });
});

handle('academy:identity:cancel-attest', async (sessionId) => {
  return pearEnd.identity().cancelAttest(sessionId);
});

handle('academy:identity:revoke-device', async (devicePublicKey) => {
  const view = pearEnd.identity().revokeDevice(devicePublicKey);
  await pearEnd.syncRevocations();
  return view;
});

handle('academy:identity:list-devices', () => pearEnd.identity().publicView().devices);

// Destructive: wipe sealed identity from this device (seed not deleted if user still has backup).
handle('academy:identity:reset', async () => {
  const idm = pearEnd.identity();
  idm.resetLocal();
  try {
    await pearEnd.closeMesh();
  } catch {
    // peer may not have been inited
  }
  return idm.publicView();
});

// --- Attested blob store (username, progress, future per-identity kinds) ---
// Handlers await idm.ready() first: init() decrypts the blob store async,
// and skipping this makes an early getProgress() throw "stores not loaded".
async function identityReady(idm) {
  if (idm.status() !== 'ready') return false;
  await idm.ready();
  return true;
}

handle('academy:identity:set-username', async (payload) => {
  const idm = pearEnd.identity();
  if (idm.status() !== 'ready') return null;
  await idm.ready();
  return idm.setUsername(payload.username);
});
handle('academy:identity:get-username', async () => {
  const idm = pearEnd.identity();
  if (idm.status() !== 'ready') return null;
  await idm.ready();
  return idm.getUsername();
});
handle('academy:identity:set-progress', async (payload) => {
  const idm = pearEnd.identity();
  if (idm.status() !== 'ready') return null;
  await idm.ready();
  return idm.setProgress(payload.progress);
});
handle('academy:identity:get-progress', async () => {
  const idm = pearEnd.identity();
  if (idm.status() !== 'ready') return null;
  await idm.ready();
  return idm.getProgress();
});
handle('academy:identity:list-blobs', async () => {
  const idm = pearEnd.identity();
  if (idm.status() !== 'ready') return { private: [], public: [] };
  await idm.ready();
  return idm.listBlobs();
});
handle('academy:identity:public-snapshot', async () => {
  const idm = pearEnd.identity();
  if (idm.status() !== 'ready') return null;
  await idm.ready();
  return idm.publicProfileSnapshot();
});
handle('academy:identity:verify-attested', async (payload) => {
  const idm = pearEnd.identity();
  return idm.verifyAttested(
    payload.kind,
    payload.payload,
    payload.proofB64,
    payload.expectedIdentityPublicKeyHex,
  );
});
handle('academy:identity:import-profile', async (payload) => {
  const idm = pearEnd.identity();
  return idm.importProfile({
    identityPublicKeyHex: payload.identityPublicKeyHex,
    profile: payload.profile,
  });
});

handle('academy:peer:take-deeplink', () => {
  const payload = pendingDeeplink;
  pendingDeeplink = null;
  return payload;
});

// Invite from the renderer: only userData. autoApprove/code aren't forwarded.
handle('academy:peer:invite', async (opts) => {
  if (!(await pearEnd.ensureReady())) {
    throw new Error('Complete identity onboarding before pairing devices');
  }
  return pearEnd.peer.createInvite({ userData: opts?.userData ?? null });
});

handle('academy:peer:approve', async (requestId) => pearEnd.peer.approve(requestId));

handle('academy:peer:reject', async (requestId) => pearEnd.peer.reject(requestId));

handle('academy:peer:pending', async () => {
  if (!(await pearEnd.ensureReady())) return [];
  return pearEnd.peer.listPending();
});

// The renderer relays the answer only. spawnExec picks which devices.
handle('academy:peer:device-consent', async ({ requestId, approved }) => {
  return pearEnd.peer.resolveDeviceRequest(requestId, approved);
});

handle('academy:peer:device-requests', async () => {
  if (!(await pearEnd.ensureReady())) return [];
  return pearEnd.peer.listDeviceRequests();
});

handle('academy:peer:audit', async (opts) => {
  if (!(await pearEnd.ensureReady())) return [];
  return pearEnd.peer.getAudit(opts);
});

handle('academy:peer:clear-audit', () => pearEnd.peer.clearAudit());

handle('academy:peer:clear-peer-audit', async (discoveryKey) =>
  pearEnd.peer.clearPeerAudit(discoveryKey),
);

handle('academy:peer:lockdown', async () => pearEnd.peer.lockdown());

handle('academy:peer:accept', async ({ inviteB64, opts }) => {
  if (!(await pearEnd.ensureReady())) {
    throw new Error('Complete identity onboarding before pairing devices');
  }
  return pearEnd.peer.acceptInvite(inviteB64, {
    userData: opts?.userData ?? null,
    code: opts?.code ?? null,
    hostIdentity: opts?.hostIdentity ?? null,
  });
});

handle('academy:peer:list', async () => {
  if (!(await pearEnd.ensureReady())) return [];
  return pearEnd.peer.listPeers();
});

handle('academy:peer:drop', async (discoveryKey) => pearEnd.peer.dropPeer(discoveryKey));

pearEnd.peer.on((event, payload) => {
  sendToAll('academy:peer:event', { event, payload });
});

function installNavigationHardening(win, allowedOrigins) {
  // Keep the main window on app-owned origins; open anything else externally.
  win.webContents.setWindowOpenHandler(({ url }) => {
    try {
      const parsed = new URL(url);
      if (parsed.protocol === 'http:' || parsed.protocol === 'https:') {
        shell.openExternal(url).catch((err) => {
          console.warn('[tether-academy-desktop] openExternal failed:', err?.message ?? err);
        });
      }
    } catch {
      // ignore malformed URLs
    }
    return { action: 'deny' };
  });

  // Node's URL serialises non-special schemes to origin 'null', so academy://
  // is compared by scheme+host directly instead of by origin.
  win.webContents.on('will-navigate', (event, url) => {
    let allowed = false;
    try {
      const parsed = new URL(url);
      allowed = allowedOrigins.some((origin) => {
        try {
          const allow = new URL(origin);
          if (allow.protocol === 'academy:') {
            return parsed.protocol === 'academy:' && parsed.host === allow.host;
          }
          return parsed.origin === allow.origin;
        } catch {
          return false;
        }
      });
    } catch {
      allowed = false;
    }
    if (!allowed) {
      event.preventDefault();
      try {
        const parsed = new URL(url);
        if (parsed.protocol === 'http:' || parsed.protocol === 'https:') {
          shell.openExternal(url).catch(() => {});
        }
      } catch {
        // ignore
      }
    }
  });
}

async function createWindow() {
  const win = new BrowserWindow({
    width: 1280,
    height: 860,
    // 720 so two windows fit side by side on a 1512pt laptop screen for a paired run.
    minWidth: 720,
    minHeight: 600,
    backgroundColor: '#0a0a0a',
    title: 'Tether Academy',
    icon: ICON_PATH, // window/taskbar icon on Linux and Windows; macOS uses the dock icon set at top-of-file
    // No native title bar on macOS; the web header doubles as one. Other
    // platforms keep the default frame so the OS window controls stay usable.
    frame: !isMac,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      sandbox: true,
      contextIsolation: true,
      nodeIntegration: false,
    },
  });
  if (process.env.PEAR_DEV_SERVER_URL || process.env.NODE_ENV === 'development') {
    win.webContents.openDevTools({ mode: 'detach' });
  }
  win.webContents.on('console-message', (_e, level, message, line, source) => {
    // pnpm closes stdout once the launcher exits; a later write throws EPIPE.
    try {
      console.log(`[renderer ${level}] ${source}:${line} ${message}`);
    } catch (err) {
      if (err?.code !== 'EPIPE') throw err;
    }
  });

  const outIndex = path.resolve(__dirname, '..', '..', 'web', 'out', 'index.html');
  const staticDir = path.resolve(__dirname, '..', '..', 'web', 'out');
  const staticExists = fsSync().existsSync(outIndex);
  const academyOrigin = 'academy://app/';
  if (process.env.PEAR_DEV_URL) {
    const devUrl = process.env.PEAR_DEV_URL;
    console.log('[tether-academy-desktop] loading', devUrl);
    installNavigationHardening(win, [devUrl]);
    await win.loadURL(devUrl);
  } else if (staticExists) {
    console.log('[tether-academy-desktop] serving', staticDir, 'on', academyOrigin);
    installNavigationHardening(win, [academyOrigin]);
    await win.loadURL(academyOrigin);
  } else {
    const devUrl = 'http://localhost:4712';
    console.log('[tether-academy-desktop] no static build found, trying', devUrl);
    console.log(
      '[tether-academy-desktop] (run `npm run build` in the repo root, or set PEAR_DEV_URL to a running web server)',
    );
    installNavigationHardening(win, [devUrl]);
    await win.loadURL(devUrl);
  }
}

function fsSync() {
  return require('node:fs');
}

// Monaco's AMD loader is served locally from /monaco/vs; no remote script origin.
// 'unsafe-eval' is required by the AMD loader's language workers; 'unsafe-inline'
// is needed because the static export has no server to mint nonces for Next's
// inline bootstrap. Policy lives in security-headers.cjs, shared with the <meta> tag.
const { SECURITY_HEADERS } = require('./security-headers.cjs');

function resolveStaticPath(pathname, root) {
  // trailingSlash: true, so directory and extensionless requests land on index.html.
  let p = decodeURIComponent(pathname || '/');
  const basePrefix = '/tether-academy';
  if (p === basePrefix || p.startsWith(`${basePrefix}/`)) {
    p = p.slice(basePrefix.length) || '/';
  }
  const rootWithSep = root.endsWith(path.sep) ? root : root + path.sep;
  const abs = path.resolve(root, '.' + p);
  if (abs !== root && !abs.startsWith(rootWithSep)) return null;
  return abs;
}

function registerAcademyProtocol(staticDir) {
  protocol.handle('academy', async (request) => {
    const url = new URL(request.url);
    const resolved = resolveStaticPath(url.pathname, staticDir);
    if (!resolved) {
      return new Response('not found', { status: 404, headers: SECURITY_HEADERS });
    }
    let finalPath = resolved;
    try {
      const stat = await fs.stat(resolved);
      if (stat.isDirectory()) finalPath = path.join(resolved, 'index.html');
    } catch {
      if (!path.extname(resolved)) finalPath = path.join(`${resolved}/`, 'index.html');
      else {
        return new Response('not found', { status: 404, headers: SECURITY_HEADERS });
      }
    }
    // net.fetch streams so model files and bundles aren't buffered in full.
    const res = await net.fetch(pathToFileURL(finalPath).toString());
    return new Response(res.body, {
      status: res.status,
      headers: {
        'Content-Type': mimeFor(finalPath),
        'Cache-Control': 'no-store',
        ...SECURITY_HEADERS,
      },
    });
  });
}


// Protocol scheme must start with an ASCII letter, so derive it from productName
// rather than the scoped `pkg.name`.
const deeplinkProtocol = (productName || name).toLowerCase().replace(/[^a-z0-9-]/g, '-');
app.setAsDefaultProtocolClient(deeplinkProtocol);

function parsePairUrl(url) {
  if (typeof url !== 'string') return null;
  if (!url.startsWith(`${deeplinkProtocol}://pair`)) return null;
  // Rejected here rather than relying on the renderer's textContent handling.
  // Both raw (`%01`) and decoded (`\x01`) control-character forms are checked.
  if (url.length > 4096) return null;
  let parsed;
  try {
    parsed = new URL(url);
  } catch {
    return null;
  }
  if (/[\x00-\x1f\x7f]/.test(parsed.search) || /%0[0-9a-f]/i.test(parsed.search)) return null;
  const invite = parsed.searchParams.get('i');
  const hostIdentity = parsed.searchParams.get('h');
  if (!invite) return null;
  return { invite, hostIdentity: hostIdentity ?? null, url };
}

let pendingDeeplink = null;

function handlePairDeepLink(url) {
  const parsed = parsePairUrl(url);
  if (!parsed) return;
  const payload = {
    invite: parsed.invite,
    hostIdentity: parsed.hostIdentity,
    url: parsed.url,
  };
  pendingDeeplink = payload;
  sendToAll('academy:peer:event', { event: 'peer:deeplink', payload });
}

app.on('open-url', (evt, url) => {
  evt.preventDefault();
  handlePairDeepLink(url);
});

const lock = app.requestSingleInstanceLock();
if (!lock) {
  app.quit();
} else {
  app.on('second-instance', (_e, args) => {
    const url = args.find((a) => a.startsWith(`${deeplinkProtocol}://`));
    if (url) handlePairDeepLink(url);
  });
  let shuttingDown = false;
  app.on('before-quit', (evt) => {
    if (shuttingDown) return;
    shuttingDown = true;
    evt.preventDefault();
    // pearEnd.shutdown() only tears down the peer-mesh worker; the sandbox
    // worker(s) from getWorker() are a separate process and were leaking
    // (never killed on quit) without this.
    for (const worker of workerProcesses) {
      try {
        worker.destroy();
      } catch {
        // already gone
      }
    }
    // A lesson Run in flight has its own detached process group (so killGroup
    // also reaches the QVAC worker it spawns). It outlives the app unless
    // aborted here.
    if (currentRun) {
      try {
        currentRun.abort();
      } catch {
        // already gone
      }
    }
    // The chat model's bare worker process is spawned by @qvac/sdk's
    // loadModel and otherwise never torn down, leaking one orphaned process
    // per session.
    chat
      .unload()
      .catch((err) => console.warn('[tether-academy-desktop] chat unload error:', err?.message ?? err))
      .finally(() => {
        pearEnd
          .shutdown()
          .catch((err) => console.warn('[tether-academy-desktop] shutdown error:', err?.message ?? err))
          .finally(() => app.quit());
      });
  });
  // Ctrl+C sends SIGINT straight to this process. Node's default is to exit
  // immediately with no cleanup, which is how the processes above get
  // orphaned. Routing both through app.quit() gives them the same
  // before-quit teardown as a normal Quit.
  process.on('SIGINT', () => app.quit());
  process.on('SIGTERM', () => app.quit());
  app.whenReady().then(async () => {
    const staticDir = path.resolve(__dirname, '..', '..', 'web', 'out');
    if (fsSync().existsSync(path.join(staticDir, 'index.html'))) {
      registerAcademyProtocol(staticDir);
    }

    // A force-quit mid-download leaves a truncated file at its final name (no .part + rename staging),
    // which then reads as fully installed forever. Sweep once per launch so the next load starts a
    // fresh download instead of reusing the truncated file.
    setImmediate(() => {
      pruneIncompleteDownloads()
        .then(({ removed }) => {
          if (removed.length > 0) {
            console.log('[tether-academy-desktop] pruned truncated model downloads:', removed);
          }
        })
        .catch((err) => console.warn('[tether-academy-desktop] pruneIncompleteDownloads failed:', err?.message ?? err));
    });

    // A run killed with SIGKILL never runs its own JS-level cleanup, so the
    // QVAC worker it spawned can outlive it indefinitely; sweep once per
    // launch for any left behind by a previous session.
    setImmediate(() => {
      try {
        const { reapOrphanedQvacWorkers } = require('../shared/qvac-orphan-reaper.cjs');
        const killed = reapOrphanedQvacWorkers();
        if (killed.length > 0) {
          console.log('[tether-academy-desktop] reaped orphaned QVAC workers:', killed);
        }
      } catch (err) {
        console.warn('[tether-academy-desktop] reapOrphanedQvacWorkers failed:', err?.message ?? err);
      }
    });

    // Warm the model manifest in the background so a peer-exec usually lands
    // with hashes already on file.
    const { scheduleVerifyAll } = require('../shared/model-integrity.cjs');
    setImmediate(() => scheduleVerifyAll());

    // Show the window first; peer/DHT bootstrap can take several seconds or hang offline.
    createWindow().catch((err) => {
      console.error(err);
      app.quit();
    });
    app.on('activate', () => {
      if (BrowserWindow.getAllWindows().length === 0) createWindow().catch(console.error);
    });

    // Background: identity + mesh. Safe to fail; pairing retries via pearEnd.ensureReady.
    setImmediate(() => {
      (async () => {
        try {
          const idm = pearEnd.identity();
          // A sealed record the keyring can no longer open otherwise reads as
          // "signed out", with the real reason only in the console.
          await idm.ready().catch(() => {});
          const initErr = idm.initError();
          if (initErr?.code === 'ERR_KEYRING_UNAVAILABLE') {
            dialog.showErrorBox(
              'Tether Academy: OS keyring unavailable',
              `${initErr.message}\n\nUntil then this device reads as signed out, `
              + 'and paired devices cannot run code on it.',
            );
          }
          await pearEnd.store();
          const ready = await pearEnd.ensureReady();
          if (!ready) {
            console.log(
              '[tether-academy-desktop] identity not ready; complete onboarding before mesh pairing',
            );
          }
        } catch (err) {
          console.warn(
            '[tether-academy-desktop] background identity/peer init:',
            err?.message ?? err,
          );
        }
        const coldUrl = process.argv.find((a) => a.startsWith(`${deeplinkProtocol}://`));
        if (coldUrl) {
          try {
            await pearEnd.ensureReady();
            await handlePairDeepLink(coldUrl);
          } catch (err) {
            console.warn(
              '[tether-academy-desktop] cold deeplink failed:',
              err?.message ?? err,
            );
          }
        }
      })();
    });
  });
  app.on('window-all-closed', () => {
    if (process.platform !== 'darwin') app.quit();
  });
}
