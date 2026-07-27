#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const coursesRoot = path.resolve(__dirname, '..');
const repoRoot = path.resolve(coursesRoot, '..', '..');
const desktopElectronDir = path.join(repoRoot, 'apps', 'desktop', 'electron');
const jsonOutPath = path.join(desktopElectronDir, 'model-usage.json');

const args = new Set(process.argv.slice(2));
const writeJson = !args.has('--no-write');
const jsonOnly = args.has('--json-only');

function findSdkModelsFile() {
  const candidates = [
    path.join(repoRoot, 'node_modules', '@qvac', 'sdk', 'dist', 'models', 'registry', 'models.js'),
    path.join(coursesRoot, 'node_modules', '@qvac', 'sdk', 'dist', 'models', 'registry', 'models.js'),
  ];
  for (const c of candidates) if (fs.existsSync(c)) return c;
  const pnpmRoot = path.join(repoRoot, 'node_modules', '.pnpm');
  if (fs.existsSync(pnpmRoot)) {
    const matches = fs
      .readdirSync(pnpmRoot)
      .filter((d) => d.startsWith('@qvac+sdk@'))
      .map((d) =>
        path.join(
          pnpmRoot,
          d,
          'node_modules',
          '@qvac',
          'sdk',
          'dist',
          'models',
          'registry',
          'models.js',
        ),
      )
      .filter((p) => fs.existsSync(p));
    if (matches.length) return matches[0];
  }
  throw new Error("Could not locate @qvac/sdk registry models.js");
}

const SDK_FILE = findSdkModelsFile();
const COURSES_DIR = path.join(coursesRoot, 'courses');

function parseSdkRegistry(source) {
  const arrStart = source.indexOf('export const models = [');
  if (arrStart < 0) throw new Error('Could not find `export const models = [`');
  const arrEnd = source.indexOf('\n];', arrStart);
  const arrLines = source.slice(arrStart, arrEnd).split('\n');

  const nameLineIdx = [];
  for (let i = 0; i < arrLines.length; i++) {
    if (/^        name:\s*'([A-Z][A-Z0-9_]*)',$/.test(arrLines[i])) nameLineIdx.push(i);
  }
  const byIndex = new Map();
  for (let k = 0; k < nameLineIdx.length; k++) {
    const start = nameLineIdx[k];
    const end = k + 1 < nameLineIdx.length ? nameLineIdx[k + 1] : arrLines.length;
    const slice = arrLines.slice(start, end).join('\n');
    const get = (key) => {
      const r = new RegExp(`^        ${key}:\\s*'([^']*)',?\\s*$`, 'm');
      const h = slice.match(r);
      return h ? h[1] : '';
    };
    const numGet = (key) => {
      const r = new RegExp(`^        ${key}:\\s*(\\d+),?\\s*$`, 'm');
      const h = slice.match(r);
      return h ? Number(h[1]) : 0;
    };
    const setKeyMatch = slice.match(/setKey:\s*'([0-9a-f]+)'/);
    byIndex.set(k, {
      name: get('name'),
      addon: get('addon'),
      engine: get('engine'),
      quantization: get('quantization'),
      params: get('params'),
      modelId: get('modelId'),
      expectedSize: numGet('expectedSize'),
      setKey: setKeyMatch ? setKeyMatch[1] : '',
    });
  }

  const out = {};
  const constRe = /export const ([A-Z][A-Z0-9_]*)\s*=\s*\{([\s\S]*?)\n\};/g;
  let m;
  while ((m = constRe.exec(source)) !== null) {
    const [, name, body] = m;
    if (name === 'models') continue;
    const idxMatch = body.match(/models\[(\d+)\]/);
    if (!idxMatch) continue;
    const meta = byIndex.get(Number(idxMatch[1]));
    if (!meta) continue;
    out[name] = meta;
  }
  return out;
}

async function* walkMdx(dir) {
  for (const entry of await fs.promises.readdir(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) yield* walkMdx(full);
    else if (entry.isFile() && entry.name.endsWith('.mdx')) yield full;
  }
}

function chapterOf(mdxPath) {
  const rel = path.relative(COURSES_DIR, mdxPath);
  const parts = rel.split(path.sep);
  return parts[2] ?? '(root)';
}

