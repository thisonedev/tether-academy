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
const { detectNetworkNeed, referencedModels, modelRegistry, modelDownloadProgress } = require('./exec-network.cjs');
const {
  lessonCwd,
  precreateOutputDirs,
  snapshotOutputs,
  describeNewOutputs,
} = require('../../shared/lesson-output.cjs');
const { syncFast, scan, removeAddedSince, verifyModelsAsync, pruneTruncatedModels, findTruncatedModels, cacheBytes, acceptAll } = require('../../shared/model-integrity.cjs');
// Cache entries are prefixed with the SDK's content hash, same convention as model-integrity.cjs.
const CACHE_HASH_PREFIX = /^[0-9a-f]{16}_/;
const { substitutePortableImports } = require('../../shared/portable-lesson-imports.cjs');
// Runs under Bare (workers/entry.cjs), so it can't require electron/chat.cjs
// directly; ctx.runSecurityScan bridges to it over RPC instead.

// The sender's require.resolve() path for @qvac/sdk and bare builtins is
// wrong here; resolve fresh with this worker's own require.resolve instead.
function resolvePortableSdk() {
  return require.resolve('@qvac/sdk');
}
function resolvePortableBuiltin(pkg) {
  return require.resolve(pkg);
}

// --require'd into a node-runtime child so it does not claim a Dock icon.
const DOCK_HIDE_SHIM = path.resolve(__dirname, '..', '..', 'electron', 'dock-hide-shim.cjs');

// No answer is a denial. The prompt can be missed.
const DEVICE_CONSENT_TIMEOUT_MS = 2 * 60_000;
// One round trip on an already-open channel; a wait this long means no answer is coming.
const IDENTITY_WAIT_MS = 10_000;
// The scan loads its own model before it can look at the code; a run has no
// child yet at this point, so a hung load would otherwise wedge it forever.
const SECURITY_SCAN_TIMEOUT_MS = 30_000;
// Hardware that cannot finish the review inside its timeout pays the timeout
// and the CPU on every run and never gets a verdict, so stop asking after this
// many consecutive failures. A single success clears it.
const SECURITY_SCAN_FAILURE_LIMIT = 2;
// Native inference ignores SIGTERM, hence the grace before SIGKILL.
const SIGKILL_GRACE_MS = 3_000;
// SIGKILL can't reap a child stuck in an uninterruptible kernel wait (e.g. a
// GPU driver call). Past this, stop waiting for a real exit and free the slot anyway.
const FORCE_REAP_MS = 5_000;
// A run alive this long has outlived any cancel sent to it; force-kill so the slot frees.
const STALE_RUN_MS = 5 * 60_000;
let _testStaleRunMs = null;
// No new output for this long after the first chunk closes the run. SDK model
// workers can keep the child alive past the lesson's main flow (BCI lessons
// hit this), so waiting on child.on('exit') alone would stay stuck in Running.
const RUN_FINAL_IDLE_MS = 30_000;
// How often the host reports download progress it can see from disk.
const DOWNLOAD_TICK_MS = 3_000;
// A download that has grown by nothing for this long has stopped for a reason
// the run cannot recover from (no route to the registry, a full disk). Short
// stalls are normal on a slow link, so this is generous.
const DOWNLOAD_STALL_MS = 5 * 60_000;
// Fallback sealing: the identity record's decrypt key is a file on disk
// rather than a keychain entry, one bug away from the device secret key.
const UNSEALED_STORAGE_SCHEME = 'aes-gcm-local';

// What a refused peer is told, keyed by the code sent alongside it. Fixed
// text: a failure carries nothing about the host's own disk, account, or tooling.
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
  'security-flagged': 'Peer exec refused: this device\'s AI security review flagged the '
    + 'code as unrelated to the declared lesson or potentially harmful.',
  'filename-escape': 'exec: fileName escaped temp directory',
  'runtime-missing': (meta) =>
    `Peer exec refused: the ${meta.runtime ?? 'requested'} runtime is not available on this device.`,
  'portable-import-unresolved': (meta) =>
    `Peer exec refused: this device is missing ${(meta.unresolved ?? []).join(', ') || 'a required package'}.`,
  'sandbox-unavailable': 'Peer exec refused: the OS sandbox is not available on this device.',
  'spawn-failed': 'Peer exec failed: the run could not be started on this device.',
  sigtrap: 'Peer exec aborted: process trapped under the OS sandbox (SIGTRAP). '
    + 'Refusing to retry without confinement.',
  'rate-limited': 'Peer exec refused: too many requests from this device. Try again later.',
};

