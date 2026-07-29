const { app, BrowserWindow, ipcMain } = require('electron');
const os = require('node:os');
const path = require('node:path');
const PearRuntime = require('pear-runtime');
const FramedStream = require('framed-stream');
const QRCode = require('qrcode');
const { isMac, isLinux, isWindows } = require('which-runtime');
const { command, flag } = require('paparam');
const { createServer } = require('node:http');
const { promises: fs } = require('node:fs');

const { runExample } = require('../runner.cjs');
const { createStore } = require('./state-store.cjs');
const { listModels, removeModel, removeAllModels } = require('./models.cjs');
const { getDeviceInfo } = require('./device.cjs');
const { buildLesson } = require('./runner-process.cjs');
const peer = require('./peer.cjs');

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
  ipcMain.handle(`pear:worker:writeIPC:${specifier}`, (_e, data) => pipe.write(data));
  workers.set(specifier, pipe);
  return pipe;
}

ipcMain.handle('pear:startWorker', (_e, filename) => {
  if (filename === mainWorkerSpecifier) getWorker(filename);
  return true;
});

// One slot for the in-flight run so the stop button can kill it.
let currentRun = null;

const COURSES_DIR = path.join(app.getAppPath(), '..', '..', 'packages', 'courses');

ipcMain.handle('academy:run', async (evt, payload) => {
  await ensureQVACSeed();
  const sender = evt.sender;
  const sendChunk = (chunk) => {
    if (!sender.isDestroyed()) sender.send('academy:run:chunk', chunk);
  };

  if (payload.peerId) {
    const wrapped = buildLesson({ source: payload.source, cwd: COURSES_DIR });
    let emitter;
    try {
      emitter = peer.exec({
        peerId: payload.peerId,
        code: wrapped,
        mode: 'file',
        fileName: typeof payload.fileName === 'string' && payload.fileName ? payload.fileName : 'snippet.mts',
        argv: ['--experimental-strip-types', '--no-warnings', ...(Array.isArray(payload.argv) ? payload.argv : [])],
        cwd: COURSES_DIR,
      });
    } catch (err) {
      return { ok: false, output: `[peer-exec] ${err.message}` };
    }
    const collected = { stdout: '', stderr: '' };
    emitter.on('stdout', (data) => {
      collected.stdout += data;
      sendChunk({ stream: 'stdout', data });
    });
    emitter.on('stderr', (data) => {
      collected.stderr += data;
      sendChunk({ stream: 'stderr', data });
    });
    const run = {
      promise: new Promise((resolve) => {
        emitter.on('exit', (info) => {
          resolve({
            ok: info.code === 0,
            output: collected.stdout,
            remoteExit: { code: info.code, signal: info.signal },
          });
        });
        emitter.on('error', (err) => {
          resolve({ ok: false, output: `${collected.stdout}${collected.stderr}\n[peer-exec] ${err.message}` });
        });
        // 5 minutes: model downloads on first run can easily exceed a minute.
        setTimeout(() => {
          resolve({ ok: false, output: `${collected.stdout}${collected.stderr}\n[peer-exec] no response from peer after 5m` });
        }, 5 * 60_000);
      }),
      abort: () => peer.cancelExec(payload.peerId),
    };
    currentRun = run;
    return run.promise.finally(() => {
      if (currentRun === run) currentRun = null;
    });
  }

  const run = runExample({
    ...payload,
    onChunk: sendChunk,
  });
  currentRun = run;
  return run.promise.finally(() => {
    if (currentRun === run) currentRun = null;
  });
});

ipcMain.handle('academy:stop', () => {
  if (!currentRun) return false;
  return currentRun.abort();
});

// Persistent state: a Corestore under userData/corestore (see state-store.cjs).
let stateStorePromise = null;
function getStateStore() {
  if (!stateStorePromise) {
    stateStorePromise = createStore(app.getPath('userData')).then((store) => {
      console.log(
        `[tether-academy-desktop] identity pubkey: ${store.identity.publicKey.slice(0, 16)}...`,
      );
      return store;
    });
  }
  return stateStorePromise;
}

async function ensureQVACSeed() {
  const store = await getStateStore();
  if (process.env.QVAC_HYPERSWARM_SEED !== store.identity.publicKey) {
    process.env.QVAC_HYPERSWARM_SEED = store.identity.publicKey;
  }
}

ipcMain.handle('academy:state:get', async (_e, key) => {
  const store = await getStateStore();
  return store.get(key);
});

