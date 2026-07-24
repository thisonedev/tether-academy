import defaultMdxComponents from 'fumadocs-ui/mdx';
import type { MDXComponents } from 'mdx/types';
import { CodeBlock } from '@/components/code-block';
import { MdxPre } from '@/components/mdx-pre';

export function useMDXComponents(components: MDXComponents): MDXComponents {
  return {
    ...defaultMdxComponents,
    CodeBlock,
    pre: MdxPre,
    ...components,
  };
}
