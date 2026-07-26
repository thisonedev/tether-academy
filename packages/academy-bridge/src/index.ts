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

export interface AcademyAPI {
  run: (payload: AcademyRunPayload) => Promise<AcademyRunResult>;
  onRunChunk?: (callback: (chunk: string) => void) => () => void;
  qr: (text: string) => Promise<string>;
  state: AcademyStateAPI;
  window?: AcademyWindowAPI;
}