// Meta fields a peer may see: each is either the peer's own input or a host
// constant. Everything else (warnings, changed model names) stays local.
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
 * Node sets it once a signal has been *sent*, so a process ignoring SIGTERM
 * still reads as `killed`.
 */
function isAlive(child) {
  return !!child && child.exitCode === null && child.signalCode === null;
}

/**
 * Signal the child's whole process group (children spawn detached, so the
 * group id is the child pid). An orphaned QVAC worker grandchild keeps its
 * lock on the registry corestore, failing every later model download until killed.
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
  } catch {}
}

// Cap on code kept in the consent prompt / audit trail; local-only, never sent to the peer.
const MAX_CODE_PREVIEW_BYTES = 20_000;
function previewCode(code) {
  if (typeof code !== 'string') return '';
  if (code.length <= MAX_CODE_PREVIEW_BYTES) return code;
  return `${code.slice(0, MAX_CODE_PREVIEW_BYTES)}\n… [truncated, ${code.length} bytes total]`;
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
 * @param {(payload: { code: string, lessonKey: null, lessonReference: string | null, modelHint: undefined, timeoutMs: number }) => Promise<{ modelName: string | null, result: { verdict: string, concerns: Array<{ summary: string, snippet: string }> } }>} [ctx.runSecurityScan]
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
    // index.cjs overrides this with the real RPC bridge; unconfigured, it
    // rejects, which spawnRun's catch treats as 'unavailable', not a silent skip.
    runSecurityScan = async () => {
      throw new Error('security scan not configured');
    },
  } = ctx;

  // Consecutive review failures on this device. Per host rather than module
  // scope so one host's bad hardware can't switch the review off elsewhere.
  let securityScanFailures = 0;

  // discoveryKey -> in-flight run, set from the moment a request is accepted
  // (including while parked on a device answer), so one peer holds one slot.
  const runs = new Map();
  // Runs parked at the sandbox boundary awaiting a human answer.
  const deviceRequests = new Map();
  // discoveryKey -> resolvers waiting on that peer's slot freeing up, so a
  // request racing a stale-run kill can wait for it instead of being refused.
  const slotWaiters = new Map();

  function waitForSlotFree(discoveryKeyHex, timeoutMs) {
    if (!runs.has(discoveryKeyHex)) return Promise.resolve(true);
    return new Promise((resolve) => {
      const waiters = slotWaiters.get(discoveryKeyHex) ?? [];
      const onFree = () => {
        clearTimeout(timer);
        resolve(true);
      };
      const timer = setTimeout(() => {
        const list = slotWaiters.get(discoveryKeyHex);
        if (list) {
          const idx = list.indexOf(onFree);
          if (idx !== -1) list.splice(idx, 1);
          if (list.length === 0) slotWaiters.delete(discoveryKeyHex);
        }
        resolve(false);
      }, timeoutMs);
      if (typeof timer.unref === 'function') timer.unref();
      waiters.push(onFree);
      slotWaiters.set(discoveryKeyHex, waiters);
    });
  }

  /**
   * Refuse a run. The peer gets a stable `code` and fixed text for it; the
   * message the host actually produced (which can name local paths and
   * account details) stays in the local audit trail only.
   * @param {string} discoveryKeyHex
   * @param {keyof PEER_ERROR_TEXT} code
   * @param {string} localMessage what the host saw, for the audit trail only
   * @param {object} [meta] recorded locally; only WIRE_SAFE_META reaches the peer
   */
  function fail(discoveryKeyHex, code, localMessage, meta = {}) {
    sendReply(discoveryKeyHex, {
      kind: 'error',
      code,
      // Echoes the request's own id, so a reply to a since-superseded request
      // (e.g. a stale run's late refusal) can't be mistaken for a fresh one's.
      runId: meta.runId,
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
  function refusedAsRevoked(discoveryKeyHex, runId) {
    const revokedDeviceKey = getRevokedDeviceKey(discoveryKeyHex);
    if (!revokedDeviceKey) return false;
    fail(discoveryKeyHex, 'revoked', 'device is on the revocation list', {
      runId,
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
    if (run.downloadTicker) clearInterval(run.downloadTicker);
    // A clean exit still leaves the worker running if the lesson never
    // unloaded its model, so sweep the group either way.
    killGroup(run.child, 'SIGKILL');
    // A SIGKILL'd run never runs its own JS-level cleanup, so its QVAC worker
    // can outlive it; a moment later gives the OS time to actually reap
    // run.child first, so the reaper sees its parent as dead.
    const reapTimer = setTimeout(() => {
      try {
        require('../../shared/qvac-orphan-reaper.cjs').reapOrphanedQvacWorkers();
      } catch {}
    }, 500);
    if (typeof reapTimer.unref === 'function') reapTimer.unref();
    removeDir(run.fileDir);
    runs.delete(discoveryKeyHex);
    const waiters = slotWaiters.get(discoveryKeyHex);
    if (waiters) {
      slotWaiters.delete(discoveryKeyHex);
      for (const resolve of waiters) resolve();
    }
  }

  /**
   * Report how a run ended, once. Whoever gets here first owns the outcome:
   * finishRun sweeps the process group, so every later exit belongs to that sweep.
   * @param {string} discoveryKeyHex
   * @param {object} run
   * @param {{ code: number | null, signal: string | null, source: string }} outcome
   */
  function reportExit(discoveryKeyHex, run, { code, signal, source }) {
    if (!isCurrent(discoveryKeyHex, run)) return;
    sendReply(discoveryKeyHex, {
      kind: 'exit',
      runId: run.runId,
      code,
      signal,
      // Lets the renderer distinguish a user-initiated Stop from an actual
      // crash, so a SIGTRAP-on-cleanup doesn't surface as "stopped by SIGTRAP".
      cancelled: run.cancelled || undefined,
      mode: run.mode,
      fileName: run.fileName,
    });
    appendAudit('peer:exec:finished', {
      discoveryKey: discoveryKeyHex,
      code,
      signal,
      mode: run.mode,
      fileName: run.fileName,
      label: run.label,
      cancelled: run.cancelled || undefined,
      source,
    });
    finishRun(discoveryKeyHex, run);
  }

  /**
   * Park the run on a human. One prompt covers everything asked for;
   * `concerns`/`sourcePreview` are attached whenever present so approving is never blind.
   * @param {string} discoveryKeyHex
   * @param {{ devices: string[], network: string | null, declared?: { network?: string, device?: string[] }, concerns?: string[], sourcePreview?: string }} asks
   * @param {string | null} label
   */
  function requestConsent(discoveryKeyHex, asks, label) {
    const requestId = crypto.randomUUID();
    const { devices, network, declared, concerns, sourcePreview } = asks;
    const entry = {
      requestId,
      discoveryKey: discoveryKeyHex,
      devices,
      network,
      label: label ?? null,
      userData: getPeerUserData(discoveryKeyHex) ?? null,
      requestedAt: Date.now(),
      ...(concerns && concerns.length > 0 ? { concerns } : {}),
      ...(sourcePreview ? { sourcePreview } : {}),
    };
    appendAudit('peer:exec:device-requested', {
      requestId,
      discoveryKey: discoveryKeyHex,
      devices,
      network,
      declared: declared ?? null,
      label,
      concerns: concerns && concerns.length > 0 ? concerns : undefined,
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

  /**
   * A child still alive after SIGKILL is stuck in an uninterruptible kernel
   * wait; no signal will end it. Stop waiting and report the run over anyway,
   * so a Stop click can't hang forever on a process nothing can actually kill.
   */
  function forceReap(discoveryKeyHex, run) {
    if (!isCurrent(discoveryKeyHex, run) || !isAlive(run.child)) return;
    reportExit(discoveryKeyHex, run, { code: null, signal: 'SIGKILL', source: 'force-reap' });
  }

  /** SIGTERM now, SIGKILL after the grace window, then give up on it. Returns
   * whether a signal was sent, not whether the run ended. */
  function terminate(discoveryKeyHex, run) {
    if (!isAlive(run.child)) return false;
    killGroup(run.child, 'SIGTERM');
    if (run.killTimer) clearTimeout(run.killTimer);
    run.killTimer = setTimeout(() => {
      if (isAlive(run.child)) killGroup(run.child, 'SIGKILL');
      run.killTimer = setTimeout(() => forceReap(discoveryKeyHex, run), FORCE_REAP_MS);
      if (typeof run.killTimer.unref === 'function') run.killTimer.unref();
    }, SIGKILL_GRACE_MS);
    if (typeof run.killTimer.unref === 'function') run.killTimer.unref();
    return true;
  }

  /**
   * Stop the run on this peer, whichever phase it's in. A run parked on a
   * device prompt has no child yet, so it's cancelled via its consent request.
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
    // Same reasoning, for the security scan's own model load: it has no
    // dedicated phase name, so check the resolver directly instead.
    if (run.denyScanWait) {
      run.denyScanWait();
      return true;
    }
    return terminate(discoveryKeyHex, run);
  }

  function handleRequest(discoveryKeyHex, msg) {
    if (!rateAllow('exec:request', discoveryKeyHex)) {
      fail(discoveryKeyHex, 'rate-limited', 'exec:request over budget for this peer', {
        runId: msg?.runId,
        mode: msg?.mode ?? null,
        fileName: msg?.fileName ?? null,
      });
      return;
    }

    if (getSecretScheme() === UNSEALED_STORAGE_SCHEME) {
      fail(discoveryKeyHex, 'unsealed-storage', 'identity sealing fell back to a file key', {
        runId: msg?.runId,
        scheme: UNSEALED_STORAGE_SCHEME,
      });
      return;
    }

    if (refusedAsRevoked(discoveryKeyHex, msg?.runId)) return;

    const existing = runs.get(discoveryKeyHex);
    if (existing) {
      const age = Date.now() - existing.startedAt;
      if (age > (_testStaleRunMs ?? STALE_RUN_MS) && isAlive(existing.child)) {
        killGroup(existing.child, 'SIGKILL');
        if (existing.killTimer) clearTimeout(existing.killTimer);
        existing.killTimer = setTimeout(() => forceReap(discoveryKeyHex, existing), FORCE_REAP_MS);
        if (typeof existing.killTimer.unref === 'function') existing.killTimer.unref();
        // The kill above is what frees the slot; wait for it instead of
        // refusing the request that arrived right as recovery started.
        waitForSlotFree(discoveryKeyHex, FORCE_REAP_MS + 1_000).then((freed) => {
          if (freed) handleRequest(discoveryKeyHex, msg);
          else {
            sendReply(discoveryKeyHex, {
              kind: 'error',
              runId: msg?.runId,
              code: 'run-in-progress',
              message: PEER_ERROR_TEXT['run-in-progress'],
            });
          }
        });
        return;
      }
      sendReply(discoveryKeyHex, {
        kind: 'error',
        runId: msg?.runId,
        code: 'run-in-progress',
        message: PEER_ERROR_TEXT['run-in-progress'],
      });
      return;
    }
    spawnRun(discoveryKeyHex, msg).catch((err) => {
      // Run the same cleanup a deliberate refusal takes, so an unhandled
      // throw doesn't leave a silent failure with a leaked run directory.
      console.warn('[peer] spawnRun failed:', err?.message ?? err);
      const run = runs.get(discoveryKeyHex);
      fail(discoveryKeyHex, 'spawn-failed', err?.message ?? String(err), {
        runId: msg?.runId,
        mode: msg?.mode ?? null,
        fileName: msg?.fileName ?? null,
      });
      if (run) finishRun(discoveryKeyHex, run);
      else runs.delete(discoveryKeyHex);
    });
  }

  // Async because a device request waits on a human.
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
      // Basename on the host; never trust remote path segments.
      fileName = sanitizeExecFileName(path.basename(String(rawFileName || 'snippet.mts')));
    } catch (err) {
      fail(discoveryKeyHex, 'invalid-request', err?.message ?? String(err), {
        runId: msg?.runId,
        mode: mode ?? null,
        fileName: null,
      });
      return;
    }

    const run = {
      child: null,
      runId: msg.runId,
      phase: 'starting',
      startedAt: Date.now(),
      mode,
      fileName,
      label,
      fileDir: null,
      killTimer: null,
      downloadTicker: null,
      cancelled: false,
      denyConsent: null,
      denyIdentityWait: null,
      denyScanWait: null,
      useKernelSandbox: true,
    };
    // Before the first await, so the slot covers the waits below.
    runs.set(discoveryKeyHex, run);

    // Every run crosses the same host stages whatever the lesson does, so one
    // reporter here covers all of them. Same shape the CLI uses.
    let phaseAt = 0;
    const phase = (label) => {
      phaseAt = Date.now();
      sendReply(discoveryKeyHex, {
        kind: 'chunk',
        runId: run.runId,
        stream: 'stderr',
        data: `→ ${label}\n`,
      });
    };
    const phaseDone = (label) => {
      const secs = phaseAt ? (Date.now() - phaseAt) / 1000 : 0;
      sendReply(discoveryKeyHex, {
        kind: 'chunk',
        runId: run.runId,
        stream: 'stderr',
        data: `  ✓ ${label}${secs >= 1 ? ` (${secs.toFixed(1)}s)` : ''}\n`,
      });
    };

    // A guest pipelining a request on channel open can reach here ahead of
    // its own identity proof; everything below that reads a device key needs
    // this wait to have happened first.
    run.phase = 'awaiting-identity';
    phase('Verifying the requesting device...');
    const verified = await Promise.race([
      awaitDeviceVerified(discoveryKeyHex, IDENTITY_WAIT_MS),
      new Promise((resolve) => {
        run.denyIdentityWait = () => resolve({ ok: false, reason: 'cancelled' });
      }),
    ]);
    run.denyIdentityWait = null;
    run.phase = 'starting';
    if (verified?.ok) phaseDone('Device verified');
    if (!verified?.ok) {
      const stopped = verified.reason === 'cancelled' || run.cancelled;
      fail(
        discoveryKeyHex,
        stopped ? 'cancelled' : 'unverified',
        stopped ? 'cancelled during the identity wait' : 'identity handshake did not settle',
        { runId: run.runId, mode, fileName, reason: verified.reason ?? 'unverified' },
      );
      finishRun(discoveryKeyHex, run);
      return;
    }
    if (refusedAsRevoked(discoveryKeyHex, run.runId)) {
      finishRun(discoveryKeyHex, run);
      return;
    }
    if (run.cancelled) {
      fail(discoveryKeyHex, 'cancelled', 'cancelled before the run started', { runId: run.runId, mode, fileName, label });
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
          runId: run.runId,
          mode,
          fileName,
          label,
          packages: refused,
        });
        finishRun(discoveryKeyHex, run);
        return;
      }
      phase(`Preparing ${wanted.join(', ')}...`);
      const warm = sandbox.warmPackages(sandbox.npmCacheDir(), wanted);
      if (!warm.ok) {
        fail(
          discoveryKeyHex,
          'package-prepare-failed',
          `could not prepare ${warm.failed.map((f) => `${f.pkg}: ${f.error}`).join('; ')}`,
          { runId: run.runId, mode, fileName },
        );
        finishRun(discoveryKeyHex, run);
        return;
      }
      phaseDone('Packages ready');
      appendAudit('peer:exec:mcp-warmed', { discoveryKey: discoveryKeyHex, packages: wanted });
    }

    // A lesson needing Node builtins runs on Electron's own binary instead;
    // same sandbox profile either way, so this widens the standard library,
    // not the permissions.
    const nodeOnly = detectNodeOnly(code);
    const runtime = nodeOnly ? 'node' : 'bare';
    run.runtime = runtime;

    // Decided host-side from the code, not the peer's claim. Declared
    // frontmatter can only widen this union, never narrow it.
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

    // `code` is buildLesson()'s wrapped output (what spawns); a
    // human or the AI reviewer only needs the lesson source underneath it.
    const displaySource =
      typeof declared.rawSource === 'string' && declared.rawSource.length > 0 ? declared.rawSource : code;

    // 'unavailable' (no model, scan errored) stays distinct from 'suspicious':
    // it never turns a run needing no device/network access into one that does.
    let securityVerdict = 'clean';
    let securityConcerns = [];
    if (securityScanFailures >= SECURITY_SCAN_FAILURE_LIMIT) {
      // Past the limit, so the prompt goes up without an AI opinion behind it.
      securityVerdict = 'unavailable';
      securityConcerns = [
        'AI security review is switched off on this device after repeatedly failing to finish. '
        + 'Review the code yourself before approving.',
      ];
      phaseDone('AI review skipped on this device');
    } else try {
      phase('Reviewing the code...');
      const scanned = await Promise.race([
        runSecurityScan({
          code: displaySource,
          lessonKey: null,
          lessonReference: typeof declared.lessonReference === 'string' ? declared.lessonReference : null,
          // The receiving device's own configured/loaded model, same as any
          // other host-side chat call; a peer cannot pick this remotely.
          modelHint: undefined,
          // The race below cannot reach the process generating the verdict,
          // so the deadline has to travel with the request.
          timeoutMs: SECURITY_SCAN_TIMEOUT_MS,
        }),
        new Promise((resolve) => {
          const timer = setTimeout(() => resolve(null), SECURITY_SCAN_TIMEOUT_MS);
          if (typeof timer.unref === 'function') timer.unref();
          // No child yet at this phase, so cancel has nothing to signal;
          // wire it here so Stop doesn't have to wait out the full timeout.
          run.denyScanWait = () => {
            clearTimeout(timer);
            resolve(null);
          };
        }),
      ]);
      run.denyScanWait = null;
      if (scanned) {
        securityScanFailures = 0;
        securityVerdict = scanned.result.verdict;
        securityConcerns = scanned.result.concerns.map((c) => c.summary);
        phaseDone(`Reviewed: ${securityVerdict}`);
      } else {
        if (!run.cancelled) securityScanFailures += 1;
        securityVerdict = 'unavailable';
        securityConcerns = [
          run.cancelled
            ? 'Cancelled while the AI security review was still loading its model.'
            : 'AI security review timed out on this device. Review the code yourself before approving.',
        ];
        phaseDone(run.cancelled ? 'Review cancelled' : 'Review timed out');
      }
    } catch (err) {
      run.denyScanWait = null;
      securityScanFailures += 1;
      securityVerdict = 'unavailable';
      securityConcerns = [
        'AI security review unavailable on this device. Review the code yourself before approving.',
      ];
      phaseDone('Review unavailable');
    }

    if (securityVerdict === 'malicious') {
      appendAudit('peer:exec:security-flagged', {
        discoveryKey: discoveryKeyHex,
        concerns: securityConcerns,
        sourcePreview: previewCode(displaySource),
      });
      fail(
        discoveryKeyHex,
        'security-flagged',
        `security scan flagged: ${securityConcerns.join('; ') || 'no reason returned'}`,
        { runId: run.runId, mode, fileName, label },
      );
      finishRun(discoveryKeyHex, run);
      return;
    }

    // A loopback ask under bwrap comes out as full egress, wider than what
    // was approved, so refuse rather than silently widen it.
    const netScope = sandbox.enforcedNetworkScope(netMode);
    if (netScope !== netMode) {
      fail(
        discoveryKeyHex,
        'network-unenforceable',
        `sandbox enforces ${netScope} for a requested ${netMode}`,
        { runId: run.runId, mode, fileName, network: netMode, networkScope: netScope },
      );
      finishRun(discoveryKeyHex, run);
      return;
    }

    // A cancel that arrived during the scan above would otherwise still
    // reach here and prompt for consent on a run already doomed to fail.
    if (run.cancelled) {
      fail(discoveryKeyHex, 'cancelled', 'cancelled before the run started', { runId: run.runId, mode, fileName, label });
      finishRun(discoveryKeyHex, run);
      return;
    }

    const grants = [];
    // 'suspicious' no longer forces a prompt on its own; the model has shown
    // that verdict to be unreliable. Only 'malicious' above hard-refuses.
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
          concerns: securityConcerns,
          sourcePreview: previewCode(displaySource),
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
          { runId: run.runId, mode, fileName, devices: wantedDevices, network: netReason },
        );
        finishRun(discoveryKeyHex, run);
        return;
      }
      grants.push(...wantedDevices);
      if (netMode === 'localhost') grants.push('network-loopback');
      else if (netMode === 'all') grants.push('network');
    }

    if (run.cancelled) {
      fail(discoveryKeyHex, 'cancelled', 'cancelled before the run started', { runId: run.runId, mode, fileName, label });
      finishRun(discoveryKeyHex, run);
      return;
    }

    // A run that never reached its own cleanup (Stop, a crash, the host dying)
    // can leave a truncated model at its final name; catch it before the
    // sandbox freezes it read-only and locks out every retry.
    try {
      const truncated = pruneTruncatedModels();
      if (truncated.length > 0) {
        appendAudit('peer:exec:truncated-models-pruned', { discoveryKey: discoveryKeyHex, truncated });
      }
    } catch (err) {
      console.warn('[peer] pruneTruncatedModels failed:', err?.message ?? err);
    }

    // Stat plus recorded hash is the steady-state path (one stat, no read);
    // an unrecorded file gets its first read here instead, off the swarm path.
    // referencedModels gives registry constant names (e.g. LLAMA_3_2_1B_INSTRUCT);
    // verifyModelsAsync and the cache filenames key on modelId instead.
    const wantedModels = referencedModels(code);
    const registry = modelRegistry();
    const wantedIds = wantedModels.map((name) => registry.get(name)?.modelId).filter(Boolean);
    let changedModels = [];
    let mismatchedModels = [];
    try {
      // A large cached model's hash can take a while under a throttled host;
      // let Stop reach it instead of leaving the run unkillable until it finishes.
      if (wantedIds.length > 0) phase(`Checking cached models (${wantedIds.length})...`);
      const result = await verifyModelsAsync(wantedIds, undefined, undefined, () => run.cancelled);
      // Scoped to this run's models: an unrelated file changing elsewhere in
      // the cache (another lesson's download) should not block this one.
      const allChanged = wantedIds.length > 0 && scan().size > 0 ? syncFast().changed : [];
      changedModels = allChanged.filter((rel) => {
        const base = path.basename(rel).replace(CACHE_HASH_PREFIX, '');
        return wantedIds.includes(base);
      });
      mismatchedModels = result.mismatched;
      if (wantedIds.length > 0) phaseDone('Models checked');
    } catch (err) {
      console.warn('[peer] model integrity check failed:', err?.message ?? err);
    }
    if (run.cancelled) {
      fail(discoveryKeyHex, 'cancelled', 'cancelled during the model integrity check', {
        runId: run.runId,
        mode,
        fileName,
        label,
      });
      finishRun(discoveryKeyHex, run);
      return;
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
        { runId: run.runId, mode, fileName, label, changedModels },
      );
      finishRun(discoveryKeyHex, run);
      return;
    }

    const portableResult = substitutePortableImports(code, {
      resolveSdk: resolvePortableSdk,
      resolveBuiltin: resolvePortableBuiltin,
    });
    if (portableResult.unresolved.length > 0) {
      fail(
        discoveryKeyHex,
        'portable-import-unresolved',
        `this device is missing: ${portableResult.unresolved.join(', ')}`,
        { runId: run.runId, mode, fileName, label, unresolved: portableResult.unresolved },
      );
      finishRun(discoveryKeyHex, run);
      return;
    }
    code = portableResult.code;

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
          runId: run.runId,
          mode,
          fileName: null,
          label,
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
        runId: run.runId,
        mode,
        fileName,
        label,
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
          // Real resolved userData, so the profile denies the actual state
          // dir even under a `--storage` override.
          userData: getUserData(),
          // npx locks its own hash dir even for an already-warmed package;
          // the sandbox grants just that lock file, not the whole read-only tree.
          npxPackages: wanted,
        },
        'qvac',
      );
    } catch (err) {
      wrapErr = err;
      console.warn('[peer] sandbox.wrapSpawn failed:', err?.message ?? err);
    }

    if (!wrap || !wrap.sandboxed) {
      const message = sandboxRefusalMessage(wrap, wrapErr);
      // wrapSpawn returning a non-sandboxed result is not itself an
      // exception, so without this it leaves no trace of which check inside
      // it actually failed.
      if (!wrapErr) console.warn('[peer] sandbox unavailable:', message, wrap?.warnings ?? []);
      fail(discoveryKeyHex, 'sandbox-unavailable', message, {
        runId: run.runId,
        mode,
        fileName,
        label,
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
        } catch {}
      }
    }
    run.child = child;
    run.phase = 'running';
    run.startedAt = Date.now();

    // A cancel that arrived between the consent answer and here had no child to
    // signal, so honour it now that there is one.
    if (run.cancelled) terminate(discoveryKeyHex, run);

    appendAudit('peer:exec:started', {
      discoveryKey: discoveryKeyHex,
      mode,
      fileName,
      label,
      // Kept even for a 'clean' run: this is the only surface for a run
      // that never triggered a consent prompt at all.
      sourcePreview: previewCode(displaySource),
    });
    sendReply(discoveryKeyHex, { kind: 'started', runId: run.runId, mode, fileName, label });
    phase('Running the lesson...');

    const stderrFilter = createNoiseFilter();
    let firstChunkAt = 0;
    let finalIdleTimer = null;
    // The SDK logs one line per blob and then prints nothing until the whole
    // transfer is done, so silence never means the run stopped working. Only a
    // cache that has stopped growing does. Sampled when the timer fires rather
    // than per chunk, so a chatty run doesn't walk the cache per line.
    const readCacheBytes = () => {
      try {
        return cacheBytes();
      } catch {
        return -1;
      }
    };
    let idleCacheBytes = readCacheBytes();
    let stalledSince = 0;
    const incompleteWanted = () => {
      try {
        return findTruncatedModels().filter((rel) =>
          wantedIds.includes(path.basename(rel).replace(CACHE_HASH_PREFIX, '')));
      } catch {
        return [];
      }
    };
    const onFinalIdle = () => {
      if (!isAlive(child) || run.cancelled || run.phase !== 'running') return;
      const bytes = readCacheBytes();
      if (bytes !== idleCacheBytes) {
        idleCacheBytes = bytes;
        stalledSince = 0;
        armFinalIdle();
        return;
      }
      // Closing here kills the child, so an unfinished download must not be
      // reported as the lesson succeeding, and a slow link must not be
      // mistaken for a dead one.
      const incomplete = incompleteWanted();
      if (incomplete.length > 0) {
        if (stalledSince === 0) stalledSince = Date.now();
        if (Date.now() - stalledSince < DOWNLOAD_STALL_MS) {
          armFinalIdle();
          return;
        }
        appendAudit('peer:exec:model-download-stalled', {
          discoveryKey: discoveryKeyHex,
          stalled: incomplete,
        });
        sendReply(discoveryKeyHex, {
          kind: 'chunk',
          runId: run.runId,
          stream: 'stderr',
          data:
            `[peer] a model download made no progress for ${DOWNLOAD_STALL_MS / 60_000} minutes. `
            + 'Check the network connection and free disk space, then run this again.\n',
        });
        reportExit(discoveryKeyHex, run, { code: 1, signal: null, source: 'download-stalled' });
        return;
      }
      reportExit(discoveryKeyHex, run, { code: 0, signal: null, source: 'final-idle' });
    };
    const armFinalIdle = () => {
      if (finalIdleTimer) clearTimeout(finalIdleTimer);
      finalIdleTimer = setTimeout(onFinalIdle, RUN_FINAL_IDLE_MS);
      if (typeof finalIdleTimer.unref === 'function') finalIdleTimer.unref();
    };
    // Emitted in the same shape the lessons print, so one console parser
    // covers a host-reported download and a lesson-reported one alike.
    let lastDownloadPercent = -1;
    const downloadTicker = setInterval(() => {
      if (!isAlive(child) || run.cancelled) return;
      let seen;
      try {
        seen = modelDownloadProgress(wantedModels);
      } catch {
        return;
      }
      if (!seen) return;
      const percent = Math.max(0, Math.min(100, Math.round((seen.downloaded / seen.total) * 100)));
      // Report the finish too. Stopping at the last sample below 100 leaves the
      // console's bar frozen mid-transfer on a download that actually landed.
      if (seen.downloaded >= seen.total && lastDownloadPercent < 0) return;
      if (percent === lastDownloadPercent) return;
      lastDownloadPercent = percent;
      const mb = (n) => Math.round(n / (1024 * 1024));
      sendReply(discoveryKeyHex, {
        kind: 'chunk',
        runId: run.runId,
        stream: 'stderr',
        data: `▸ Downloading ${percent}% (${mb(seen.downloaded)}/${mb(seen.total)} MB)\n`,
      });
    }, DOWNLOAD_TICK_MS);
    if (typeof downloadTicker.unref === 'function') downloadTicker.unref();
    run.downloadTicker = downloadTicker;
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
      sendReply(discoveryKeyHex, { kind: 'chunk', runId: run.runId, stream: 'stdout', data: chunk.toString('utf8') });
    });
    childStderr.on('data', (chunk) => {
      if (firstChunkAt === 0) firstChunkAt = Date.now();
      armFinalIdle();
      const data = stderrFilter.push(chunk.toString('utf8'));
      if (data) sendReply(discoveryKeyHex, { kind: 'chunk', runId: run.runId, stream: 'stderr', data });
    });
    child.on('error', (err) => {
      if (finalIdleTimer) clearTimeout(finalIdleTimer);
      if (!isCurrent(discoveryKeyHex, run)) return;
      fail(discoveryKeyHex, 'spawn-failed', err?.message ?? String(err), { runId: run.runId, mode, fileName, label });
      finishRun(discoveryKeyHex, run);
    });
    child.on('exit', (exitCode, signal) => {
      if (finalIdleTimer) clearTimeout(finalIdleTimer);
      // A run already reported also already swept the group, so a later
      // exit event here belongs to that sweep, not to the lesson.
      if (!isCurrent(discoveryKeyHex, run)) return;
      const tail = stderrFilter.end();
      if (tail) sendReply(discoveryKeyHex, { kind: 'chunk', runId: run.runId, stream: 'stderr', data: tail });

      try {
        const note = describeNewOutputs(run.outputsBefore ?? new Map(), lessonCwd());
        if (note) sendReply(discoveryKeyHex, { kind: 'chunk', runId: run.runId, stream: 'stderr', data: note });
      } catch {}

      // Fail closed on SIGTRAP: do not re-run unsandboxed.
      if (signal === 'SIGTRAP' && run.useKernelSandbox && !run.cancelled) {
        fail(discoveryKeyHex, 'sigtrap', 'child trapped under the OS sandbox', {
          runId: run.runId,
          mode,
          fileName,
          label,
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
      // Re-baseline in case this run downloaded a model, so the next
      // peer-exec doesn't read its own download as tampering.
      else {
        try {
          acceptAll();
        } catch {}
      }
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
    if (terminate(discoveryKeyHex, run)) {
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
  FORCE_REAP_MS,
  DEVICE_CONSENT_TIMEOUT_MS,
  RUN_FINAL_IDLE_MS,
  STALE_RUN_MS,
  // Module-level, so it applies to every createExecHost() instance in this
  // process; tests reset it in teardown rather than scoping it per-instance.
  _setTestStaleRunMs(value) {
    _testStaleRunMs = value;
  },
};