function lessonTitle(mdxPath) {
  try {
    const raw = fs.readFileSync(mdxPath, 'utf-8');
    const m = raw.match(/^---\r?\n([\s\S]*?)\r?\n---/);
    if (m) {
      const t = m[1].match(/^title:\s*['"]?(.+?)['"]?\s*$/m);
      if (t) return t[1];
    }
  } catch {}
  return path.basename(mdxPath, '.mdx');
}

function findReferencesInMdx(content, constants) {
  const names = Object.keys(constants).sort((a, b) => b.length - a.length);
  if (!names.length) return [];
  const re = new RegExp(`\\b(${names.join('|')})\\b`, 'g');
  const hits = new Set();
  for (const m of content.matchAll(re)) hits.add(m[1]);
  return [...hits];
}

const PURPOSES = {
  llm: 'text generation',
  diffusion: 'image generation',
  embeddings: 'text embeddings / RAG',
  parakeet: 'speech recognition',
  whisper: 'speech recognition',
  bci: 'brain-computer interface',
  tts: 'text to speech',
  nmt: 'translation',
  vla: 'vision-language-action (robotics)',
  ocr: 'optical character recognition',
  classification: 'image classification',
};
const describeAddon = (a) => PURPOSES[a] ?? a;

function formatSize(bytes) {
  if (!bytes) return '';
  if (bytes >= 1e9) return `${(bytes / 1e9).toFixed(1)} GB`;
  if (bytes >= 1e6) return `${(bytes / 1e6).toFixed(0)} MB`;
  if (bytes >= 1e3) return `${(bytes / 1e3).toFixed(0)} KB`;
  return `${bytes} B`;
}

async function main() {
  const sdkSource = fs.readFileSync(SDK_FILE, 'utf-8');
  const registry = parseSdkRegistry(sdkSource);

  const used = new Set();
  const byKey = new Map();
  function addRef(key, chapter, title) {
    if (!key) return;
    const bucket = byKey.get(key) ?? new Map();
    const lessonList = bucket.get(chapter) ?? new Set();
    lessonList.add(title);
    bucket.set(chapter, lessonList);
    byKey.set(key, bucket);
  }
  for await (const mdx of walkMdx(COURSES_DIR)) {
    const content = fs.readFileSync(mdx, 'utf-8');
    const refs = findReferencesInMdx(content, registry);
    if (!refs.length) continue;
    const chapter = chapterOf(mdx);
    const title = lessonTitle(mdx);
    for (const ref of refs) {
      used.add(ref);
      const meta = registry[ref];
      if (!meta) continue;
      addRef(meta.modelId, chapter, title);
      // setKey is the on-disk dir name for companion sets, so the desktop row name matches it.
      if (meta.setKey) addRef(meta.setKey, chapter, title);
    }
  }

  if (writeJson) {
    const json = {};
    for (const [key, chapterMap] of byKey) {
      json[key] = [...chapterMap.entries()]
        .map(([chapter, lessonSet]) => ({
          chapter,
          lessons: [...lessonSet].sort(),
        }))
        .sort((a, b) => a.chapter.localeCompare(b.chapter));
    }
    await fs.promises.mkdir(desktopElectronDir, { recursive: true });
    await fs.promises.writeFile(jsonOutPath, JSON.stringify(json, null, 2) + '\n');
    if (!jsonOnly) {
      console.log(`Wrote ${Object.keys(json).length} model entries to ${path.relative(repoRoot, jsonOutPath)}`);
    }
  }

  if (jsonOnly) return;

  const all = Object.keys(registry).sort();
  const unused = all.filter((n) => !used.has(n));
  console.log(`Removable models: ${unused.length} of ${all.length} SDK constants are not referenced in any lesson.\n`);

  const byEngine = new Map();
  for (const n of unused) {
    const key = registry[n].engine || '(no engine)';
    byEngine.set(key, (byEngine.get(key) ?? 0) + 1);
  }
  const engines = [...byEngine.entries()].sort((a, b) => b[1] - a[1]);

  for (const [engine, count] of engines) {
    const models = unused
      .filter((n) => (registry[n].engine || '(no engine)') === engine)
      .sort();
    console.log(`### ${engine}  (${count})`);
    console.log('');
    console.log('| Name | Purpose | Quant | Size | File size |');
    console.log('| --- | --- | --- | --- | --- |');
    for (const n of models) {
      const m = registry[n];
      console.log(
        `| \`${n}\` | ${describeAddon(m.addon)} | ${m.quantization || ''} | ${m.params || ''} | ${formatSize(m.expectedSize)} |`,
      );
    }
    console.log('');
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
