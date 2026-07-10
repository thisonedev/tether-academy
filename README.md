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
npm run lint      # biome lint
npm run format    # biome format --write
```

`biome.json` is the source of truth. It ignores `node_modules`, `references/`, `courses/`, and Next's build output. Lessons are MDX and are not parsed as JS; the prose style lives in `core/style-guide.md`.

## Verifying lessons

`scripts/verify-tests.mjs` runs every lesson's frontmatter `tests:` array against the matching vendored example.

```bash
npm run verify:tests          # print per-lesson pass/fail
npm run verify:tests:check    # CI mode, exit 1 on any failure
```

## Keeping lessons in sync with the upstream SDK

`github.com/tetherto/qvac` is the source of truth. CI clones it fresh on every run, so nothing in the lesson repo needs to track it.

```bash
npm run sync:examples              # show a drift report (default)
npm run sync:examples:check        # CI mode, exit 1 on real problems
```

The script reports four statuses:

| Status | Exit | Meaning | Fix |
|---|---|---|---|
| `✓ ok` | 0 | Vendored calls are a subset of upstream's | Nothing |
| `-` skipped | 0 | Lesson intentionally has no `sourceExample` (no single upstream file fits it) | Nothing |
| `✗ api-drift` | 1 | Vendored file calls something upstream no longer has (renamed/removed) | Edit the vendored copy + lesson text to match the new upstream API, or re-point `sourceExample` at a closer file |
| `✗ missing-upstream` | 1 | Frontmatter points to a file that doesn't exist in upstream | Fix or remove `sourceExample` |
| `✗ missing-vendored` | 1 | `examples/qvac/<basename>.answer.ts` doesn't exist | Re-author the vendored copy |

The build only blocks on the `✗` statuses. When upstream nudges (adds a function, edits a comment, reorders code), the daily run still prints `All lessons in sync.` and the build stays green. You only see a real failure when the lesson's calls actually stop working.

The vendored `.answer.ts` is a pedagogical subset of upstream, not a verbatim copy, so the script does not auto-overwrite it. To update a vendored copy after an api-drift fix, edit the file directly and commit.

## Workflows

The project has two GitHub workflows:

- `.github/workflows/sync-upstream.yml` — daily at 06:00 UTC, and on push/PR. Shallow-clones `github.com/tetherto/qvac` (sparse-checkout, examples only), sets `QVAC_REFERENCES_DIR`, runs `sync:examples:check`. Real drift fails the run.
- `.github/workflows/ci.yml` — every push and PR. Clones the same fresh upstream, then runs lint, verify-tests, and build. The prebuild hook runs the sync check, so the build is gated on real API drift.