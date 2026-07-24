import type { InferPageType } from 'fumadocs-core/source';
import { source } from '@/lib/source';

export async function getLLMText(page: InferPageType<typeof source>) {
  const processed = await page.data.getText('processed');
  return `# ${page.data.title} (${page.url})\n\n${processed}`;
}

function walkNode(
  node: {
    type: string;
    name?: unknown;
    url?: string;
    description?: unknown;
    children?: unknown[];
    index?: unknown;
  },
  lines: string[],
  depth: number,
) {
  if (node.type === 'page') {
    const desc = typeof node.description === 'string' ? node.description : '';
    const suffix = desc ? `: ${desc}` : '';
    lines.push(`${'  '.repeat(depth)}- [${String(node.name)}](${node.url ?? ''})${suffix}`);
    return;
  }
  if (node.type === 'folder') {
    if (depth > 0 && node.name) {
      lines.push(`\n${'  '.repeat(depth)}## ${String(node.name)}\n`);
    }
    if (node.index && typeof node.index === 'object') {
      walkNode(node.index as Parameters<typeof walkNode>[0], lines, depth);
    }
    for (const child of node.children ?? []) {
      walkNode(child as Parameters<typeof walkNode>[0], lines, depth + 1);
    }
  }
}

export function getLLMIndex() {
  const tree = source.getPageTree();
  const lines: string[] = ['# Tether Academy', ''];
  for (const child of tree.children) {
    walkNode(child as Parameters<typeof walkNode>[0], lines, 0);
  }
  return `${lines.join('\n')}\n`;
}
