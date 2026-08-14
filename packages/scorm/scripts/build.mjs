#!/usr/bin/env node
// Entry point: pnpm generate-scorm --qvac

import { existsSync } from 'node:fs';
import { cp, mkdir, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';
import { createWriteStream } from 'node:fs';
import archiver from 'archiver';
import * as esbuild from 'esbuild';
import { COURSES, CURRICULUM } from '@academy/courses';
import { buildManifest, countLessons } from './lib/manifest.mjs';
import { debracketPaths, patchAbsoluteJsPaths, rewriteHtmlFiles } from './lib/rewrite-static.mjs';

const SCORM_PKG_DIR = path.resolve(fileURLToPath(import.meta.url), '../..');
const REPO_ROOT = path.resolve(SCORM_PKG_DIR, '../..');
const WEB_OUT_DIR = path.join(REPO_ROOT, 'apps/web/out');
const SHIM_FILE_NAME = 'scorm-shim.js';

const SUPPORTED_COURSE_SLUGS = new Set(['qvac']);

const EXCLUDED_ROOT_ENTRIES = new Set([
  'index.html',
  'index.txt',
  'settings',
  '404',
  '404.html',
  'install.sh',
  'device-pairing.png',
  'model-management.png',
  'monaco-editor.png',
  'this-device.png',
]);

function parseCourseSlug(argv) {
  const flag = argv.find((a) => a.startsWith('--'));
  if (!flag) {
    throw new Error('Usage: pnpm generate-scorm --<course-slug> (e.g. pnpm generate-scorm --qvac)');
  }
  return flag.slice(2);
}

function courseLessonHtmlHref(courseSlug, chapterSlug, lessonSlug) {
  return `courses/${courseSlug}/en/${chapterSlug}/${lessonSlug}/index.html`;
}

async function ensureWebBuild() {
  if (process.env.SCORM_SKIP_BUILD === '1') {
    if (!existsSync(WEB_OUT_DIR)) {
      throw new Error(`SCORM_SKIP_BUILD=1 but ${WEB_OUT_DIR} doesn't exist. Run \`pnpm build\` first.`);
    }
    console.log('[scorm] SCORM_SKIP_BUILD=1, reusing existing apps/web/out/');
    return;
  }
  console.log('[scorm] building the web app static export (pnpm build)...');
  execFileSync('pnpm', ['build'], { cwd: REPO_ROOT, stdio: 'inherit' });
}

async function stageOutput(courseSlug) {
  const stagingDir = path.join(SCORM_PKG_DIR, '.staging', courseSlug);
  await rm(stagingDir, { recursive: true, force: true });
  await mkdir(stagingDir, { recursive: true });
  console.log(`[scorm] copying apps/web/out/ -> ${path.relative(REPO_ROOT, stagingDir)}`);
  await cp(WEB_OUT_DIR, stagingDir, {
    recursive: true,
    filter: (src) => {
      if (src.endsWith('.map') || src.endsWith('.DS_Store')) return false;
      if (path.dirname(src) === WEB_OUT_DIR && EXCLUDED_ROOT_ENTRIES.has(path.basename(src))) return false;
      return true;
    },
  });
  return stagingDir;
}

async function buildShim(stagingDir) {
  const result = await esbuild.build({
    entryPoints: [path.join(SCORM_PKG_DIR, 'src/shim.ts')],
    bundle: true,
    format: 'iife',
    target: 'es2018',
    write: false,
    minify: true,
  });
  await writeFile(path.join(stagingDir, SHIM_FILE_NAME), result.outputFiles[0].contents);
}

async function zipDirectory(stagingDir, outFile) {
  await mkdir(path.dirname(outFile), { recursive: true });
  await new Promise((resolve, reject) => {
    const output = createWriteStream(outFile);
    const archive = archiver('zip', { zlib: { level: 9 } });
    output.on('close', resolve);
    archive.on('error', reject);
    archive.pipe(output);
    archive.directory(stagingDir, false);
    archive.finalize();
  });
}

async function main() {
  const courseSlug = parseCourseSlug(process.argv.slice(2));
  const course = COURSES.find((c) => c.slug === courseSlug);
  if (!course) {
    throw new Error(`Unknown course "${courseSlug}". Known courses: ${COURSES.map((c) => c.slug).join(', ')}`);
  }
  if (!SUPPORTED_COURSE_SLUGS.has(courseSlug)) {
    throw new Error(`"${courseSlug}" has no lesson content yet, nothing to package.`);
  }

  await ensureWebBuild();
  const stagingDir = await stageOutput(courseSlug);

  const { patchedFiles, renamedCount } = await debracketPaths(stagingDir);
  console.log(`[scorm] debracketed dynamic-route chunk paths: ${renamedCount} dirs renamed, ${patchedFiles} files patched`);

  console.log(`[scorm] injecting SCORM shim + rewriting asset paths (${countLessons(CURRICULUM)} lessons)...`);
  await buildShim(stagingDir);
  const patchedChunks = await patchAbsoluteJsPaths(stagingDir);
  const rewrittenPages = await rewriteHtmlFiles(stagingDir, { shimFileName: SHIM_FILE_NAME });
  console.log(`[scorm] rewrote ${rewrittenPages} html pages, patched ${patchedChunks} js chunk(s)`);

  console.log('[scorm] generating imsmanifest.xml...');
  const manifestXml = buildManifest(course, CURRICULUM, (chapterSlug, lessonSlug) =>
    courseLessonHtmlHref(courseSlug, chapterSlug, lessonSlug),
  );
  await writeFile(path.join(stagingDir, 'imsmanifest.xml'), manifestXml);

  const outFile = path.join(SCORM_PKG_DIR, 'dist', `tether-academy-${courseSlug}.zip`);
  console.log(`[scorm] zipping -> ${path.relative(REPO_ROOT, outFile)}`);
  await zipDirectory(stagingDir, outFile);

  console.log(`[scorm] done: ${outFile}`);
}

main().catch((err) => {
  console.error(`[scorm] ${err.message}`);
  process.exit(1);
});
