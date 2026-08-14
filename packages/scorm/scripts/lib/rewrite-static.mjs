import { readFile, writeFile, readdir, rename } from 'node:fs/promises';
import path from 'node:path';

const BLANKET_ROOT_DIRS = ['_next', 'monaco'];

const BRACKET_RENAMES = [
  { from: '%5B...slug%5D', to: 'catchall-slug' },
  { from: '[...slug]', to: 'catchall-slug' },
  { from: '%5Bslug%5D', to: 'slug-dynamic' },
  { from: '[slug]', to: 'slug-dynamic' },
];

const HIDE_AI_CHAT_CSS =
  'div:has(> div > textarea[placeholder*="AI chat is only available"]){display:none!important}';

const HIDE_USER_MENU_CSS =
  '.site-header div:has(button span.bg-emerald-500\\/15){display:none!important}';

// Cross-lesson navigation (bottom Previous/Next, top lesson pills) bypasses the LMS's own
// sequencing, so its own sidebar never learns the current lesson changed. Hidden in favor of
// the LMS's own toolbar/sidebar, which stays in sync because it drives the navigation itself.
const HIDE_LESSON_NAV_CSS = 'nav.sticky.bottom-0{display:none!important}.m-0.flex.list-none.flex-wrap{display:none!important}';

const ROOT_FROM_CURRENT_SCRIPT =
  '(function(){try{var s=document.currentScript;var i=s&&s.src?s.src.indexOf("/_next/"):-1;' +
  'return i>=0?s.src.slice(0,i):""}catch(e){return ""}})()';

const JS_PATCHES = [
  {
    target: '.p="/_next/"',
    replacement: `.p=${ROOT_FROM_CURRENT_SCRIPT}+"/_next/"`,
  },
  {
    target: '"".concat("","/monaco/vs")',
    replacement: `${ROOT_FROM_CURRENT_SCRIPT}+"/monaco/vs"`,
  },
];

async function walk(dir, extFilter) {
  const entries = await readdir(dir, { withFileTypes: true });
  const out = [];
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      out.push(...(await walk(full, extFilter)));
    } else if (extFilter(entry.name)) {
      out.push(full);
    }
  }
  return out;
}

async function walkAllPaths(dir) {
  const entries = await readdir(dir, { withFileTypes: true });
  const out = [];
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    out.push({ full, isDirectory: entry.isDirectory() });
    if (entry.isDirectory()) out.push(...(await walkAllPaths(full)));
  }
  return out;
}

export async function debracketPaths(stagingDir) {
  const textFiles = (await walkAllPaths(stagingDir)).filter(
    (e) => !e.isDirectory && /\.(html|js|txt)$/.test(e.full),
  );
  let patchedFiles = 0;
  for (const { full } of textFiles) {
    const content = await readFile(full, 'utf8');
    let next = content;
    for (const { from, to } of BRACKET_RENAMES) {
      if (next.includes(from)) next = next.replaceAll(from, to);
    }
    if (next !== content) {
      await writeFile(full, next);
      patchedFiles++;
    }
  }

  const dirs = (await walkAllPaths(stagingDir)).filter((e) => e.isDirectory);
  let renamedCount = 0;
  for (const { from, to } of BRACKET_RENAMES) {
    for (const { full } of dirs) {
      if (path.basename(full) !== from) continue;
      await rename(full, path.join(path.dirname(full), to));
      renamedCount++;
    }
  }
  return { patchedFiles, renamedCount };
}

function relativePrefixFor(stagingDir, filePath) {
  const depth = path.relative(stagingDir, path.dirname(filePath)).split(path.sep).filter(Boolean).length;
  return depth === 0 ? '' : '../'.repeat(depth);
}

function lessonKeyFor(stagingDir, filePath) {
  const segments = path.relative(stagingDir, filePath).split(path.sep);
  if (segments.length !== 6 || segments[0] !== 'courses' || segments[2] !== 'en') return null;
  const [, , , chapter, lesson] = segments;
  return `${chapter}-${lesson}`;
}

export async function rewriteHtmlFiles(stagingDir, { shimFileName }) {
  const htmlFiles = await walk(stagingDir, (name) => name.endsWith('.html'));
  for (const file of htmlFiles) {
    const relPrefix = relativePrefixFor(stagingDir, file);
    const lessonKey = lessonKeyFor(stagingDir, file);
    let html = await readFile(file, 'utf8');

    // Order matters: this pass must run before the attribute pass below.
    for (const dir of BLANKET_ROOT_DIRS) html = html.replaceAll(`/${dir}/`, `${relPrefix}${dir}/`);

    html = html.replace(/(href|src)="\/(?!\/)([^"]*)"/g, (_m, attr, rest) => `${attr}="${relPrefix}${rest}"`);

    // Some LMS content servers don't auto-resolve a directory path to its index.html.
    html = html.replace(/href="([^"]*\/)"/g, (m, hrefVal) => {
      if (/^([a-z][a-z0-9+.-]*:)?\/\//i.test(hrefVal) || hrefVal.startsWith('#') || hrefVal.startsWith('mailto:')) return m;
      return `href="${hrefVal}index.html"`;
    });

    const lessonKeyScript = lessonKey ? `window.__SCORM_LESSON_KEY__=${JSON.stringify(lessonKey)};` : '';
    const injected =
      `<style>${HIDE_AI_CHAT_CSS}${HIDE_USER_MENU_CSS}${HIDE_LESSON_NAV_CSS}</style>` +
      `<script>${lessonKeyScript}</script><script src="${relPrefix}${shimFileName}"></script>`;
    html = html.replace(/<body([^>]*)>/, (_m, attrs) => `<body${attrs}>${injected}`);

    await writeFile(file, html);
  }
  return htmlFiles.length;
}

export async function patchAbsoluteJsPaths(stagingDir) {
  const jsFiles = await walk(path.join(stagingDir, '_next'), (name) => name.endsWith('.js'));
  let patched = 0;
  for (const file of jsFiles) {
    const content = await readFile(file, 'utf8');
    const hit = JS_PATCHES.find((p) => content.includes(p.target));
    if (!hit) continue;
    let next = content;
    for (const patch of JS_PATCHES) next = next.replaceAll(patch.target, patch.replacement);
    await writeFile(file, next);
    patched++;
  }
  return patched;
}
