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
}
