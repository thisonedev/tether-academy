import type { z } from 'zod';
import type { academyRunPayloadSchema, academyRunResultSchema } from './ipc.js';

export type AcademyRunPayload = z.infer<typeof academyRunPayloadSchema>;
export type AcademyRunResult = z.infer<typeof academyRunResultSchema>;

export interface AcademyStateAPI {
  get: (key: string) => Promise<string | null>;
  set: (key: string, value: string) => Promise<void>;
  remove: (key: string) => Promise<void>;
  list: () => Promise<Array<{ key: string; value: string }>>;
}

export interface AcademyWindowAPI {
  minimize: () => Promise<void>;
  maximize: () => Promise<void>;
  close: () => Promise<void>;
}

// `id` is a stable relative path within the SDK models cache directory; pass it back to `models.remove`.
export interface AcademyModelLessonRef {
  chapter: string;
  lessons: string[];
}

export interface AcademyModelEntry {
  id: string;
  name: string;
  sizeBytes: number;
  kind: 'single' | 'sharded' | 'set';
  // Hash prefix the SDK prepends to single-file cache entries; empty for sharded/set groups.
  sourceHash: string;
  fileCount: number;
  usedIn: AcademyModelLessonRef[];
  /** Plain-language description from apps/desktop/electron/model-descriptions.json; empty when unregistered. */
  description: string;
  /** False when the on-disk size is short of the SDK registry's expected size; true when there's nothing to check against. */
  complete: boolean;
}

export interface AcademyModelsRemoveResult {
  removed: number;
  freedBytes: number;
}

/** Result of re-hashing the cache. `mismatched` lists paths relative to it. */
export interface AcademyModelsVerifyResult {
  verified: number;
  mismatched: string[];
  recorded: number;
}

/** How much of the model's recommended minimums this hardware can meet. */
export type AcademyModelFit = 'fits' | 'tight' | 'too-big';

/** A model in the installable catalogue (may or may not be on disk yet). */
export interface AcademyModelCatalogueEntry {
  /** Filename under the cache root, e.g. `Qwen3-0.6B-Q4_0.gguf`. */
  name: string;
  /** Stable id used in `usedIn` lookups; same as `name` today. */
  id: string;
  /** Best-effort byte size for the download, 0 when unknown. */
  sizeBytes: number;
  /** Plain-language description from model-descriptions.json; empty when unregistered. */
  description: string;
  /** Lessons in CURRICULUM that need this model. */
  usedIn: AcademyModelLessonRef[];
  /** "chat" for instruction-tuned text models, anything else for embeddings/audio/etc. */
  family: 'chat' | 'embedding' | 'audio' | 'image' | 'video' | 'other';
  /** Recommended minimum free RAM in bytes; 0 when not modelled. */
  minRamBytes: number;
  /** 'preferred' when GPU noticeably speeds it up, 'optional' otherwise. */
  gpu: 'preferred' | 'optional' | 'none';
  /** Cache filename the loader opens, which two entries sharing `name` do not. */
  cacheFile?: string | null;
  /** Whether that exact file is on disk and complete. */
  installed?: boolean;
}

export interface AcademyModelRecommendation {
  /** Best pick for this lesson on this hardware. null when no chat model fits. */
  pick: string | null;
  /** All catalogue entries, in the order: fits > tight > too-big, then by minRam ascending. */
  ranked: AcademyModelCatalogueEntry[];
  /** Why the pick was made; surfaced in the UI. */
  reason:
    | 'lesson-requires'
    | 'largest-installed'
    | 'hardware-fits-best'
    | 'no-chat-models'
    | 'no-hardware-info';
}

export interface AcademyModelsAPI {
  list: () => Promise<AcademyModelEntry[]>;
  remove: (id: string) => Promise<AcademyModelsRemoveResult>;
  removeAll: () => Promise<AcademyModelsRemoveResult>;
  verify: () => Promise<AcademyModelsVerifyResult>;
  /** All installable models the host knows about, regardless of whether they're on disk. */
  catalogue: () => Promise<AcademyModelCatalogueEntry[]>;
  /** Best chat-model pick for the given chapter/lesson + the current device's hardware. */
  recommend: (lessonKey: { chapter: string; lesson: string } | null) => Promise<AcademyModelRecommendation>;
  /** All catalogue entries tagged for a given chapter/lesson, in display order. */
  forLesson: (lessonKey: { chapter: string; lesson: string }) => Promise<AcademyModelCatalogueEntry[]>;
}

/** One message in a chat conversation. */
export interface AcademyChatMessage {
  role: 'system' | 'user' | 'assistant';
  content: string;
}

