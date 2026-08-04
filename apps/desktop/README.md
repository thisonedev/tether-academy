# Tether Academy Desktop

Electron + Pear Runtime shell that loads the Tether Academy web app.

## Getting started

### Prerequisites

- Node.js 20.18+
- pnpm 9.15.9 (matches the workspace `packageManager` field)
- A built web export at `apps/web/out/`, or a running Next dev server on `:3000` (see Development below)

### Run the built app

```bash
pnpm start:desktop
```

or from `apps/desktop`:

```bash
pnpm start
```

The app serves `apps/web/out/` over an inline HTTP server. `PEAR_DEV_URL` always wins if set; otherwise it serves the static build. If neither is available, it falls back to `http://localhost:4712` as a last resort.

### Development

Run both commands from the repository root. `start:desktop` is defined on the workspace `package.json` and resolves to `pnpm --filter @tether-academy/desktop start`; from inside `apps/desktop` the equivalent is `pnpm start`. Running `pnpm start:desktop` from another directory produces `ERR_PNPM_RECURSIVE_EXEC_FIRST_FAIL Command "start:desktop" not found`.

```bash
# terminal 1
pnpm dev                          # Next dev server with HMR on :3000

# terminal 2
PEAR_DEV_URL=http://localhost:3000 pnpm start:desktop
```

`PEAR_DEV_URL` always wins over the static build, so changes to the web app hot-reload into the desktop window.

## Layout

| File | Purpose |
| --- | --- |
| `electron/main.js` | BrowserWindow, IPC handlers, inline static server, deep-link receiver; thin shell that delegates P2P/identity to `pear-end/` |
| `electron/preload.js` | exposes `window.academy` via contextBridge |
| `electron/identity/manager.cjs` | root + device identity (`keet-identity-key`): create/recover/attest/revoke, sealed at rest |
| `electron/pear-end/` | main-side facade and the proxy that spawns the Bare worker (`worker-client.cjs`) |
| `workers/peer/` | pairing, mesh, and peer-exec orchestration (invite/approve, sandboxed remote code execution) |
| `workers/sandbox/` | per-platform OS confinement for peer-exec (`sandbox-exec` on macOS, `bwrap` on Linux, refused on Windows) |
| `workers/entry.cjs` | worker-side `bare-rpc` command dispatcher; hosts `workers/peer/` |
| `shared/` | required from both runtimes: `rpc-commands.cjs` (command IDs), `bare-bin.cjs` |
| `electron/state-store.cjs` | Corestore-backed KV store behind `academy:state:*` |
| `runner.cjs` | Node child process that runs lesson code locally ("This device" mode) |
| `tests/` | `unit/` (fast, pure), `integration/` (real DHT + real spawns), `helpers/` (shared fixtures) |
| `scripts/` | developer tools, not tests: `peer-exec.cjs` (manual pairing CLI), `peer-test-pair.sh` (launch two instances side by side) |
| `package.json` | `@tether-academy/desktop`, depends on `pear-runtime`, `bare-rpc`, and the `bare-*` runtime packages |

## Tests

```bash
pnpm test              # run all tests
pnpm test:unit         # ~2s
pnpm test:integration  # ~3min, real DHT testnets and sandboxed children
```

The runner is [brittle](https://github.com/holepunchto/brittle), which also runs under Bare via `brittle-bare` if `workers/peer/` ever needs testing in its worker runtime.

`unit/` touches no network and spawns nothing, so CI runs it on every PR. `integration/` creates `hyperdht` testnets and spawns sandboxed children, so CI runs it nightly. Tests never close resources by hand.

## Architecture

`workers/peer/index.cjs` (pairing + mesh + peer-exec) runs inside a real Bare worker process, spawned by `pear-end/worker-client.cjs` and communicating over a `bare-rpc` command channel (one command per action, no generic `invoke(method, args)` dispatcher). `main.js` only ever talks to `pear-end/index.cjs`'s facade; it never requires `workers/peer/` directly. Identity (`identity/manager.cjs`) and the KV store stay in the Electron main process. The worker receives only an already-decrypted device identity at init.

### What macOS read confinement does not cover

Writes are allowlisted by subpath; reads can't be, because dyld and the runtime need broad filesystem visibility to start. So the profile allows `file-read*` and denies back entry by entry, generated per spawn from `$HOME`, its parent, and `/tmp`, along with a named list of credential stores elsewhere (`sandbox-mac.cjs`).

Denying back leaves gaps a rule can't close without breaking something the runtime needs:

- A path created after the profile is generated isn't in the deny set. This is bounded to one run, since the profile is rebuilt every spawn.
- A directory the walk must enter but can't list keeps its contents readable; the profile warns per directory.
- `~/Library` stays readable outside the named denies because the dyld, font, and preference caches the runtime starts from live there.
- Paths outside `$HOME`, `/Users`, and `/tmp` are covered only by the named `SYSTEM_READ_DENY` list; walking `$TMPDIR` entry by entry would push `sandbox-exec`'s per-spawn compile time past what a run can tolerate.
- Any path the walk had not reached when it hit `MAX_GENERATED_DENIES` stays readable.

Seatbelt matches rules last-first, so a later allow re-opens an earlier `subpath` deny. This lets a crowded directory be confined without a rule per entry: deny the root once, then allow back each path the run needs.

### sandbox-exec is deprecated

`sandbox-exec(1)` carries a deprecation notice in its own man page and is the entire macOS peer-exec boundary. If a future macOS drops it, peer-exec on macOS stops working by design: `buildWrap` reports `sandboxed: false` when the binary is missing, and callers refuse the spawn rather than run remote code unconfined.

Neither documented replacement fits today: App Sandbox is entitlement-based and applies to the whole app at launch, not a per-spawn profile, so it would confine the editor along with the lesson. Endpoint Security observes syscalls after the fact rather than declaring what a child may reach before it starts.

Revisit when Apple ships a supported per-process profile mechanism.

## Storage

State lives in a Corestore at `app.getPath('userData')/corestore/`, with a separate sealed identity record (`identity-v3.json`) managed by `identity/manager.cjs`. The Corestore holds one core:

- `kv-state` (json): append-only event log of `{op, key, value, ts}` writes. Current state is the reduce of the log. Same `get/set/remove/list` API the renderer's storage adapter already speaks.

It used to hold a second ed25519 keypair of its own, kept alive only because `ensureQVACSeed()` read it. That seed now derives from the device identity, and the core is gone.

The renderer never touches the storage layer directly. `packages/core/src/store/academy-storage.ts` reads and writes through `window.academy.state`, exposed by `electron/preload.js` and backed by IPC handlers in `electron/main.js`.

On first launch with the corestore build, any legacy `state.json` is migrated into the `kv-state` core and deleted from disk.

## Deep links

`pear://<key>` is registered as a protocol handler. The key is set when the app is published via `pear stage` and `pear provision`. OTA updates flow through the `hello-pear-worker` Bare worker that `electron/main.js` spawns on `app.whenReady`.
