# Tether Academy Desktop

Electron + Pear Runtime shell that loads the Tether Academy web app. 

## Getting started

### Prerequisites

- Node.js 20.18+
- pnpm 9.15.9 (matches the workspace `packageManager` field)
- A built web export at `apps/web/out/`, or a running Next dev server on `:4712`

### Run the built app

```bash
pnpm start:desktop
```

or from `apps/desktop`:

```bash
pnpm start
```

The app serves `apps/web/out/` over an inline HTTP server (because Next's `/_next/...` asset paths don't load over `file://`). If the build is missing, it falls back to `http://localhost:4712`, then to `PEAR_DEV_URL` if set.

### Development

```bash
# terminal 1
pnpm dev                          # Next dev server with HMR

# terminal 2
PEAR_DEV_URL=http://localhost:4712 pnpm start:desktop
```

`PEAR_DEV_URL` always wins over the static build, so changes to the web app hot-reload into the desktop window.

## Layout

| File | Purpose |
|---|---|
| `electron/main.js` | BrowserWindow, IPC handlers, inline static server, deep-link receiver — thin shell, delegates P2P/identity to `pear-end/` |
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

The runner is [brittle](https://github.com/holepunchto/brittle), which also runs under Bare via `brittle-bare` if `peer.cjs` ever needs testing in its worker runtime.

`unit/` touches no network and spawns nothing, so CI runs it on every PR. `integration/` creates `hyperdht` testnets and spawns sandboxed children, so CI runs it nightly. Tests never close resources by hand.

## Architecture

`peer.cjs` (pairing + mesh + peer-exec) runs inside a real Bare worker process, spawned by `pear-end/worker-client.cjs` and communicating over a `bare-rpc` command channel (one command per action — no generic `invoke(method, args)` dispatcher). `main.js` only ever talks to `pear-end/index.cjs`'s facade; it never requires `peer.cjs` directly. Identity (`identity/manager.cjs`) and the KV store stay in the Electron main process — the worker receives only an already-decrypted device identity at init.

Peer-exec always fails closed if the OS sandbox isn't available; see `references/audit.md` and `references/plan.md` for the full security audit and phased hardening history.

### What macOS read confinement does not cover

Writes are allowlisted by subpath. Reads cannot be, because dyld and the runtime need broad filesystem visibility to start: a pure read allowlist kills the `bare` binary with SIGABRT, and a synthetic `HOME` makes every cached model look missing, since the SDK resolves its cache from it. So the profile allows `file-read*` and then denies back. `sandbox-mac.cjs` generates that deny set per spawn by listing `$HOME`, its parent, and the shared temp root, and denying every entry no needed path touches, on top of a named list of credential stores elsewhere.

Denying back leaves residue. Each of the following is a limit of the mechanism, and closing it needs something seatbelt does not offer:

- A file or directory created after the profile is generated is not in the deny set. The profile is rebuilt for every spawn, so this window is the length of one run.
- A directory the walk has to descend into, but cannot list, keeps its contents readable. Lesson output lives in `~/Documents/Tether Academy`, so the walk must enter `~/Documents` to deny the siblings of that one folder. TCC blocks reading `~/Documents` until the user grants access, and without the listing there are no sibling names to deny. The profile emits a warning naming each directory it could not read.
- `~/Library` stays readable apart from the named denies, because the dyld, font, and preference caches the runtime starts from live there.
- Paths outside `$HOME`, `/Users`, and `/tmp` are covered only by the named list in `SYSTEM_READ_DENY`. A credential in a location that list does not name is readable.

Seatbelt has no deny-except form for reads, so none of these can be fixed by reordering rules: an earlier `subpath` deny beats a later allow whatever the order.

### sandbox-exec is deprecated

`sandbox-exec(1)` carries a deprecation notice in its own man page and is the entire macOS boundary. If a future macOS drops it, peer-exec on macOS stops working. That is the intended outcome: `buildWrap` checks the binary is present and reports `mode: 'mac-no-sandbox-exec'` with `sandboxed: false` when it is not, and callers refuse the spawn rather than running remote code unconfined.

Neither documented replacement covers this use today:

- App Sandbox is entitlement-based and applies to the whole application at launch. It cannot express a different profile per spawned child, which is what peer-exec needs, and it would confine the editor and the P2P stack along with the lesson.
- Endpoint Security observes and can block, but it is an event-monitoring API requiring a provisioned distribution entitlement from Apple, and it is a different shape of control: it watches syscalls as they happen, where peer-exec needs to declare what a child may reach before it starts.

Revisit when Apple ships a supported per-process profile mechanism. Until then this is a known strategic risk, not an oversight.

## Storage

State lives in a Corestore at `app.getPath('userData')/corestore/`, plus a separate sealed identity record (`identity-v3.json`) managed by `identity/manager.cjs`. The Corestore holds one core:

- `kv-state` (json): append-only event log of `{op, key, value, ts}` writes. Current state is the reduce of the log. Same `get/set/remove/list` API the renderer's storage adapter already speaks.

It used to hold a second ed25519 keypair of its own, kept alive only because `ensureQVACSeed()` read it. That seed now derives from the device identity, and the core is gone.

The renderer never touches the storage layer directly. `packages/core/src/store/academy-storage.ts` reads and writes through `window.academy.state`, exposed by `electron/preload.js` and backed by IPC handlers in `electron/main.js`.

On first launch with the corestore build, any legacy `state.json` is migrated into the `kv-state` core and deleted from disk.

## Deep links

`pear://<key>` is registered as a protocol handler. The key is set when the app is published via `pear stage` and `pear provision`. OTA updates flow through the `hello-pear-worker` Bare worker that `electron/main.js` spawns on `app.whenReady`.