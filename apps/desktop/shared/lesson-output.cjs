'use strict';

// Lessons write plain relative paths ("output/image-gen/cat.png"), so the
// child's cwd decides where they land. Not the app directory: peer-exec must
// never modify the app or course content.

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

// writeFileSync fails with ENOENT on a missing parent, so the host creates
// these first. Read from the source, which covers user-edited paths too.
function precreateOutputDirs(src, cwd) {
  const patterns = [
    /(outputParametersDir|checkpointSaveDir)\s*:\s*['"]([^'"]+)['"]/g,
    /fs\.writeFileSync\s*\(\s*['"]([^'"]+)['"]/g,
    /\bwriteFileSync\s*\(\s*['"]([^'"]+)['"]/g,
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

// A lesson that hands a directory to the SDK gets its bytes written by the
// native side, which never passes through the snippet's writeFileSync and so
// never prints a [saved] line. A finetune writes adapter weights plus optimizer
// state to a static path that nothing prunes, so diff the folder across the run
// and name it in the output.
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
 * What the run added, grouped by the folder each lesson owns, and only past a
 * size a person would care about. Growth counts as well as new files: a
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
};
