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
      // standard gives the renderer a stable origin; secure puts the editor's
      // workers and any crypto API in a secure context.
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
const IPC_CHANNELS = require('../shared/ipc-channels.cjs');

// Single registry, single wrapper. A channel that is not in IPC_CHANNELS
// throws at startup, so a 44th handler cannot inherit nothing. The dynamic
// `pear:worker:writeIPC:*` channel falls back to a longest-prefix match in
// the same table.
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
    // Chunks are always plain text; UI must never interpret them as HTML.
    if (!sender.isDestroyed()) sender.send('academy:run:chunk', chunk);
  };

  if (parsed.peerId) {
    // The host picks its interpreter from the same source, so the build has to
    // match: a Bare build rewrites node: imports to Bare packages, which a Node
    // child cannot load, and vice versa.
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
      return { ok: false, output: `[peer-exec] ${err.message}` };
    }
    // Capped so a run that prints in a loop cannot grow main-process memory
    // without bound. The renderer has already seen every chunk through sendChunk;
    // this only feeds the final { ok, output } the IPC handler returns.
    const collected = createAccumulator();
    // Measured from the last output, since a first run downloads the model and
    // streams progress for as long as that takes. The old deadline counted from
    // the start and cut off runs that were plainly alive.
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
        const settle = (value) => {
          if (idleTimer) clearTimeout(idleTimer);
          idleTimer = null;
          resolve(value);
        };
        noteActivity = () => {
          if (idleTimer) clearTimeout(idleTimer);
          idleTimer = setTimeout(() => {
            // Giving up here leaves the run going on the host, holding the
            // registry lock every other model load on that machine needs.
            pearEnd.peer.cancelExec(parsed.peerId).catch(() => {});
            settle({
              ok: false,
              output: `${collected.result('stdout')}${collected.result('stderr')}\n[peer-exec] no output from peer for ${PEER_EXEC_IDLE_MS / 60_000}m; cancelled the run`,
            });
          }, PEER_EXEC_IDLE_MS);
        };
        emitter.on('exit', (info) => {
          settle({
            ok: info.code === 0,
            output: collected.result('stdout'),
            remoteExit: { code: info.code, signal: info.signal },
          });
        });
        emitter.on('error', (err) => {
          settle({ ok: false, output: `${collected.result('stdout')}${collected.result('stderr')}\n[peer-exec] ${err.message}` });
        });
        noteActivity();
      }),
      abort: () => pearEnd.peer.cancelExec(parsed.peerId),
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

// Pear-end: identity, state (Corestore under userData/corestore), and
// peer/mesh. See pear-end/index.cjs.
const pearEnd = createPearEnd(app.getPath('userData'), { getSafeStorage });

