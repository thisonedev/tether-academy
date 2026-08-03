import { frontmatterSchema } from 'fumadocs-mdx/config';
import { z } from 'zod';

const lessonTest = z.object({
  id: z.string(),
  description: z.string(),
  pattern: z.string().optional(),
  contains: z.string().optional(),
});

// argv slot the runner fills before the lesson's snippet runs.
const lessonArgvSlot = z.object({
  name: z.string(),
  // Where the runner looks up the value at run time.
  from: z.enum([
    'state:lastProviderPublicKey',
    'literal',
  ]),
  // Used when `from: 'literal'`. Acts as a fallback when no override is set.
  default: z.string().optional(),
  // Human-readable label shown in the runner header override input.
  label: z.string().optional(),
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
  // argv slots the runner resolves before executing the lesson's snippet.
  argv: z.array(lessonArgvSlot).optional(),
  // Declaration of capabilities the lesson intends to use. The host widens
  // its consent prompt by unioning these with what its detectors find, so
  // an honest declaration can only make the prompt louder. Detectors stay
  // the trust boundary; this is hint text for the lesson author.
  // network is ordered none < localhost < all; the prompt shows the maximum.
  network: z.enum(['none', 'localhost', 'all']).optional(),
  device: z.array(z.string()).optional(),
});
