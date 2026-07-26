import { defineDocs } from 'fumadocs-mdx/config';
import { lessonFrontmatter } from '@academy/validation';
export const docs = defineDocs({
    dir: 'courses',
    docs: {
        schema: lessonFrontmatter,
        postprocess: {
            includeProcessedMarkdown: true,
        },
    },
});
//# sourceMappingURL=source.config.js.map