/** Streamed chunk from a chat completion. The renderer appends `delta` to the last assistant message. */
export interface AcademyChatChunk {
  /** Per-call request id; matches the one returned by `chat.send`. */
  requestId: string;
  delta: string;
  /** True when this is the last chunk for the request. */
  done: boolean;
  /** Error message if the call failed; `done` is also true. */
  error: string | null;
  /** When true, the renderer replaces the last assistant message with `delta` instead of appending.
   *  Used by the host to swap streamed text for a post-processed version (e.g. paragraph-split). */
  replace?: boolean;
}

/** Result of starting a chat completion. The actual response arrives via `onChunk` events. */
export interface AcademyChatSendResult {
  requestId: string;
  /** Filename of the model the host loaded for this request. */
  modelName: string;
}

/**
 * Whole-submission verdict from the AI review pass; only reached once a
 * client-side match check already found a real difference.
 * - 'complete': functionally finished and correct, just written differently.
 * - 'different-but-valid': a genuine alternate approach that still satisfies the lesson.
 * - 'unfinished': started but not done (stub, TODO, partial logic).
 * - 'wrong': attempted fully but incorrect or off-task.
 */
export type ChatVerifyVerdict = 'complete' | 'different-but-valid' | 'unfinished' | 'wrong';

/** `ChatVerifyVerdict` plus the client-only 'match' value for an exact
 *  match, which never calls the AI. */
export type MatchStatus = ChatVerifyVerdict | 'match';

export interface ChatVerifyResult {
  verdict: ChatVerifyVerdict;
  /** One to a few sentences. Empty is valid for 'complete' when there's nothing more to say. */
  reason: string;
}

/** Delivered once via `onVerifyResult`, keyed by the `requestId` `chat.verify` returned.
 *  Unlike `AcademyChatChunk`, this is a single structured result, not a streamed delta. */
export interface AcademyChatVerifyChunk {
  requestId: string;
  done: true;
  /** Error message if the call failed or the model's output couldn't be parsed; `result` is null in that case. */
  error: string | null;
  result: ChatVerifyResult | null;
}

/** Verdict from the pre-flight security scan; only 'malicious' blocks a run. */
export type SecurityVerdict = 'clean' | 'suspicious' | 'malicious';

export interface ChatSecurityConcern {
  summary: string;
  /** Short excerpt of the code the concern is about, for the human reviewing it. */
  snippet: string;
}

export interface ChatSecurityResult {
  verdict: SecurityVerdict;
  concerns: ChatSecurityConcern[];
}

/** Delivered once via `onSecurityResult`, keyed by the `requestId` `chat.securityScan` returned. */
export interface AcademyChatSecurityChunk {
  requestId: string;
  done: true;
  error: string | null;
  result: ChatSecurityResult | null;
}

export interface AcademyChatAPI {
  /** True if a model is loaded and ready to answer. */
  ready: () => Promise<boolean>;
  /** Which model the host has loaded right now (its filename), or null. */
  currentModel: () => Promise<string | null>;
  /** The model selected in Settings, whether or not it is loaded in this process. */
  configuredModel: () => Promise<string | null>;
  /** Status of the cached QVAC SDK documentation the host may inject into prompts. */
  docsStatus: () => Promise<{ available: boolean; source: string; bytes: number; expiresAt: number }>;
  /** Force-refresh the cached QVAC SDK documentation; resolves with the new status. */
  docsRefresh: () => Promise<{ ok: boolean; available: boolean; source: string; bytes: number; expiresAt: number }>;
  /**
   * Pre-load a chat model without sending a completion. Returns once the
   * model is loaded (or throws if it can't be). Used by the picker when
   * the user picks a model, so the chat phase opens clean and the first
   * real message is the one the user types.
   */
  load: (modelHint: string) => Promise<{ modelName: string }>;
  /**
   * Send a chat completion. The host streams `delta` chunks back via `onChunk`.
   * If no model is loaded, the host picks the smallest installed chat model
   * automatically; pass `modelHint` to force a specific filename.
   */
  send: (payload: {
    messages: AcademyChatMessage[];
    lessonKey: { chapter: string; lesson: string } | null;
    lessonReference?: string;
    useFullDocs?: boolean;
    modelHint?: string;
  }) => Promise<AcademyChatSendResult>;
  /**
   * Run the AI grading pass over a checklist that already passed its regex/contains
   * checks. The host streams nothing back for this call; the verdict arrives once,
   * via `onVerifyResult`, keyed by the returned `requestId`.
   */
  verify: (payload: {
    code: string;
    tests: Array<{ id: string; description: string }>;
    lessonKey: { chapter: string; lesson: string } | null;
    lessonReference?: string;
    /** Canonical solution, so the grader judges functional equivalence rather than keyword coverage alone. */
    answer?: string;
    modelHint?: string;
  }) => Promise<AcademyChatSendResult>;
  /** Pre-flight scan before a submission ships to a paired device; verdict
   *  arrives once via `onSecurityResult`. */
  securityScan: (payload: {
    code: string;
    lessonKey: { chapter: string; lesson: string } | null;
    lessonReference?: string;
    modelHint?: string;
  }) => Promise<AcademyChatSendResult>;
  /** Cancel an in-flight request. Returns true if a request was actually cancelled. */
  stop: (requestId: string) => Promise<boolean>;
  /** Subscribe to chat chunks. Returns an unsubscribe function. */
  onChunk: (callback: (chunk: AcademyChatChunk) => void) => () => void;
  /** Subscribe to verify results. Returns an unsubscribe function. */
  onVerifyResult: (callback: (chunk: AcademyChatVerifyChunk) => void) => () => void;
  /** Subscribe to security scan results. Returns an unsubscribe function. */
  onSecurityResult: (callback: (chunk: AcademyChatSecurityChunk) => void) => () => void;
  /** Subscribe to model-loading progress (for the first-run "downloading model" UI). */
  onLoadProgress: (callback: (event: { modelName: string; loaded: number; total: number }) => void) => () => void;
}