// Derived from the device identity, which is the only identity this app has.
// It used to come from a second ed25519 keypair in its own Corestore core,
// kept alive by this function alone.
//
// A device with no identity yet leaves the variable unset and the SDK decides
// what to do about that. Minting a key here to avoid the question is how the
// second implementation grew in the first place.
async function ensureQVACSeed() {
  const device = pearEnd.identity().getDeviceIdentity();
  if (!device?.privateKey) return;
  // Private-material HKDF with a QVAC domain, distinct from the mesh swarm seed.
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

// The pairing code is the shared secret that gates pairing, and a clipboard
// outlives the panel that filled it. Keeping the timer in the main process is
// what makes closing the window stop cancelling the scrub.
//
// Only clears when the clipboard still holds what we put there, so an earlier
// scrub cannot take whatever the user has copied since.
handle('academy:clipboard:copy', async ({ text, scrubAfterMs }) => {
  clipboard.writeText(text);
  if (scrubAfterMs > 0) {
    const timer = setTimeout(() => {
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
    // Prefer root identity for display; fall back to mesh device key.
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
  // mnemonic returned once for backup UI — not logged.
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

// No begin-link / complete-link handlers. The device-link flow was removed
// along with the manager code behind it, because the proof it accepted was
// never bound to the challenge it handed out. It comes back with that binding.

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

// Invite from the renderer: only userData. autoApprove/code are not forwarded;
// tests require peer.cjs directly when they need those options.
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

  // Compare scheme and host for academy://: Node's URL serialises every
  // non-special scheme to origin 'null', so an origin comparison would let
  // academy://evil/ pass alongside academy://app/. http(s) keeps origin
  // equality. The academy:protocol.cjs unit test pins the trap.
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
    // 720 so two windows fit side by side on a 1512pt laptop screen, which is
    // how a paired run gets watched from both ends. The lesson layout stacks
    // below 1024, so a narrow window reads top-to-bottom instead of splitting.
    minWidth: 720,
    minHeight: 600,
    backgroundColor: '#0a0a0a',
    title: 'Tether Academy',
    // No native title bar. The web header is the title bar; drag it
    // via -webkit-app-region: drag. Close the window via Cmd+W, Cmd+Q,
    // or the macOS menu bar. On non-macOS keep the default frame so
    // the OS window controls stay usable.
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
    // pnpm closes stdout once the launcher exits; writing then throws EPIPE
    // and Electron surfaces it as an uncaught exception. Drop it silently.
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

// Monaco is served from /monaco/vs by the app itself, copied at build time.
// No remote origin in script-src: a CDN compromise, a TLS intercept, or a
// pinned-range mistake cannot run code in the same origin that holds the IPC
// bridge. 'unsafe-eval' is still required by the AMD loader's language workers
// and is the smaller half of this item (item 15). 'unsafe-inline' is here
// because the static export has no server to mint nonces for the inline
// bootstrap Next emits.
//
// The full policy lives in security-headers.cjs so the web export's <meta>
// and the Electron main-process header cannot drift apart.
const { SECURITY_HEADERS } = require('./security-headers.cjs');

function mimeFor(p) {
  if (p.endsWith('.html')) return 'text/html; charset=utf-8';
  if (p.endsWith('.js') || p.endsWith('.mjs')) return 'text/javascript; charset=utf-8';
  if (p.endsWith('.css')) return 'text/css; charset=utf-8';
  if (p.endsWith('.json')) return 'application/json; charset=utf-8';
  if (p.endsWith('.svg')) return 'image/svg+xml';
  if (p.endsWith('.png')) return 'image/png';
  if (p.endsWith('.woff2')) return 'font/woff2';
  return 'application/octet-stream';
}

function resolveStaticPath(pathname, root) {
  // trailingSlash: true, so a directory request and an extensionless request
  // both have to land on index.html.
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
    // net.fetch streams, so model files and bundles the editor pulls come
    // through without buffering. pathToFileURL handles spaces and # in paths.
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


// Protocol scheme must start with an ASCII letter; `pkg.name` is scoped
// (`@tether-academy/desktop`) so derive a letter-led scheme from productName.
const deeplinkProtocol = (productName || name).toLowerCase().replace(/[^a-z0-9-]/g, '-');
app.setAsDefaultProtocolClient(deeplinkProtocol);

function parsePairUrl(url) {
  if (typeof url !== 'string') return null;
  if (!url.startsWith(`${deeplinkProtocol}://pair`)) return null;
  // Bound the URL at parse time. The renderer reads these fields with
  // textContent today, so a control character or HTML in the query is
  // not a live attack; rejecting here means the defense does not depend
  // on the renderer. Raw (`%01`) and decoded (`\x01`) forms both trip.
  // Bound the URL at parse time. The renderer reads these fields with
  // textContent today, so a control character or HTML in the query is
  // not a live attack; rejecting here means the defense does not depend
  // on the renderer. Raw (`%01`) and decoded (`\x01`) forms both trip.
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
  // Queue for the UI; pairing still needs the out-of-band code.
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
    // academy:// serves the packaged renderer. SECURITY_HEADERS travel on the
    // protocol response now that no HTTP server exists. PEAR_DEV_URL still
    // loads over HTTP with devtools open, which keeps its own headers.
    const staticDir = path.resolve(__dirname, '..', '..', 'web', 'out');
    if (fsSync().existsSync(path.join(staticDir, 'index.html'))) {
      registerAcademyProtocol(staticDir);
    }

    // Warm the model manifest in the background so a peer-exec usually lands
    // with hashes already on file. Main is off the DHT path; a long sync
    // read here starves nothing.
    const { scheduleVerifyAll } = require('../shared/model-integrity.cjs');
    setImmediate(() => scheduleVerifyAll());

    // Show the window first. Peer/DHT bootstrap can take several seconds (or
    // hang offline) and must not block the dock icon from opening a window.
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
