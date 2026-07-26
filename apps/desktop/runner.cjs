// @qvac/sdk is ESM-only, so the wrapper is .mjs. Inside Electron's
// CJS main we spawn plain Node via ELECTRON_RUN_AS_NODE=1 and rely
// on the .mjs extension for module type.

const { spawn } = require('node:child_process');
const { mkdtemp, writeFile, rm } = require('node:fs/promises');
const { tmpdir } = require('node:os');
const { join } = require('node:path');
const path = require('node:path');

const MAX_RUNTIME_MS = 5 * 60 * 1000;

// Anchor createRequire to this file (createRequire needs a file path, not a dir) so npm packages resolve from the desktop app's node_modules before the snippet is written to /tmp.
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

async function runExample({ source, language, onChunk }) {
  const isJsLike =
    language === 'javascript' ||
    language === 'typescript' ||
    language === 'tsx' ||
    language === 'jsx';
  if (!isJsLike) {
    return {
      ok: false,
      output: `[runner] language "${language}" is not executable in this shell.`,
    };
  }

  const dir = await mkdtemp(join(tmpdir(), 'ta-run-'));

  // Rewrite every `import ... from "X"` in the lesson source to use
  // absolute paths, so the snippet can run from /tmp/ where there's
  // no node_modules. The lesson's existing @qvac/sdk import is
  // handled the same way as any other npm import; we just additionally
  // inject `close` from the SDK so the wrapper can tear down the
  // bare worker after main() settles.
  const resolvedSource = resolveAllImports(source);
  // Only names from the @qvac/sdk import get re-pulled into the
  // wrapper's forced import line. Names from other packages (e.g.
  // MCP's Client, StdioClientTransport) are already pulled in by
  // the lesson's own rewritten import, no need to re-export.
  const importedNames = extractImportedNames(source);
  const namesForImport = Array.from(new Set([...importedNames, 'close']));
  const importLine = `import { ${namesForImport.join(', ')} } from ${JSON.stringify(parentRequire.resolve('@qvac/sdk'))};\n`;

  // The lesson source ends with `main().catch(console.error);` which
  // kicks off main() and swallows errors. We don't call main()
  // ourselves: doing so re-runs loadModel against a model that's
  // now in the bare worker's registry and throws
  // "MODEL_LOAD_FAILED: already registered". Instead, we hook
  // `.finally(close).then(() => process.exit(0))` onto that
  // existing top-level promise so the SDK tears down after the
  // lesson's own main() settles.
  const hooked = stripForNode(resolvedSource).replace(
    /main\(\)\.catch\(([^)]+)\)(\s*;?)/,
    `main().catch($1).finally(() => close().catch(() => {})).then(() => process.exit(0));`,
  );

  const wrapped = `${importLine}${hooked}\n`;

  // .ts extension so Node's --experimental-strip-types actually runs
  // (it only fires on .ts/.mts/.cts files). The user code mixes real
  // ESM imports with TS type annotations; the stripper drops the type
  // annotations and our pre-pass drops the type-only import lines.
  const file = join(dir, 'snippet.mts');

  try {
    await writeFile(file, wrapped, 'utf-8');
    return await new Promise((resolve) => {
      const child = spawn(
        process.execPath,
        ['--experimental-strip-types', file],
        {
          // Anchor the child to packages/courses/ so relative paths in
          // lesson code like `./examples/qvac/multimodal/cat.png` resolve
          // to the vendored files there. The SDK's cache lives in
          // $HOME/.qvac/ regardless of cwd.
          cwd: path.join(__dirname, '..', '..', 'packages', 'courses'),
          env: {
            ...process.env,
            ELECTRON_RUN_AS_NODE: '1',
            NODE_NO_WARNINGS: '1',
            // Force the SDK to stay quiet on stderr unless something
            // actually fails. The CLI's own progress is the lesson
            // output, not the SDK's internal logging.
            QVAC_LOG_LEVEL: 'warn',
          },
          stdio: ['ignore', 'pipe', 'pipe'],
        },
      );
      let output = '';
      let killed = false;
      const timer = setTimeout(() => {
        killed = true;
        child.kill('SIGTERM');
      }, MAX_RUNTIME_MS);
      child.stdout.on('data', (chunk) => {
        const s = chunk.toString();
        output += s;
        if (onChunk) onChunk(s);
      });
      child.stderr.on('data', (chunk) => {
        const s = chunk.toString();
        output += s;
        if (onChunk) onChunk(s);
      });
      child.on('error', (err) => {
        clearTimeout(timer);
        resolve({ ok: false, output: `[runner] ${err.message}\n${output}` });
      });
      child.on('exit', (code) => {
        clearTimeout(timer);
        if (killed)
          resolve({
            ok: false,
            output: `${output}\n[runner] killed after ${MAX_RUNTIME_MS / 1000}s`,
          });
        else resolve({ ok: code === 0, output });
      });
    });
  } finally {
    rm(dir, { recursive: true, force: true }).catch(() => {});
  }
}

// Pulls the symbol names from `import { ... } from "@qvac/sdk"` so the wrapper only re-exports what the lesson needs.
function extractImportedNames(src) {
  const m = src.match(/^import\s*\{([^}]+)\}\s*from\s*['"]@qvac\/sdk['"]\s*;?/m);
  if (!m) return [];
  return m[1]
    .split(',')
    .map((s) => s.trim().split(/\s+as\s+/)[0].trim())
    .filter(Boolean);
}

// Rewrites npm-package specifiers in `import ... from "X"` to absolute paths so the temp snippet in /tmp can resolve them.
function resolveAllImports(src) {
  return src.replace(
    /(\bimport\s+(?:[\w*\s{},]+\s+from\s+)?|\bexport\s+(?:[\w*\s{},]+\s+from\s+)?)(['"])([^'"]+)\2/g,
    (match, head, quote, spec) => {
      const resolved = resolveImport(spec);
      return resolved === spec ? match : `${head}${quote}${resolved}${quote}`;
    },
  );
}

// Returns [[specifier, [names...]], ...] for every named import, so the wrapper can re-export the symbols the lesson needs.
function extractImportEntries(src) {
  const out = [];
  const re = /^import\s*\{([^}]+)\}\s*from\s*['"]([^'"]+)['"]/gm;
  let m;
  while ((m = re.exec(src))) {
    const names = m[1]
      .split(',')
      .map((s) => s.trim().split(/\s+as\s+/)[0].trim())
      .filter(Boolean);
    out.push([m[2], names]);
  }
  return out;
}

// Strip just enough TypeScript for plain JS parsing. --experimental-strip-types fails on .mjs with mixed type and value imports.
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

module.exports = { runExample };
