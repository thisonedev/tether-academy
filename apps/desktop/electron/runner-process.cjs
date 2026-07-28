// Pure string-processing for lesson snippets. Reused by:
// - apps/desktop/runner.cjs (writes the wrapped code to a temp file, spawns locally)
// - apps/desktop/electron/main.js (ships the wrapped code to a peer via peer.exec)
// No I/O, no spawning. The caller decides where the code runs.

const { createRequire } = require('node:module');
const path = require('node:path');
const { mkdirSync } = require('node:fs');

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

function buildLesson({ source, cwd }) {
  precreateOutputDirs(source, cwd);
  const resolvedSource = resolveAllImports(source);
  const importedNames = extractImportedNames(source);
  const namesForImport = Array.from(new Set([...importedNames, 'close']));
  const importLine = `import { ${namesForImport.join(', ')} } from ${JSON.stringify(parentRequire.resolve('@qvac/sdk'))};\n`;
  const hooked = hookMainCatch(stripForNode(resolvedSource));
  return `${importLine}${hooked}\n`;
}

module.exports = {
  resolveImport,
  precreateOutputDirs,
  extractImportedNames,
  resolveAllImports,
  stripForNode,
  hookMainCatch,
  buildLesson,
  parentRequire,
};