ipcMain.handle('academy:state:set', async (_e, key, value) => {
  const store = await getStateStore();
  return store.set(key, value);
});

ipcMain.handle('academy:state:remove', async (_e, key) => {
  const store = await getStateStore();
  return store.remove(key);
});

ipcMain.handle('academy:state:list', async () => {
  const store = await getStateStore();
  return store.list();
});

ipcMain.handle('academy:window:minimize', (evt) => {
  BrowserWindow.fromWebContents(evt.sender)?.minimize();
});

ipcMain.handle('academy:window:maximize', (evt) => {
  const win = BrowserWindow.fromWebContents(evt.sender);
  if (!win) return;
  if (win.isMaximized()) win.unmaximize();
  else win.maximize();
});

ipcMain.handle('academy:window:close', (evt) => {
  BrowserWindow.fromWebContents(evt.sender)?.close();
});

ipcMain.handle('academy:models:list', async () => {
  return listModels();
});

ipcMain.handle('academy:models:remove', async (_e, id) => {
  return removeModel(id);
});

ipcMain.handle('academy:models:removeAll', async () => {
  return removeAllModels();
});

ipcMain.handle('academy:device:info', async () => {
  return getDeviceInfo();
});

ipcMain.handle('academy:qr', async (_e, text) => {
  if (typeof text !== 'string' || text.length === 0) {
    throw new Error('academy:qr: text must be a non-empty string');
  }
  return QRCode.toDataURL(text, { errorCorrectionLevel: 'M', margin: 1, width: 360 });
});

ipcMain.handle('academy:peer:identity', () => {
  return peer.getIdentity();
});

ipcMain.handle('academy:peer:invite', async (_e, opts) => {
  return peer.createInvite(opts ?? {});
});

ipcMain.handle('academy:peer:approve', async (_e, requestId) => {
  return peer.approve(requestId);
});

ipcMain.handle('academy:peer:reject', async (_e, requestId) => {
  return peer.reject(requestId);
});

ipcMain.handle('academy:peer:pending', () => {
  return peer.listPending();
});

ipcMain.handle('academy:peer:audit', (_e, opts) => {
  return peer.getAudit(opts ?? {});
});

ipcMain.handle('academy:peer:clear-audit', () => {
  return peer.clearAudit();
});

ipcMain.handle('academy:peer:clear-peer-audit', (_e, discoveryKey) => {
  return peer.clearPeerAudit(discoveryKey);
});

ipcMain.handle('academy:peer:lockdown', async () => {
  return peer.lockdown();
});

ipcMain.handle('academy:peer:accept', async (_e, inviteB64, opts) => {
  return peer.acceptInvite(inviteB64, opts ?? {});
});

ipcMain.handle('academy:peer:list', () => {
  return peer.listPeers();
});

ipcMain.handle('academy:peer:drop', async (_e, discoveryKey) => {
  return peer.dropPeer(discoveryKey);
});

peer.on((event, payload) => {
  sendToAll('academy:peer:event', { event, payload });
});

