// Host side of peer-exec: the half that runs a remote peer's code. Owns the run
// lifecycle (validate → device consent → sandbox → spawn → cancel) and the two
// pieces of state that go with it, `runs` and `deviceRequests`.
//
// What it needs from the transport arrives in the context object, so it reaches
// the swarm and the pairing tables only through index.cjs.
'use strict';

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const process = require('process');
const { spawn } = require('child_process');
const { isWindows } = require('which-runtime');

const sandbox = require('../sandbox');
const { ensureBareExecutable } = require('../../shared/bare-bin.cjs');
const { createNoiseFilter } = require('./exec-noise.cjs');
const { isAllowed: rateAllow, GLOBAL_KEY } = require('./rate-limit.cjs');
const {
  detectDeviceNeeds,
  detectNodeOnly,
  npxPackages,
  sanitizeExecFileName,
  sanitizeExecArgv,
  sanitizeExecCode,
} = require('./exec-validate.cjs');
const { detectNetworkNeed, referencedModels } = require('./exec-network.cjs');
const {
  lessonCwd,
  precreateOutputDirs,
  snapshotOutputs,
  describeNewOutputs,
} = require('../../shared/lesson-output.cjs');
const { syncFast, scan, removeAddedSince, verifyModelsAsync } = require('../../shared/model-integrity.cjs');

// --require'd into a node-runtime child so it does not claim a Dock icon.
const DOCK_HIDE_SHIM = path.resolve(__dirname, '..', '..', 'electron', 'dock-hide-shim.cjs');

// No answer is a denial. The prompt can be missed.
const DEVICE_CONSENT_TIMEOUT_MS = 2 * 60_000;
// How long a request waits for the identity handshake it raced. One round trip
// on an already-open channel, so a wait this long means no answer is coming.
const IDENTITY_WAIT_MS = 10_000;
// Grace between SIGTERM and SIGKILL. Native inference ignores SIGTERM.
const SIGKILL_GRACE_MS = 3_000;
// A run alive this long has outlived any cancel sent to it. Force-kill it so
// the slot frees on exit; the request that found it still gets refused.
const STALE_RUN_MS = 5 * 60_000;
// After the host has received at least one chunk of output and then sees no
// new bytes for this long, treat the run as substantively complete and
// close it. SDK model workers can keep the child process alive past the
// lesson's main flow, so a renderer waiting on child.on('exit') would
// otherwise stay in Running. The BCI lessons hit this; the limit is set
// above any quiet compute phase a real lesson can hit.
const RUN_FINAL_IDLE_MS = 30_000;
// Fallback sealing: the key that decrypts the identity record is a file on the
// same disk rather than a keychain entry. Running a peer's code on a device in
// that state puts the device secret key and the root seed one bug away.
const UNSEALED_STORAGE_SCHEME = 'aes-gcm-local';

// What a refused peer is told, keyed by the code sent alongside it. Fixed text,
// so a failure carries nothing the host knows about its own disk, account, or
// tooling. The entries that vary are built from the peer's own request, which
// it already has.
const PEER_ERROR_TEXT = {
  'unsealed-storage':
    'Peer exec refused: this device has no OS keychain, so the identity record '
    + 'is sealed with a key file on disk. Remote code will not run here.',
  revoked: 'Peer exec refused: this device was revoked.',
  unverified: 'Peer exec refused: this device has not proven which key it holds.',
  cancelled: 'Peer exec cancelled before it started.',
  'cancelled-awaiting-consent': 'Peer exec cancelled while waiting for approval.',
  'invalid-request': 'Peer exec refused: the request was rejected by validation.',
  'run-in-progress': 'another exec is already running on this peer',
  'package-not-allowed': (meta) =>
    `Peer exec refused: ${(meta.packages ?? []).join(', ')} is not in this device's `
    + 'course allowlist, and a run cannot install its own tooling.',
  'package-prepare-failed':
    'Peer exec refused: this device could not prepare the tooling the run asked for.',
  'network-unenforceable': (meta) =>
    "Peer exec refused: this device's sandbox cannot hold a run to "
    + `${meta.network ?? 'the requested'} network access.`
    + (meta.networkScope ? ` It would get ${meta.networkScope}.` : ''),
  'consent-denied': (meta) => {
    const asked = [...(meta.devices ?? []), ...(meta.network ? ['network'] : [])];
    return `Peer exec refused: ${asked.join(', ') || 'the access it asked for'} `
      + 'was not approved on this device.';
  },
  'model-integrity': 'Peer exec refused: cached model files on this device changed '
    + 'outside the app. They have to be re-downloaded or removed before remote code runs.',
  'filename-escape': 'exec: fileName escaped temp directory',
  'runtime-missing': (meta) =>
    `Peer exec refused: the ${meta.runtime ?? 'requested'} runtime is not available on this device.`,
  'sandbox-unavailable': 'Peer exec refused: the OS sandbox is not available on this device.',
  'spawn-failed': 'Peer exec failed: the run could not be started on this device.',
  sigtrap: 'Peer exec aborted: process trapped under the OS sandbox (SIGTRAP). '
    + 'Refusing to retry without confinement.',
  'rate-limited': 'Peer exec refused: too many requests from this device. Try again later.',
};

