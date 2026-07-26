import { z } from 'zod';

export const academyRunPayloadSchema = z.object({
  source: z.string(),
  language: z.string(),
});

export const academyRunResultSchema = z.object({
  ok: z.boolean(),
  output: z.string(),
});

export const academyRunChunkSchema = z.string();