async function createWindow() {
  const win = new BrowserWindow({
    width: 1280,
    height: 860,
    minWidth: 960,
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
      sandbox: false,
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
  if (process.env.PEAR_DEV_URL) {
    console.log('[tether-academy-desktop] loading', process.env.PEAR_DEV_URL);
    await win.loadURL(process.env.PEAR_DEV_URL);
  } else if (staticExists) {
    const port = await startStaticServer(staticDir);
    const url = `http://localhost:${port}/`;
    console.log('[tether-academy-desktop] serving', staticDir, 'on', url);
    await win.loadURL(url);
  } else {
    const devUrl = 'http://localhost:4712';
    console.log('[tether-academy-desktop] no static build found, trying', devUrl);
    console.log(
      '[tether-academy-desktop] (run `npm run build` in the repo root, or set PEAR_DEV_URL to a running web server)',
    );
    await win.loadURL(devUrl);
  }
}

function fsSync() {
  return require('node:fs');
}

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

// Pin the port: Chromium partitions localStorage by origin, so a random
// port per launch would put the renderer's persistence on a fresh partition.
function loadSavedPort() {
  const file = path.join(app.getPath('userData'), 'static-server.port');
  try {
    const n = parseInt(fsSync().readFileSync(file, 'utf-8'), 10);
    return Number.isFinite(n) && n > 0 && n < 65536 ? n : null;
  } catch {
    return null;
  }
}

function savePort(port) {
  const file = path.join(app.getPath('userData'), 'static-server.port');
  try {
    fsSync().writeFileSync(file, String(port), 'utf-8');
  } catch (err) {
    console.warn('[tether-academy-desktop] could not save static server port:', err.message);
  }
}

function listenOnce(server, port) {
  return new Promise((resolve, reject) => {
    const onError = (err) => {
      server.removeListener('listening', onListening);
      reject(err);
    };
    const onListening = () => {
      server.removeListener('error', onError);
      resolve(server.address().port);
    };
    server.once('error', onError);
    server.once('listening', onListening);
    server.listen(port ?? 0, '127.0.0.1');
  });
}

async function startStaticServer(root) {
  const server = createServer(async (req, res) => {
    try {
      const u = new URL(req.url, 'http://x');
      let p = decodeURIComponent(u.pathname);
      const basePrefix = '/tether-academy';
      if (p === basePrefix || p.startsWith(`${basePrefix}/`)) {
        p = p.slice(basePrefix.length) || '/';
      }
      const abs = path.join(root, p);
      if (!abs.startsWith(root)) {
        res.writeHead(403);
        res.end();
        return;
      }
      let resolved = abs;
      try {
        const stat = await fs.stat(abs);
        if (stat.isDirectory()) {
          resolved = path.join(abs, 'index.html');
        }
      } catch {
        if (!path.extname(abs)) {
          resolved = path.join(`${abs}/`, 'index.html');
        } else {
          res.writeHead(404);
          res.end('not found');
          return;
        }
      }
      const data = await fs.readFile(resolved);
      res.writeHead(200, { 'Content-Type': mimeFor(resolved), 'Cache-Control': 'no-store' });
      res.end(data);
    } catch {
      res.writeHead(404);
      res.end('not found');
    }
  });

  const saved = loadSavedPort();
  try {
    const port = await listenOnce(server, saved);
    if (port !== saved) savePort(port);
    return port;
  } catch (err) {
    if (saved && err.code === 'EADDRINUSE') {
      console.warn(
        `[tether-academy-desktop] saved port ${saved} in use, picking a new one`,
      );
      const port = await listenOnce(server, null);
      savePort(port);
      return port;
    }
    throw err;
  }
}


// Protocol scheme must start with an ASCII letter; `pkg.name` is scoped
// (`@tether-academy/desktop`) so derive a letter-led scheme from productName.
const deeplinkProtocol = (productName || name).toLowerCase().replace(/[^a-z0-9-]/g, '-');
app.setAsDefaultProtocolClient(deeplinkProtocol);

function parsePairUrl(url) {
  if (typeof url !== 'string') return null;
  if (!url.startsWith(`${deeplinkProtocol}://pair`)) return null;
  let parsed;
  try {
    parsed = new URL(url);
  } catch {
    return null;
  }
  const invite = parsed.searchParams.get('i');
  const code = parsed.searchParams.get('c');
  const hostIdentity = parsed.searchParams.get('h');
  if (!invite) return null;
  return { invite, code: code ?? null, hostIdentity: hostIdentity ?? null, url };
}

async function handlePairDeepLink(url) {
  const parsed = parsePairUrl(url);
  if (!parsed) return;
  try {
    if (!peer.getIdentity()) {
      const store = await getStateStore();
      await peer.init({ store });
    }
    await peer.acceptInvite(parsed.invite, {
      userData: { name: 'deep-link', source: 'tether-academy://pair' },
      code: parsed.code,
      hostIdentity: parsed.hostIdentity,
    });
    sendToAll('academy:peer:event', { event: 'peer:deeplink', payload: parsed });
  } catch (err) {
    console.warn('[tether-academy-desktop] deeplink accept failed:', err.message);
  }
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
  app.whenReady().then(async () => {
    const coldUrl = process.argv.find((a) => a.startsWith(`${deeplinkProtocol}://`));
    if (coldUrl) {
      try {
        const store = await getStateStore();
        await peer.init({ store });
        await handlePairDeepLink(coldUrl);
      } catch (err) {
        console.warn('[tether-academy-desktop] cold deeplink failed:', err.message);
      }
    } else {
      try {
        const store = await getStateStore();
        await peer.init({ store });
      } catch (err) {
        console.warn('[tether-academy-desktop] peer init failed:', err.message);
      }
    }
    createWindow().catch((err) => {
      console.error(err);
      app.quit();
    });
    app.on('activate', () => {
      if (BrowserWindow.getAllWindows().length === 0) createWindow().catch(console.error);
    });
  });
  app.on('window-all-closed', () => {
    if (process.platform !== 'darwin') app.quit();
  });
}
