// Which lessons the Bare exec child can run. A dependency can pull in a Node-only
// module transitively (e.g. @modelcontextprotocol/sdk needs child_process via
// cross-spawn), so the check is per-package rather than per-symptom. The editor
// uses this to grey out the option; the host's build-time check is authoritative.

/** Packages the Bare child can load. Everything else pins a lesson to Node. */
export const BARE_SAFE_PACKAGES = [/^@qvac\/sdk(\/|$)/, /^bare-[a-z0-9-]+(\/|$)/];

/** Builtins the lesson build swaps for a Bare package, with or without the `node:` prefix. Mirrors BARE_BUILTINS in electron/runner-process.cjs; a test holds the two lists in sync. */
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

/** Packages a lesson imports that the Bare child cannot load; reads the source as written, so specifiers are still package names. */
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
