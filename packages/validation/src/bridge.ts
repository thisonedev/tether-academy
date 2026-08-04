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

export interface AcademyModelsAPI {
  list: () => Promise<AcademyModelEntry[]>;
  remove: (id: string) => Promise<AcademyModelsRemoveResult>;
  removeAll: () => Promise<AcademyModelsRemoveResult>;
  verify: () => Promise<AcademyModelsVerifyResult>;
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
  label: string | null;
  userData: unknown;
  requestedAt: number;
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
  /** Kill the current run. Returns false when nothing was running. */
  stop?: () => Promise<boolean>;
  onRunChunk?: (callback: (chunk: AcademyRunChunk) => void) => () => void;
  state: AcademyStateAPI;
  window?: AcademyWindowAPI;
  models?: AcademyModelsAPI;
  device?: AcademyDeviceAPI;
  peer?: AcademyPeerAPI;
  identity?: AcademyIdentityAPI;
  clipboard?: AcademyClipboardAPI;
}

export interface AcademyClipboardAPI {
  /** Copies text and clears it after `scrubAfterMs` (0 = never); main owns the timer so the scrub survives the window closing. */
  copy: (text: string, scrubAfterMs?: number) => Promise<boolean>;
}
