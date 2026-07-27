// Spawned via ELECTRON_RUN_AS_NODE so the CJS main can run an ESM .mts snippet.
const { spawn } = require('node:child_process');
const { rm } = require('node:fs/promises');
const { mkdirSync, mkdtempSync, writeFileSync } = require('node:fs');
const { tmpdir } = require('node:os');
const { join } = require('node:path');
const path = require('node:path');

const MAX_RUNTIME_MS = 5 * 60 * 1000;

// createRequire needs a file path, not a dir; anchor to this file so packages resolve from the desktop app.
const { createRequire } = require('node:module');
const parentRequire = createRequire(__filename);

function resolveImport(spec) {
  if (spec.startsWith('node:')) return spec;
  if (spec.startsWith('.') || spec.startsWith('/') || spec.startsWith('..')) {
    return spec;
  }
  try {
    return parentRequire.resolve(spec);
  } catch {
    return spec;
  }
}

// Pre-create output directories the snippet writes to. Covers two patterns:
// 1. finetune() options.outputParametersDir / checkpointSaveDir. Otherwise, trainer writes into the input dir.
// 2. fs.writeFileSync("./.../output/...", ...). Image-gen and video-gen lessons write artifacts here.
function precreateOutputDirs(src, cwd) {
  const patterns = [
    /(outputParametersDir|checkpointSaveDir)\s*:\s*['"]([^'"]+)['"]/g,
    /fs\.writeFileSync\s*\(\s*['"]([^'"]+)['"]/g,
  ];
  for (const re of patterns) {
    let m;
    while ((m = re.exec(src))) {
      const rel = m[2] || m[1];
      if (!rel) continue;
      const abs = path.isAbsolute(rel) ? rel : path.join(cwd, rel);
      const dir = path.extname(abs) ? path.dirname(abs) : abs;
      try {
        mkdirSync(dir, { recursive: true });
      } catch {
        // best-effort
      }
    }
  }
}

// Returns { promise, abort } so the main process can kill the child.
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
  precreateOutputDirs(source, childCwd);

  const dir = mkdtempSync(join(tmpdir(), 'ta-run-'));

  // Rewrite npm specifiers to absolute paths so the snippet in /tmp can resolve them.
  const resolvedSource = resolveAllImports(source);
  const importedNames = extractImportedNames(source);
  const namesForImport = Array.from(new Set([...importedNames, 'close']));
  const importLine = `import { ${namesForImport.join(', ')} } from ${JSON.stringify(parentRequire.resolve('@qvac/sdk'))};\n`;

  // Append .finally(close).then(exit) so re-running loadModel doesn't trip "already registered".
  const hooked = hookMainCatch(stripForNode(resolvedSource));

  const wrapped = `${importLine}${hooked}\n`;

  // .mts so --experimental-strip-types accepts TS annotations; type imports are stripped first.
  const file = join(dir, 'snippet.mts');

  const extraArgv = Array.isArray(argv) ? argv.filter((a) => typeof a === 'string') : [];

  writeFileSync(file, wrapped, 'utf-8');

  const child = spawn(
    process.execPath,
    ['--experimental-strip-types', file, ...extraArgv],
    {
      // Anchor at packages/courses/ so lesson relative paths resolve next to vendored files.
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

function extractImportedNames(src) {
  const m = src.match(/^import\s*\{([^}]+)\}\s*from\s*['"]@qvac\/sdk['"]\s*;?/m);
  if (!m) return [];
  return m[1]
    .split(',')
    .map((s) => s.trim().split(/\s+as\s+/)[0].trim())
    .filter(Boolean);
}

function resolveAllImports(src) {
  return src.replace(
    /(\bimport\s+(?:[\w*\s{},]+\s+from\s+)?|\bexport\s+(?:[\w*\s{},]+\s+from\s+)?)(['"])([^'"]+)\2/g,
    (match, head, quote, spec) => {
      const resolved = resolveImport(spec);
      return resolved === spec ? match : `${head}${quote}${resolved}${quote}`;
    },
  );
}

// Strip just enough TS for plain JS parsing; --experimental-strip-types fails on .mjs with mixed type and value imports.
function stripForNode(src) {
  const sdkPath = parentRequire.resolve('@qvac/sdk');
  const sdkPathRe = sdkPath.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return src
    .replace(/^import\s+type\s+.+?from\s+['"][^'"]+['"];?\s*$/gm, '')
    .replace(
      new RegExp(
        `^import\\s+\\{[^}]+\\}\\s+from\\s+['"]@qvac/sdk['"];?\\s*$`,
        'gm',
      ),
      '',
    )
    .replace(
      new RegExp(
        `^import\\s+\\{[^}]+\\}\\s+from\\s+['"]${sdkPathRe}['"];?\\s*$`,
        'gm',
      ),
      '',
    )
    .replace(
      new RegExp(`^import\\s+.+?from\\s+['"]@qvac/sdk['"];?\\s*$`, 'gm'),
      '',
    )
    .replace(
      new RegExp(`^import\\s+.+?from\\s+['"]${sdkPathRe}['"];?\\s*$`, 'gm'),
      '',
    )
    .replace(/^export\s+(?:default\s+)?[^=].*;?\s*$/gm, '')
    .replace(/^export\s+default\s+[^=].*;?\s*$/gm, '')
    .replace(/^export\s+\{[^}]*\};?\s*$/gm, '');
}

// Scans parens to find the matching close so the catch handler can be a multi-line arrow, not just a single ident.
function hookMainCatch(src) {
  const marker = 'main().catch(';
  const start = src.indexOf(marker);
  if (start === -1) return src;
  let i = start + marker.length;
  let depth = 1;
  let inSingle = false;
  let inDouble = false;
  let inTemplate = false;
  let inLineComment = false;
  let inBlockComment = false;
  while (i < src.length && depth > 0) {
    const ch = src[i];
    const next = src[i + 1];
    if (inLineComment) {
      if (ch === '\n') inLineComment = false;
    } else if (inBlockComment) {
      if (ch === '*' && next === '/') {
        inBlockComment = false;
        i++;
      }
    } else if (inSingle) {
      if (ch === '\\') i++;
      else if (ch === "'") inSingle = false;
    } else if (inDouble) {
      if (ch === '\\') i++;
      else if (ch === '"') inDouble = false;
    } else if (inTemplate) {
      if (ch === '\\') i++;
      else if (ch === '`') inTemplate = false;
    } else {
      if (ch === '/' && next === '/') {
        inLineComment = true;
        i++;
      } else if (ch === '/' && next === '*') {
        inBlockComment = true;
        i++;
      } else if (ch === "'") inSingle = true;
      else if (ch === '"') inDouble = true;
      else if (ch === '`') inTemplate = true;
      else if (ch === '(') depth++;
      else if (ch === ')') {
        depth--;
        if (depth === 0) break;
      }
    }
    i++;
  }
  if (depth !== 0) return src;
  const handler = src.slice(start + marker.length, i);
  let j = i + 1;
  while (j < src.length && (src[j] === ' ' || src[j] === '\t' || src[j] === '\n' || src[j] === '\r')) j++;
  if (src[j] === ';') j++;
  const replacement = `main().catch(${handler}).finally(() => close().catch(() => {})).then(() => process.exit(0));`;
  return src.slice(0, start) + replacement + src.slice(j);
}

module.exports = { runExample };
