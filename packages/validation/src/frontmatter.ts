import { frontmatterSchema } from 'fumadocs-mdx/config';
import { z } from 'zod';

const lessonTest = z.object({
  id: z.string(),
  description: z.string(),
  pattern: z.string().optional(),
  contains: z.string().optional(),
});

export const lessonFrontmatter = frontmatterSchema.extend({
  // Upstream SDK file this lesson's answer was vendored from. Path is
  // relative to the local upstream snapshot. The sync workflow reads
  // this to detect API drift and to refresh the vendored copy.
  sourceExample: z.string().optional(),
  // sha256-prefix hash of the upstream file at last review. Refreshed by
  // the sync script; mismatches in CI flag stale vendored copies.
  sourceExampleHash: z.string().optional(),
  // Set to true to skip this lesson from the sync workflow.
  noSync: z.boolean().optional(),
  // Pedagogical fields. Tests run against the runner's editor, hints
  // progressively unlock, expectedOutput drives the simulated Run.
  hints: z.array(z.string()).optional(),
  expectedOutput: z.array(z.string()).optional(),
  tests: z.array(lessonTest).optional(),
  platforms: z.array(z.enum(['node', 'web', 'mobile', 'desktop'])).optional(),
});