// Meta fields a peer may see. Each is either the peer's own input or a host
// constant. Everything else, warnings and changed model names in particular,
// names paths and stays in the local trail.
const WIRE_SAFE_META = [
  'mode',
  'fileName',
  'devicePublicKey',
  'packages',
  'devices',
  'network',
  'networkScope',
  'runtime',
  'signal',
  'scheme',
  'reason',
  'sandboxMode',
  'sandboxed',
];

function peerErrorText(code, meta) {
  const entry = PEER_ERROR_TEXT[code];
  if (typeof entry === 'function') return entry(meta);
  return entry ?? 'Peer exec failed on this device.';
}

// Compose the reason text for a network prompt from detection plus any
// declaration. Detection drives the wording; the declaration is appended
// so the human answering sees both.
function detectedNetReason(detectedNet, declared) {
  const parts = [];
  if (detectedNet.reason) parts.push(detectedNet.reason);
  if (declared?.network && declared.network !== 'none') {
    parts.push(`the lesson declares ${declared.network} access`);
  }
  return parts.join('; ') || null;
}

function wireSafeMeta(meta) {
  const out = {};
  for (const key of WIRE_SAFE_META) {
    if (meta[key] !== undefined) out[key] = meta[key];
  }
  return out;
}

/**
 * A child is alive until it reports an exit. `child.killed` is not that check:
 * Node sets it once a signal has been *sent*, so a process that ignores
 * SIGTERM still reads as `killed`. Guarding escalation on `killed` is why
 * cancel used to report success while the workload kept running.
 */
function isAlive(child) {
  return !!child && child.exitCode === null && child.signalCode === null;
}

/**
 * Signal the child's whole process group. Children are spawned detached, so the
 * group id is the child pid.
 *
 * The QVAC worker is a grandchild, and one left orphaned keeps its lock on the
 * registry corestore. That lock is per machine, so every later model download
 * fails with "File descriptor could not be locked" until someone kills it.
 */
function killGroup(child, signal) {
  if (!child?.pid) return false;
  try {
    process.kill(-child.pid, signal);
    return true;
  } catch {
    try {
      child.kill(signal);
      return true;
    } catch {
      return false;
    }
  }
}

function removeDir(dir) {
  if (!dir) return;
  try {
    fs.rmSync(dir, { recursive: true, force: true });
  } catch {
    // best effort; it is under the OS temp dir either way
  }
}

/**
 * @param {object} ctx
 * @param {(discoveryKeyHex: string, payload: object) => void} ctx.sendReply
 * @param {(type: string, payload: object) => void} ctx.appendAudit
 * @param {(event: string, payload: object) => void} ctx.emit
 * @param {(discoveryKeyHex: string) => unknown} ctx.getPeerUserData
 * @param {() => string} ctx.getExecPath
 * @param {() => string | null} ctx.getBareRuntimeBinPath
 * @param {() => string | null} [ctx.getUserData]
 * @param {() => string | null} [ctx.getSecretScheme]
 * @param {(discoveryKeyHex: string) => string | null} [ctx.getRevokedDeviceKey]
 * @param {(discoveryKeyHex: string, timeoutMs: number) => Promise<{ ok: boolean, reason: string | null }>} [ctx.awaitDeviceVerified]
 */
