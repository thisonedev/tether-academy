import type { z } from 'zod';
import type { academyRunPayloadSchema, academyRunResultSchema } from '@academy/validation';

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

// One entry in the downloaded-models list. `id` is a stable relative path
// within the SDK models cache directory; pass it back to `models.remove`.
export interface AcademyModelLessonRef {
  chapter: string;
  lessons: string[];
}

export interface AcademyModelEntry {
  id: string;
  name: string;
  sizeBytes: number;
  kind: 'single' | 'sharded' | 'set';
  // Hash prefix that the SDK prepends to single-file cache entries.
  // Empty for sharded / set groups since those are keyed by directory.
  sourceHash: string;
  fileCount: number;
  usedIn: AcademyModelLessonRef[];
}

export interface AcademyModelsRemoveResult {
  removed: number;
  freedBytes: number;
}

export interface AcademyModelsAPI {
  list: () => Promise<AcademyModelEntry[]>;
  remove: (id: string) => Promise<AcademyModelsRemoveResult>;
  removeAll: () => Promise<AcademyModelsRemoveResult>;
}

export interface AcademyDeviceInfo {
  os: 'macos' | 'linux' | 'windows' | 'other';
  osLabel: string;
  arch: string;
  hostname: string;
  // Human-friendly model identifier. On macOS this is the Apple Silicon
  // SoC (e.g. "Apple M3 Max"); on Linux/Windows it's the CPU model.
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
}

/** A pair request waiting for the host to approve or reject. */
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
    | 'peer:lockdown';
  timestamp: number;
  discoveryKey?: string;
  requestId?: string;
  role?: 'host' | 'guest';
  dropped?: number;
  remoteUserData?: unknown;
  reason?: string;
  expected?: string;
  entered?: string;
  remoteBuildId?: string;
}

export interface AcademyPeerIdentity {
  publicKey: string;
  createdAt: number | null;
}

export interface AcademyPeerInvite {
  invite: string;
  sessionPublicKey: string;
  discoveryKey: string;
  autobaseKey: string;
  userData: unknown;
  /** 6-character code the host generates. Share out-of-band with the guest. */
  pairingCode: string;
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
  | { event: 'peer:audit'; payload: AcademyPeerAuditEntry }
  | { event: 'peer:deeplink'; payload: { invite: string; pairingCode: string; url: string } };

export interface AcademyPeerAPI {
  identity: () => Promise<AcademyPeerIdentity | null>;
  invite: (opts?: { userData?: unknown; autoApprove?: boolean; code?: string }) => Promise<AcademyPeerInvite>;
  accept: (
    inviteB64: string,
    opts?: { userData?: unknown; code?: string },
  ) => Promise<AcademyPeerAcceptResult>;
  list: () => Promise<AcademyPeerInfo[]>;
  pending: () => Promise<AcademyPeerPending[]>;
  approve: (requestId: string) => Promise<boolean>;
  reject: (requestId: string) => Promise<boolean>;
  audit: (opts?: { since?: number; limit?: number }) => Promise<AcademyPeerAuditEntry[]>;
  lockdown: () => Promise<number>;
  drop: (discoveryKey: string) => Promise<boolean>;
  onEvent: (callback: (msg: AcademyPeerEvent) => void) => () => void;
}

export interface AcademyRunChunk {
  stream: "stdout" | "stderr";
  data: string;
}

export interface AcademyAPI {
  run: (payload: AcademyRunPayload) => Promise<AcademyRunResult>;
  /** Kill the current run. Returns false when nothing was running. */
  stop?: () => Promise<boolean>;
  onRunChunk?: (callback: (chunk: AcademyRunChunk) => void) => () => void;
  qr: (text: string) => Promise<string>;
  state: AcademyStateAPI;
  window?: AcademyWindowAPI;
  models?: AcademyModelsAPI;
  device?: AcademyDeviceAPI;
  peer?: AcademyPeerAPI;
}
