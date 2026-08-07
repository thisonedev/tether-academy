# Tether Academy

Interactive code school for the [Tether](https://tether.io) product suite. A pnpm-workspace monorepo with two apps and six shared packages.

## Install via terminal (Mac/Linux)

```bash
curl -fsSL https://tetheracademy.cc/install.sh | sh
```

Installs to ~/.tether-academy and adds tether-academy to your PATH.

```bash
tether-academy start              # launch the desktop app
tether-academy update             # pull and safely build the latest version
tether-academy uninstall          # remove the academy app, CLI shim, and profile backups, but keep the profile key(s)
tether-academy uninstall --purge  # remove everything, including profile key(s)
```

## Getting started

### Prerequisites

- Node.js 20.18+
- pnpm 9.15.9 (matches the workspace `packageManager` field)

### Setup

```bash
pnpm install
```

### Run the web app

```bash
pnpm dev          # Next.js dev with HMR on :3000
pnpm build        # build packages + web static export to apps/web/out/
pnpm start        # alias: pnpm start:web; serve the static export on :3000
```

See `apps/web/README.md` for the full web build and dev details.

### Run the desktop app

```bash
pnpm build            # build packages + web static export
pnpm start:desktop    # open the Electron shell
```

The desktop loads `apps/web/out/`. To hot-reload web changes into the desktop, run `pnpm dev` in one terminal and `PEAR_DEV_URL=http://localhost:3000 pnpm start:desktop` in another. See `apps/desktop/README.md` for storage (Corestore) and deep-link details.

## Layout

```
tether-academy/
  apps/
    web/        Next.js 15 + Fumadocs. Static export at apps/web/out/.
    desktop/    Electron 40 + Pear Runtime. See apps/desktop/README.md.
  packages/
    config/         Shared TypeScript + Biome base config
    validation/     Zod schemas (frontmatter, IPC payloads, window.academy contract)
    sandbox-types/  Shared TypeScript types for the OS-level sandbox
    core/           Zustand store + storage adapter
    ui/             React components (lesson workspace, code block, etc.)
    courses/        Curriculum, lesson MDX, vendored examples, sync/verify scripts
  .github/workflows/  deploy.yml, test-desktop.yml, verify-lessons.yml
```

Each app and package has its own `package.json` and `tsconfig.json` (extending `packages/config/tsconfig.base.json`).

## Lint and format

```bash
pnpm lint         # biome lint
pnpm check        # biome check (lint + format)
pnpm check:write  # biome check --write, auto-fixes safe issues
pnpm format       # biome format --write
```

`pnpm lint` currently runs only on the web app (`apps/web/biome.json`). Packages extend `packages/config/biome.json` and can be linted individually with `biome check .` from inside each package.

## Verifying lessons

`packages/courses/scripts/verify-tests.mjs` runs every lesson's frontmatter `tests:` array against the matching vendored example.

```bash
pnpm verify:tests          # print per-lesson pass/fail
pnpm verify:tests:check    # CI mode, exit 1 on any failure
```

## Lesson frontmatter check

```bash
pnpm check:yaml    # validate every lesson's YAML frontmatter against the zod schema
```

## Keeping lessons in sync with the upstream SDK

```bash
pnpm sync:examples          # print per-lesson sync status
pnpm sync:examples:check    # CI mode, exit 1 on any drift
```

| Status | Exit | Meaning | Fix |
| --- | --- | --- | --- |
| `✓ ok` | 0 | Vendored calls are a subset of upstream's | Nothing |
| `-` skipped | 0 | Lesson has no `sourceExample` frontmatter | Nothing |
| `✗ api-drift` | 1 | Vendored file calls something upstream no longer has | Edit the vendored copy + lesson text, or re-point `sourceExample` |
| `✗ missing-upstream` | 1 | Frontmatter points to a file that doesn't exist in upstream | Fix or remove `sourceExample` |
| `✗ missing-vendored` | 1 | `packages/courses/examples/qvac/<basename>.answer.ts` doesn't exist | Re-author the vendored copy |

The vendored `.answer.ts` is a pedagogical subset of upstream, not a verbatim copy, so the script does not auto-overwrite it. To refresh a vendored copy after an upstream rename, edit the file directly and commit.

## Funding

This is a community-owned project.

Buy me a coffee (USDT/USDC/ETH): `0x409072a91aa81C9759E1170993e29F8Ec83E6405`

For sponsorships or grant inquiries, contact [here](https://thisonedev.github.io/#contact).
