// Fetches a registry model over HTTPS from the source the registry itself
// names, for when the peer-to-peer blob path will not serve it. Nothing enters
// the cache until its bytes match the recorded size and checksum.
'use strict';

const crypto = require('crypto');
const fs = require('fs');
const https = require('https');
const os = require('os');
const path = require('path');

const REGISTRY_PATH = path.resolve(
  __dirname,
  '..',
  'node_modules',
  '@qvac',
  'sdk',
  'dist',
  'models',
  'registry',
  'models.js',
);

const HOSTS = { hf: 'https://huggingface.co' };

function modelsDir(home = os.homedir()) {
  return path.join(home, '.qvac', 'models');
}

/** The SDK names a cached file `<sha256(registryPath)[0..16]>_<basename>`. */
function cacheFileName(registryPath) {
  const hash = crypto.createHash('sha256').update(Buffer.from(registryPath, 'utf8')).digest('hex');
  return `${hash.substring(0, 16)}_${registryPath.split('/').pop()}`;
}

function sourceUrl(entry) {
  const host = HOSTS[entry.registrySource];
  if (!host) throw new Error(`no direct source for registrySource "${entry.registrySource}"`);
  return `${host}/${entry.registryPath}`;
}

/**
 * Registry constants, read as text: the SDK ships an ESM bundle the Bare
 * worker cannot require.
 * @returns {Map<string, { modelId: string, registryPath: string, registrySource: string, expectedSize: number, sha256: string | null }>}
 */
function readRegistry(file = REGISTRY_PATH) {
  const out = new Map();
  let src;
  try {
    src = fs.readFileSync(file, 'utf8');
  } catch {
    return out;
  }
  // Split per entry so a field cannot leak in from the next one.
  for (const chunk of src.split("name: '").slice(1)) {
    const name = /^([A-Z][A-Z0-9_]*)'/.exec(chunk);
    const registryPath = /registryPath: '([^']+)'/.exec(chunk);
    const registrySource = /registrySource: '([^']+)'/.exec(chunk);
    const modelId = /modelId: '([^']+)'/.exec(chunk);
    const size = /expectedSize: (\d+)/.exec(chunk);
    const sha = /sha256Checksum: '([0-9a-f]{64})'/.exec(chunk);
    if (!name || !registryPath || !modelId) continue;
    out.set(name[1], {
      modelId: modelId[1],
      registryPath: registryPath[1],
      registrySource: registrySource ? registrySource[1] : 'hf',
      expectedSize: size ? Number(size[1]) : 0,
      sha256: sha ? sha[1] : null,
    });
  }
  return out;
}

function get(url, redirectsLeft = 5) {
  return new Promise((resolve, reject) => {
    https
      .get(url, { headers: { 'user-agent': 'tether-academy' } }, (res) => {
        const status = res.statusCode ?? 0;
        if (status >= 300 && status < 400 && res.headers.location) {
          res.resume();
          if (redirectsLeft === 0) return reject(new Error('too many redirects'));
          return resolve(get(new URL(res.headers.location, url).href, redirectsLeft - 1));
        }
        if (status !== 200) {
          res.resume();
          return reject(new Error(`HTTP ${status} for ${url}`));
        }
        resolve(res);
      })
      .on('error', reject);
  });
}

/**
 * @param {string} name registry constant, e.g. 'QWEN3_4B_Q4_K_M'
 * @param {{ home?: string, onProgress?: (downloaded: number, total: number) => void, registry?: Map<string, object> }} [opts]
 * @returns {Promise<{ path: string, bytes: number, alreadyCached: boolean }>}
 */
async function sideloadModel(name, opts = {}) {
  const registry = opts.registry ?? readRegistry();
  const entry = registry.get(name);
  if (!entry) throw new Error(`unknown model "${name}"`);

  const dir = modelsDir(opts.home);
  const target = path.join(dir, cacheFileName(entry.registryPath));
  if (fs.existsSync(target) && fs.statSync(target).size === entry.expectedSize) {
    return { path: target, bytes: entry.expectedSize, alreadyCached: true };
  }

  fs.mkdirSync(dir, { recursive: true });
  // Written beside the target so the rename below stays on one filesystem.
  const partial = `${target}.sideload`;
  const res = await get(sourceUrl(entry));
  const hash = crypto.createHash('sha256');
  let downloaded = 0;
  await new Promise((resolve, reject) => {
    const out = fs.createWriteStream(partial);
    res.on('data', (chunk) => {
      downloaded += chunk.length;
      hash.update(chunk);
      if (opts.onProgress) opts.onProgress(downloaded, entry.expectedSize);
    });
    res.on('error', reject);
    out.on('error', reject);
    out.on('finish', () => resolve());
    res.pipe(out);
  }).catch((err) => {
    fs.rmSync(partial, { force: true });
    throw err;
  });

  const digest = hash.digest('hex');
  const sizeOk = entry.expectedSize === 0 || downloaded === entry.expectedSize;
  const shaOk = !entry.sha256 || digest === entry.sha256;
  if (!sizeOk || !shaOk) {
    fs.rmSync(partial, { force: true });
    throw new Error(
      !sizeOk
        ? `${name}: got ${downloaded} bytes, registry expects ${entry.expectedSize}`
        : `${name}: sha256 ${digest} does not match the registry's ${entry.sha256}`,
    );
  }

  fs.renameSync(partial, target);
  return { path: target, bytes: downloaded, alreadyCached: false };
}

module.exports = {
  cacheFileName,
  modelsDir,
  readRegistry,
  sideloadModel,
  sourceUrl,
  REGISTRY_PATH,
};