export interface AcademyDeviceInfo {
  os: 'macos' | 'linux' | 'windows' | 'other';
  osLabel: string;
  arch: string;
  hostname: string;
  // Apple Silicon SoC name on macOS (e.g. "Apple M3 Max"); CPU model on Linux/Windows.
  model: string;
  cpuCores: number;
  cpuPhysicalCores: number;
  memoryBytes: number;
  storageBytes: number;
  storageFreeBytes: number;
  storagePath: string;
  // Best-effort GPU description. null when not detectable.
  gpu: string | null;
}

export interface AcademyDeviceAPI {
  info: () => Promise<AcademyDeviceInfo>;
}

/** One paired device. discoveryKey is the stable pair id (use it with drop()). */
export interface AcademyPeerInfo {
  discoveryKey: string;
  sessionPublicKey: string | null;
  role: 'host' | 'guest';
  pairedAt: number;
  userData: unknown;
  autobaseKey: string;
  inviteId: string | null;
  /** Host's main public key as claimed by the invite link (guest-role peers only); claimed, not proven. */
  hostIdentity: string | null;
  /** True once the peer proved it holds a device key attested to the root identity it announced. */
  identityVerified: boolean;
  /** Device key the peer proved it holds. null until the handshake completes. */
  verifiedDevicePublicKey: string | null;
  /** Root identity that key is attested to, once proven. */
  verifiedIdentityPublicKey: string | null;
}

export interface AcademyPeerPending {
  requestId: string;
  discoveryKey: string;
  sessionPublicKey: string;
  inviteId: string | null;
  userData: unknown;
  receivedAt: number;
  /** Code the host generated and shared with the guest out-of-band. */
  expectedPairingCode: string;
  /** Code the guest entered in the pair request. null if the guest sent none. */
  enteredPairingCode: string | null;
}

/** One line in the rolling pair-event log. */
export interface AcademyPeerAuditEntry {
  type:
    | 'peer:pending'
    | 'peer:paired'
    | 'peer:approved'
    | 'peer:rejected'
    | 'peer:dropped'
    | 'peer:identity-verified'
    | 'peer:lockdown'
    | 'peer:pair:sent'
    | 'peer:pair:error'
    | 'peer:exec:started'
    | 'peer:exec:finished'
    | 'peer:exec:error'
    | 'peer:exec:remote-started'
    | 'peer:exec:remote-finished'
    | 'peer:exec:remote-error';
  timestamp: number;
  discoveryKey?: string;
  requestId?: string;
  role?: 'host' | 'guest';
  dropped?: number;
  remoteUserData?: unknown;
  reason?: string;
  code?: number | null;
  signal?: string | null;
  message?: string;
  expected?: string;
  entered?: string;
  remoteBuildId?: string;
  fileName?: string;
  label?: string;
  mode?: 'inline' | 'file';
  devicePublicKey?: string | null;
  identityPublicKey?: string | null;
  identityVerified?: boolean;
  /** On a host-identity-mismatch rejection: what the invite link claimed. */
  claimed?: string;
  /** Code preview, local-only. Named `sourcePreview` since `code` above
   *  already means the process exit code. */
  sourcePreview?: string;
}

