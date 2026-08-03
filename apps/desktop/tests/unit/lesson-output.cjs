'use strict';

// Lesson code writes plain relative paths, so the child's cwd is the
// destination.

const test = require('brittle');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { buildLesson } = require('../../electron/runner-process.cjs');
const {
  lessonHomeDir,
  lessonOutputDir,
  precreateOutputDirs,
  snapshotOutputs,
  describeNewOutputs,
} = require('../../shared/lesson-output.cjs');

const COURSES = path.join(__dirname, '..', '..', '..', '..', 'packages', 'courses');

function tmp(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'academy-out-'));
  t.teardown(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

// Runs the generated preamble's dedupe helper without spawning a child.
function freePathFactory() {
  const built = buildLesson({ source: 'fs.writeFileSync("x.png", 1);\n', cwd: COURSES });
  const body = built.slice(built.indexOf('function __academyFreePath'));
  const src = body.slice(0, body.indexOf('function __academyWriteFile'));
  const make = new Function(
    '__academyMkdir', '__academyExists', '__academyDirname', '__academyExt', '__academyJoin', '__academyBase',
    `${src}; return __academyFreePath;`,
  );
  return make(
    fs.mkdirSync, fs.existsSync, path.dirname, path.extname, path.join, path.basename,
  );
}

test('lesson-output - writes route through the dedupe helper', (t) => {
  const built = buildLesson({
    source: 'import fs from "node:fs";\nfs.writeFileSync("output/cat.png", img);\n',
    cwd: COURSES,
  });
  t.ok(built.includes('__academyWriteFile("output/cat.png"'), 'call site is rewritten');
  t.absent(built.includes('fs.writeFileSync("output/cat.png"'), 'original call is gone');
});

test('lesson-output - a bare writeFileSync import is routed too', (t) => {
  const built = buildLesson({
    source: 'import { writeFileSync } from "node:fs";\nwriteFileSync("a.png", x);\n',
    cwd: COURSES,
  });
  t.ok(built.includes('__academyWriteFile("a.png"'));
});

test('lesson-output - an existing file is never clobbered', (t) => {
  const dir = tmp(t);
  const freePath = freePathFactory();
  const target = path.join(dir, 'cat.png');

  t.is(freePath(target), target, 'first write uses the name as given');

  fs.writeFileSync(target, 'one');
  t.is(freePath(target), path.join(dir, 'cat_1.png'));

  fs.writeFileSync(path.join(dir, 'cat_1.png'), 'two');
  t.is(freePath(target), path.join(dir, 'cat_2.png'));

  t.is(fs.readFileSync(target, 'utf8'), 'one', 'the original is untouched');
});

test('lesson-output - a name with no extension still counts up', (t) => {
  const dir = tmp(t);
  const freePath = freePathFactory();
  const target = path.join(dir, 'checkpoint');
  fs.writeFileSync(target, 'x');
  t.is(freePath(target), path.join(dir, 'checkpoint_1'));
});

test('lesson-output - a missing parent directory is created', (t) => {
  const dir = tmp(t);
  const freePath = freePathFactory();
  const target = path.join(dir, 'output', 'image-gen', 'cat.png');
  t.is(freePath(target), target);
  t.ok(fs.existsSync(path.dirname(target)), 'writeFileSync would otherwise ENOENT');
});

// Fixtures live next to the courses, but the child no longer runs there.
test('lesson-output - fixture reads are made absolute', (t) => {
  const built = buildLesson({
    source: 'const p = "./examples/qvac/image-generation/input/sketch.png";\n',
    cwd: COURSES,
  });
  t.ok(
    built.includes(path.join(COURSES, 'examples/qvac/image-generation/input/sketch.png')),
    'relative fixture path is resolved against the courses dir',
  );
});

test('lesson-output - SDK-owned output dirs are pre-created on the host', (t) => {
  const dir = tmp(t);
  precreateOutputDirs('{ outputParametersDir: "output/finetune/", checkpointSaveDir: "output/finetune/checkpoints/" }', dir);
  t.ok(fs.existsSync(path.join(dir, 'output', 'finetune', 'checkpoints')));
});

test('lesson-output - a lesson cannot mkdir its way out of the workspace', (t) => {
  const dir = tmp(t);
  precreateOutputDirs('fs.writeFileSync("../../escaped/evil.png", x)', dir);
  t.absent(fs.existsSync(path.join(path.dirname(path.dirname(dir)), 'escaped')));
});

// The lesson code only ever says `output/cat.png`, so the run has to announce
// the real location or nobody can find the file.
test('lesson-output - each write announces its absolute path', (t) => {
  const built = buildLesson({ source: 'fs.writeFileSync("output/cat.png", x);\n', cwd: COURSES });
  t.ok(built.includes('console.log("[saved] " + __academyResolve(p))'), 'path is absolute');
});

// Application Support is where this first landed, and it was too hard to find.
test('lesson-output - output lands in a named folder a person can find', (t) => {
  const home = tmp(t);
  t.is(lessonHomeDir(home), path.join(home, 'Tether Academy'), 'no Documents, use home');

  fs.mkdirSync(path.join(home, 'Documents'));
  t.is(lessonHomeDir(home), path.join(home, 'Documents', 'Tether Academy'));
  t.is(lessonOutputDir(home), path.join(home, 'Documents', 'Tether Academy', 'output'));
});

// Checkpoints are written by the addon, so no [saved] line announces them and
// nothing deletes them. The run has to say where the bytes went.
function writeOutput(cwd, rel, bytes) {
  const abs = path.join(cwd, 'output', rel);
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(abs, Buffer.alloc(bytes));
}

test('lesson-output - a large run reports the folder it filled', (t) => {
  const cwd = tmp(t);
  const before = snapshotOutputs(cwd);
  t.is(before.size, 0, 'no output folder yet');

  writeOutput(cwd, path.join('finetune', 'checkpoints', 'step_1', 'optimizer.gguf'), 40 * 1024 * 1024);
  const note = describeNewOutputs(before, cwd);

  t.ok(note.includes(path.join(cwd, 'output', 'finetune')), 'names the folder to delete');
  t.ok(note.includes('40 MB'));
});

test('lesson-output - a small run says nothing', (t) => {
  const cwd = tmp(t);
  const before = snapshotOutputs(cwd);
  writeOutput(cwd, path.join('image-gen', 'cat.png'), 1024);
  t.is(describeNewOutputs(before, cwd), '', 'writeFileSync already logged [saved]');
});

test('lesson-output - files the run did not touch are not counted', (t) => {
  const cwd = tmp(t);
  writeOutput(cwd, path.join('finetune', 'old.gguf'), 40 * 1024 * 1024);
  const before = snapshotOutputs(cwd);
  t.is(describeNewOutputs(before, cwd), '', 'a prior run\'s bytes are its own');
});

// A resumed finetune rewrites a checkpoint at the same path.
test('lesson-output - a file that grew counts as new bytes', (t) => {
  const cwd = tmp(t);
  writeOutput(cwd, path.join('finetune', 'adapter.gguf'), 1024);
  const before = snapshotOutputs(cwd);
  writeOutput(cwd, path.join('finetune', 'adapter.gguf'), 40 * 1024 * 1024);
  t.ok(describeNewOutputs(before, cwd).includes('finetune'));
});

test('lesson-output - the pause/resume lesson leaves periodic checkpoints off', (t) => {
  const dir = path.join(COURSES, 'examples', 'qvac', 'fine-tuning');
  for (const name of ['pause-resume-cancel.starting.ts', 'pause-resume-cancel.answer.ts']) {
    const src = fs.readFileSync(path.join(dir, name), 'utf8');
    // Only pause checkpoints are cleaned up; checkpoint_step_* dirs accumulate.
    t.absent(src.includes('checkpointSaveSteps'), name);
  }
});

test('lesson-output - the sandbox grants the lesson folder, not all of Documents', (t) => {
  const { CAPABILITIES, defaultTemplateVars, expandDeep } = require('../../workers/sandbox/capabilities.cjs');
  const write = expandDeep(CAPABILITIES.qvac, defaultTemplateVars()).fs.write;
  const vars = defaultTemplateVars();

  t.ok(write.includes(vars.lessonDir), 'lesson folder is writable');
  t.absent(write.includes(path.join(os.homedir(), 'Documents')), 'Documents itself is not');
});
