# Tether Academy

Interactive code school for the [Tether](https://tether.io) product suite.

[![demo-sui](/public/demo.png)](https://youtu.be/m3e4nDuLERo)

## Getting started

### Prerequisites

- Node.js 20.18+ (Node 20 LTS works; Node 22 also fine)
- npm 10+ (pnpm 11 also works if you're on Node 22.13+)

### Setup

```bash
npm install
```

### Development

```bash
npm run dev          # Turbopack dev with HMR (recommended)
npm run dev:webpack  # webpack dev, fallback if Turbopack misbehaves
npm run dev:clean    # wipe .next/.source/.turbo then start Turbopack
```

### Build (static export)

```bash
npm run build        # full pipeline: prebuild (sync + verify) + next build. Use for deploy.
npm run build:dev    # next build only, no prebuild. Use for local visual checks.
```

Output goes to `out/`. The site is fully static; drop the directory on any static host.

### Lint and format

```bash
npm run lint         # biome lint
npm run check        # biome check (lint + format)
npm run check:write  # biome check --write, auto-fixes safe issues
npm run format       # biome format --write
```

`biome.json` is the source of truth. It ignores `node_modules`, `references/`, `courses/`, and Next's build output. Lessons are MDX and are not parsed as JS; the prose style lives in `core/style-guide.md`.

## Verifying lessons

`scripts/verify-tests.mjs` runs every lesson's frontmatter `tests:` array against the matching vendored example.

```bash
npm run verify:tests          # print per-lesson pass/fail
npm run verify:tests:check    # CI mode, exit 1 on any failure
```

## Keeping lessons in sync with the upstream SDK

```bash
npm run sync:examples
```

| Status | Exit | Meaning | Fix |
|---|---|---|---|
| `✓ ok` | 0 | Vendored calls are a subset of upstream's | Nothing |
| `-` skipped | 0 | Lesson has no `sourceExample` frontmatter | Nothing |
| `✗ api-drift` | 1 | Vendored file calls something upstream no longer has | Edit the vendored copy + lesson text, or re-point `sourceExample` |
| `✗ missing-upstream` | 1 | Frontmatter points to a file that doesn't exist in upstream | Fix or remove `sourceExample` |
| `✗ missing-vendored` | 1 | `examples/qvac/<basename>.answer.ts` doesn't exist | Re-author the vendored copy |

The vendored `.answer.ts` is a pedagogical subset of upstream, not a verbatim copy, so the script does not auto-overwrite it. To refresh a vendored copy after an upstream rename, edit the file directly and commit.