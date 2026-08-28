#!/usr/bin/env node
// lessons-check.mjs: generic upstream-vs-our-code change auditor.
//
// Repo-agnostic: to point it at a different upstream, add an entry to
// PROJECTS below via defineProject(). Everything past PROJECTS is generic.
//
// For the selected project (--project <key>, default 'qvac'): clones/fetches
// the upstream repo(s), resolves a baseline (latest version tag satisfying
// a package.json dep constraint, or --since <tag|sha|date>), extracts the
// SDK surface at baseline and HEAD via the TS compiler API, diffs it into
// EXPORT_*/PARAM_*/TYPE_*/SCHEMA_FIELD_*/FILE_* changes, filters down to
// what's RELEVANT to existing lessons plus NEW OPPORTUNITIES, and writes a
// markdown report plus machine-readable JSON.
//
// Usage:
//   pnpm <name>:check                     # full run, default project+baseline
//   pnpm <name>:check -- --project <key>  # pick a project (see PROJECTS)
//   pnpm <name>:check -- --since <ref>    # override baseline
//   pnpm <name>:check -- --quick          # skip docs site fetch
//   pnpm <name>:check -- --json           # JSON only, no markdown
//
// Output is namespaced per project under temp/lessons-check/<key>/.

import { spawn, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';
import { createHash } from 'node:crypto';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const MONOREPO_ROOT = path.resolve(__dirname, '..', '..', '..');
// Folder (relative to the monorepo root) where generated output is written:
// per project, the report, its JSON twin, run state, and the cached docs
// dump. Gitignored; safe to wipe between runs.
const OUTPUT_DIR_NAME = path.join('temp', 'lessons-check');

// ─── PROJECTS ──────────────────────────────────────────────────────────────
// ────────────────────────────────────────────────────────────────────
// Add a project via defineProject(key, overrides). `key` doubles as the
// lesson/example directory name and the output namespace.
//
// qvac is a monorepo, but not every project is: `repos` is a map of every
// named git repo the project pulls from, and `examplesRepo`/`docsRepo`
// (default 'main') say which one examples/docs live in when they differ.
// Each repo is cloned and baselined independently: a tag in one repo means
// nothing in another.
// ────────────────────────────────────────────────────────────────────

function defineProject(key, cfg) {
  const outDir = path.join(MONOREPO_ROOT, OUTPUT_DIR_NAME, key);
  return {
    key,
    reportMd: path.join(outDir, 'report', 'report.md'),
    reportJson: path.join(outDir, 'report', 'report.json'),
    stateFile: path.join(outDir, 'check-state.json'),
    docsFileCache: path.join(outDir, 'docs', 'full.txt'),
    lessonsRoot: path.join(MONOREPO_ROOT, 'packages', 'courses', 'courses', key, 'en'),
    vendoredRoot: path.join(MONOREPO_ROOT, 'packages', 'courses', 'examples', key),
    // Named git repos: see comment above. Every project needs at least a
    // 'main' entry: { url, baselinePackage, baselineDepName, baselineTagGlob }.
    // baselinePackage/baselineDepName pick the default baseline from a
    // package.json dep constraint (null to require --since every run).
    repos: {},
    examplesRepo: 'main',
    docsRepo: 'main',
    // Optional: docs pages (relative to the docs repo root) that map
    // example files/subdirectories to capability names for chapter
    // attribution. See buildChapterMapFromDocs(). Empty if unset.
    docsCapabilityDirs: [],
    // Optional: release-notes directory (relative to the docs repo root)
    // with a per-version api.md carrying human-written usage snippets. See
    // loadReleaseNoteSnippets(). Null to skip.
    changelogDir: null,
    // Optional: files (relative to the main repo root) backing the "does a
    // lesson already pass this required field" schema-to-loadModel-family
    // linkage. See buildModelConfigSchemaIndex(). Null to skip
    // (qvac-specific pattern; unlikely to transfer to a different upstream
    // as-is).
    modelTypesFile: null,
    loadModelSchemaFile: null,
    ...cfg,
  };
}

const PROJECTS = {
  qvac: defineProject('qvac', {
    project: 'QVAC SDK',
    projectUrl: 'https://docs.qvac.tether.io',
    // Monorepo: SDK source, examples, and docs all live in one repo, so
    // examplesRepo/docsRepo stay at their 'main' default (no override needed).
    repos: {
      main: {
        url: 'https://github.com/tetherto/qvac.git',
        // Null requires --since on every run.
        baselinePackage: path.join(MONOREPO_ROOT, 'apps', 'desktop', 'package.json'),
        baselineDepName: '@qvac/sdk',
        baselineTagGlob: 'sdk-v*',
      },
    },
    // Directory inside the upstream whose files we want to diff and
    // consider for NEW OPPORTUNITIES.
    examplesPathPrefix: 'packages/sdk/examples/',
    // Directory inside the upstream whose files we want to extract as the
    // "SDK surface" (function signatures, types, Zod schemas).
    surfacePathPrefix: 'packages/sdk/',
    // Optional: a single file in the upstream that exports a flat list of
    // uppercase constants (the "model registry"). Set to null to skip.
    modelRegistryFile: 'packages/sdk/models/registry/models.ts',
    // The package's public entry point. Only symbols reachable from here via
    // its re-export chain are actually importable as `@qvac/sdk`'s public API.
    // Used to gate ADD_NEW_API so it doesn't suggest showcasing symbols that
    // are `export`ed from some internal file (making them technically
    // importable via a deep path) but never re-exported to the package root.
    publicEntryFile: 'packages/sdk/index.ts',
    // Optional: where to fetch the docs dump for divergence checking.
    docsLlmsUrl: 'https://docs.qvac.tether.io/llms-full.txt',
    docsCapabilityDirs: ['docs/website/content/docs/ai-capabilities', 'docs/website/content/docs/p2p-capabilities'],
    changelogDir: 'packages/sdk/changelog',
    modelTypesFile: 'packages/sdk/schemas/model-types.ts',
    loadModelSchemaFile: 'packages/sdk/schemas/load-model.ts',
  }),
};
// ─── END PROJECTS ──────────────────────────────────────────────────────────

// ────────────────────────────────────────────────────────────────────
// CLI args and project resolution.
// ────────────────────────────────────────────────────────────────────

const args = new Set(process.argv.slice(2));
const RAW_SINCE = (() => {
  const i = process.argv.indexOf('--since');
  return i >= 0 ? process.argv[i + 1] : null;
})();
const RAW_PROJECT = (() => {
  const i = process.argv.indexOf('--project');
  return i >= 0 ? process.argv[i + 1] : null;
})() ?? 'qvac';
const QUICK = args.has('--quick');
const JSON_ONLY = args.has('--json');

if (!PROJECTS[RAW_PROJECT]) {
  console.error(`[check] unknown project "${RAW_PROJECT}". Known: ${Object.keys(PROJECTS).join(', ')}`);
  process.exit(1);
}
const CONFIG = PROJECTS[RAW_PROJECT];

const STATE_FILE = CONFIG.stateFile;
const REPORT_MD = CONFIG.reportMd;
const REPORT_JSON = CONFIG.reportJson;

// ────────────────────────────────────────────────────────────────────
// report.md is regenerated from scratch every run, which would reset every
// `[x]` back to `[ ]`. Each checkbox row carries a hidden `<!-- id:... -->`
// marker (see box() below); loadCheckedKeys() unions those still checked in
// the previous report.md with check-state.json, so a checked row survives
// the next regen. Unchecking one back off means editing check-state.json.
// ────────────────────────────────────────────────────────────────────

function extractCheckedKeys(text) {
  const keys = new Set();
  const re = /\[x\][^\n]*<!--\s*id:(.+?)\s*-->/gi;
  let m;
  while ((m = re.exec(text))) keys.add(m[1]);
  return keys;
}

function loadCheckedKeys() {
  const keys = new Set();
  try {
    const state = JSON.parse(readFileSync(STATE_FILE, 'utf8'));
    for (const k of state.checkedKeys ?? []) keys.add(k);
  } catch { /* no prior state */ }
  try {
    for (const k of extractCheckedKeys(readFileSync(REPORT_MD, 'utf8'))) keys.add(k);
  } catch { /* no prior report */ }
  return keys;
}

let CHECKED_KEYS = new Set();
const box = (key) => (CHECKED_KEYS.has(key) ? 'x' : ' ');

// ────────────────────────────────────────────────────────────────────
// Repo handles — each bundles a `git` function bound to its clone dir, so
// the rest of the file passes `repo.git` around instead of a module-global.
// ────────────────────────────────────────────────────────────────────

function makeGit(repoDir) {
  return function git(argv) {
    return new Promise((resolve, reject) => {
      const c = spawn('git', ['-C', repoDir, ...argv], { stdio: ['ignore', 'pipe', 'pipe'] });
      let out = '', err = '';
      c.stdout.on('data', (d) => (out += d.toString()));
      c.stderr.on('data', (d) => (err += d.toString()));
      c.on('close', (code) => code === 0 ? resolve(out) : reject(new Error(`git ${argv.join(' ')} -> ${code}: ${err}`)));
    });
  };
}

const repoHandleCache = new Map();

// ────────────────────────────────────────────────────────────────────
// Returns the cached repo handle for `key`, building it from CONFIG.repos on first use.
// ────────────────────────────────────────────────────────────────────

function getRepo(key) {
  if (repoHandleCache.has(key)) return repoHandleCache.get(key);
  const repoCfg = CONFIG.repos[key];
  if (!repoCfg) throw new Error(`[check] project "${CONFIG.key}" has no repos.${key} configured`);
  const dir = path.join(MONOREPO_ROOT, OUTPUT_DIR_NAME, CONFIG.key, 'repos', key);
  const handle = { key, dir, url: repoCfg.url, config: repoCfg, git: makeGit(dir) };
  repoHandleCache.set(key, handle);
  return handle;
}

// ────────────────────────────────────────────────────────────────────
// Clones a repo on first run, fetches on every run after.
// ────────────────────────────────────────────────────────────────────

async function ensureRepo(repo) {
  if (existsSync(path.join(repo.dir, '.git'))) {
    console.error(`[check] ${repo.key} repo exists, fetching...`);
    await repo.git(['fetch', '--tags', '--force', 'origin']);
    return;
  }
  mkdirSync(path.dirname(repo.dir), { recursive: true });
  console.error(`[check] cloning ${repo.key} (${repo.url})...`);
  await new Promise((res, rej) => {
    const c = spawn('git', ['clone', repo.url, repo.dir], { stdio: 'inherit' });
    c.on('close', (code) => code === 0 ? res() : rej(new Error(`clone -> ${code}`)));
  });
  await repo.git(['fetch', '--tags', '--force', 'origin']);
}

// ────────────────────────────────────────────────────────────────────
// Resolves a tag/sha/ISO-date/null ref to a concrete {ref, sha, date}.
// ────────────────────────────────────────────────────────────────────

async function resolveRef(git, ref) {
  // ref can be: a tag, a sha, an ISO date, or null (= HEAD).
  if (!ref) return { ref: 'HEAD', sha: (await git(['rev-parse', 'HEAD'])).trim(), date: (await git(['log', '-1', '--format=%aI', 'HEAD'])).trim() };
  if (/^\d{4}-\d{2}-\d{2}/.test(ref)) {
    const sha = (await git(['log', '-1', '--format=%H', `--since=${ref}`, `--until=${ref}T23:59:59`])).trim();
    if (!sha) throw new Error(`no commit on ${ref}`);
    const date = (await git(['log', '-1', '--format=%aI', sha])).trim();
    return { ref, sha, date };
  }
  try {
    const sha = (await git(['rev-parse', '--verify', `${ref}^{commit}`])).trim();
    const date = (await git(['log', '-1', '--format=%aI', sha])).trim();
    return { ref, sha, date };
  } catch (e) {
    throw new Error(`could not resolve ${ref}: ${e.message}`);
  }
}

// ────────────────────────────────────────────────────────────────────
// Resolves the baseline ref from a package.json dep constraint and the highest satisfying tag.
// ────────────────────────────────────────────────────────────────────

async function baselineFromDep(git, repoCfg) {
  if (!repoCfg.baselinePackage) throw new Error('baselinePackage is null — pass --since=<ref> explicitly');
  const pkg = JSON.parse(readFileSync(repoCfg.baselinePackage, 'utf8'));
  const constraint = (pkg.dependencies ?? pkg.devDependencies ?? {})[repoCfg.baselineDepName];
  if (!constraint) throw new Error(`${repoCfg.baselineDepName} not in ${repoCfg.baselinePackage}`);
  // ^0.15.0 -> [0.15.0, 0.16.0); pick the highest matching tag satisfying it.
  const m = constraint.match(/^[\^~]?\s*(\d+)\.(\d+)\.(\d+)/);
  if (!m) throw new Error(`unparseable constraint: ${constraint}`);
  const [, MAJ, MIN, PAT] = m.map(Number);
  const tags = (await git(['tag', '--list', repoCfg.baselineTagGlob, '--sort=-version:refname'])).trim().split('\n').filter(Boolean);
  // Find the latest tag whose semver matches the constraint floor. Tags can
  // carry any non-digit prefix (sdk-v1.2.3, v1.2.3, release-1.2.3, ...):
  // parseSemver() just finds the first X.Y.Z run, no fixed prefix assumed.
  for (const t of tags) {
    const tm = parseSemver(t);
    if (!tm) continue;
    const [maj, min, pat] = tm;
    if (maj !== MAJ || min !== MIN) continue;
    // ^0.15.0 means >=0.15.0 <0.16.0 in npm semver for 0.x packages; ~0.15.0
    // means the same range. min===MIN is already pinned above, so every
    // patch on that minor satisfies both operators, only the floor matters.
    if (pat < PAT) continue;
    return await resolveRef(git, t);
  }
  throw new Error(`no tag matching ${repoCfg.baselineTagGlob} satisfies ${constraint}`);
}

// ────────────────────────────────────────────────────────────────────
// AST extraction: functions, params, type fields, Zod schemas.
// ────────────────────────────────────────────────────────────────────

function fingerprint(node) {
  // Normalized AST hash, sensitive to any structural statement change,
  // stable across whitespace/comment reformatting.
  const seen = new WeakSet();
  function visit(n) {
    if (!n || typeof n !== 'object') return '';
    if (seen.has(n)) return '';
    seen.add(n);
    if (n.flags & ts.NodeFlags.Synthesized) return '';
    if (n.kind === ts.SyntaxKind.JSDocComment || n.kind === ts.SyntaxKind.JSDoc) return '';
    const kids = n.getChildren ? n.getChildren() : [];
    const out = [ts.SyntaxKind[n.kind]];
    for (const k of kids) {
      if (k.kind === ts.SyntaxKind.SingleLineCommentTrivia ||
          k.kind === ts.SyntaxKind.MultiLineCommentTrivia ||
          k.kind === ts.SyntaxKind.NewLineTrivia ||
          k.kind === ts.SyntaxKind.WhitespaceTrivia ||
          k.kind === ts.SyntaxKind.ShebangTrivia) continue;
      out.push(visit(k));
    }
    return out.join('|');
  }
  return createHash('sha256').update(visit(node)).digest('hex').slice(0, 16);
}

// ────────────────────────────────────────────────────────────────────
// Extracts a function parameter's name/type/optional/default as plain data.
// ────────────────────────────────────────────────────────────────────

function paramShape(p) {
  return {
    name: ts.isIdentifier(p.name) ? p.name.text : p.name.getText(),
    type: p.type ? p.type.getText() : '',
    optional: !!p.questionToken,
    default: p.initializer ? p.initializer.getText() : null,
  };
}

// ────────────────────────────────────────────────────────────────────
// Extracts field/method members from a type literal or interface.
// ────────────────────────────────────────────────────────────────────

function extractTypeMembers(node) {
  if (!node) return [];
  if (ts.isTypeLiteralNode(node)) return extractFromMembers(node.members);
  if (ts.isInterfaceDeclaration(node)) return extractFromMembers(node.members ?? []);
  if (ts.isTypeReferenceNode(node)) {
    // Unwrap `z.infer<typeof fooSchema>`-style references by following the
    // symbol. We don't have cross-file symbol resolution here, so we record
    // the reference name and the extractor also walks Zod schemas
    // independently in extractZodSchemas().
    return [{ kind: 'type-ref', name: node.typeName.getText() }];
  }
  return [];
}

// ────────────────────────────────────────────────────────────────────
// Converts property/method/index signature nodes to plain field data.
// ────────────────────────────────────────────────────────────────────

function extractFromMembers(members) {
  const out = [];
  for (const m of members) {
    if (ts.isPropertySignature(m) && m.name) {
      out.push({ name: m.name.getText(), type: m.type ? m.type.getText() : '', optional: !!m.questionToken, kind: 'field' });
    } else if (ts.isMethodSignature(m) && m.name) {
      out.push({ name: m.name.getText(), params: m.parameters.map(paramShape), returnType: m.type ? m.type.getText() : '', kind: 'method' });
    } else if (ts.isIndexSignature(m)) {
      out.push({ name: '[index]', type: m.type ? m.type.getText() : '', kind: 'index' });
    }
  }
  return out;
}

// Zod methods that wrap validation/docs without changing the object shape.
// Unwrapping them lets the walker find `z.object({...})` buried under
// chains like `.strict().refine(fn).describe('...')`.
const ZOD_TRANSPARENT_WRAPPERS = new Set([
  'strict', 'passthrough', 'partial', 'deepPartial', 'required',
  'refine', 'superRefine', 'transform', 'describe', 'readonly',
  'brand', 'catch', 'default', 'optional', 'nullable', 'nullish', 'meta',
]);

// ────────────────────────────────────────────────────────────────────
// Finds Zod schemas declared as `export const fooSchema = z.object({...})`,
// including ones composed via `.extend()`/`.merge()` on a local base const.
// AST inspection only, no schema instantiation.
//
// Known gap: a function's parameter type isn't generally linked back to the
// schema that validates it (`z.input<typeof fooSchema>`), so a schema-field
// change only attributes to lessons that import the schema by name.
// buildModelConfigSchemaIndex() closes this for one common pattern
// (`loadModel({ modelConfig })` family schemas); nothing else.
// ────────────────────────────────────────────────────────────────────

function extractZodSchemas(filePath, sourceText) {
  const sf = ts.createSourceFile(filePath, sourceText, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  const localSchemas = new Map(); // name -> fields result, in source order
  const schemas = {};
  for (const stmt of sf.statements) {
    if (!ts.isVariableStatement(stmt)) continue;
    const isExport = stmt.modifiers?.some((m) => m.kind === ts.SyntaxKind.ExportKeyword);
    for (const decl of stmt.declarationList.declarations) {
      if (!decl.name || !ts.isIdentifier(decl.name)) continue;
      if (!decl.initializer) continue;
      const fields = walkZodExpr(decl.initializer, localSchemas);
      if (fields) {
        localSchemas.set(decl.name.text, fields);
        if (isExport) schemas[decl.name.text] = { fields, fingerprint: fingerprint(decl.initializer) };
      }
    }
  }
  return schemas;
}

// ────────────────────────────────────────────────────────────────────
// Merges the fields of every schema in a `z.union`/`discriminatedUnion`
// options array. Discriminated-union fields get tagged with the branch's
// discriminant literal (`branch: 'parler'`) so diffSchemaFields() diffs
// same-branch fields instead of merging unrelated branches by field name.
// ────────────────────────────────────────────────────────────────────

function unionFields(arrNode, localSchemas, discriminantKey = null) {
  const out = [];
  for (const el of arrNode.elements) {
    const sub = walkZodExpr(el, localSchemas);
    if (!sub || sub.kind !== 'fields') continue;
    let branch = null;
    if (discriminantKey) {
      const discField = sub.fields.find((f) => f.name === discriminantKey);
      const m = discField?.type.match(/z\.literal\(\s*['"`]([^'"`]+)['"`]\s*\)/);
      if (m) branch = m[1];
    }
    for (const f of sub.fields) out.push(branch ? { ...f, branch } : f);
  }
  return { kind: 'fields', fields: out, discriminantKey };
}

// ────────────────────────────────────────────────────────────────────
// Walks a Zod expression down to its field shape, resolving `.extend()`/`.merge()`/wrapper chains.
// ────────────────────────────────────────────────────────────────────

function walkZodExpr(node, localSchemas) {
  if (!node) return null;
  if (ts.isIdentifier(node)) return localSchemas?.get(node.text) ?? null;
  if (ts.isPropertyAccessExpression(node) && node.name.text === 'shape') {
    return walkZodExpr(node.expression, localSchemas);
  }
  if (ts.isCallExpression(node)) {
    const expr = node.expression;
    const arg = node.arguments[0];
    if (ts.isPropertyAccessExpression(expr)) {
      const method = expr.name.text;
      const receiver = expr.expression;
      if (method === 'extend' || method === 'merge') {
        const base = walkZodExpr(receiver, localSchemas);
        const baseFields = base && base.kind === 'fields' ? base.fields : [];
        // `.extend({...})` takes an object literal; `.merge(otherSchema)`
        // takes a schema reference, resolve either the same way.
        const added = arg && ts.isObjectLiteralExpression(arg)
          ? objectLiteralToFields(arg)
          : walkZodExpr(arg, localSchemas);
        const addedFields = added && added.kind === 'fields' ? added.fields : [];
        const merged = new Map(baseFields.map((f) => [f.name, f]));
        for (const f of addedFields) merged.set(f.name, f);
        return { kind: 'fields', fields: [...merged.values()] };
      }
      if (ZOD_TRANSPARENT_WRAPPERS.has(method)) return walkZodExpr(receiver, localSchemas);
      if (method === 'discriminatedUnion') {
        // `z.discriminatedUnion('key', [...])`: the options array is the
        // *second* argument, not the first (that's the discriminator key).
        const keyArg = node.arguments[0];
        const discriminantKey = keyArg && ts.isStringLiteralLike(keyArg) ? keyArg.text : null;
        const options = node.arguments[1];
        if (options && ts.isArrayLiteralExpression(options)) return unionFields(options, localSchemas, discriminantKey);
      }
      if (method === 'union') {
        if (arg && ts.isArrayLiteralExpression(arg)) return unionFields(arg, localSchemas);
      }
      if (method === 'intersection') {
        // `z.intersection(left, right)` takes two positional schema args,
        // not an array. A value satisfying the intersection has both shapes,
        // so merge them the same way `.extend()`/`.merge()` do.
        const left = walkZodExpr(node.arguments[0], localSchemas);
        const right = walkZodExpr(node.arguments[1], localSchemas);
        const leftFields = left && left.kind === 'fields' ? left.fields : [];
        const rightFields = right && right.kind === 'fields' ? right.fields : [];
        const merged = new Map(leftFields.map((f) => [f.name, f]));
        for (const f of rightFields) merged.set(f.name, f);
        return { kind: 'fields', fields: [...merged.values()] };
      }
    }
    if (arg && ts.isObjectLiteralExpression(arg)) return objectLiteralToFields(arg);
  }
  return null;
}

const ZOD_FIELD_MODIFIERS = new Set(['optional', 'nullable', 'nullish', 'describe', 'default', 'catch', 'readonly', 'brand']);

// ────────────────────────────────────────────────────────────────────
// Walks the full method chain, not just the outermost call. Fields are
// routinely `z.number().optional().describe('...')`, and checking only the
// outermost link misses the `.optional()` in the middle.
// ────────────────────────────────────────────────────────────────────

function fieldFromValueExpr(name, valueExpr) {
  let node = valueExpr;
  let optional = false;
  let nullable = false;
  while (ts.isCallExpression(node) && ts.isPropertyAccessExpression(node.expression) && ZOD_FIELD_MODIFIERS.has(node.expression.name.text)) {
    const method = node.expression.name.text;
    if (method === 'optional' || method === 'nullish') optional = true;
    if (method === 'nullable' || method === 'nullish') nullable = true;
    node = node.expression.expression;
  }
  const type = node.getText();
  return { name, type: nullable ? `${type} | null` : type, optional };
}

// ────────────────────────────────────────────────────────────────────
// Converts an object literal's properties to field records.
// ────────────────────────────────────────────────────────────────────

function objectLiteralToFields(obj) {
  const out = [];
  for (const prop of obj.properties) {
    if (ts.isPropertyAssignment(prop) && prop.name) {
      const name = ts.isIdentifier(prop.name) ? prop.name.text : prop.name.getText();
      out.push(fieldFromValueExpr(name, prop.initializer));
    }
    // Spread properties (`...baseSchema.shape`) aren't resolved here: this
    // function only sees the object literal, not the enclosing file's local
    // schema map. Not observed in this codebase at time of writing.
  }
  return { kind: 'fields', fields: out };
}

export function extractFile(filePath, sourceText) {
  const sf = ts.createSourceFile(filePath, sourceText, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  const result = {
    file: filePath,
    exports: [],
    functions: {},
    consts: {},
    types: {},
    zodSchemas: extractZodSchemas(filePath, sourceText),
  };
  for (const stmt of sf.statements) {
    const isExport = stmt.modifiers?.some((m) => m.kind === ts.SyntaxKind.ExportKeyword);
    if (isExport) {
      if (ts.isFunctionDeclaration(stmt) && stmt.name) {
        const name = stmt.name.text;
        result.exports.push({ kind: 'function', name });
        result.functions[name] = {
          params: stmt.parameters.map(paramShape),
          fingerprint: fingerprint(stmt.body ?? stmt),
        };
        continue;
      }
      if (ts.isVariableStatement(stmt)) {
        for (const decl of stmt.declarationList.declarations) {
          if (decl.name && ts.isIdentifier(decl.name)) {
            const name = decl.name.text;
            const fp = decl.initializer ? fingerprint(decl.initializer) : fingerprint(decl);
            result.exports.push({ kind: 'const', name });
            result.consts[name] = { fingerprint: fp };
          }
        }
        continue;
      }
      if (ts.isTypeAliasDeclaration(stmt) && stmt.name) {
        const name = stmt.name.text;
        result.exports.push({ kind: 'type', name });
        result.types[name] = {
          kind: 'type',
          fingerprint: fingerprint(stmt.type),
          fields: extractTypeMembers(stmt.type),
        };
        continue;
      }
      if (ts.isInterfaceDeclaration(stmt) && stmt.name) {
        const name = stmt.name.text;
        result.exports.push({ kind: 'interface', name });
        result.types[name] = {
          kind: 'interface',
          fingerprint: fingerprint(stmt),
          fields: stmt.members ? extractFromMembers(stmt.members) : [],
        };
        continue;
      }
      if (ts.isClassDeclaration(stmt) && stmt.name) {
        const name = stmt.name.text;
        result.exports.push({ kind: 'class', name });
        result.types[name] = { kind: 'class', fingerprint: fingerprint(stmt) };
        continue;
      }
    }
    if (ts.isExportDeclaration(stmt) && stmt.exportClause) {
      if (stmt.exportClause.kind === ts.SyntaxKind.NamedExports) {
        for (const spec of stmt.exportClause.elements) {
          result.exports.push({ kind: 'reexport', name: spec.name.text, from: stmt.moduleSpecifier?.getText() ?? '' });
        }
      } else if (stmt.exportClause.kind === ts.SyntaxKind.NamespaceExport) {
        result.exports.push({ kind: 'namespace-reexport', name: stmt.exportClause.name.text });
      }
    } else if (ts.isExportDeclaration(stmt) && !stmt.exportClause && stmt.moduleSpecifier) {
      // Bare `export * from './foo'` has no exportClause at all (that's only
      // set for `export { ... } from` or `export * as ns from`). Needed by
      // computePublicSurface() to follow chains like the SDK root's
      // `export * from './models/registry'`.
      result.exports.push({ kind: 'star-reexport', from: stmt.moduleSpecifier.getText() });
    }
  }
  return result;
}

// ────────────────────────────────────────────────────────────────────
// Extracts the SDK surface (exports, functions, types, schemas) for every file at a ref.
// ────────────────────────────────────────────────────────────────────

async function extractRef(git, ref) {
  const files = (await git(['ls-tree', '-r', '--name-only', ref, '--', CONFIG.surfacePathPrefix]))
    .split('\n').filter((f) => f && f.endsWith('.ts') && !f.endsWith('.d.ts') && !f.includes('/test/') && !f.includes('/tests/'));
  const out = {};
  for (const rel of files) {
    try {
      out[rel] = extractFile(rel, (await git(['show', `${ref}:${rel}`])));
    } catch (e) {
      // skip unreadable
    }
  }
  return out;
}

// ────────────────────────────────────────────────────────────────────
// Diff: per-file exports, per-function params, per-type fields,
// per-Zod-schema fields, plus model registry.
// ────────────────────────────────────────────────────────────────────

function diffParams(before, after) {
  const changes = [];
  const bByName = new Map(before.map((p) => [p.name, p]));
  const aByName = new Map(after.map((p) => [p.name, p]));
  for (const [n, b] of bByName) {
    const a = aByName.get(n);
    if (!a) { changes.push({ category: 'PARAM_REMOVED', param: n }); continue; }
    if (b.type !== a.type) changes.push({ category: 'PARAM_RETYPE', param: n, before: b.type, after: a.type });
    if (b.optional !== a.optional) changes.push({ category: 'PARAM_OPTIONAL_TOGGLED', param: n, before: b.optional, after: a.optional });
    if ((b.default ?? null) !== (a.default ?? null)) changes.push({ category: 'PARAM_DEFAULT_CHANGED', param: n, before: b.default, after: a.default });
  }
  for (const [n, a] of aByName) if (!bByName.has(n)) changes.push({ category: 'PARAM_ADDED', param: n, optional: a.optional });
  const bOrder = before.map((p) => p.name);
  const aOrder = after.map((p) => p.name);
  if (bOrder.length === aOrder.length && bOrder.slice().sort().join(',') === aOrder.slice().sort().join(',') && bOrder.join(',') !== aOrder.join(',')) {
    changes.push({ category: 'PARAMS_REORDERED', order: { before: bOrder, after: aOrder } });
  }
  return changes;
}

// ────────────────────────────────────────────────────────────────────
// Diffs two type field lists into TYPE_FIELD_* changes.
// ────────────────────────────────────────────────────────────────────

function diffTypeFields(before, after) {
  const out = [];
  const bByName = new Map(before.filter((f) => f.kind === 'field').map((f) => [f.name, f]));
  const aByName = new Map(after.filter((f) => f.kind === 'field').map((f) => [f.name, f]));
  for (const [n, b] of bByName) if (!aByName.has(n)) out.push({ category: 'TYPE_FIELD_REMOVED', field: n, type: b.type });
  for (const [n, a] of aByName) if (!bByName.has(n)) out.push({ category: 'TYPE_FIELD_ADDED', field: n, type: a.type, optional: a.optional });
  for (const [n, b] of bByName) {
    const a = aByName.get(n);
    if (!a) continue;
    if (b.type !== a.type) out.push({ category: 'TYPE_FIELD_RETYPED', field: n, before: b.type, after: a.type });
    if (b.optional !== a.optional) out.push({ category: 'TYPE_FIELD_OPTIONAL_TOGGLED', field: n, before: b.optional, after: a.optional });
  }
  return out;
}

// ────────────────────────────────────────────────────────────────────
// Diffs two Zod schema field lists into SCHEMA_FIELD_* changes, grouped by
// unionFields()'s `branch` tag first: without that, a brand-new branch's
// field would diff against an unrelated branch's same-named field and read
// as a false retype instead of an addition. Non-union schemas have no
// `branch` tag, so they all fall into one group, same as a flat diff.
// ────────────────────────────────────────────────────────────────────

function groupFieldsByBranch(fields) {
  const map = new Map();
  for (const f of fields) {
    const key = f.branch ?? '';
    if (!map.has(key)) map.set(key, new Map());
    map.get(key).set(f.name, f);
  }
  return map;
}

function diffSchemaFields(before, after) {
  const out = [];
  const bFields = (before?.fields?.kind === 'fields' ? before.fields.fields : []) || [];
  const aFields = (after?.fields?.kind === 'fields' ? after.fields.fields : []) || [];
  const discriminantKey = after?.fields?.discriminantKey ?? before?.fields?.discriminantKey ?? null;
  const bByBranch = groupFieldsByBranch(bFields);
  const aByBranch = groupFieldsByBranch(aFields);
  const branchKeys = new Set([...bByBranch.keys(), ...aByBranch.keys()]);
  for (const branchKey of branchKeys) {
    const bByName = bByBranch.get(branchKey) ?? new Map();
    const aByName = aByBranch.get(branchKey) ?? new Map();
    const branch = branchKey || null;
    for (const [n, b] of bByName) if (!aByName.has(n)) out.push({ category: 'SCHEMA_FIELD_REMOVED', field: n, type: b.type, branch, discriminantKey });
    for (const [n, a] of aByName) if (!bByName.has(n)) out.push({ category: 'SCHEMA_FIELD_ADDED', field: n, type: a.type, optional: a.optional, branch, discriminantKey });
    for (const [n, b] of bByName) {
      const a = aByName.get(n);
      if (!a) continue;
      if (b.type !== a.type) out.push({ category: 'SCHEMA_FIELD_RETYPED', field: n, before: b.type, after: a.type, branch, discriminantKey });
    }
  }
  return out;
}

// ────────────────────────────────────────────────────────────────────
// Diffs two extracted snapshots into the full list of raw changes.
// ────────────────────────────────────────────────────────────────────

function diffSnapshots(before, after) {
  const changes = [];
  const beforeFiles = new Set(Object.keys(before));
  const afterFiles = new Set(Object.keys(after));
  for (const f of beforeFiles) {
    if (!afterFiles.has(f)) { changes.push({ category: 'FILE_REMOVED', file: f }); continue; }
    const b = before[f], a = after[f];
    const bExports = new Map();
    for (const e of b.exports ?? []) if (e?.name) bExports.set(e.name + '|' + e.kind, e);
    const aExports = new Map();
    for (const e of a.exports ?? []) if (e?.name) aExports.set(e.name + '|' + e.kind, e);
    for (const [k, ex] of bExports) if (!aExports.has(k)) changes.push({ category: 'EXPORT_REMOVED', file: f, name: ex.name, kind: ex.kind });
    for (const [k, ex] of aExports) if (!bExports.has(k)) changes.push({ category: 'EXPORT_ADDED', file: f, name: ex.name, kind: ex.kind });
    for (const [name, fn] of Object.entries(b.functions ?? {})) {
      const af = (a.functions ?? {})[name];
      if (!af || af.fingerprint === fn.fingerprint) continue;
      const pc = diffParams(fn.params, af.params);
      if (pc.length > 0) for (const p of pc) changes.push({ category: p.category, file: f, name, ...p });
      else changes.push({ category: 'BODY_CHANGED', file: f, name, before: fn.fingerprint, after: af.fingerprint });
    }
    for (const [name, c] of Object.entries(b.consts ?? {})) {
      const ac = (a.consts ?? {})[name];
      if (!ac || ac.fingerprint === c.fingerprint) continue;
      changes.push({ category: 'CONST_CHANGED', file: f, name, before: c.fingerprint, after: ac.fingerprint });
    }
    for (const [name, t] of Object.entries(b.types ?? {})) {
      const at = (a.types ?? {})[name];
      if (!at) continue;
      if (t.fingerprint !== at.fingerprint) changes.push({ category: 'TYPE_CHANGED', file: f, name, kind: t.kind });
      for (const c of diffTypeFields(t.fields ?? [], at.fields ?? [])) changes.push({ category: c.category, file: f, name, ...c });
    }
    for (const [name, bSch] of Object.entries(b.zodSchemas ?? {})) {
      const aSch = (a.zodSchemas ?? {})[name];
      if (!aSch) continue;
      for (const c of diffSchemaFields(bSch, aSch)) changes.push({ category: c.category, file: f, schema: name, ...c });
    }
  }
  for (const f of afterFiles) if (!beforeFiles.has(f)) changes.push({ category: 'FILE_ADDED', file: f });
  return changes;
}

// ────────────────────────────────────────────────────────────────────
// Diffs the model registry's constant names between two refs.
// ────────────────────────────────────────────────────────────────────

async function diffModelRegistry(git, fromRef, toRef) {
  if (!CONFIG.modelRegistryFile) return { added: [], removed: [] };
  try {
    const before = await git(['show', `${fromRef}:${CONFIG.modelRegistryFile}`]);
    const after = await git(['show', `${toRef}:${CONFIG.modelRegistryFile}`]);
    const extract = (text) => {
      const names = new Set();
      for (const m of text.matchAll(/export\s+const\s+([A-Z][A-Z0-9_]+)\s*[:=]/g)) names.add(m[1]);
      return names;
    };
    const b = extract(before), a = extract(after);
    return { added: [...a].filter((n) => !b.has(n)), removed: [...b].filter((n) => !a.has(n)) };
  } catch (e) {
    return { added: [], removed: [], error: e.message };
  }
}

// ────────────────────────────────────────────────────────────────────
// extractRef() only walks the main repo, so when examples live elsewhere
// this is the only source of their FILE_ADDED/FILE_REMOVED events.
// ────────────────────────────────────────────────────────────────────

async function diffExampleFilesAcrossRepo(git, fromSha, toSha, pathPrefix) {
  const before = new Set((await git(['ls-tree', '-r', '--name-only', fromSha, '--', pathPrefix])).trim().split('\n').filter(Boolean));
  const after = new Set((await git(['ls-tree', '-r', '--name-only', toSha, '--', pathPrefix])).trim().split('\n').filter(Boolean));
  const changes = [];
  for (const f of before) if (!after.has(f)) changes.push({ category: 'FILE_REMOVED', file: f });
  for (const f of after) if (!before.has(f)) changes.push({ category: 'FILE_ADDED', file: f });
  return changes;
}

// ────────────────────────────────────────────────────────────────────
// Lists commits (first-parent) touching CONFIG.examplesPathPrefix between two refs.
// ────────────────────────────────────────────────────────────────────

async function listCommitsTouchingExamples(git, sinceRef, toRef) {
  const log = await git(['log', '--first-parent', '--format=%H|%aI|%s', `${sinceRef}..${toRef}`, '--', CONFIG.examplesPathPrefix]);
  if (!log.trim()) return [];
  return log.trim().split('\n').map((line) => {
    const [sha, date, ...rest] = line.split('|');
    return { sha, date, subject: rest.join('|') };
  });
}

// ────────────────────────────────────────────────────────────────────
// Lists the files a commit touched.
// ────────────────────────────────────────────────────────────────────

async function filesChangedInCommit(git, sha) {
  try {
    return (await git(['show', '--name-only', '--format=', sha])).split('\n').filter(Boolean);
  } catch { return []; }
}

// ────────────────────────────────────────────────────────────────────
// Relevance: which upstream changes matter to the academy. Builds
// relevantPaths (files a lesson references) and coveredExampleFiles
// (example paths already vendored); everything else drops before the report.
// ────────────────────────────────────────────────────────────────────

function walkSync(dir, ext, out = []) {
  let entries;
  try { entries = readdirSync(dir, { withFileTypes: true }); } catch { return out; }
  for (const e of entries) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) walkSync(p, ext, out);
    else if (!ext || p.endsWith(ext)) out.push(p);
  }
  return out;
}

// ────────────────────────────────────────────────────────────────────
// Maps each symbol imported from the package to the vendored files that import it.
// ────────────────────────────────────────────────────────────────────

function harvestImportedSymbols(examplesDir) {
  const imports = new Map();
  const importPattern = new RegExp(`import\\s*\\{([^}]+)\\}\\s*from\\s*['"]${escapeRegExp(CONFIG.repos.main.baselineDepName)}['"]`, 'g');
  for (const f of walkSync(examplesDir, '.answer.ts')) {
    let code;
    try { code = readFileSync(f, 'utf8'); } catch { continue; }
    for (const m of code.matchAll(importPattern)) {
      for (const sym of m[1].split(',')) {
        const name = sym.trim().split(/\s+as\s+/).pop().trim();
        if (!name) continue;
        if (!imports.has(name)) imports.set(name, new Set());
        imports.get(name).add(f);
      }
    }
  }
  return imports;
}

// ────────────────────────────────────────────────────────────────────
// Maps each lesson's `sourceExample` frontmatter value to the lesson file(s) that declare it.
// ────────────────────────────────────────────────────────────────────

function buildLessonIndex(lessonsDir) {
  const upstreamToLessons = new Map();
  for (const f of walkSync(lessonsDir, '.mdx')) {
    if (f.endsWith('index.mdx')) continue;
    let raw;
    try { raw = readFileSync(f, 'utf8'); } catch { continue; }
    const m = raw.match(/^---\r?\n([\s\S]*?)\r?\n---/);
    if (!m) continue;
    const srcEx = m[1].match(/^sourceExample\s*:\s*(.*)$/m);
    if (!srcEx) continue;
    let v = srcEx[1].trim().replace(/^['"]|['"]$/g, '');
    if (!v) continue;
    if (!upstreamToLessons.has(v)) upstreamToLessons.set(v, new Set());
    upstreamToLessons.get(v).add(f);
  }
  return { upstreamToLessons };
}

// ────────────────────────────────────────────────────────────────────
// Resolves a relative import specifier (e.g. `'./client/api'`) against the
// importing file's path to whichever snapshot key it points at
// (`<dir>/api.ts` or `<dir>/api/index.ts`). Returns null for non-relative
// specifiers (external packages) or paths not present in the snapshot.
// ────────────────────────────────────────────────────────────────────

function resolveModuleFile(snapshot, fromFile, rawSpec) {
  const spec = rawSpec.replace(/^['"]|['"]$/g, '');
  if (!spec.startsWith('.')) return null;
  const base = path.posix.normalize(path.posix.join(path.posix.dirname(fromFile), spec));
  if (snapshot[`${base}.ts`]) return `${base}.ts`;
  const indexFile = path.posix.join(base, 'index.ts');
  if (snapshot[indexFile]) return indexFile;
  if (snapshot[base]) return base;
  return null;
}

// ────────────────────────────────────────────────────────────────────
// Symbol names actually importable from the package: reachable from
// CONFIG.publicEntryFile via its re-export chain, transitively. A file
// under CONFIG.surfacePathPrefix using `export` isn't enough on its own:
// plenty of surface files have module-internal exports the package never
// re-exports from its entry point. Without this gate, ADD_NEW_API produced
// lesson content importing symbols the package doesn't actually expose.
// ────────────────────────────────────────────────────────────────────

function computePublicSurface(snapshot, entryFile) {
  const names = new Set();
  const visited = new Set();
  function visitExports(file) {
    if (visited.has(file)) return;
    visited.add(file);
    const data = snapshot[file];
    if (!data) return;
    for (const ex of data.exports ?? []) {
      if (ex.kind === 'reexport') {
        names.add(ex.name);
      } else if (ex.kind === 'star-reexport') {
        const target = resolveModuleFile(snapshot, file, ex.from);
        if (target) visitExports(target);
      } else if (ex.name) {
        names.add(ex.name);
      }
    }
  }
  visitExports(entryFile);
  return names;
}

// ────────────────────────────────────────────────────────────────────
// Maps each exported symbol name to the upstream file(s) that export it.
// ────────────────────────────────────────────────────────────────────

function indexExportsBySnapshot(snapshot) {
  const symbolToFiles = new Map();
  for (const [rel, file] of Object.entries(snapshot)) {
    for (const ex of file.exports ?? []) {
      if (!ex?.name) continue;
      if (!symbolToFiles.has(ex.name)) symbolToFiles.set(ex.name, new Set());
      symbolToFiles.get(ex.name).add(rel);
    }
  }
  return symbolToFiles;
}

// ────────────────────────────────────────────────────────────────────
// Builds the maps that decide which upstream changes are relevant to our lessons.
// ────────────────────────────────────────────────────────────────────

function buildRelevanceIndex(snapshot, opts = {}) {
  const examplesDir = CONFIG.vendoredRoot;
  const lessonsDir = CONFIG.lessonsRoot;
  const { upstreamToLessons } = buildLessonIndex(lessonsDir);

  // For each symbol imported by a vendored .answer.ts, record:
  //   - the set of upstream files that export it (in the current snapshot)
  //   - the set of vendored files that import it, so a change to that
  //     symbol can be attributed to the lesson that actually uses it.
  const importedSymbols = harvestImportedSymbols(examplesDir);
  const symbolToFiles = indexExportsBySnapshot(snapshot);
  const symbolToVendored = importedSymbols; // symbol -> Set<vendored .answer.ts path>

  const symbolToRelevantUpstreamFiles = new Map();
  for (const [sym] of importedSymbols) {
    const files = symbolToFiles.get(sym);
    if (files && files.size > 0) symbolToRelevantUpstreamFiles.set(sym, files);
  }

  const relevantPaths = new Set();
  for (const p of upstreamToLessons.keys()) relevantPaths.add(p);
  for (const files of symbolToRelevantUpstreamFiles.values()) {
    for (const f of files) relevantPaths.add(f);
  }

  // Also add any upstream file whose basename matches a vendored file:
  // catches a moved upstream source before the lesson's frontmatter catches up.
  const vendoredBasenames = new Set();
  for (const f of walkSync(examplesDir, '.answer.ts')) {
    vendoredBasenames.add(path.basename(f, '.answer.ts'));
  }
  if (snapshot) {
    for (const file of Object.keys(snapshot)) {
      if (!file.startsWith(CONFIG.examplesPathPrefix)) continue;
      const base = path.basename(file, '.ts');
      if (vendoredBasenames.has(base)) relevantPaths.add(file);
    }
  }

  const coveredExampleFiles = new Set();
  for (const p of upstreamToLessons.keys()) {
    if (p.startsWith(CONFIG.examplesPathPrefix)) coveredExampleFiles.add(p);
  }

  const publicSurface = computePublicSurface(snapshot, CONFIG.publicEntryFile);

  return {
    relevantPaths,
    coveredExampleFiles,
    symbolToRelevantUpstreamFiles,
    symbolToVendored,
    upstreamToLessons,
    examplesDir,
    publicSurface,
  };
}

// ────────────────────────────────────────────────────────────────────
// Model-config schema linkage: links a `loadModel({ modelConfig })` family
// schema (ttsConfigSchema, ...) to the lessons that pass it, via the shared
// modelType literal — see the comment above buildModelConfigSchemaIndex().
// ────────────────────────────────────────────────────────────────────

function unwrapMethodChain(node) {
  const calls = [];
  let cur = node;
  while (ts.isCallExpression(cur) && ts.isPropertyAccessExpression(cur.expression)) {
    calls.unshift({ method: cur.expression.name.text, args: cur.arguments });
    cur = cur.expression.expression;
  }
  return calls;
}

// ────────────────────────────────────────────────────────────────────
// Strips `as const`/`satisfies X`/parens wrappers, which can stack (`[...] as const satisfies T[]`).
// ────────────────────────────────────────────────────────────────────

function unwrapExpr(node) {
  while (node && (ts.isAsExpression(node) || ts.isSatisfiesExpression(node) || ts.isParenthesizedExpression(node))) {
    node = node.expression;
  }
  return node;
}

// ────────────────────────────────────────────────────────────────────
// Escapes regex special characters in a string.
// ────────────────────────────────────────────────────────────────────

function escapeRegExp(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

// ────────────────────────────────────────────────────────────────────
// Extracts the `ModelType` object's camelCase-key to kebab-case-literal mapping.
// ────────────────────────────────────────────────────────────────────

async function extractModelTypeLiterals(git, toSha) {
  const map = new Map(); // camelCase key -> kebab-case literal, e.g. ttsGgml -> 'tts-ggml'
  let text;
  if (!CONFIG.modelTypesFile) return map;
  try { text = await git(['show', `${toSha}:${CONFIG.modelTypesFile}`]); } catch { return map; }
  const sf = ts.createSourceFile('model-types.ts', text, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  for (const stmt of sf.statements) {
    if (!ts.isVariableStatement(stmt)) continue;
    for (const decl of stmt.declarationList.declarations) {
      if (!decl.name || decl.name.getText() !== 'ModelType' || !decl.initializer) continue;
      let obj = decl.initializer;
      obj = unwrapExpr(obj);
      if (!ts.isObjectLiteralExpression(obj)) continue;
      for (const p of obj.properties) {
        if (ts.isPropertyAssignment(p) && p.name && ts.isStringLiteralLike(p.initializer)) {
          map.set(p.name.getText(), p.initializer.text);
        }
      }
    }
  }
  return map;
}

// ────────────────────────────────────────────────────────────────────
// Extracts which modelType key each modelConfig schema loads under, from `loadBuiltinToRequestSchema`.
// ────────────────────────────────────────────────────────────────────

async function extractSchemaToModelTypeKey(git, toSha) {
  const map = new Map(); // configSchemaName -> ModelType key, e.g. ttsConfigSchema -> ttsGgml
  let text;
  if (!CONFIG.loadModelSchemaFile) return map;
  try { text = await git(['show', `${toSha}:${CONFIG.loadModelSchemaFile}`]); } catch { return map; }
  const sf = ts.createSourceFile('load-model.ts', text, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  for (const stmt of sf.statements) {
    if (!ts.isVariableStatement(stmt)) continue;
    for (const decl of stmt.declarationList.declarations) {
      if (!decl.name || decl.name.getText() !== 'loadBuiltinToRequestSchema' || !decl.initializer) continue;
      const calls = unwrapMethodChain(decl.initializer);
      const unionCall = calls.find((c) => c.method === 'discriminatedUnion');
      const branches = unionCall?.args[1];
      if (!branches || !ts.isArrayLiteralExpression(branches)) continue;
      for (const branch of branches.elements) {
        const branchCalls = unwrapMethodChain(branch);
        const objCall = branchCalls.find((c) => c.method === 'object');
        const transformCall = branchCalls.find((c) => c.method === 'transform');
        const objLit = objCall?.args[0];
        if (!objLit || !ts.isObjectLiteralExpression(objLit)) continue;
        const modelConfigProp = objLit.properties.find((p) => ts.isPropertyAssignment(p) && p.name?.getText() === 'modelConfig');
        if (!modelConfigProp) continue;
        let schemaExpr = modelConfigProp.initializer;
        while (ts.isCallExpression(schemaExpr) && ts.isPropertyAccessExpression(schemaExpr.expression)) {
          schemaExpr = schemaExpr.expression.expression;
        }
        if (!ts.isIdentifier(schemaExpr)) continue;
        const fn = transformCall?.args[0];
        if (!fn || !(ts.isArrowFunction(fn) || ts.isFunctionExpression(fn))) continue;
        let body = fn.body;
        if (ts.isParenthesizedExpression(body)) body = body.expression;
        let returnObj = ts.isObjectLiteralExpression(body) ? body : null;
        if (!returnObj && ts.isBlock(body)) {
          for (const s of body.statements) {
            if (ts.isReturnStatement(s) && s.expression) {
              let e = s.expression;
              if (ts.isParenthesizedExpression(e)) e = e.expression;
              if (ts.isObjectLiteralExpression(e)) { returnObj = e; break; }
            }
          }
        }
        const modelTypeProp = returnObj?.properties.find((p) => ts.isPropertyAssignment(p) && p.name?.getText() === 'modelType');
        const mtInit = modelTypeProp?.initializer;
        if (mtInit && ts.isPropertyAccessExpression(mtInit)) {
          map.set(schemaExpr.text, mtInit.name.getText());
        }
      }
    }
  }
  return map;
}

// ────────────────────────────────────────────────────────────────────
// Maps each explicit `modelType` literal to the vendored files that pass it to `loadModel`.
// ────────────────────────────────────────────────────────────────────

function harvestModelTypeUsage(examplesDir) {
  const usage = new Map(); // modelType literal -> Set<vendored file>
  for (const f of walkSync(examplesDir, '.answer.ts')) {
    let code;
    try { code = readFileSync(f, 'utf8'); } catch { continue; }
    const sf = ts.createSourceFile(f, code, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
    const visit = (node) => {
      if (ts.isCallExpression(node) && ts.isIdentifier(node.expression) && node.expression.text === 'loadModel') {
        for (const arg of node.arguments) {
          if (!ts.isObjectLiteralExpression(arg)) continue;
          const mt = arg.properties.find((p) => ts.isPropertyAssignment(p) && p.name?.getText() === 'modelType');
          if (mt && ts.isStringLiteralLike(mt.initializer)) {
            const lit = mt.initializer.text;
            if (!usage.has(lit)) usage.set(lit, new Set());
            usage.get(lit).add(f);
          }
        }
      }
      ts.forEachChild(node, visit);
    };
    visit(sf);
  }
  return usage;
}

// ────────────────────────────────────────────────────────────────────
// Maps a model constant to its modelType key via the registry's `addon`
// field: covers lessons that pass `modelSrc` without an explicit `modelType`.
// ────────────────────────────────────────────────────────────────────

async function extractModelConstantAddons(git, toSha) {
  const constantToAddon = new Map();
  let text;
  if (!CONFIG.modelRegistryFile) return constantToAddon;
  try { text = await git(['show', `${toSha}:${CONFIG.modelRegistryFile}`]); } catch { return constantToAddon; }
  const sf = ts.createSourceFile('models.ts', text, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  const modelsArrayAddon = new Map(); // raw array index -> addon literal
  for (const stmt of sf.statements) {
    if (!ts.isVariableStatement(stmt)) continue;
    for (const decl of stmt.declarationList.declarations) {
      if (!decl.name || decl.name.getText() !== 'models' || !decl.initializer) continue;
      let arr = decl.initializer;
      arr = unwrapExpr(arr);
      if (!ts.isArrayLiteralExpression(arr)) continue;
      arr.elements.forEach((el, i) => {
        if (!ts.isObjectLiteralExpression(el)) return;
        const p = el.properties.find((pr) => ts.isPropertyAssignment(pr) && pr.name?.getText() === 'addon');
        if (p && ts.isStringLiteralLike(p.initializer)) modelsArrayAddon.set(i, p.initializer.text);
      });
    }
  }
  for (const stmt of sf.statements) {
    if (!ts.isVariableStatement(stmt)) continue;
    const isExport = stmt.modifiers?.some((m) => m.kind === ts.SyntaxKind.ExportKeyword);
    if (!isExport) continue;
    for (const decl of stmt.declarationList.declarations) {
      if (!decl.name || !ts.isIdentifier(decl.name) || decl.name.text === 'models' || !decl.initializer) continue;
      let obj = decl.initializer;
      obj = unwrapExpr(obj);
      if (!ts.isObjectLiteralExpression(obj)) continue;
      const p = obj.properties.find((pr) => ts.isPropertyAssignment(pr) && pr.name?.getText() === 'addon');
      if (!p) continue;
      let addon = null;
      if (ts.isStringLiteralLike(p.initializer)) {
        addon = p.initializer.text;
      } else if (
        ts.isPropertyAccessExpression(p.initializer) && p.initializer.name.text === 'addon' &&
        ts.isElementAccessExpression(p.initializer.expression) &&
        p.initializer.expression.argumentExpression && ts.isNumericLiteral(p.initializer.expression.argumentExpression)
      ) {
        addon = modelsArrayAddon.get(Number(p.initializer.expression.argumentExpression.text)) ?? null;
      }
      if (addon) constantToAddon.set(decl.name.text, addon);
    }
  }
  return constantToAddon;
}

// ────────────────────────────────────────────────────────────────────
// Extracts the registry `addon` family to `ModelType` key mapping from `ModelTypeAliases`.
// ────────────────────────────────────────────────────────────────────

async function extractAddonToModelTypeKey(git, toSha) {
  // addon family (matches registry `addon:` values, e.g. 'tts') -> ModelType camelCase key ('ttsGgml')
  const map = new Map();
  let text;
  if (!CONFIG.modelTypesFile) return map;
  try { text = await git(['show', `${toSha}:${CONFIG.modelTypesFile}`]); } catch { return map; }
  const sf = ts.createSourceFile('model-types.ts', text, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  for (const stmt of sf.statements) {
    if (!ts.isVariableStatement(stmt)) continue;
    for (const decl of stmt.declarationList.declarations) {
      if (!decl.name || decl.name.getText() !== 'ModelTypeAliases' || !decl.initializer) continue;
      let obj = decl.initializer;
      obj = unwrapExpr(obj);
      if (!ts.isObjectLiteralExpression(obj)) continue;
      for (const p of obj.properties) {
        if (!ts.isPropertyAssignment(p) || !p.name) continue;
        const aliasKey = ts.isComputedPropertyName(p.name) && ts.isPropertyAccessExpression(p.name.expression)
          ? p.name.expression.name.text
          : p.name.getText().replace(/^['"]|['"]$/g, '');
        if (aliasKey && ts.isPropertyAccessExpression(p.initializer)) map.set(aliasKey, p.initializer.name.getText());
      }
    }
  }
  return map;
}

// ────────────────────────────────────────────────────────────────────
// symbolToVendored can't do this on its own: lessons never import the config schema by name.
// ────────────────────────────────────────────────────────────────────

async function buildModelConfigSchemaIndex(git, toSha, examplesDir, symbolToVendored) {
  if (!CONFIG.modelTypesFile || !CONFIG.loadModelSchemaFile || !CONFIG.modelRegistryFile) return new Map();
  const modelTypeLiterals = await extractModelTypeLiterals(git, toSha);
  const schemaToModelTypeKey = await extractSchemaToModelTypeKey(git, toSha);
  const modelTypeUsage = harvestModelTypeUsage(examplesDir);
  const constantToAddon = await extractModelConstantAddons(git, toSha);
  const addonToModelTypeKey = await extractAddonToModelTypeKey(git, toSha);

  const modelTypeKeyToConstants = new Map();
  for (const [constant, addon] of constantToAddon) {
    const key = addonToModelTypeKey.get(addon);
    if (!key) continue;
    if (!modelTypeKeyToConstants.has(key)) modelTypeKeyToConstants.set(key, new Set());
    modelTypeKeyToConstants.get(key).add(constant);
  }

  const map = new Map(); // configSchemaName -> Set<vendored file>
  for (const [schemaName, key] of schemaToModelTypeKey) {
    const files = new Set();
    const literal = modelTypeLiterals.get(key);
    for (const f of modelTypeUsage.get(literal) ?? []) files.add(f);
    for (const constant of modelTypeKeyToConstants.get(key) ?? []) {
      for (const f of symbolToVendored.get(constant) ?? []) files.add(f);
    }
    if (files.size) map.set(schemaName, files);
  }
  return map;
}

// ────────────────────────────────────────────────────────────────────
// Classification and partitioning: apply the relevance index to the raw
// diff, split renames from genuine new files, and attribute each change to a lesson.
// ────────────────────────────────────────────────────────────────────

function classifyChange(change, index) {
  if (change.category === 'FILE_ADDED') {
    if (change.file?.startsWith(CONFIG.examplesPathPrefix)) {
      return index.coveredExampleFiles.has(change.file) ? 'relevant' : 'new-example-file';
    }
    return 'drop'; // non-example file additions never matter to lessons
  }
  if (change.category === 'FILE_REMOVED') {
    return (change.file && index.relevantPaths.has(change.file)) ? 'relevant' : 'drop';
  }
  if (change.category === 'EXPORT_ADDED') {
    // A new symbol can't already be imported, so relevance has to come from
    // public-surface membership rather than a lesson-import signal (see
    // computePublicSurface()).
    return index.publicSurface.has(change.name) ? 'relevant' : 'drop';
  }
  // Everything else modifies/removes something that must already exist:
  // if a lesson cares, it's already importing it by name. symbolToVendored
  // is keyed by vendored imports, so unlike a snapshot map it still has
  // symbols upstream just deleted.
  const symbol = change.name ?? change.schema ?? null;
  if (symbol) {
    if (index.symbolToVendored.has(symbol)) return 'relevant';
    if (change.schema && index.modelConfigSchemaToVendored?.has(change.schema)) return 'relevant';
    return 'drop';
  }
  if (change.file && index.relevantPaths.has(change.file)) return 'relevant';
  return 'drop';
}

// ────────────────────────────────────────────────────────────────────
// Splits a change into the report's 'sdk' or 'examples' section by path;
// examples wins if a file is under both prefixes (e.g. re-exports an SDK symbol).
// ────────────────────────────────────────────────────────────────────

function categorizeChange(change) {
  const f = change.file ?? '';
  if (f.startsWith(CONFIG.examplesPathPrefix)) return 'examples';
  return 'sdk';
}

// ────────────────────────────────────────────────────────────────────
// Pairs a FILE_REMOVED with a same-basename FILE_ADDED under a different
// directory and treats it as one rename rather than two unrelated events:
// the lesson's `sourceExample` just needs to point at the new path.
// ────────────────────────────────────────────────────────────────────

function detectRenames(examplesRepoDir, changes, fromSha, toSha) {
  const removed = new Map(); // basename -> [{ file }]
  const added = new Map();
  for (const c of changes) {
    if (c.category !== 'FILE_REMOVED' && c.category !== 'FILE_ADDED') continue;
    if (!c.file?.startsWith(CONFIG.examplesPathPrefix)) continue;
    const base = path.basename(c.file);
    const m = c.category === 'FILE_REMOVED' ? removed : added;
    if (!m.has(base)) m.set(base, []);
    m.get(base).push({ file: c.file });
  }

  // For each basename in both maps, fetch the file content at both refs
  // and decide whether it's a true rename (content near-identical,
  // probably just usage-string updates) or a replacement (content
  // diverges significantly, often the old file was empty/stub and the
  // new file is genuinely new content).
  const renames = [];
  const falseRenames = []; // pairs that look like renames but aren't, surfaced in the report
  for (const [base, removedList] of removed) {
    const addedList = added.get(base);
    if (!addedList) continue;
    for (const r of removedList) {
      for (const a of addedList) {
        if (path.dirname(r.file) === path.dirname(a.file)) continue;
        // Fetch both contents via git show. Failures (file not in
        // tree at this ref) leave content empty.
        const oldContent = fromSha ? safeReadGitFile(examplesRepoDir, fromSha, r.file) : '';
        const newContent = toSha ? safeReadGitFile(examplesRepoDir, toSha, a.file) : '';
        const oldSize = oldContent.length;
        const newSize = newContent.length;
        // Empty old file → this is genuinely a new file, not a rename.
        if (oldSize === 0 && newSize > 0) {
          falseRenames.push({ from: r.file, to: a.file, basename: base, reason: 'old file was empty', oldSize, newSize });
          continue;
        }
        // Compute a quick similarity: fraction of lines that appear in
        // both. Cheap O(n) heuristic; accurate enough for our use.
        const sim = lineSimilarity(oldContent, newContent);
        // High similarity (≥80%) → genuine rename. Lower → replacement.
        if (sim >= 0.8) {
          renames.push({ from: r.file, to: a.file, basename: base, similarity: sim, oldSize, newSize });
        } else {
          falseRenames.push({ from: r.file, to: a.file, basename: base, reason: 'content diverges', similarity: sim, oldSize, newSize });
        }
      }
    }
  }
  return { renames, falseRenames };
}

// ────────────────────────────────────────────────────────────────────
// Reads a file at a git ref, returning '' if it doesn't exist at that ref.
// ────────────────────────────────────────────────────────────────────

function safeReadGitFile(repoDir, sha, filePath) {
  try {
    const r = spawnSync('git', ['-C', repoDir, 'show', `${sha}:${filePath}`], { encoding: 'utf8' });
    return r.status === 0 ? r.stdout : '';
  } catch {
    return '';
  }
}

// ────────────────────────────────────────────────────────────────────
// Cheap line-level Jaccard similarity. Strips blank lines and comments
// before comparing so that whitespace-only diffs don't tank the score.
// ────────────────────────────────────────────────────────────────────

function lineSimilarity(a, b) {
  if (!a && !b) return 1;
  if (!a || !b) return 0;
  const norm = function norm(s) {
    return s.split('\n').map(function (l) { return l.trim(); }).filter(function (l) { return l && !l.startsWith('//') && !l.startsWith('*'); }).join('\n');
  };
  var aN = norm(a), bN = norm(b);
  if (!aN && !bN) return 1;
  var setA = new Set(aN.split('\n'));
  var setB = new Set(bN.split('\n'));
  var inter = 0;
  for (const l of setA) if (setB.has(l)) inter++;
  var union = setA.size + setB.size - inter;
  return union === 0 ? 0 : inter / union;
}

// ────────────────────────────────────────────────────────────────────
// Splits the raw diff into relevant/informational changes, renames, and
// new-lesson opportunities.
// ────────────────────────────────────────────────────────────────────

function partitionChanges(changes, commits, index, examplesRepoDir, examplesFromSha, examplesToSha) {
  const relevant = [];
  const newExampleFiles = new Set();
  const informational = [];
  for (const c of changes) {
    const cls = classifyChange(c, index);
    if (cls === 'relevant') {
      // Demote BODY_*/CONST_*/TYPE_CHANGED unless there's a sibling
      // signature change in the same file+symbol.
      const category = c.category;
      if (category === 'BODY_CHANGED' || category === 'CONST_CHANGED' || category === 'TYPE_CHANGED') {
        const sibling = relevant.some((r) =>
          r.file === c.file && r.name === c.name &&
          (r.category.startsWith('PARAM_') || r.category.startsWith('TYPE_FIELD') || r.category.startsWith('SCHEMA_FIELD'))
        );
        if (!sibling) informational.push(c);
        else relevant.push(c);
      } else {
        relevant.push(c);
      }
    } else if (cls === 'new-example-file') newExampleFiles.add(c.file);
  }

  const { renames: allRenames, falseRenames } = detectRenames(examplesRepoDir, changes, examplesFromSha, examplesToSha);
  // Drop already-synced renames (some lesson's sourceExample already points at `to`).
  const syncedRenames = allRenames.filter((r) => !index.upstreamToLessons.has(r.to));
  const resolvedRenameCount = allRenames.length - syncedRenames.length;
  // Only a real rename if a lesson exists at either path; otherwise it's just a new lesson to build, not a sync.
  const renames = syncedRenames.filter((r) => lessonHintForPath(r.from, index) || lessonHintForPath(r.to, index));

  const relevantCommits = [];
  for (const commit of commits) {
    const files = (commit._files ?? []).filter((f) => f.startsWith(CONFIG.examplesPathPrefix));
    const coveredFiles = files.filter((f) => index.coveredExampleFiles.has(f));
    // Files that aren't covered AND aren't the `to` half of a known rename
    // become new-opportunity files.
    const newOpportunityFiles = files.filter((f) =>
      !index.coveredExampleFiles.has(f) && !renames.some((r) => r.to === f)
    );
    relevantCommits.push({ ...commit, _files: coveredFiles, _newOpportunityFiles: newOpportunityFiles });
  }

  // Build the list of files that are truly "new lessons" (not renames).
  const allNew = [...new Set([...newExampleFiles, ...relevantCommits.flatMap((c) => c._newOpportunityFiles)])]
    .filter((f) => f.startsWith(CONFIG.examplesPathPrefix));

  // A rename where the new path is the only entry per basename gets
  // dropped from newOpportunities: it's already represented as a
  // REPLACE_SOURCE_EXAMPLE action for any lesson that was pointing at
  // the old path.
  const newOpportunities = [];
  const seen = new Set();
  for (const f of allNew.sort()) {
    const base = path.basename(f);
    if (seen.has(base)) continue;
    const altPath = f.includes('/transcription/') ? f.replace('/transcription/', '/asr/') : null;
    if (altPath && allNew.includes(altPath)) continue;
    if (renames.some((r) => r.to === f)) continue;
    seen.add(base);
    newOpportunities.push(f);
  }

  // Strip example FILE_ADDED entries that are a rename's `to` half, so they
  // don't double up as a separate action item. Checked against allRenames,
  // not the narrowed `renames`: a resolved/orphan rename still needs
  // suppressing here even once it's dropped from section 2a.
  const filteredRelevant = relevant.filter((c) => {
    if (c.category !== 'FILE_ADDED') return true;
    if (!c.file?.startsWith(CONFIG.examplesPathPrefix)) return true;
    if (allRenames.some((r) => r.to === c.file)) return false;
    return true;
  });

  // falseRenames: pairs where basename matched but the content diverges.
  // These are NOT renames, just FILE_ADDED with a coincidental basename
  // match against a removed (often empty/stub) file. Re-classify
  // them as FILE_ADDED so they flow into the newOpportunities list.
  for (const fr of falseRenames) {
    newExampleFiles.add(fr.to);
  }

  return {
    relevant: filteredRelevant,
    informational,
    renames,
    falseRenames,
    relevantCommits,
    newOpportunities,
    resolvedRenameCount,
  };
}

// ────────────────────────────────────────────────────────────────────
// Maps an upstream path to the lessons it affects, in priority order:
// 1. exact `sourceExample:` match in a lesson's frontmatter
// 2. a vendored file imports a symbol the path exports (`changeHint`
//    narrows this to the specific symbol that changed, if given)
// 3. basename match against vendored filenames
// ────────────────────────────────────────────────────────────────────

function lessonHintForPath(upstreamPath, index, changeHint = null) {
  // 1. Direct match via sourceExample.
  const exact = index.upstreamToLessons.get(upstreamPath);
  if (exact && exact.size > 0) {
    const lessonsRoot = CONFIG.lessonsRoot;
    return [...exact].map((p) => path.relative(lessonsRoot, p)).join(', ');
  }
  // 2. Symbol-level attribution: which symbol did the change touch, and
  //    which vendored file imports it?
  const examplesDir = index.examplesDir;
  const lessonsRoot = CONFIG.lessonsRoot;
  const lessonHits = new Set();
  function vendoredPathToLesson(vendoredAbs) {
    // Vendored layout: examples/qvac/<chapter>/<basename>.answer.ts
    // Lesson layout:  courses/qvac/en/<chapter>/<basename>.mdx
    const rel = path.relative(examplesDir, vendoredAbs);
    const parts = rel.split(path.sep); // [chapter, basename]
    if (parts.length !== 2) return null;
    const base = parts[1].replace(/\.answer\.ts$/, '');
    return path.join(lessonsRoot, parts[0], `${base}.mdx`);
  }
  if (changeHint?.name) {
    const importers = index.symbolToVendored.get(changeHint.name);
    if (importers) {
      for (const v of importers) {
        const lessonAbs = vendoredPathToLesson(v);
        if (lessonAbs && existsSync(lessonAbs)) lessonHits.add(path.relative(lessonsRoot, lessonAbs));
      }
    }
  } else if (changeHint?.schema) {
    const importers = index.symbolToVendored.get(changeHint.schema) ?? index.modelConfigSchemaToVendored?.get(changeHint.schema);
    if (importers) {
      for (const v of importers) {
        const lessonAbs = vendoredPathToLesson(v);
        if (lessonAbs && existsSync(lessonAbs)) lessonHits.add(path.relative(lessonsRoot, lessonAbs));
      }
    }
  } else {
    // No specific symbol: any vendored file importing anything from this
    // upstream path is potentially affected.
    for (const [sym, files] of index.symbolToRelevantUpstreamFiles) {
      if (!files.has(upstreamPath)) continue;
      const importers = index.symbolToVendored.get(sym);
      if (!importers) continue;
      for (const v of importers) {
        const lessonAbs = vendoredPathToLesson(v);
        if (lessonAbs && existsSync(lessonAbs)) lessonHits.add(path.relative(lessonsRoot, lessonAbs));
      }
    }
  }
  if (lessonHits.size > 0) return [...lessonHits].join(', ');
  // 3. Basename fallback.
  const base = path.basename(upstreamPath, '.ts');
  const hits = [];
  for (const f of walkSync(examplesDir, '.answer.ts')) {
    if (f.endsWith(`${base}.answer.ts`)) hits.push(path.relative(examplesDir, f));
  }
  return hits.length ? hits.join(', ') : null;
}

// ────────────────────────────────────────────────────────────────────
// Docs site divergence (optional, --quick skips this).
// ────────────────────────────────────────────────────────────────────

async function checkDocs(snapshot) {
  const url = CONFIG.docsLlmsUrl;
  let text;
  try {
    const res = await fetch(url);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    text = await res.text();
    mkdirSync(path.dirname(CONFIG.docsFileCache), { recursive: true });
    writeFileSync(CONFIG.docsFileCache, text);
  } catch (e) {
    return { error: e.message, results: [] };
  }
  // Extract fenced blocks
  const blocks = [];
  const lines = text.split('\n');
  let inFence = false, lang = '', buf = [], context = '', start = 0;
  for (let i = 0; i < lines.length; i++) {
    const l = lines[i];
    if (!inFence) {
      const m = l.match(/^```(\w*)/);
      if (m) {
        inFence = true; lang = m[1]; buf = []; start = i + 1;
        for (let j = i - 1; j >= Math.max(0, i - 8); j--) {
          const p = lines[j].trim();
          if (p && (p.startsWith('#') || p.length > 0)) { context = p.slice(0, 120); break; }
        }
      }
    } else if (l.trim().startsWith('```')) {
      blocks.push({ lang, context, code: buf.join('\n'), startLine: start });
      inFence = false; lang = ''; buf = [];
    } else {
      buf.push(l);
    }
  }
  // Group by upstream ref
  const grouped = new Map();
  for (const b of blocks) {
    if (!b.code.includes(CONFIG.repos.main.baselineDepName)) continue;
    const m = b.code.match(new RegExp(`${escapeRegExp(CONFIG.examplesPathPrefix)}[\\w./-]+\\.ts`)) || b.code.match(/examples\/[\w./-]+\.ts/);
    const key = m ? m[0] : '__inline__';
    if (!grouped.has(key)) grouped.set(key, []);
    grouped.get(key).push(b);
  }
  const sig = (code) => {
    const imports = new Set();
    for (const m of code.matchAll(/\b(?:import|export)\s+(?:type\s+)?\{([^}]+)\}/g))
      for (const n of m[1].split(',')) { const c = n.trim().split(/\s+as\s+/).pop(); if (c) imports.add(c); }
    return imports;
  };
  const results = [];
  for (const [ref, grp] of grouped) {
    if (ref === '__inline__') {
      results.push({ kind: 'inline-block', context: grp[0].context, blockCount: grp.length, imports: [...sig(grp[0].code)] });
      continue;
    }
    const fileSnap = snapshot[ref];
    if (!fileSnap) {
      results.push({ kind: 'upstream-ref', upstreamFile: ref, context: grp[0].context, status: 'upstream-missing' });
      continue;
    }
    const upstreamSig = sig(fileSnap.exports.map((e) => e.name).join(' '));
    for (const b of grp) {
      const docSig = sig(b.code);
      const missing = [...docSig].filter((i) => !upstreamSig.has(i));
      results.push({
        kind: 'upstream-ref', upstreamFile: ref, context: b.context,
        imports: [...docSig], missing, status: missing.length === 0 ? 'ok' : 'diverged',
      });
    }
  }
  return { error: null, results };
}

// ────────────────────────────────────────────────────────────────────
// Report rendering.
// ────────────────────────────────────────────────────────────────────

function formatChange(c) {
  switch (c.category) {
    case 'EXPORT_ADDED':
    case 'EXPORT_REMOVED': return `\`${c.name}\` (${c.kind})`;
    case 'FILE_ADDED':
    case 'FILE_REMOVED': return '';
    case 'PARAM_ADDED':
    case 'PARAM_REMOVED': return `\`${c.name}(${c.param})\``;
    case 'PARAM_RETYPE': return `\`${c.name}(${c.param})\` type \`${c.before}\` → \`${c.after}\``;
    case 'PARAM_OPTIONAL_TOGGLED': return `\`${c.name}(${c.param})\` optional \`${c.before}\` → \`${c.after}\``;
    case 'PARAM_DEFAULT_CHANGED': return `\`${c.name}(${c.param})\` default changed`;
    case 'PARAMS_REORDERED': return `\`${c.name}\` params: [${c.order.before.join(', ')}] → [${c.order.after.join(', ')}]`;
    case 'BODY_CHANGED': return `\`${c.name}\` body \`${c.before}\` → \`${c.after}\``;
    case 'CONST_CHANGED': return `\`${c.name}\` \`${c.before}\` → \`${c.after}\``;
    case 'TYPE_CHANGED': return `\`${c.name}\` (${c.kind}) body changed`;
    case 'TYPE_FIELD_ADDED': return `\`${c.name}.${c.field}\` (${c.optional ? 'optional' : 'required'} \`${c.type}\`)`;
    case 'TYPE_FIELD_REMOVED': return `\`${c.name}.${c.field}\``;
    case 'TYPE_FIELD_RETYPED': return `\`${c.name}.${c.field}\` \`${c.before}\` → \`${c.after}\``;
    case 'TYPE_FIELD_OPTIONAL_TOGGLED': return `\`${c.name}.${c.field}\` optional \`${c.before}\` → \`${c.after}\``;
    case 'SCHEMA_FIELD_ADDED': return `\`${c.schema}.shape.${c.field}\` (${c.optional ? 'optional' : 'required'} \`${c.type}\`)`;
    case 'SCHEMA_FIELD_REMOVED': return `\`${c.schema}.shape.${c.field}\``;
    case 'SCHEMA_FIELD_RETYPED': return `\`${c.schema}.shape.${c.field}\` \`${c.before}\` → \`${c.after}\``;
    default: return JSON.stringify(c);
  }
}

const CATEGORY_ORDER = [
  'FILE_ADDED', 'FILE_REMOVED',
  'EXPORT_ADDED', 'EXPORT_REMOVED',
  'SCHEMA_FIELD_ADDED', 'SCHEMA_FIELD_REMOVED', 'SCHEMA_FIELD_RETYPED',
  'TYPE_FIELD_ADDED', 'TYPE_FIELD_REMOVED', 'TYPE_FIELD_RETYPED', 'TYPE_FIELD_OPTIONAL_TOGGLED',
  'PARAM_ADDED', 'PARAM_REMOVED', 'PARAM_RETYPE', 'PARAM_OPTIONAL_TOGGLED', 'PARAM_DEFAULT_CHANGED', 'PARAMS_REORDERED',
  'BODY_CHANGED', 'TYPE_CHANGED', 'CONST_CHANGED',
];

// ────────────────────────────────────────────────────────────────────
// Renders a raw change list as grouped markdown bullets. Unused currently; kept for debugging raw diffs.
// ────────────────────────────────────────────────────────────────────

function renderChanges(changes, opts = {}) {
  const idx = opts.index;
  const grouped = {};
  for (const c of changes) (grouped[c.category] ??= []).push(c);
  const out = [];
  for (const cat of CATEGORY_ORDER) {
    const list = grouped[cat];
    if (!list?.length) continue;
    out.push(`- **${cat}** (${list.length})`);
    for (const c of list.slice(0, 50)) {
      const hintArgs = c.file && idx ? [c.file, idx, c] : null;
        const lesson = opts.withLessonHint && hintArgs ? lessonHintForPath(...hintArgs) : null;
      out.push(`  - \`${c.file ?? ''}\`${c.name ? ` \`${c.name}\`` : ''}${c.schema ? ` \`${c.schema}\`` : ''} — ${formatChange(c)}${lesson ? ` _(lesson: ${lesson})_` : ''}`);
    }
    if (list.length > 50) out.push(`  - _…${list.length - 50} more, see report.json_`);
  }
  // Any unexpected categories
  for (const cat of Object.keys(grouped)) {
    if (CATEGORY_ORDER.includes(cat)) continue;
    out.push(`- **${cat}** (${grouped[cat].length})`);
    for (const c of grouped[cat].slice(0, 10)) out.push(`  - ${formatChange(c)}`);
  }
  return out.join('\n');
}


// ────────────────────────────────────────────────────────────────────
// Derives a plain-English action for a change, tiered 'required'/'verify'/
// 'optional' (tier meanings are spelled out in the report text below).
// `verb` is grep-friendly for the JSON output; `desc` renders in the markdown.
// ────────────────────────────────────────────────────────────────────

function actionForChange(c) {
  switch (c.category) {
    case 'FILE_REMOVED': {
      return { verb: 'REPLACE_SOURCE_EXAMPLE', tier: 'required', desc: `\`${c.file}\` was removed upstream. Find its replacement in the renames table below and point \`sourceExample\` at it.` };
    }
    case 'EXPORT_REMOVED': {
      if (c.kind === 'reexport' || c.kind === 'namespace-reexport') return null;
      // Model registry changes get their own section in Part 5; skip here.
      if (c.file === CONFIG.modelRegistryFile) return { verb: '__SKIP__', desc: '' };
      return { verb: 'UPDATE_FUNCTION_NAME', tier: 'required', desc: `\`${c.name}\` (${c.kind}) was removed from \`${c.file}\`. Update the code sample to stop using it.` };
    }
    case 'EXPORT_ADDED': {
      if (c.kind === 'reexport' || c.kind === 'namespace-reexport') return null;
      if (c.file === CONFIG.modelRegistryFile) return { verb: '__SKIP__', desc: '' };
      if (c.kind === 'function' || c.kind === 'const') {
        return { verb: 'ADD_NEW_API', tier: 'optional', desc: `\`${c.name}\` (${c.kind}) is new in \`${c.file}\`. You could add an example that calls it.` };
      }
      return { verb: 'ADD_NEW_API', tier: 'optional', desc: `\`${c.name}\` (${c.kind}) is new in \`${c.file}\`. It's a supporting type, not something to showcase on its own; it'll show up naturally in an example for whatever function uses it.` };
    }
    case 'PARAM_ADDED': {
      if (c.optional === false) return { verb: 'ADD_PARAM', tier: 'required', desc: `\`${c.name}\` gained a new required parameter \`${c.param}\`. The code sample must now pass it or it will fail.` };
      return { verb: 'ADD_PARAM', tier: 'optional', desc: `\`${c.name}\` gained a new optional parameter \`${c.param}\`. Existing calls that omit it keep working.` };
    }
    case 'PARAM_REMOVED': return { verb: 'REMOVE_PARAM', tier: 'required', desc: `\`${c.name}\` no longer accepts \`${c.param}\`. Remove it from the code sample.` };
    case 'PARAM_RETYPE': return { verb: 'CHANGE_PARAM_TYPE', tier: 'required', desc: `\`${c.name}\`'s \`${c.param}\` parameter changed type: \`${c.before}\` → \`${c.after}\`. Check the code sample still passes a valid value.` };
    case 'PARAM_OPTIONAL_TOGGLED': {
      if (c.before === true && c.after === false) return { verb: 'OPTIONALITY_CHANGED', tier: 'required', desc: `\`${c.name}\`'s \`${c.param}\` parameter is now required (used to be optional). If the code sample omits it, this will now fail.` };
      return { verb: 'OPTIONALITY_CHANGED', tier: 'optional', desc: `\`${c.name}\`'s \`${c.param}\` parameter is now optional (used to be required). You could simplify the example by dropping it.` };
    }
    case 'PARAM_DEFAULT_CHANGED': return { verb: 'CHANGE_PARAM_DEFAULT', tier: 'verify', desc: `\`${c.name}\`'s \`${c.param}\` parameter's default value changed. The code sample's behavior may differ if it relies on the old default.` };
    case 'SCHEMA_FIELD_ADDED': {
      if (c.optional === false) return { verb: 'ADD_SCHEMA_FIELD', tier: 'required', desc: `\`${c.schema}\` gained a new required field \`${c.field}\` (\`${c.type}\`). The code sample must now set it.` };
      return { verb: 'ADD_SCHEMA_FIELD', tier: 'optional', desc: `\`${c.schema}\` gained a new optional field \`${c.field}\` (\`${c.type}\`). Existing code that doesn't set it keeps working.` };
    }
    case 'SCHEMA_FIELD_REMOVED': return { verb: 'REMOVE_SCHEMA_FIELD', tier: 'required', desc: `\`${c.schema}\` lost the field \`${c.field}\`. If the code sample sets it, remove that.` };
    case 'SCHEMA_FIELD_RETYPED': return { verb: 'CHANGE_SCHEMA_FIELD_TYPE', tier: 'required', desc: `\`${c.schema}\`'s \`${c.field}\` field changed type: \`${c.before}\` → \`${c.after}\`. Check the code sample still passes a valid value.` };
    case 'TYPE_FIELD_ADDED': {
      if (c.optional === false) return { verb: 'ADD_TYPE_FIELD', tier: 'required', desc: `\`${c.name}\` gained a new required field \`${c.field}\`. Anywhere the code sample builds this object, it must now include it.` };
      return { verb: 'ADD_TYPE_FIELD', tier: 'optional', desc: `\`${c.name}\` gained a new optional field \`${c.field}\`. Existing code that doesn't set it keeps working.` };
    }
    case 'TYPE_FIELD_REMOVED': return { verb: 'REMOVE_TYPE_FIELD', tier: 'required', desc: `\`${c.name}\` lost the field \`${c.field}\`. If the code sample reads or sets it, remove that.` };
    case 'TYPE_FIELD_RETYPED': return { verb: 'CHANGE_TYPE_FIELD_TYPE', tier: 'required', desc: `\`${c.name}\`'s \`${c.field}\` field changed type: \`${c.before}\` → \`${c.after}\`. Check the code sample still passes a valid value.` };
    case 'BODY_CHANGED': return { verb: 'BODY_CHANGED_INFO', tier: 'verify', desc: `\`${c.name}\` in \`${c.file}\` changed internally; its signature is identical.` };
    case 'CONST_CHANGED': return { verb: 'CONST_CHANGED_INFO', tier: 'verify', desc: `\`${c.name}\` in \`${c.file}\` changed value. Check the code sample still gets the result it expects.` };
    case 'TYPE_CHANGED': return { verb: 'TYPE_CHANGED_INFO', tier: 'verify', desc: `\`${c.name}\` (${c.kind}) in \`${c.file}\` changed.` };
  }
  return null;
}

const TIER_LABEL = { required: '[required]', verify: '[verify]', optional: '[optional]' };
const TIER_ORDER = { required: 0, verify: 1, optional: 2 };

// ────────────────────────────────────────────────────────────────────
// True if a vendored lesson already passes `paramName` at a call site of
// `symbolName`. Only returns true on a positive AST match (object-literal
// arg with the property); positional/spread calls leave the item flagged.
// ────────────────────────────────────────────────────────────────────

function paramAlreadyPassed(symbolName, paramName, index) {
  const importers = index.symbolToVendored.get(symbolName);
  if (!importers) return false;
  for (const vendoredFile of importers) {
    let code;
    try { code = readFileSync(vendoredFile, 'utf8'); } catch { continue; }
    const sf = ts.createSourceFile(vendoredFile, code, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
    let found = false;
    const visit = (node) => {
      if (found) return;
      if (ts.isCallExpression(node)) {
        const callee = node.expression;
        const calleeName = ts.isIdentifier(callee) ? callee.text
          : (ts.isPropertyAccessExpression(callee) ? callee.name.text : null);
        if (calleeName === symbolName) {
          for (const arg of node.arguments) {
            if (ts.isObjectLiteralExpression(arg) && objectLiteralHasProperty(arg, paramName)) {
              found = true;
              break;
            }
          }
        }
      }
      if (!found) ts.forEachChild(node, visit);
    };
    visit(sf);
    if (found) return true;
  }
  return false;
}

// ────────────────────────────────────────────────────────────────────
// True if an object literal has a property (or shorthand) with the given name.
// ────────────────────────────────────────────────────────────────────

function objectLiteralHasProperty(obj, name) {
  return obj.properties.some((p) => {
    if (ts.isPropertyAssignment(p) && p.name) return p.name.getText().replace(/^['"]|['"]$/g, '') === name;
    if (ts.isShorthandPropertyAssignment(p) && p.name) return p.name.text === name;
    return false;
  });
}

// ────────────────────────────────────────────────────────────────────
// Finds the string literal a vendored lesson passes for `key` (e.g.
// `ttsEngine: 'parler'`). Positive AST match only, same as
// paramAlreadyPassed() above. A variable or computed value leaves it null.
// ────────────────────────────────────────────────────────────────────

function findDiscriminantLiteralInFile(vendoredFile, key) {
  let code;
  try { code = readFileSync(vendoredFile, 'utf8'); } catch { return null; }
  const sf = ts.createSourceFile(vendoredFile, code, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  let found = null;
  const visit = (node) => {
    if (found) return;
    if (ts.isPropertyAssignment(node) && node.name && node.name.getText().replace(/^['"]|['"]$/g, '') === key && ts.isStringLiteralLike(node.initializer)) {
      found = node.initializer.text;
      return;
    }
    ts.forEachChild(node, visit);
  };
  visit(sf);
  return found;
}

// ────────────────────────────────────────────────────────────────────
// How the lessons importing `schemaName` use this branch: 'match' if any
// sets `discriminantKey` to `literal`, 'all-differ' if every one positively
// sets it to something else (safe to downgrade), else 'unknown' (stay
// conservative).
// ────────────────────────────────────────────────────────────────────

function classifyDiscriminantUsage(schemaName, discriminantKey, literal, index) {
  const importers = index.symbolToVendored.get(schemaName) ?? index.modelConfigSchemaToVendored?.get(schemaName);
  if (!importers || importers.size === 0) return 'unknown';
  let sawMatch = false, sawUnknown = false;
  for (const vendoredFile of importers) {
    const found = findDiscriminantLiteralInFile(vendoredFile, discriminantKey);
    if (found === literal) sawMatch = true;
    else if (found === null) sawUnknown = true;
  }
  if (sawMatch) return 'match';
  if (sawUnknown) return 'unknown';
  return 'all-differ';
}

// ────────────────────────────────────────────────────────────────────
// Renders the full markdown report from every computed section.
// ────────────────────────────────────────────────────────────────────

function renderReport({ from, to, modelChanges, allChanges, relevant, informational, renames, falseRenames, relevantCommits, newOpportunities, docs, index, docChapterMap, releaseNoteSnippets }) {
  const out = [];
  out.push(`# ${CONFIG.project} change report`);
  out.push('');
  out.push(`_Generated: ${new Date().toISOString()}_`);
  out.push(`_Baseline: \`${from.ref}\` (\`${from.sha.slice(0, 8)}\`, ${from.date.slice(0, 10)})_  ·  _Current: \`${to.ref}\` (\`${to.sha.slice(0, 8)}\`, ${to.date.slice(0, 10)})_`);
  out.push(`_Upstream: ${CONFIG.projectUrl}_`);
  out.push('');
  out.push(`> ${allChanges.length} raw changes in upstream since baseline. ${relevant.length} affect existing lessons. ${newOpportunities.length} new example files could become lessons. ${renames.length} detected renames. ${informational.length} body-only changes flagged as informational.`);
  out.push('');

  // ─── PART 1: SDK changes ──────────────────────────────────────────────
// Two views: (1a) what needs to change in existing lessons, as a
// per-lesson table; (1b) new SDK symbols added but no lesson touches
// them yet, as a plain list (no need for checkboxes).
  const sdkChanges = relevant.filter((c) => categorizeChange(c) === 'sdk');
  out.push(`## 1. SDK changes (${sdkChanges.length})`);
  out.push('');
  out.push('Functions, types, Zod schemas, and model constants in the upstream SDK surface.');
  out.push('');

  // 1a. Per-lesson view: only changes that have a known affected lesson.
  const sdkChangesByLesson = new Map();
  const orphanedSdkChanges = [];
  for (const c of sdkChanges) {
    let action = actionForChange(c);
    if (!action || action.verb === '__SKIP__') continue;
    if (action.verb === 'ADD_PARAM' && action.tier === 'required' && paramAlreadyPassed(c.name, c.param, index)) continue;
    if (c.branch && c.discriminantKey) {
      const usage = classifyDiscriminantUsage(c.schema, c.discriminantKey, c.branch, index);
      const note = ` _(only applies when \`${c.discriminantKey}\` is \`'${c.branch}'\`${usage === 'all-differ' ? " — none of these lessons use that value" : ''})_`;
      action = usage === 'all-differ' && action.tier === 'required'
        ? { ...action, tier: 'optional', desc: action.desc + note }
        : { ...action, desc: action.desc + note };
    }
    const lesson = lessonHintForPath(c.file ?? '', index, c);
    if (lesson) {
      if (!sdkChangesByLesson.has(lesson)) sdkChangesByLesson.set(lesson, []);
      sdkChangesByLesson.get(lesson).push({ change: c, action });
    } else {
      orphanedSdkChanges.push({ change: c, action });
    }
  }

  out.push('Each item below is tagged `[required]`, `[verify]`, or `[optional]`:');
  out.push('- `[required]`: the code sample uses this and the change will break it. Must be fixed.');
  out.push('- `[verify]`: nothing necessarily breaks, but behavior may differ. Worth a quick look or smoke test.');
  out.push('- `[optional]`: purely additive (new function, new optional field). Nothing to fix; only useful if you want to teach it.');
  out.push('');

  out.push(`### 1a. Changes to existing lessons (${sdkChangesByLesson.size} lesson${sdkChangesByLesson.size === 1 ? '' : 's'})`);
  out.push('');
  if (sdkChangesByLesson.size === 0) {
    out.push('_No SDK changes have a known affected lesson._');
  } else {
    // The map key is whatever `lessonHintForPath` returned for the symbol-
    // aware attribution: usually a vendored `.answer.ts` path. Convert to
    // the lesson MDX path before rendering.
    const toMdxPath = (k) => {
      // If the key is already an MDX path, use it as-is.
      if (k.endsWith('.mdx')) return k;
      // If the key is a vendored `.answer.ts` path, derive the MDX.
      if (k.endsWith('.answer.ts')) {
        const rel = path.relative(CONFIG.vendoredRoot, path.join(CONFIG.vendoredRoot, k));
        const parts = rel.split(path.sep);
        if (parts.length === 2) return `${parts[0]}/${parts[1].replace(/\.answer\.ts$/, '.mdx')}`;
      }
      return k;
    };
    for (const [rawKey, items] of [...sdkChangesByLesson.entries()].sort()) {
      const lessonMdx = toMdxPath(rawKey);
      const lessonParts = lessonMdx.split('/');
      const vendoredPath = `examples/${CONFIG.key}/${lessonParts[0]}/${lessonParts[1].replace(/\.mdx$/, '.answer.ts')}`;
      const sorted = [...items].sort((x, y) => TIER_ORDER[x.action.tier] - TIER_ORDER[y.action.tier]);
      const counts = { required: 0, verify: 0, optional: 0 };
      for (const { action } of sorted) counts[action.tier]++;
      const summary = [
        counts.required && `${counts.required} required`,
        counts.verify && `${counts.verify} to verify`,
        counts.optional && `${counts.optional} optional`,
      ].filter(Boolean).join(', ');
      const key = `1a:${rawKey}`;
      out.push(`- [${box(key)}] **${lessonMdx}** _(${summary})_ <!-- id:${key} -->`);
      out.push(`    - Code sample: \`${vendoredPath}\``);
      for (const { change, action } of sorted) {
        out.push(`    - \`${TIER_LABEL[action.tier]}\` ${action.desc}`);
        appendReleaseNoteSnippet(out, '      ', change, releaseNoteSnippets);
      }
    }
    out.push('');
  }

  // 1b. Orphaned SDK changes: new symbols added that no lesson uses.
  out.push(`### 1b. New SDK capabilities no lesson uses yet (${orphanedSdkChanges.length})`);
  out.push('');
  out.push('No existing lesson touches these. Nothing broke, they\'re just new; only relevant if you want a new lesson or example to showcase one.');
  out.push('');
  if (orphanedSdkChanges.length === 0) {
    out.push('_None._');
  } else {
    const sorted = [...orphanedSdkChanges].sort((x, y) => TIER_ORDER[x.action.tier] - TIER_ORDER[y.action.tier]);
    for (const { change, action } of sorted) {
      out.push(`- \`${TIER_LABEL[action.tier]}\` ${action.desc}`);
      appendReleaseNoteSnippet(out, '  ', change, releaseNoteSnippets);
    }
  }
  out.push('');

  // ─── PART 2: Example changes ──────────────────────────────────────────
  out.push(`## 2. Example changes (${renames.length + relevantCommits.reduce((n, c) => n + c._files.length, 0)})`);
  out.push('');
  out.push(`Upstream example files added, removed, renamed, or modified. Each row points at the vendored \`examples/${CONFIG.key}/\` file that needs syncing.`);
  out.push('');

  if (renames.length > 0) {
    out.push(`### 2a. Renames (${renames.length}) — content verified (no new lessons needed)`);
    out.push('');
    out.push('These are confirmed renames: the upstream file was moved from one directory to another but the code is essentially identical (just usage-string updates). Pull the new file and refresh the vendored copy.');
    out.push('');
    for (const r of renames) {
      const lessonAtOld = lessonHintForPath(r.from, index);
      const lessonAtNew = lessonAtOld ?? lessonHintForPath(r.to, index);
      // lessonHintForPath can return either an MDX path or a vendored
      // .answer.ts path; we want the MDX. Convert if needed.
      const lessonMdx = (lessonAtNew ?? '').endsWith('.answer.ts')
        ? lessonAtNew.replace(/\.answer\.ts$/, '.mdx')
        : lessonAtNew;
      const lessonParts = (lessonMdx ?? '').split('/');
      const chapter = lessonParts[0] || '_new_chapter';
      const fromShort = r.from.startsWith(CONFIG.examplesPathPrefix) ? r.from.slice(CONFIG.examplesPathPrefix.length) : r.from;
      const toShort = r.to.startsWith(CONFIG.examplesPathPrefix) ? r.to.slice(CONFIG.examplesPathPrefix.length) : r.to;
      const sim = r.similarity != null ? Math.round(r.similarity * 100) : '?';
      const key = `2a:${r.to}`;
      out.push(`- [${box(key)}] **RENAME** \`${r.basename}\` _(content similarity: ${sim}%)_ <!-- id:${key} -->`);
      out.push(`    - Lesson: ${lessonMdx ? '`' + lessonMdx + '`' : '_(no lesson yet)_'}`);
      out.push(`    - Code sample: \`examples/${CONFIG.key}/${chapter}/${r.basename.replace(/\.ts$/, '.answer.ts')}\`${chapter === '_new_chapter' ? ' _(chapter not yet created)_' : ''}`);
      out.push(`    - Changes needed: update \`sourceExample\` frontmatter from \`${fromShort}\` to \`${toShort}\`; pull the new upstream file and refresh vendored imports/signatures`);
      out.push(`    - Reason: upstream example was moved (the old path was removed; the new path keeps the same lesson functionality under a different directory name)`);
    }
    out.push('');
  }

  if (falseRenames.length > 0) {
    out.push(`### 2b. False renames (${falseRenames.length}) — content diverged, treated as new lessons`);
    out.push('');
    out.push('The basename matched between a removed file and an added file, but the content is too different to call this a rename. Listed here so Dee can verify; the corresponding \`to\` path is also in Section 4 (new chapters).');
    out.push('');
    for (const fr of falseRenames) {
      out.push(`- \`${fr.basename}\` — \`${fr.reason}\` _(similarity: ${fr.similarity != null ? Math.round(fr.similarity * 100) : '?'}%, ${fr.oldSize}→${fr.newSize} bytes)_`);
    }
    out.push('');
  }

  const coveredTouchedFiles = new Set();
  for (const c of relevantCommits) for (const f of c._files) coveredTouchedFiles.add(f);
  // File-level events: FILE_ADDED/FILE_REMOVED in examples/ that aren't renames.
  const exampleFileChanges = relevant.filter((c) =>
    (c.category === 'FILE_ADDED' || c.category === 'FILE_REMOVED') &&
    c.file?.startsWith(CONFIG.examplesPathPrefix)
  );
  if (exampleFileChanges.length > 0 || relevantCommits.length > 0) {
    out.push('### 2b. File-level changes');
    out.push('');
    out.push('| [ ] | Upstream file | Vendored mirror | Change |');
    out.push('| --- | ------------- | ---------------- | ------ |');
    const seen = new Set();
    for (const c of exampleFileChanges) {
      const f = c.file;
      if (seen.has(f)) continue;
      seen.add(f);
      const base = path.basename(f, '.ts');
      const vendored = guessVendoredPath(f);
      const lessonAt = lessonHintForPath(f, index);
      const change = c.category === 'FILE_ADDED' ? 'Added upstream' : 'Removed upstream';
      const key = `2b:${f}`;
      out.push(`| [${box(key)}] | \`${f}\` | \`${vendored}\` | ${change}${lessonAt ? ` _(lesson: ${lessonAt})_` : ''} <!-- id:${key} --> |`);
    }
    out.push('');
  }

  if (relevantCommits.length > 0) {
    out.push('### 2c. Per-commit context');
    out.push('');
    out.push('| Commit | Date | Subject | Files |');
    out.push('| ------ | ---- | ------- | ----- |');
    for (const c of relevantCommits) {
      if (c._files.length === 0 && c._newOpportunityFiles.length === 0) continue;
      out.push(`| \`${c.sha.slice(0, 8)}\` | ${c.date.slice(0, 10)} | ${c.subject} | ${c._files.length} covered, ${c._newOpportunityFiles.length} new |`);
    }
    out.push('');
  }

  // ─── PART 3: Docs changes ─────────────────────────────────────────────
  const docsDiverged = docs?.results.filter((r) => r.status === 'diverged') ?? [];
  const docsMissing = docs?.results.filter((r) => r.status === 'upstream-missing') ?? [];
  out.push(`## 3. Docs changes (${docsDiverged.length + docsMissing.length})`);
  out.push('');
  if (!docs) {
    out.push('_Docs check skipped (--quick). Re-run without --quick to check._');
  } else if (docs.error) {
    out.push(`_Docs check failed: ${docs.error}_`);
  } else if (docsDiverged.length === 0 && docsMissing.length === 0) {
    out.push('_No docs-site code blocks diverge from upstream examples._');
  } else {
    if (docsDiverged.length > 0) {
      out.push('### 3a. Diverged (docs code block references symbols no longer in the upstream example)');
      out.push('');
      out.push('| [ ] | Doc block context | Upstream example | Missing symbols |');
      out.push('| --- | ----------------- | ---------------- | --------------- |');
      for (const d of docsDiverged.slice(0, 30)) {
        const key = `3a:${d.upstreamFile}::${d.context}`;
        out.push(`| [${box(key)}] | ${d.context} | \`${d.upstreamFile}\` | ${(d.missing ?? []).map((m) => '`' + m + '`').join(', ') || '—'} <!-- id:${key} --> |`);
      }
      out.push('');
    }
    if (docsMissing.length > 0) {
      out.push('### 3b. Upstream-missing (docs reference an example that no longer exists)');
      out.push('');
      out.push('| [ ] | Doc block context | Missing upstream file |');
      out.push('| --- | ----------------- | --------------------- |');
      for (const d of docsMissing.slice(0, 30)) {
        const key = `3b:${d.upstreamFile}::${d.context}`;
        out.push(`| [${box(key)}] | ${d.context} | \`${d.upstreamFile}\` <!-- id:${key} --> |`);
      }
      out.push('');
    }
  }

  // ─── PART 4: New chapters (optional) ──────────────────────────────────
  out.push(`## 4. New chapters / optional additions (${newOpportunities.length})`);
  out.push('');
  out.push('Upstream example files that have no matching vendored copy. Each row proposes where a new lesson would live.');
  out.push('');
  if (newOpportunities.length === 0) {
    out.push('_No new example files since the baseline. Nothing to add._');
  } else {
    for (const f of newOpportunities) {
      const chapter = chapterGuess(f, docChapterMap);
      const base = path.basename(f, '.ts');
      const key = `4:${f}`;
      out.push(`- [${box(key)}] **NEW LESSON** \`${chapter}/${base}.mdx\` <!-- id:${key} -->`);
      out.push(`    - Lesson: \`${chapter}/${base}.mdx\` (chapter: \`${chapter}\`)`);
      out.push(`    - Code sample: \`examples/${CONFIG.key}/${chapter}/${base}.answer.ts\``);
      out.push(`    - Changes needed: create the lesson MDX and the vendored \`.answer.ts\`; mirror \`${f}\``);
      out.push(`    - Reason: new upstream example with no vendored counterpart yet — fills a gap in the \`${chapter}\` chapter`);
    }
  }
  out.push('');

  // ─── PART 5: Model registry ───────────────────────────────────────────
  // One sentence per direction: comma-separated constant lists. Saves
  // ~150 lines vs. one-line-per-constant in the 48/109 case.
  if (modelChanges.added.length || modelChanges.removed.length) {
    out.push(`## 5. Model registry (${CONFIG.modelRegistryFile})`);
    out.push('');
    if (modelChanges.added.length) {
      out.push(`**Added models (${modelChanges.added.length}):** ${modelChanges.added.map((m) => '`' + m + '`').join(', ')}.`);
      out.push('');
    }
    if (modelChanges.removed.length) {
      out.push(`**Removed models (${modelChanges.removed.length}):** ${modelChanges.removed.map((m) => '`' + m + '`').join(', ')}.`);
      out.push('');
    }
  }

  // ─── PART 6: Informational (body-only, no signature drift) ────────────
  // Group by upstream file. One row per file, listing the symbols whose
  // body changed but signature didn't. These are *not* action items.
  if (informational.length > 0) {
    out.push(`## 6. Informational (${informational.length})`);
    out.push('');
    out.push('Body fingerprint changed but the function/type signature is identical. Lessons probably still work, but a smoke run is cheap insurance. Not action items.');
    out.push('');
    // Group by file, keep insertion order of first occurrence.
    const byFile = new Map();
    for (const c of informational) {
      const f = c.file ?? '(unknown)';
      if (!byFile.has(f)) byFile.set(f, []);
      byFile.get(f).push(c);
    }
    out.push('| Upstream | Symbols whose body changed (signature identical) |');
    out.push('|----------|---------------------------------------------------|');
    for (const [f, items] of byFile) {
      const shortPath = f.startsWith(CONFIG.surfacePathPrefix) ? f.slice(CONFIG.surfacePathPrefix.length) : f;
      const symbols = items.map((c) => '`' + (c.name ?? c.schema ?? '?') + '`').join(', ');
      out.push(`| \`${shortPath}\` | ${symbols} |`);
    }
    out.push('');
  }

  // ─── PART 7: Per-commit trail (covered) ───────────────────────────────
  const coveredTouchedCommits = relevantCommits.filter((c) => c._files.length > 0);
  if (coveredTouchedCommits.length > 0) {
    out.push(`## 7. Per-commit trail (${coveredTouchedCommits.length})`);
    out.push('');
    out.push('For traceability: every commit since baseline that touched a covered example file.');
    out.push('');
    out.push('| Commit | Date | Subject | Files changed |');
    out.push('| ------ | ---- | ------- | ------------- |');
    for (const c of coveredTouchedCommits) {
      const files = c._files.map((f) => '\`' + path.basename(f) + '\`').slice(0, 6).join(', ');
      const more = c._files.length > 6 ? `, +${c._files.length - 6} more` : '';
      out.push(`| \`${c.sha.slice(0, 8)}\` | ${c.date.slice(0, 10)} | ${c.subject} | ${files}${more} |`);
    }
    out.push('');
  }

  out.push('---');
  out.push('');
  out.push(`Re-run: \`node scripts/lessons-check.mjs --project ${CONFIG.key}\`. Override baseline: \`--since <ref>\`. Skip docs: \`--quick\`.`);
  out.push('');
  return out.join('\n');
}

// ────────────────────────────────────────────────────────────────────
// Matches an upstream example file to its vendored .answer.ts by basename;
// falls back to proposing the same relative path under CONFIG.vendoredRoot.
// ────────────────────────────────────────────────────────────────────

function guessVendoredPath(upstreamFile) {
  const base = path.basename(upstreamFile, '.ts');
  for (const f of walkSync(CONFIG.vendoredRoot, '.answer.ts')) {
    if (f.endsWith(`${base}.answer.ts`)) return path.relative(CONFIG.vendoredRoot, f);
  }
  // No existing vendored copy. Propose a path mirroring the upstream layout.
  const rel = upstreamFile.replace(CONFIG.examplesPathPrefix, '');
  return rel;
}

// ────────────────────────────────────────────────────────────────────
// Chapter map derived from upstream's own docs rather than hand-maintained
// prefix rules: each CONFIG.docsCapabilityDirs page references the example
// files/subdirs for its capability, and our chapter names mirror those
// slugs 1:1. A subdir claimed by more than one doc page is left unmapped;
// chapterGuess() falls back to basename prefixes for anything undocumented.
// ────────────────────────────────────────────────────────────────────

async function buildChapterMapFromDocs(git, toSha) {
  const exactFileToSlug = new Map();
  const subdirCounts = new Map(); // subdir -> Map<slug, count>
  const refPattern = new RegExp(`${escapeRegExp(CONFIG.examplesPathPrefix)}([A-Za-z0-9_./-]+)\\.ts`, 'g');
  for (const dir of CONFIG.docsCapabilityDirs) {
    let files;
    try {
      files = (await git(['ls-tree', '-r', '--name-only', toSha, '--', dir])).trim().split('\n').filter((f) => f.endsWith('.mdx'));
    } catch { continue; }
    for (const f of files) {
      const slug = path.basename(f, '.mdx');
      let text;
      try { text = await git(['show', `${toSha}:${f}`]); } catch { continue; }
      const refs = new Set([...text.matchAll(refPattern)].map((m) => `${CONFIG.examplesPathPrefix}${m[1]}.ts`));
      for (const ref of refs) {
        exactFileToSlug.set(ref, slug);
        const rel = ref.slice(CONFIG.examplesPathPrefix.length);
        const parts = rel.split('/');
        if (parts.length > 1) {
          const subdir = parts[0];
          if (!subdirCounts.has(subdir)) subdirCounts.set(subdir, new Map());
          const counts = subdirCounts.get(subdir);
          counts.set(slug, (counts.get(slug) ?? 0) + 1);
        }
      }
    }
  }
  const subdirToSlug = new Map();
  for (const [subdir, slugCounts] of subdirCounts) {
    if (slugCounts.size === 1) subdirToSlug.set(subdir, [...slugCounts.keys()][0]);
  }
  return { exactFileToSlug, subdirToSlug };
}

// ────────────────────────────────────────────────────────────────────
// Extracts the first X.Y.Z run from a string as [major, minor, patch].
// ────────────────────────────────────────────────────────────────────

function parseSemver(s) {
  const m = String(s).match(/(\d+)\.(\d+)\.(\d+)/);
  return m ? [Number(m[1]), Number(m[2]), Number(m[3])] : null;
}

// ────────────────────────────────────────────────────────────────────
// True if semver tuple `a` is greater than `b`.
// ────────────────────────────────────────────────────────────────────

function semverGt(a, b) {
  for (let i = 0; i < 3; i++) { if (a[i] !== b[i]) return a[i] > b[i]; }
  return false;
}

// ────────────────────────────────────────────────────────────────────
// CONFIG.changelogDir/<version>/api.md carries a human-written usage
// snippet per API-affecting PR, a supplement since coverage isn't
// guaranteed (fixes/chores rarely get one). Skips if the baseline isn't a
// parseable version ref (e.g. a raw --since sha), with no range to scan.
// ────────────────────────────────────────────────────────────────────

async function loadReleaseNoteSnippets(git, fromRef, toSha) {
  if (!CONFIG.changelogDir) return [];
  const baseline = parseSemver(fromRef);
  if (!baseline) return [];
  let files;
  try {
    files = (await git(['ls-tree', '-r', '--name-only', toSha, '--', CONFIG.changelogDir]))
      .trim().split('\n').filter((f) => f.endsWith('/api.md'));
  } catch { return []; }
  const versions = [...new Set(files.map((f) => f.slice(CONFIG.changelogDir.length + 1).split('/')[0]))]
    .filter((v) => { const s = parseSemver(v); return s && semverGt(s, baseline); });

  const snippets = [];
  for (const version of versions) {
    let text;
    try { text = await git(['show', `${toSha}:${CONFIG.changelogDir}/${version}/api.md`]); } catch { continue; }
    for (const entry of text.split(/\n---\n/)) {
      const titleMatch = entry.match(/^##\s+(.+)$/m);
      const prMatch = entry.match(/PR:\s*\[#(\d+)\]\((\S+)\)/);
      const codeMatch = entry.match(/```\w*\n([\s\S]*?)```/);
      if (!titleMatch || !codeMatch) continue;
      snippets.push({
        version,
        title: titleMatch[1].trim(),
        prNumber: prMatch?.[1] ?? null,
        prUrl: prMatch?.[2] ?? null,
        code: codeMatch[1].trim(),
      });
    }
  }
  return snippets;
}

// ────────────────────────────────────────────────────────────────────
// Finds the first release-note snippet whose code references `symbol`.
// ────────────────────────────────────────────────────────────────────

function findReleaseNoteSnippet(symbol, snippets) {
  if (!symbol) return null;
  const re = new RegExp(`\\b${escapeRegExp(symbol)}\\b`);
  return snippets.find((s) => re.test(s.code)) ?? null;
}

// ────────────────────────────────────────────────────────────────────
// Appends a matching release-note snippet under a report line, if one exists.
// ────────────────────────────────────────────────────────────────────

function appendReleaseNoteSnippet(out, indent, change, snippets) {
  if (!snippets?.length) return;
  // Field/param name first: lesson code and these snippets reference the
  // property being set (`ttsEngine: 'parler'`), never the schema/type name
  // that owns it (`ttsConfigSchema` never appears in call-site code).
  const symbol = change.field ?? change.param ?? change.name ?? change.schema ?? null;
  const snippet = findReleaseNoteSnippet(symbol, snippets);
  if (!snippet) return;
  out.push(`${indent}Release note (v${snippet.version}${snippet.prNumber ? `, PR #${snippet.prNumber}` : ''}): ${snippet.title}`);
  out.push(`${indent}\`\`\`typescript`);
  for (const line of snippet.code.split('\n')) out.push(`${indent}${line}`);
  out.push(`${indent}\`\`\``);
}

// ────────────────────────────────────────────────────────────────────
// Guesses which lesson chapter an upstream file belongs to.
// ────────────────────────────────────────────────────────────────────

function chapterGuess(upstreamFile, docChapterMap) {
  if (docChapterMap?.exactFileToSlug.has(upstreamFile)) return docChapterMap.exactFileToSlug.get(upstreamFile);
  if (upstreamFile.startsWith(CONFIG.examplesPathPrefix)) {
    const rel = upstreamFile.slice(CONFIG.examplesPathPrefix.length);
    const subdir = rel.split('/')[0];
    if (rel.includes('/') && docChapterMap?.subdirToSlug.has(subdir)) return docChapterMap.subdirToSlug.get(subdir);
  }
  // Legacy fallback: undocumented file, no doc page mentions it yet. Best
  // guess from the basename; still shown in the report so a human decides.
  const base = path.basename(upstreamFile, '.ts');
  if (base.startsWith('diffusion-')) return /img2vid|txt2vid|vid2vid/.test(base) ? 'video-generation' : 'image-generation';
  if (base.startsWith('vla-')) return 'vla';
  if (base.startsWith('rag-')) return 'rag';
  if (base.startsWith('completion-') || base.startsWith('multi-turn') || base.startsWith('concurrent-')) return 'text-generation';
  if (base.startsWith('transcribe') || base.startsWith('whisper') || base.startsWith('parakeet')) return 'transcription';
  if (base.startsWith('tts-') || base.startsWith('chatterbox') || base.startsWith('parler')) return 'text-to-speech';
  if (base.startsWith('logging-')) return 'profiling';
  if (base.startsWith('multi-model') || base.startsWith('llamacpp-multimodal') || base.startsWith('mcp-')) return 'multimodal';
  if (base.startsWith('registry-')) return 'p2p';
  if (base.startsWith('cancel-') || base.startsWith('parallel-') || base.startsWith('suspend-')) return 'runtime';
  if (base.startsWith('kv-cache') || base.startsWith('llamacpp-cache')) return 'text-generation';
  if (base.startsWith('config-') || base.startsWith('default-config') || base.startsWith('llamacpp-http') || base.startsWith('llamacpp-sharded')) return 'getting-started';
  if (base.startsWith('quickstart') || base.startsWith('llamacpp-filesystem') || base.startsWith('llamacpp-p2p') || base.startsWith('llamacpp-structured') || base.startsWith('llamacpp-tools-') || base.startsWith('llamacpp-dynamic') || base.startsWith('mcp-websearch') || base.startsWith('seed-')) return 'getting-started';
  if (base.startsWith('voice-')) return 'voice-assistant';
  return '(root)';
}

// ────────────────────────────────────────────────────────────────────
// Resolves a repo's baseline: --since if given, else its own tag/dep constraint.
// ────────────────────────────────────────────────────────────────────

async function resolveRepoBaseline(repo) {
  if (RAW_SINCE) return resolveRef(repo.git, RAW_SINCE);
  return baselineFromDep(repo.git, repo.config);
}

// ────────────────────────────────────────────────────────────────────
// Entry point: resolves repos and baselines, diffs, classifies, and writes the report.
// ────────────────────────────────────────────────────────────────────

async function main() {
  const mainRepo = getRepo('main');
  const examplesRepoKey = CONFIG.examplesRepo ?? 'main';
  const docsRepoKey = CONFIG.docsRepo ?? 'main';
  const examplesRepo = examplesRepoKey === 'main' ? mainRepo : getRepo(examplesRepoKey);
  const docsRepo = docsRepoKey === 'main' ? mainRepo : (docsRepoKey === examplesRepoKey ? examplesRepo : getRepo(docsRepoKey));

  // Dedupe: clone/fetch each distinct repo exactly once.
  const distinctRepos = [...new Map([mainRepo, examplesRepo, docsRepo].map((r) => [r.dir, r])).values()];
  for (const repo of distinctRepos) await ensureRepo(repo);

  // Each repo baselines independently; main/examples/docs only share
  // `from`/`to` when they're literally the same repo.
  const from = await resolveRepoBaseline(mainRepo);
  const to = await resolveRef(mainRepo.git, 'HEAD');
  console.error(`[check] baseline: ${from.ref} (${from.sha.slice(0, 8)}, ${from.date.slice(0, 10)})`);
  console.error(`[check] current:  ${to.ref} (${to.sha.slice(0, 8)}, ${to.date.slice(0, 10)})`);

  const examplesFrom = examplesRepo.dir === mainRepo.dir ? from : await resolveRepoBaseline(examplesRepo);
  const examplesTo = examplesRepo.dir === mainRepo.dir ? to : await resolveRef(examplesRepo.git, 'HEAD');
  const docsTo = docsRepo.dir === mainRepo.dir ? to : (docsRepo.dir === examplesRepo.dir ? examplesTo : await resolveRef(docsRepo.git, 'HEAD'));
  const docsFrom = docsRepo.dir === mainRepo.dir ? from : (docsRepo.dir === examplesRepo.dir ? examplesFrom : await resolveRepoBaseline(docsRepo));

  const docChapterMap = await buildChapterMapFromDocs(docsRepo.git, docsTo.sha);
  console.error(`[check] chapter map from docs: ${docChapterMap.exactFileToSlug.size} exact files, ${docChapterMap.subdirToSlug.size} subdirs`);
  const releaseNoteSnippets = await loadReleaseNoteSnippets(docsRepo.git, docsFrom.ref, docsTo.sha);
  console.error(`[check] release note snippets: ${releaseNoteSnippets.length}`);

  // Extract both snapshots (main repo, SDK surface).
  console.error('[check] extracting baseline SDK snapshot...');
  const beforeSnap = await extractRef(mainRepo.git, from.sha);
  console.error(`[check]   ${Object.keys(beforeSnap).length} files`);
  console.error('[check] extracting HEAD SDK snapshot...');
  const afterSnap = await extractRef(mainRepo.git, to.sha);
  console.error(`[check]   ${Object.keys(afterSnap).length} files`);

  // Diff.
  let allChanges = diffSnapshots(beforeSnap, afterSnap);
  // If examples live in a separate repo, extractRef() above never walked
  // them (it's scoped to CONFIG.surfacePathPrefix in the main repo): add
  // their FILE_ADDED/FILE_REMOVED events from the examples repo directly.
  if (examplesRepo.dir !== mainRepo.dir) {
    const exampleFileChanges = await diffExampleFilesAcrossRepo(examplesRepo.git, examplesFrom.sha, examplesTo.sha, CONFIG.examplesPathPrefix);
    allChanges = allChanges.concat(exampleFileChanges);
    console.error(`[check] examples repo (${examplesRepo.key}) file changes: ${exampleFileChanges.length}`);
  }
  console.error(`[check] raw diff: ${allChanges.length} changes`);

  // Model registry (always reported, even if no lessons touch these models).
  const modelChanges = await diffModelRegistry(mainRepo.git, from.sha, to.sha);
  console.error(`[check] models: +${modelChanges.added.length} -${modelChanges.removed.length}`);

  // Examples directory commits.
  const commits = await listCommitsTouchingExamples(examplesRepo.git, examplesFrom.sha, examplesTo.sha);
  for (const c of commits) c._files = await filesChangedInCommit(examplesRepo.git, c.sha);
  console.error(`[check] examples commits: ${commits.length}`);

  // Build the relevance index: which upstream paths and symbols do our
  // lessons actually depend on? Everything else is dropped before the
  // report is rendered.
  const index = buildRelevanceIndex(afterSnap, { snapshot: afterSnap });
  index.modelConfigSchemaToVendored = await buildModelConfigSchemaIndex(mainRepo.git, to.sha, index.examplesDir, index.symbolToVendored);
  console.error(`[check] modelConfig schema links: ${index.modelConfigSchemaToVendored.size}`);
  const partition = partitionChanges(allChanges, commits, index, examplesRepo.dir, examplesFrom.sha, examplesTo.sha);
  const { relevant, informational, renames, falseRenames, relevantCommits, newOpportunities, resolvedRenameCount } = partition;
  console.error(`[check] relevant: ${relevant.length}, informational: ${informational.length}, renames: ${renames.length} (${resolvedRenameCount} already synced, dropped), falseRenames: ${falseRenames.length}, new opportunities: ${newOpportunities.length}`);

  // Docs site.
  let docs = null;
  if (!QUICK) {
    console.error('[check] checking docs site...');
    docs = await checkDocs(afterSnap);
    console.error(`[check] docs: ${docs.results.length} blocks (${docs.results.filter((r) => r.status === 'diverged').length} diverged)`);
  }

  // Render and write.
  CHECKED_KEYS = loadCheckedKeys();
  console.error(`[check] carrying forward ${CHECKED_KEYS.size} checked item(s) from prior runs`);
  const report = renderReport({ from, to, modelChanges, allChanges, relevant, informational, renames, falseRenames, relevantCommits, newOpportunities, docs, index, docChapterMap, releaseNoteSnippets });
  mkdirSync(path.dirname(REPORT_MD), { recursive: true });
  if (!JSON_ONLY) writeFileSync(REPORT_MD, report);

  // Machine-readable JSON for tooling.
  const jsonOut = {
    generated: new Date().toISOString(),
    from: { ref: from.ref, sha: from.sha, date: from.date },
    to: { ref: to.ref, sha: to.sha, date: to.date },
    summary: {
      rawChanges: allChanges.length,
      relevantChanges: relevant.length,
      informational: informational.length,
      renames: renames.length,
      falseRenames: falseRenames.length,
      newOpportunities: newOpportunities.length,
      modelsAdded: modelChanges.added.length,
      modelsRemoved: modelChanges.removed.length,
      examplesCommits: commits.length,
      docsBlocks: docs?.results.length ?? 0,
      docsDiverged: docs?.results.filter((r) => r.status === 'diverged').length ?? 0,
      docsMissing: docs?.results.filter((r) => r.status === 'upstream-missing').length ?? 0,
    },
    modelChanges,
    rawChanges: allChanges,
    relevantChanges: relevant,
    informational,
    renames,
    falseRenames,
    relevantCommits,
    newOpportunities,
    docs: docs?.results ?? null,
  };
  writeFileSync(REPORT_JSON, JSON.stringify(jsonOut, null, 2));

  // Save state.
  writeFileSync(STATE_FILE, JSON.stringify({ lastRun: new Date().toISOString(), from, to, checkedKeys: [...CHECKED_KEYS].sort() }, null, 2));

  // Stdout summary for CI.
  console.log(JSON.stringify(jsonOut.summary, null, 2));
  console.log(`Report: ${REPORT_MD}`);
}

main().catch((e) => {
  console.error('[check] failed:', e);
  process.exit(1);
});
