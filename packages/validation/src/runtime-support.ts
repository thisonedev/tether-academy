// Which lessons the Bare exec child can run.
//
// A peer run wraps the lesson's own `node:` imports in Bare packages, but it
// cannot reach inside a dependency: @modelcontextprotocol/sdk pulls cross-spawn,
// which requires 'child_process', and @sqliteai/sqlite-wasm imports 'module'.
// So the test is the package rather than the symptom.
//
// The editor uses this to grey the option out before a run; the host checks the
// built source again on its own side, and that check is the authoritative one.

/** Packages the Bare child can load. Everything else pins a lesson to Node. */
export const BARE_SAFE_PACKAGES = [/^@qvac\/sdk(\/|$)/, /^bare-[a-z0-9-]+(\/|$)/];

/**
 * Builtins the lesson build swaps for a Bare package, with or without the
 * `node:` prefix. Mirrors BARE_BUILTINS in electron/runner-process.cjs; a Node
 * builtin missing from both lists is node-only, so the two have to agree and a
 * test holds them to it.
 */
export const REWRITTEN_BUILTINS = [
  'fs',
  'fs/promises',
  'os',
  'path',
  'child_process',
  'process',
  'events',
  'crypto',
];

const IMPORT_SPECIFIER = /\bfrom\s+["']([^"']+)["']/g;

/**
 * Packages a lesson imports that the Bare child cannot load. Reads the source
 * as the author wrote it, so specifiers are still package names.
 */
export function nodeOnlyImports(source: string): string[] {
  if (typeof source !== 'string' || !source) return [];
  const out: string[] = [];
  for (const [, spec] of source.matchAll(IMPORT_SPECIFIER)) {
    if (spec.startsWith('.') || spec.startsWith('/')) continue;
    if (REWRITTEN_BUILTINS.includes(spec.replace(/^node:/, ''))) continue;
    if (BARE_SAFE_PACKAGES.some((re) => re.test(spec))) continue;
    const name = /^(@[^/]+\/[^/]+|[^/]+)/.exec(spec)?.[1];
    if (name && !out.includes(name)) out.push(name);
  }
  return out;
}
