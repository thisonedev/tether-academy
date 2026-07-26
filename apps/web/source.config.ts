import { lessonFrontmatter } from '@academy/validation';
import { defineDocs } from 'fumadocs-mdx/config';

export const docs = defineDocs({
  dir: '../../packages/courses/courses',
  docs: {
    schema: lessonFrontmatter,
    postprocess: {
      includeProcessedMarkdown: true,
    },
  },
});
