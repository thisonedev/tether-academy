import defaultMdxComponents from 'fumadocs-ui/mdx';
import { CodeBlock } from '@/components/code-block';
import { MdxPre } from '@/components/mdx-pre';
import type { MDXComponents } from 'mdx/types';

export function useMDXComponents(components: MDXComponents): MDXComponents {
  return {
    ...defaultMdxComponents,
    CodeBlock,
    pre: MdxPre,
    ...components,
  };
}