function createExecHost(ctx) {
  const {
    sendReply,
    appendAudit,
    emit,
    getPeerUserData,
    getExecPath,
    getBareRuntimeBinPath,
    getUserData = () => null,
    getSecretScheme = () => null,
    getRevokedDeviceKey = () => null,
    // No transport means nothing can prove who is on the wire, so nothing runs.
    awaitDeviceVerified = async () => ({ ok: false, reason: 'no-handshake' }),
  } = ctx;

  // discoveryKey -> in-flight run. Present from the moment a request is
  // accepted, including while it is parked on a human's device answer, so a
  // peer cannot queue up N concurrent runs during the consent window.
  const runs = new Map();
  // Runs parked at the sandbox boundary awaiting a human answer.
  const deviceRequests = new Map();

  /**
   * Refuse a run. The peer gets a stable `code` and the fixed text for it; the
   * message the host actually produced stays in the local audit trail.
   *
   * A raw host error is reconnaissance. Sandbox setup failures carry the path
   * they failed on, package preparation failures carry npm's output, and both
   * name the account, its home directory layout, and which tools are installed
   * where. One failed run hands a peer all of it without running anything.
   *
   * @param {string} discoveryKeyHex
   * @param {keyof PEER_ERROR_TEXT} code
   * @param {string} localMessage what the host saw, for the audit trail only
   * @param {object} [meta] recorded locally; only WIRE_SAFE_META reaches the peer
   */
  function fail(discoveryKeyHex, code, localMessage, meta = {}) {
    sendReply(discoveryKeyHex, {
      kind: 'error',
      code,
      message: peerErrorText(code, meta),
      ...wireSafeMeta(meta),
    });
    appendAudit('peer:exec:error', {
      discoveryKey: discoveryKeyHex,
      code,
      message: localMessage,
      ...meta,
    });
  }

  /** Refuse and report when this peer's proven device key has been revoked. */
  function refusedAsRevoked(discoveryKeyHex) {
    const revokedDeviceKey = getRevokedDeviceKey(discoveryKeyHex);
    if (!revokedDeviceKey) return false;
    fail(discoveryKeyHex, 'revoked', 'device is on the revocation list', {
      devicePublicKey: revokedDeviceKey,
    });
    return true;
  }

  function sandboxRefusalMessage(wrap, wrapErr) {
    if (wrapErr) {
      return `Peer exec refused: sandbox failed to initialize (${wrapErr.message || wrapErr})`;
    }
    if (!wrap) {
      return 'Peer exec refused: sandbox is not available on this device';
    }
    if (wrap.mode === 'windows-unavailable' || isWindows) {
      return (
        'Peer exec is not available on Windows yet. ' +
        'OS confinement (AppContainer) is required before remote code can run.'
      );
    }
    if (wrap.mode === 'linux-passthrough' || wrap.bwrapMissing) {
      return (
        'Peer exec refused: bubblewrap (bwrap) is not installed. ' +
        'Install the bubblewrap package to enable sandboxed remote execution.'
      );
    }
    if (wrap.mode === 'linux-no-userns') {
      return (
        'Peer exec refused: bubblewrap is installed but this kernel refuses it ' +
        'a user namespace. Enable unprivileged user namespaces to run remote code here.'
      );
    }
    if (wrap.mode === 'mac-no-sandbox-exec') {
      return (
        'Peer exec refused: this version of macOS has no sandbox-exec, which is '
        + 'the only OS confinement this app can apply here.'
      );
    }
    if (wrap.mode === 'linux-no-seccomp') {
      return (
        `Peer exec refused: no seccomp syscall table for this CPU architecture ` +
        `(${process.arch}), so ptrace and the mount calls cannot be denied.`
      );
    }
    return `Peer exec refused: OS sandbox is not available (mode=${wrap.mode || 'unknown'})`;
  }

  /** Undo a failed run's half-finished downloads. See removeAddedSince. */
  function revertModelAdditions(discoveryKeyHex, run) {
    if (!run.modelsBefore) return;
    try {
      const removed = removeAddedSince(run.modelsBefore);
      if (removed.length > 0) {
        appendAudit('peer:exec:models-reverted', {
          discoveryKey: discoveryKeyHex,
          removed,
        });
      }
    } catch (err) {
      console.warn('[peer] model cleanup failed:', err?.message ?? err);
    }
  }

  /** A run that no longer holds its peer's slot has already been reported. */
  function isCurrent(discoveryKeyHex, run) {
    return runs.get(discoveryKeyHex) === run;
  }

  function finishRun(discoveryKeyHex, run) {
    if (!isCurrent(discoveryKeyHex, run)) return;
    if (run.killTimer) clearTimeout(run.killTimer);
    // A clean exit still leaves the worker running if the lesson never
    // unloaded its model, so sweep the group either way.
    killGroup(run.child, 'SIGKILL');
    removeDir(run.fileDir);
    runs.delete(discoveryKeyHex);
  }

  /**
   * Report how a run ended, once. Whoever gets here first owns the outcome:
   * finishRun sweeps the process group, so every later exit belongs to that
   * sweep and not to the lesson.
   * @param {string} discoveryKeyHex
   * @param {object} run
   * @param {{ code: number | null, signal: string | null, source: string }} outcome
   */
  function reportExit(discoveryKeyHex, run, { code, signal, source }) {
    if (!isCurrent(discoveryKeyHex, run)) return;
    sendReply(discoveryKeyHex, {
      kind: 'exit',
      code,
      signal,
      mode: run.mode,
      fileName: run.fileName,
    });
    appendAudit('peer:exec:finished', {
      discoveryKey: discoveryKeyHex,
      code,
      signal,
      mode: run.mode,
      fileName: run.fileName,
      cancelled: run.cancelled || undefined,
      source,
    });
    finishRun(discoveryKeyHex, run);
  }

  /**
   * Park the run on a human. One prompt covers everything the run asked for, so
   * `network` rides alongside `devices`. `declared` carries through to the
   * audit event so post-incident review can see what the lesson frontmatter
   * said vs what the host's detector found.
   * @param {string} discoveryKeyHex
   * @param {{ devices: string[], network: string | null, declared?: { network?: string, device?: string[] } }} asks
   * @param {string | null} label
   */
  function requestConsent(discoveryKeyHex, asks, label) {
    const requestId = crypto.randomUUID();
    const { devices, network, declared } = asks;
    const entry = {
      requestId,
      discoveryKey: discoveryKeyHex,
      devices,
      network,
      label: label ?? null,
      userData: getPeerUserData(discoveryKeyHex) ?? null,
      requestedAt: Date.now(),
    };
    appendAudit('peer:exec:device-requested', {
      requestId,
      discoveryKey: discoveryKeyHex,
      devices,
      network,
      declared: declared ?? null,
      label,
    });

    let settle;
    const promise = new Promise((resolve) => {
      settle = (approved, reason) => {
        if (!deviceRequests.has(requestId)) return;
        clearTimeout(timer);
        deviceRequests.delete(requestId);
        appendAudit('peer:exec:device-resolved', {
          requestId,
          discoveryKey: discoveryKeyHex,
          devices,
          network,
          approved,
          reason,
        });
        emit('peer:exec:device-resolved', {
          requestId,
          discoveryKey: discoveryKeyHex,
          approved,
          reason,
        });
        resolve({ approved, reason });
      };
      const timer = setTimeout(() => settle(false, 'timeout'), DEVICE_CONSENT_TIMEOUT_MS);
      if (typeof timer.unref === 'function') timer.unref();
      deviceRequests.set(requestId, { ...entry, settle });
      emit('peer:exec:device-request', entry);
    });
    // `deny` lets a cancel unpark the run without waiting for a human.
    return { promise, deny: (reason) => settle(false, reason) };
  }

  /** Answer a pending device-access prompt. Anything but an explicit true denies. */
  function resolveDeviceRequest(requestId, approved) {
    const pending = deviceRequests.get(requestId);
    if (!pending) return false;
    pending.settle(approved === true, approved === true ? 'approved' : 'denied');
    return true;
  }

  function listDeviceRequests() {
    return Array.from(deviceRequests.values()).map(({ settle, ...rest }) => rest);
  }

  /** SIGTERM now, SIGKILL after the grace window. Returns whether a signal was
   * sent, not whether the run ended. */
  function terminate(run) {
    if (!isAlive(run.child)) return false;
    killGroup(run.child, 'SIGTERM');
    if (run.killTimer) clearTimeout(run.killTimer);
    run.killTimer = setTimeout(() => {
      if (isAlive(run.child)) killGroup(run.child, 'SIGKILL');
    }, SIGKILL_GRACE_MS);
    if (typeof run.killTimer.unref === 'function') run.killTimer.unref();
    return true;
  }

  /**
   * Stop the run on this peer, whichever phase it is in. A run parked on a
   * device prompt has no child yet, so it is cancelled by denying its own
   * consent request; spawnRun then unwinds before wrapping anything.
   */
  function cancel(discoveryKeyHex, reason = 'cancelled') {
    const run = runs.get(discoveryKeyHex);
    if (!run) return false;
    run.cancelled = true;
    appendAudit('peer:exec:cancel', {
      discoveryKey: discoveryKeyHex,
      phase: run.phase,
      reason,
    });
    if (run.phase === 'awaiting-consent') {
      run.denyConsent?.('cancelled');
      return true;
    }
    // No child to signal yet, and the wait would otherwise run its full
    // timeout with the peer slot held and Stop looking dead.
    if (run.phase === 'awaiting-identity') {
      run.denyIdentityWait?.();
      return true;
    }
    return terminate(run);
  }

  function handleRequest(discoveryKeyHex, msg) {
    // The cheapest refusal first: a peer that is already over its budget
    // gets a stable code and the run never starts.
    if (!rateAllow('exec:request', discoveryKeyHex)) {
      fail(discoveryKeyHex, 'rate-limited', 'exec:request over budget for this peer', {
        mode: msg?.mode ?? null,
        fileName: msg?.fileName ?? null,
      });
      return;
    }

    if (getSecretScheme() === UNSEALED_STORAGE_SCHEME) {
      fail(discoveryKeyHex, 'unsealed-storage', 'identity sealing fell back to a file key', {
        scheme: UNSEALED_STORAGE_SCHEME,
      });
      return;
    }

    // Revocation drops the pairing, so reaching here means the drop is still in
    // flight. Checked again anyway: this is the gate the run passes through.
    if (refusedAsRevoked(discoveryKeyHex)) return;

    const existing = runs.get(discoveryKeyHex);
    if (existing) {
      const age = Date.now() - existing.startedAt;
      if (age > STALE_RUN_MS && isAlive(existing.child)) {
        killGroup(existing.child, 'SIGKILL');
        // The exit handler tears the state down; the peer can retry once it has.
      }
      sendReply(discoveryKeyHex, {
        kind: 'error',
        code: 'run-in-progress',
        message: PEER_ERROR_TEXT['run-in-progress'],
      });
      return;
    }
    spawnRun(discoveryKeyHex, msg).catch((err) => {
      // A throw from inside spawnRun is what makes the silent failure
      // (peer exec returns nothing, run directory leaks). Run the same
      // cleanup fail() / finishRun() take on a deliberate refusal, so the
      // peer gets a stable code, the audit event lands, and the run
      // directory is removed.
      console.warn('[peer] spawnRun failed:', err?.message ?? err);
      const run = runs.get(discoveryKeyHex);
      fail(discoveryKeyHex, 'spawn-failed', err?.message ?? String(err), {
        mode: msg?.mode ?? null,
        fileName: msg?.fileName ?? null,
      });
      if (run) finishRun(discoveryKeyHex, run);
      else runs.delete(discoveryKeyHex);
    });
  }

  // Peer-exec always requires a real kernel sandbox. Never fall open to naked
  // spawn. Async because a device request waits on a human.
  async function spawnRun(discoveryKeyHex, msg) {
    const {
      code: rawCode,
      mode = 'inline',
      argv: rawArgv = [],
      fileName: rawFileName = 'snippet.mts',
      label = null,
    } = msg;

    let code;
    let argv;
    let fileName;
    try {
      code = sanitizeExecCode(rawCode);
      argv = sanitizeExecArgv(rawArgv);
      if (mode !== 'inline' && mode !== 'file') {
        throw new Error(`exec: mode must be 'inline' or 'file', got ${mode}`);
      }
      // Basename on the host — never trust remote path segments.
      fileName = sanitizeExecFileName(path.basename(String(rawFileName || 'snippet.mts')));
    } catch (err) {
      fail(discoveryKeyHex, 'invalid-request', err?.message ?? String(err), {
        mode: mode ?? null,
        fileName: null,
      });
      return;
    }

    const run = {
      child: null,
      phase: 'starting',
      startedAt: Date.now(),
      mode,
      fileName,
      label,
      fileDir: null,
      killTimer: null,
      cancelled: false,
      denyConsent: null,
      denyIdentityWait: null,
      useKernelSandbox: true,
    };
    // Before the first await, so the slot covers the waits below.
    runs.set(discoveryKeyHex, run);

    // Pairing gets a human's approval. The handshake is what proves which
    // device key is on the wire, and a guest that pipelines a request on
    // channel open reaches here ahead of its own proof reply. Everything below
    // that reads a device key needs this wait to have happened.
    run.phase = 'awaiting-identity';
    const verified = await Promise.race([
      awaitDeviceVerified(discoveryKeyHex, IDENTITY_WAIT_MS),
      new Promise((resolve) => {
        run.denyIdentityWait = () => resolve({ ok: false, reason: 'cancelled' });
      }),
    ]);
    run.denyIdentityWait = null;
    run.phase = 'starting';
    if (!verified?.ok) {
      const stopped = verified.reason === 'cancelled' || run.cancelled;
      fail(
        discoveryKeyHex,
        stopped ? 'cancelled' : 'unverified',
        stopped ? 'cancelled during the identity wait' : 'identity handshake did not settle',
        { mode, fileName, reason: verified.reason ?? 'unverified' },
      );
      finishRun(discoveryKeyHex, run);
      return;
    }
    // The first read of the revocation list against a key nobody self-reported.
    if (refusedAsRevoked(discoveryKeyHex)) {
      finishRun(discoveryKeyHex, run);
      return;
    }
    if (run.cancelled) {
      fail(discoveryKeyHex, 'cancelled', 'cancelled before the run started', { mode, fileName });
      finishRun(discoveryKeyHex, run);
      return;
    }

    // The host installs these, never the child. See mcp-warm.cjs.
    const wanted = npxPackages(code);
    if (wanted.length > 0) {
      const allowed = sandbox.allowedMcpPackages();
      const refused = wanted.filter((pkg) => !allowed.includes(pkg));
      if (refused.length > 0) {
        fail(discoveryKeyHex, 'package-not-allowed', `refused packages: ${refused.join(', ')}`, {
          mode,
          fileName,
          packages: refused,
        });
        finishRun(discoveryKeyHex, run);
        return;
      }
      const warm = sandbox.warmPackages(sandbox.npmCacheDir(), wanted);
      if (!warm.ok) {
        fail(
          discoveryKeyHex,
          'package-prepare-failed',
          `could not prepare ${warm.failed.map((f) => `${f.pkg}: ${f.error}`).join('; ')}`,
          { mode, fileName },
        );
        finishRun(discoveryKeyHex, run);
        return;
      }
      appendAudit('peer:exec:mcp-warmed', { discoveryKey: discoveryKeyHex, packages: wanted });
    }

    // A lesson whose dependency needs Node builtins runs on the app's own
    // Electron binary instead. Same sandbox profile either way — the kernel
    // rules come from the capability, not from which interpreter is spawned —
    // so this widens the child's standard library, not its permissions.
    const nodeOnly = detectNodeOnly(code);
    const runtime = nodeOnly ? 'node' : 'bare';
    run.runtime = runtime;

    // Both decided host-side from the code, not from the peer's claim. A denial
    // refuses the run: a muted mic and a download that waits on a socket that
    // never opens both look like a lesson that does not work. The declared
    // frontmatter widens the union but never narrows it; the host's detector
    // stays the trust boundary.
    const detectedDevices = detectDeviceNeeds(code);
    const detectedNet = detectNetworkNeed(code);
    const declared = msg.declared ?? {};
    const declaredDevices = Array.isArray(declared.device) ? declared.device : [];
    // Take the wider of declared vs detected network mode. none < localhost < all.
    const netOrder = { none: 0, localhost: 1, all: 2 };
    const declaredNetRank = netOrder[declared.network ?? 'none'] ?? 0;
    const detectedNetRank = netOrder[detectedNet.mode] ?? 0;
    const netMode = declaredNetRank > detectedNetRank
      ? (declared.network ?? detectedNet.mode)
      : detectedNet.mode;
    const netReason = detectedNetReason(detectedNet, declared);
    const wantedDevices = Array.from(new Set([...detectedDevices, ...declaredDevices]));

    // A loopback ask under bwrap comes out as full egress, and the human who
    // approved "this machine only" did not approve that. So refuse it.
    const netScope = sandbox.enforcedNetworkScope(netMode);
    if (netScope !== netMode) {
      fail(
        discoveryKeyHex,
        'network-unenforceable',
        `sandbox enforces ${netScope} for a requested ${netMode}`,
        { mode, fileName, network: netMode, networkScope: netScope },
      );
      finishRun(discoveryKeyHex, run);
      return;
    }

    const grants = [];
    if (wantedDevices.length > 0 || netMode !== 'none') {
      run.phase = 'awaiting-consent';
      const consent = requestConsent(
        discoveryKeyHex,
        {
          devices: wantedDevices,
          network: netReason,
          declared: {
            network: msg.declared?.network,
            device: msg.declared?.device,
          },
        },
        label,
      );
      run.denyConsent = consent.deny;
      const { approved, reason } = await consent.promise;
      run.denyConsent = null;
      run.phase = 'starting';
      if (!approved) {
        fail(
          discoveryKeyHex,
          reason === 'cancelled' ? 'cancelled-awaiting-consent' : 'consent-denied',
          `consent ${reason} for ${[...wantedDevices, netMode].join(', ')}`,
          { mode, fileName, devices: wantedDevices, network: netReason },
        );
        finishRun(discoveryKeyHex, run);
        return;
      }
      grants.push(...wantedDevices);
      if (netMode === 'localhost') grants.push('network-loopback');
      else if (netMode === 'all') grants.push('network');
    }

    if (run.cancelled) {
      fail(discoveryKeyHex, 'cancelled', 'cancelled before the run started', { mode, fileName });
      finishRun(discoveryKeyHex, run);
      return;
    }

    // A cached model the app did not download is one this run's inference
    // engine would parse anyway. Stat plus recorded hash is the steady-state
    // path: a hash-on-record costs one stat, no read. The first read for an
    // unrecorded file happens here, off the swarm path, with setImmediate
    // yielding so the DHT can breathe while the bytes stream.
    const wantedModels = referencedModels(code);
    let changedModels = [];
    let mismatchedModels = [];
    try {
      const result = await verifyModelsAsync(wantedModels);
      changedModels = scan().size > 0 ? syncFast().changed : [];
      mismatchedModels = result.mismatched;
    } catch (err) {
      console.warn('[peer] model integrity check failed:', err?.message ?? err);
    }
    if (mismatchedModels.length > 0 || changedModels.length > 0) {
      appendAudit('peer:exec:model-integrity', {
        discoveryKey: discoveryKeyHex,
        changed: changedModels,
        mismatched: mismatchedModels,
      });
      fail(
        discoveryKeyHex,
        'model-integrity',
        mismatchedModels.length > 0
          ? `${mismatchedModels.length} cached model file(s) have bytes that do not match the recorded hash`
          : `${changedModels.length} cached model file(s) changed outside the app`,
        { mode, fileName, changedModels },
      );
      finishRun(discoveryKeyHex, run);
      return;
    }

    // The host picks the workspace, not the peer: a `cwd` in the request would
    // let a remote choose where writes land.
    const childCwd = lessonCwd();
    // Made here so the snippet and the sandbox grant name one directory.
    run.fileDir = sandbox.makeRunDir();
    // Node reads flags before the script and bare reads them after, so the
    // runtime owns its own; the peer's argv always lands on the script.
    const nodeFlags = runtime === 'node'
      ? ['--experimental-strip-types', '--no-warnings',
         ...(process.platform === 'darwin' ? ['--require', DOCK_HIDE_SHIM] : [])]
      : [];
    let args;
    if (mode === 'file') {
      const file = path.join(run.fileDir, fileName);
      // Containment: the resolved path must stay under the temp dir.
      if (!file.startsWith(run.fileDir + path.sep)) {
        fail(discoveryKeyHex, 'filename-escape', 'fileName escaped the run directory', {
          mode,
          fileName: null,
        });
        finishRun(discoveryKeyHex, run);
        return;
      }
      fs.writeFileSync(file, code, 'utf-8');
      args = [...nodeFlags, file, ...argv];
    } else {
      args = [...nodeFlags, '-e', code, ...argv];
    }

    // The chmod happens host-side: the child cannot write under node_modules.
    // The SDK spawns bare as its own worker, so it is prepared either way.
    const bareRuntimeBinPath = getBareRuntimeBinPath();
    precreateOutputDirs(code, childCwd);
    run.outputsBefore = snapshotOutputs(childCwd);
    const bareBin = ensureBareExecutable(bareRuntimeBinPath);

    const interpreter = runtime === 'node' ? getExecPath() : bareBin;
    if (!interpreter) {
      fail(discoveryKeyHex, 'runtime-missing', `${runtime} runtime not resolvable`, {
        mode,
        fileName,
        runtime,
      });
      finishRun(discoveryKeyHex, run);
      return;
    }

    let wrap = null;
    let wrapErr = null;
    try {
      wrap = sandbox.wrapSpawn(
        interpreter,
        args,
        {
          cwd: childCwd,
          bareRuntimeBinPath,
          grants,
          runDir: run.fileDir,
          runtime,
          // The host's resolved userData, so the capability profile denies
          // the real state directory rather than the home-default. Without
          // this, `--storage` makes the two diverge.
          userData: getUserData(),
        },
        'qvac',
      );
    } catch (err) {
      wrapErr = err;
      console.warn('[peer] sandbox.wrapSpawn failed:', err?.message ?? err);
    }

    if (!wrap || !wrap.sandboxed) {
      // sandboxRefusalMessage names paths and platform detail, and the
      // warnings carry more of both, so both stay on this side of the wire.
      const message = sandboxRefusalMessage(wrap, wrapErr);
      fail(discoveryKeyHex, 'sandbox-unavailable', message, {
        mode,
        fileName,
        sandboxMode: wrap?.mode ?? 'unavailable',
        sandboxed: false,
        warnings: wrap?.warnings ?? [],
      });
      appendAudit('peer:exec:sandboxed', {
        discoveryKey: discoveryKeyHex,
        mode,
        fileName,
        label,
        sandboxed: false,
        sandboxMode: wrap?.mode ?? 'unavailable',
        network: { requested: netMode, enforced: wrap?.networkScope ?? null },
        warnings: wrap?.warnings ?? [message],
        refused: true,
      });
      finishRun(discoveryKeyHex, run);
      return;
    }

    appendAudit('peer:exec:sandboxed', {
      discoveryKey: discoveryKeyHex,
      mode,
      fileName,
      label,
      sandboxed: true,
      sandboxMode: wrap.mode,
      runtime,
      grants,
      network: { requested: netMode, enforced: wrap.networkScope ?? null },
      warnings: wrap.warnings ?? [],
    });

    // What the cache held before the run, so a failure can undo what it added.
    try {
      run.modelsBefore = new Set(scan().keys());
    } catch {
      run.modelsBefore = null;
    }

    // bwrap reads its filter from a descriptor, so the program has to be open
    // on the slot the wrap named before the child exists. Closed in the parent
    // as soon as it is inherited.
    const seccompFd = wrap.seccompFilter ? sandbox.openSeccompFd(wrap.seccompFilter) : null;
    // Stdio can include a raw file descriptor for the seccomp filter slot.
    // bare-subprocess types it as `(number | Stream | IOType | "ipc")[]`; the
    // JSDoc on the array carries the type past the literal.
    /** @type {Array<'ignore' | 'pipe' | 'ipc' | number>} */
    const stdio = ['ignore', 'pipe', 'pipe'];
    if (seccompFd !== null) stdio.push(seccompFd);

    let child;
    try {
      child = spawn(wrap.command, wrap.args, {
        cwd: childCwd,
        env: wrap.env,
        stdio,
        // Own process group for killGroup. Not unref'd: this process still owns
        // the run's lifetime.
        detached: true,
      });
    } finally {
      if (seccompFd !== null) {
        try {
          fs.closeSync(seccompFd);
        } catch {
          // spawn may have consumed it already
        }
      }
    }
    run.child = child;
    run.phase = 'running';
    run.startedAt = Date.now();

    // A cancel that arrived between the consent answer and here had no child to
    // signal, so honour it now that there is one.
    if (run.cancelled) terminate(run);

    appendAudit('peer:exec:started', { discoveryKey: discoveryKeyHex, mode, fileName, label });
    sendReply(discoveryKeyHex, { kind: 'started', mode, fileName, label });

    const stderrFilter = createNoiseFilter();
    // When the child is alive but has not produced output for RUN_FINAL_IDLE_MS
    // after the first chunk, the SDK's model worker is keeping the process
    // alive past the lesson's main flow. Force the run closed so the
    // renderer returns to idle.
    let firstChunkAt = 0;
    let finalIdleTimer = null;
    const armFinalIdle = () => {
      if (finalIdleTimer) clearTimeout(finalIdleTimer);
      finalIdleTimer = setTimeout(() => {
        if (!isAlive(child) || run.cancelled || run.phase !== 'running') return;
        reportExit(discoveryKeyHex, run, { code: 0, signal: null, source: 'final-idle' });
      }, RUN_FINAL_IDLE_MS);
      if (typeof finalIdleTimer.unref === 'function') finalIdleTimer.unref();
    };
    // The stdio array above names 'pipe' for stdout/stderr, so child.stdout
    // and child.stderr are non-null at runtime. The JSDoc satisfies the
    // checker without a defensive branch that would otherwise be dead code.
    /** @type {NodeJS.ReadableStream} */
    const childStdout = child.stdout;
    /** @type {NodeJS.ReadableStream} */
    const childStderr = child.stderr;
    childStdout.on('data', (chunk) => {
      if (firstChunkAt === 0) firstChunkAt = Date.now();
      armFinalIdle();
      sendReply(discoveryKeyHex, { kind: 'chunk', stream: 'stdout', data: chunk.toString('utf8') });
    });
    childStderr.on('data', (chunk) => {
      if (firstChunkAt === 0) firstChunkAt = Date.now();
      armFinalIdle();
      const data = stderrFilter.push(chunk.toString('utf8'));
      if (data) sendReply(discoveryKeyHex, { kind: 'chunk', stream: 'stderr', data });
    });
    child.on('error', (err) => {
      if (finalIdleTimer) clearTimeout(finalIdleTimer);
      if (!isCurrent(discoveryKeyHex, run)) return;
      fail(discoveryKeyHex, 'spawn-failed', err?.message ?? String(err), { mode, fileName });
      finishRun(discoveryKeyHex, run);
    });
    child.on('exit', (exitCode, signal) => {
      if (finalIdleTimer) clearTimeout(finalIdleTimer);
      // Whatever already reported this run also killed the group on its way
      // out, so this exit is the host's own SIGKILL rather than the lesson's
      // result. Reporting it turned a finished run into a stopped one.
      if (!isCurrent(discoveryKeyHex, run)) return;
      const tail = stderrFilter.end();
      if (tail) sendReply(discoveryKeyHex, { kind: 'chunk', stream: 'stderr', data: tail });

      // Not through stderrFilter: the host wrote this, not the child.
      try {
        const note = describeNewOutputs(run.outputsBefore ?? new Map(), lessonCwd());
        if (note) sendReply(discoveryKeyHex, { kind: 'chunk', stream: 'stderr', data: note });
      } catch {
        // advisory only
      }

      // Fail closed on SIGTRAP: do not re-run unsandboxed.
      if (signal === 'SIGTRAP' && run.useKernelSandbox && !run.cancelled) {
        fail(discoveryKeyHex, 'sigtrap', 'child trapped under the OS sandbox', {
          mode,
          fileName,
          signal: 'SIGTRAP',
        });
        finishRun(discoveryKeyHex, run);
        return;
      }

      reportExit(discoveryKeyHex, run, {
        code: exitCode,
        signal: signal ?? null,
        source: 'exit',
      });
      if (exitCode !== 0) revertModelAdditions(discoveryKeyHex, run);
    });
  }

  /** Stop a peer's run without waiting for it, e.g. when the peer is dropped. */
  function stopFor(discoveryKeyHex) {
    const run = runs.get(discoveryKeyHex);
    if (!run) return;
    run.cancelled = true;
    run.denyConsent?.('cancelled');
    run.denyIdentityWait?.();
    // The child's own exit arrives after the slot has been released, so a run
    // that had reached spawn is reported here or not at all.
    if (terminate(run)) {
      reportExit(discoveryKeyHex, run, { code: null, signal: 'SIGTERM', source: 'stopped' });
    }
    finishRun(discoveryKeyHex, run);
  }

  /** Teardown: every run on every peer. */
  function stopAll() {
    for (const discoveryKeyHex of Array.from(runs.keys())) {
      stopFor(discoveryKeyHex);
    }
    runs.clear();
    deviceRequests.clear();
  }

  return {
    handleRequest,
    cancel,
    stopFor,
    stopAll,
    resolveDeviceRequest,
    listDeviceRequests,
    hasRun: (discoveryKeyHex) => runs.has(discoveryKeyHex),
  };
}

module.exports = {
  createExecHost,
  isAlive,
  PEER_ERROR_TEXT,
  WIRE_SAFE_META,
  SIGKILL_GRACE_MS,
  DEVICE_CONSENT_TIMEOUT_MS,
  RUN_FINAL_IDLE_MS,
};
