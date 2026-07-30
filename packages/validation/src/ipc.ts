import { z } from 'zod';

export const academyRunPayloadSchema = z.object({
  source: z.string(),
  language: z.string(),
  argv: z.array(z.string()).optional(),
  peerId: z.string().optional(),
  /** Human-readable run label shown in the paired-devices history. */
  label: z.string().optional(),
  /** Temp file name on the host. Internal; surfaced only in the raw audit log. */
  fileName: z.string().optional(),
});

export const academyRunResultSchema = z.object({
  ok: z.boolean(),
  output: z.string(),
  remoteExit: z.object({ code: z.number().nullable(), signal: z.string().nullable() }).optional(),
});

export const academyRunChunkSchema = z.string();
