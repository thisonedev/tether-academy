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
| `electron/main.js` | BrowserWindow, IPC handlers, inline static server, deep-link receiver |
| `electron/preload.js` | exposes `window.academy` via contextBridge |
| `electron/peer.cjs` | placeholder for the P2P layer (HyperDHT + Hyperswarm) |
| `electron/state-store.cjs` | persistent state via Corestore + Hypercore |
| `runner.cjs` | Node child process that runs lesson code |
| `package.json` | `@tether-academy/desktop`, depends on `pear-runtime` and `hello-pear-worker` |

## Storage

State lives in a Corestore at `app.getPath('userData')/corestore/`. Two named Hypercores:

- `identity` (binary): ed25519 keypair generated on first launch. Pubkey is logged on startup. Future use: core encryption key source, event signer, etc.
- `kv-state` (json): append-only event log of `{op, key, value, ts}` writes. Current state is the reduce of the log. Same `get/set/remove/list` API the renderer's storage adapter already speaks.

The renderer never touches the storage layer directly. `packages/core/src/store/academy-storage.ts` reads and writes through `window.academy.state`, exposed by `electron/preload.js` and backed by IPC handlers in `electron/main.js`.

On first launch with the corestore build, any legacy `state.json` is migrated into the `kv-state` core and deleted from disk.

## Deep links

`pear://<key>` is registered as a protocol handler. The key is set when the app is published via `pear stage` and `pear provision`. OTA updates flow through the `hello-pear-worker` Bare worker that `electron/main.js` spawns on `app.whenReady`.