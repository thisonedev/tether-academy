'use strict';

// Lessons write plain relative paths ("output/image-gen/cat.png"), so the
// child's cwd decides where they land; never the app directory or course content.

const fs = require('fs');
const os = require('os');
const path = require('path');

const FOLDER_NAME = 'Tether Academy';

/** Narrowly allowlisted in capabilities.cjs: this folder, not Documents. */
function lessonHomeDir(homeDir = os.homedir()) {
  const documents = path.join(homeDir, 'Documents');
  const base = fs.existsSync(documents) ? documents : homeDir;
  return path.join(base, FOLDER_NAME);
}

/** Child cwd for a lesson run. Lesson writes are relative to this. */
function lessonCwd() {
  const dir = lessonHomeDir();
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

/** The shared folder lessons write into, for display and reveal-in-folder. */
function lessonOutputDir(homeDir) {
  return path.join(lessonHomeDir(homeDir), 'output');
}

// writeFileSync fails with ENOENT on a missing parent, so the host precreates these.
function precreateOutputDirs(src, cwd) {
  const patterns = [
    /(outputParametersDir|checkpointSaveDir)\s*:\s*['"]([^'"]+)['"]/g,
    /fs\.writeFileSync\s*\(\s*['"]([^'"]+)['"]/g,
    /\bwriteFileSync\s*\(\s*['"]([^'"]+)['"]/g,
    // Lessons that read a CLI argv or env var but fall back to a chapter-folder
    // default like `const x = process.argv[2] ?? "output/.../file"` still need
    // the default directory pre-created on disk. Restricted to "output/..."
    // literals so a prompt/query/caption default (e.g. `?? "ai"`) isn't
    // mistaken for a path and mkdir'd as a stray sibling of output/.
    /=\s*process\.argv\[\d\]\s*\?\?\s*['"](output\/[^'"]+)['"]/g,
    // Lessons that build a chapter-relative output path at runtime via
    // `const outputDir = "output/...";` (no argv). The `fs.writeFileSync`
    // call further down uses `path.join(outputDir, "file.avi")`, so the
    // string literal here is the only place the directory is named.
    /(?:const|let|var)\s+(?:outputDir|outputPath|outputPrefix|outDir)\s*=\s*['"]([^'"]+)['"]/g,
  ];
  for (const re of patterns) {
    let m;
    while ((m = re.exec(src))) {
      const rel = m[2] || m[1];
      if (!rel) continue;
      const abs = path.isAbsolute(rel) ? rel : path.join(cwd, rel);
      // Containment: a lesson must not mkdir its way out of the workspace.
      if (!path.isAbsolute(rel) && !abs.startsWith(cwd + path.sep)) continue;
      const dir = path.extname(abs) ? path.dirname(abs) : abs;
      try {
        fs.mkdirSync(dir, { recursive: true });
      } catch {
        // best-effort; the lesson reports its own write error
      }
    }
  }
}

// Native-side writes (e.g. finetune checkpoints) never pass through the
// snippet's writeFileSync, so the output folder is diffed across the run instead.
const NOTE_MIN_BYTES = 32 * 1024 * 1024;

/** Every file under the output folder, keyed by path relative to it. */
function snapshotOutputs(cwd) {
  const root = path.join(cwd, 'output');
  const sizes = new Map();
  const stack = [''];
  while (stack.length > 0) {
    const rel = stack.pop();
    let entries;
    try {
      entries = fs.readdirSync(path.join(root, rel), { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      const childRel = rel ? path.join(rel, entry.name) : entry.name;
      if (entry.isDirectory()) {
        stack.push(childRel);
        continue;
      }
      if (!entry.isFile()) continue;
      try {
        sizes.set(childRel, fs.statSync(path.join(root, childRel)).size);
      } catch {
        // vanished mid-scan
      }
    }
  }
  return sizes;
}

function formatBytes(bytes) {
  const mb = bytes / (1024 * 1024);
  return mb >= 1024 ? `${(mb / 1024).toFixed(1)} GB` : `${Math.round(mb)} MB`;
}

/**
 * Run delta per folder (≥32 MB added). Growth + new files both count — a
 * resumed finetune rewrites a checkpoint in place.
 * @param {Map<string, number>} before From snapshotOutputs, taken pre-run.
 * @returns {string} Chunk text to print, empty when there is nothing to report.
 */
function describeNewOutputs(before, cwd) {
  const root = path.join(cwd, 'output');
  const byFolder = new Map();
  for (const [rel, size] of snapshotOutputs(cwd)) {
    const added = size - (before.get(rel) ?? 0);
    if (added <= 0) continue;
    const folder = rel.split(path.sep)[0];
    byFolder.set(folder, (byFolder.get(folder) ?? 0) + added);
  }
  let note = '';
  for (const [folder, bytes] of byFolder) {
    if (bytes < NOTE_MIN_BYTES) continue;
    note +=
      `[output] this run wrote ${formatBytes(bytes)} to ${path.join(root, folder)}. ` +
      `Nothing removes it for you, so delete it when you are done.\n`;
  }
  return note;
}

module.exports = {
  lessonHomeDir,
  lessonCwd,
  lessonOutputDir,
  precreateOutputDirs,
  snapshotOutputs,
  describeNewOutputs,
  formatRunError,
};

// SDK / Node error messages here often include `at func (file:///...node_modules/...)`
// frames; the lesson panel only needs a one-word reason.
function formatRunError(err) {
  if (!err) return 'unknown error';
  const raw = typeof err === 'string' ? err : err.message || String(err);
  const text = String(raw).trim();
  if (!text) return 'unknown error';

  // The QVAC SDK throws an INFERENCE_CANCELLED error pointing into a
  // node_modules path that's not useful in the lesson panel. Collapse it
  // to a short word.
  if (/INFERENCE_CANCELLED|AbortedError|was cancelled before it could complete/i.test(text)) {
    return 'stopped';
  }

  // Lesson snippets install their own uncaughtException filter for these. If
  // one slips through the host shouldn't pass on a stack for it.
  if (/WorkerShutdownError|CHANNEL_CLOSED/.test(text)) {
    return 'runner stopped';
  }

  // Drop trailing frame markers: `at name (file:line:col)`, `at file:line:col`,
  // and backtick file paths left over from the SDK's `at` wrappers. Match
  // anywhere in the message, not just the tail, so partial stacks still shrink.
  return text
    .replace(/\s+at\s+[^\n]+(?:file:\/\/\/|\/)[^\n)]+\)?\s*/g, ' ')
    .replace(/file:\/\/\/\S+/g, '')
    .replace(/\s{2,}/g, ' ')
    .trim()
    .slice(0, 400) || 'unknown error';
}

