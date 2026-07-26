import { CodeBlock, MdxPre } from '@academy/ui';
import defaultMdxComponents from 'fumadocs-ui/mdx';
import type { MDXComponents } from 'mdx/types';

export function useMDXComponents(components: MDXComponents): MDXComponents {
  return {
    ...defaultMdxComponents,
    CodeBlock,
    pre: MdxPre,
    ...components,
  };
}
