import { defineDocs, frontmatterSchema } from 'fumadocs-mdx/config';
import { z } from 'zod';

const lessonTest = z.object({
  id: z.string(),
  description: z.string(),
  pattern: z.string().optional(),
  contains: z.string().optional(),
});

const lessonFrontmatter = frontmatterSchema.extend({
  // Upstream SDK file this lesson's answer was vendored from. Path is
  // relative to `references/qvac/` (the local upstream snapshot). The
  // sync workflow reads this to detect API drift and to refresh the
  // vendored copy in `examples/qvac/<basename>.answer.ts`.
  sourceExample: z.string().optional(),
  // sha256-prefix hash of the upstream file at last review. Refreshed by
  // `npm run sync:examples:write`; mismatches in CI flag stale vendored
  // copies.
  sourceExampleHash: z.string().optional(),
  // Set to true to skip this lesson from the sync workflow.
  noSync: z.boolean().optional(),
  // Pedagogical fields — still hand-authored. Tests run against the
  // runner's editor, hints/progressively unlock, expectedOutput drives
  // the simulated Run Code output.
  hints: z.array(z.string()).optional(),
  expectedOutput: z.array(z.string()).optional(),
  tests: z.array(lessonTest).optional(),
  platforms: z.array(z.enum(['node', 'web', 'mobile', 'desktop'])).optional(),
});

export const docs = defineDocs({
  dir: 'courses',
  docs: {
    schema: lessonFrontmatter,
    postprocess: {
      includeProcessedMarkdown: true,
    },
  },
});
