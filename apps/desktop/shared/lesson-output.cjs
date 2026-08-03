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

module.exports = {
  lessonHomeDir,
  lessonCwd,
  lessonOutputDir,
  precreateOutputDirs,
};
