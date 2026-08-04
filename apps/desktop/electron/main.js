const { app, BrowserWindow, clipboard, ipcMain, net, protocol, shell } = require('electron');
const os = require('node:os');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const PearRuntime = require('pear-runtime');
const FramedStream = require('framed-stream');
const { isMac, isLinux, isWindows } = require('which-runtime');
const { command, flag } = require('paparam');
const { promises: fs } = require('node:fs');

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

const { runExample } = require('../runner.cjs');
const { listModels, removeModel, removeAllModels } = require('./models.cjs');
const { getDeviceInfo } = require('./device.cjs');
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
    return fn(args, evt);
  });
}

// Shared Zod schemas from @academy/validation (ESM). Loaded once on first use.
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

const workers = new Map();

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
  const worker = PearRuntime.run(WORKER_PATH, [
    updates,
    version,
    upgrade,
    productName + extension,
    dir,
    appPath,
  ]);
  const pipe = new FramedStream(worker);
  const sendIPC = (data) => sendToAll(`pear:worker:ipc:${specifier}`, data);
  const sendOut = (data) => sendToAll(`pear:worker:stdout:${specifier}`, data);
  const sendErr = (data) => sendToAll(`pear:worker:stderr:${specifier}`, data);
  pipe.on('data', sendIPC);
  worker.stdout.on('data', sendOut);
  worker.stderr.on('data', sendErr);
  worker.once('exit', (code) => {
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
const PEER_EXEC_IDLE_MS = 5 * 60_000;

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
    // packages, which a Node child cannot load, and vice versa.
    const { nodeOnlyImports } = await loadIpcValidation();
    const runtime = nodeOnlyImports(parsed.source).length > 0 ? 'node' : 'bare';
    const wrapped = buildLesson({ source: parsed.source, cwd: COURSES_DIR, runtime });
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
      });
    } catch (err) {
      return { ok: false, output: `[peer-exec] ${formatRunError(err)}` };
    }
    // Capped so a run that prints in a loop cannot grow main-process memory unbounded.
    const collected = createAccumulator();
    // Measured from the last output, not the start: a first run downloads the model
    // and streams progress for as long as that takes.
    let noteActivity = () => {};
    emitter.on('stdout', (data) => {
      collected.append('stdout', data);
      noteActivity();
      sendChunk({ stream: 'stdout', data });
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

  const run = runExample({
    ...parsed,
    onChunk: sendChunk,
  });
  currentRun = run;
  return run.promise.finally(() => {
    if (currentRun === run) currentRun = null;
  });
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

handle('academy:models:remove', async (id) => removeModel(id));

handle('academy:models:removeAll', async () => removeAllModels());

// Full re-hash of the cache. Reads every cached byte, so a user asks for it.
handle('academy:models:verify', async () => {
  const { verifyAllAsync } = require('../shared/model-integrity.cjs');
  const { verified, mismatched, recorded } = await verifyAllAsync();
  return { verified: verified.length, mismatched, recorded: recorded.length };
});

handle('academy:device:info', async () => getDeviceInfo());

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
    pearEnd
      .shutdown()
      .catch((err) => console.warn('[tether-academy-desktop] shutdown error:', err?.message ?? err))
      .finally(() => app.quit());
  });
  app.whenReady().then(async () => {
    const staticDir = path.resolve(__dirname, '..', '..', 'web', 'out');
    if (fsSync().existsSync(path.join(staticDir, 'index.html'))) {
      registerAcademyProtocol(staticDir);
    }

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
          pearEnd.identity();
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