export interface AcademyPeerIdentity {
  /** Device public key used on the mesh. */
  publicKey: string | null;
  /** Root identity public key (keet-identity-key). */
  identityPublicKey?: string | null;
  source?: 'tether-academy' | 'keet-linked' | null;
  createdAt: number | null;
  status?: string;
  ready?: boolean;
  holdsRoot?: boolean;
  devices?: Array<{
    publicKey: string;
    role: string;
    revoked: boolean;
    attestedAt: number | null;
    label?: string | null;
  }>;
}

export interface AcademyIdentityStatus {
  status: 'none' | 'pending-backup' | 'ready' | string;
  ready: boolean;
  source: 'tether-academy' | 'keet-linked' | null;
  identityPublicKey: string | null;
  devicePublicKey: string | null;
  createdAt: number | null;
  backupConfirmed: boolean;
  holdsRoot: boolean;
  devices: Array<{
    publicKey: string;
    role: string;
    revoked: boolean;
    attestedAt: number | null;
    label?: string | null;
  }>;
}

export interface AcademyIdentityAPI {
  status: () => Promise<AcademyIdentityStatus>;
  create: () => Promise<{
    mnemonic: string;
    identityPublicKey: string;
    devicePublicKey: string;
    source: string;
  }>;
  confirmBackup: () => Promise<AcademyIdentityStatus>;
  recover: (mnemonic: string) => Promise<AcademyIdentityStatus>;
  beginAttest: (payload: {
    devicePublicKey: string;
    label?: string;
  }) => Promise<{ sessionId: string; devicePublicKey: string; identityPublicKey: string; needsConfirm: boolean }>;
  finishAttest: (payload: {
    sessionId: string;
    confirm: true;
  }) => Promise<{ proof: string; identityPublicKey: string; devicePublicKey: string; source: string }>;
  cancelAttest: (sessionId: string) => Promise<boolean>;
  revokeDevice: (devicePublicKey: string) => Promise<AcademyIdentityStatus>;
  listDevices: () => Promise<AcademyIdentityStatus['devices']>;
  /** Wipe identity from this device only. Requires create/link/recover to use the app again. */
  reset: () => Promise<AcademyIdentityStatus>;
  // Attested blob store; see electron/identity/manager.cjs for the primitive.
  setUsername: (payload: { username: string }) => Promise<{
    username: string;
    revision: number;
    updatedAt: number;
  } | null>;
  getUsername: () => Promise<{
    username: string;
    revision: number;
    updatedAt: number;
    published: boolean;
  } | null>;
  setProgress: (payload: {
    progress: Record<string, unknown>;
  }) => Promise<{ progress: Record<string, unknown>; revision: number; updatedAt: number } | null>;
  getProgress: () => Promise<{
    progress: Record<string, unknown>;
    revision: number;
    updatedAt: number;
  } | null>;
  listBlobs: () => Promise<{
    private: Array<{ kind: string; revision: number; updatedAt: number }>;
    public: Array<{ kind: string; revision: number; updatedAt: number }>;
  }>;
  publicSnapshot: () => Promise<{
    identityPublicKey: string;
    devicePublicKey: string;
    proof: string;
    blobs: Record<string, unknown>;
  } | null>;
  verifyAttested: (payload: {
    kind: string;
    payload: unknown;
    proofB64: string;
    expectedIdentityPublicKeyHex: string;
  }) => Promise<boolean>;
  importProfile: (payload: {
    identityPublicKeyHex: string;
    profile: unknown;
  }) => Promise<{ ok: boolean; verified: Record<string, boolean> }>;
}

export interface AcademyPeerInvite {
  invite: string;
  sessionPublicKey: string;
  discoveryKey: string;
  autobaseKey: string;
  userData: unknown;
  /** 6-character code the host generates. Share out-of-band with the guest. */
  pairingCode: string;
  /** Host's root identity key, or its device key when it has no root; lets the guest check what it paired with. */
  hostIdentity: string | null;
}

export interface AcademyPeerAcceptResult {
  discoveryKey: string;
  paired: boolean;
}

export type AcademyPeerEvent =
  | { event: 'peer:pending'; payload: AcademyPeerPending }
  | { event: 'peer:paired'; payload: AcademyPeerInfo }
  | { event: 'peer:dropped'; payload: { discoveryKey: string } }
  | { event: 'peer:rejected'; payload: { requestId: string; discoveryKey: string } }
  | {
      event: 'peer:identity-verified';
      payload: {
        discoveryKey: string;
        identityVerified: boolean;
        verifiedDevicePublicKey: string | null;
        verifiedIdentityPublicKey: string | null;
      };
    }
  | { event: 'peer:audit'; payload: AcademyPeerAuditEntry }
  | { event: 'peer:audit-cleared'; payload: { at: number } }
  | { event: 'peer:audit-cleared-for-peer'; payload: { discoveryKey: string; at: number; removed: number } }
  | { event: 'peer:deeplink'; payload: { invite: string; hostIdentity: string | null; url: string } };

/** A peer-exec run waiting on a human to allow microphone/camera access. */
export interface AcademyPeerDeviceRequest {
  requestId: string;
  discoveryKey: string;
  /** e.g. ["microphone"], decided host-side from the code. */
  devices: string[];
  /** Why the run needs to reach off this machine. */
  network: string | null;
  /** Set when this device's sandbox cannot hold the run to what it asked
   *  for: bwrap has no loopback-only mode, so a localhost lesson gets `all`,
   *  and approving grants that wider scope. */
  networkScope?: string;
  label: string | null;
  userData: unknown;
  requestedAt: number;
  /** Findings from the security scan, when it ran and found something worth a
   *  second look (including "scan unavailable on this device"). Empty when clean. */
  concerns?: string[];
  /** The code about to run, capped to a preview length, so the human approving
   *  device/network access (or a scan-unavailable flag) can read it first. */
  sourcePreview?: string;
}

export interface AcademyPeerAPI {
  identity: () => Promise<AcademyPeerIdentity | null>;
  /** Consume a queued pair deep-link (invite only; code is entered separately). */
  takeDeeplink?: () => Promise<{ invite: string; hostIdentity: string | null; url: string } | null>;
  invite: (opts?: { userData?: unknown; autoApprove?: boolean; code?: string }) => Promise<AcademyPeerInvite>;
  accept: (
    inviteB64: string,
    opts?: { userData?: unknown; code?: string; hostIdentity?: string },
  ) => Promise<AcademyPeerAcceptResult>;
  list: () => Promise<AcademyPeerInfo[]>;
  pending: () => Promise<AcademyPeerPending[]>;
  approve: (requestId: string) => Promise<boolean>;
  reject: (requestId: string) => Promise<boolean>;
  /** Runs held at the sandbox boundary awaiting device-access consent. */
  deviceRequests: () => Promise<AcademyPeerDeviceRequest[]>;
  /** Answer one of them. Anything but true denies, and denial refuses the run. */
  resolveDeviceRequest: (requestId: string, approved: boolean) => Promise<boolean>;
  audit: (opts?: { since?: number; limit?: number }) => Promise<AcademyPeerAuditEntry[]>;
  clearAudit: () => Promise<boolean>;
  clearPeerAudit: (discoveryKey: string) => Promise<number>;
  lockdown: () => Promise<number>;
  drop: (discoveryKey: string) => Promise<boolean>;
  onEvent: (callback: (msg: AcademyPeerEvent) => void) => () => void;
}

export interface AcademyRunChunk {
  stream: "stdout" | "stderr";
  data: string;
}

export interface AcademyAPI {
  /** Synchronous: app name/version from main's package.json. */
  pkg: () => { name: string; version: string };
  run: (payload: AcademyRunPayload) => Promise<AcademyRunResult>;
  /** Show a file a lesson saved in the OS file manager. */
  reveal?: (filePath: string) => Promise<boolean>;
  /** Read a saved file's bytes (base64) + MIME for inline preview in the lesson panel.
   *  Refuses paths outside the lesson home; the renderer never sees arbitrary disk reads. */
  readSaved?: (filePath: string) => Promise<{ base64: string; mime: string; bytes: number } | null>;
  /** Kill the current run. Returns false when nothing was running. */
  stop?: () => Promise<boolean>;
  onRunChunk?: (callback: (chunk: AcademyRunChunk) => void) => () => void;
  state: AcademyStateAPI;
  window?: AcademyWindowAPI;
  models?: AcademyModelsAPI;
  device?: AcademyDeviceAPI;
  chat?: AcademyChatAPI;
  peer?: AcademyPeerAPI;
  identity?: AcademyIdentityAPI;
  clipboard?: AcademyClipboardAPI;
}

export interface AcademyClipboardAPI {
  /** Copies text and clears it after `scrubAfterMs` (0 = never); main owns the timer so the scrub survives the window closing. */
  copy: (text: string, scrubAfterMs?: number) => Promise<boolean>;
}
