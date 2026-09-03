import remarkGfm from 'remark-gfm';
import remarkParse from 'remark-parse';
import { unified } from 'unified';
import type { ConsoleEntry } from './lesson-console.js';

export type ExportFormat = 'pdf' | 'markdown' | 'txt' | 'csv' | 'docx' | 'xlsx';

export type Block =
  | { type: 'heading'; level: number; text: string }
  | { type: 'paragraph'; text: string }
  | { type: 'table'; headers: string[]; rows: string[][] }
  | { type: 'list'; ordered: boolean; items: string[] }
  | { type: 'code'; text: string };

function stripInline(text: string): string {
  return text
    .replace(/\*\*(.+?)\*\*/g, '$1')
    .replace(/(?<!\*)\*([^*\n]+)\*(?!\*)/g, '$1')
    .replace(/`([^`]+)`/g, '$1')
    .replace(/\[([^\]]+)\]\([^)]+\)/g, '$1')
    .trim();
}

// biome-ignore lint/suspicious/noExplicitAny: mdast node shape, not worth importing the type package for
function rawSlice(source: string, node: any): string {
  return node?.position ? source.slice(node.position.start.offset, node.position.end.offset) : '';
}

// A table cell's own position isn't reliably pipe-free across remark-gfm's cell
// boundary handling, so cells (which can't contain a real newline anyway, unlike
// a paragraph) extract by walking inline children instead of slicing raw text.
// biome-ignore lint/suspicious/noExplicitAny: mdast inline node shape
function inlineText(node: any): string {
  if (node.type === 'text' || node.type === 'inlineCode') return node.value ?? '';
  if (Array.isArray(node.children)) return node.children.map(inlineText).join('');
  return '';
}

// Slices by AST position instead of joining child text nodes: joining drops the
// line break a soft wrap leaves between two text nodes, which glued "at all."
// straight into "2." with nothing between them.
export function markdownToBlocks(markdown: string): Block[] {
  // biome-ignore lint/suspicious/noExplicitAny: mdast root, not worth importing the type package for
  const tree: any = unified().use(remarkParse).use(remarkGfm).parse(markdown);
  const blocks: Block[] = [];
  for (const node of tree.children ?? []) {
    if (node.type === 'heading') {
      blocks.push({ type: 'heading', level: node.depth, text: stripInline(rawSlice(markdown, node)) });
    } else if (node.type === 'paragraph') {
      const text = stripInline(rawSlice(markdown, node));
      if (text.length > 0) blocks.push({ type: 'paragraph', text });
    } else if (node.type === 'table') {
      const [headerRow, ...bodyRows] = node.children ?? [];
      // biome-ignore lint/suspicious/noExplicitAny: mdast row node
      const headers = (headerRow?.children ?? []).map((c: any) => stripInline(inlineText(c)));
      // The raw mdast tree keeps every cell a row has, even past the header
      // count; only react-markdown's later hast conversion clips a ragged row.
      // biome-ignore lint/suspicious/noExplicitAny: mdast row node
      const rows = bodyRows.map((r: any) => {
        // biome-ignore lint/suspicious/noExplicitAny: mdast cell node
        const cells = (r.children ?? []).map((c: any) => stripInline(inlineText(c)));
        const row = cells.slice(0, headers.length);
        while (row.length < headers.length) row.push('');
        return row;
      });
      blocks.push({ type: 'table', headers, rows });
    } else if (node.type === 'list') {
      const items = (node.children ?? []).map(
        // A list item's own position includes its marker ("1. "); slicing from
        // its first child skips that so the marker isn't duplicated when a
        // format re-adds its own.
        // biome-ignore lint/suspicious/noExplicitAny: mdast list-item node
        (li: any) => stripInline(rawSlice(markdown, li.children?.[0] ?? li)),
      );
      blocks.push({ type: 'list', ordered: !!node.ordered, items });
    } else if (node.type === 'code') {
      blocks.push({ type: 'code', text: node.value ?? '' });
    }
  }
  return blocks;
}

export function blocksToMarkdown(blocks: Block[]): string {
  const parts: string[] = [];
  for (const block of blocks) {
    if (block.type === 'heading') parts.push(`${'#'.repeat(block.level)} ${block.text}`);
    else if (block.type === 'paragraph') parts.push(block.text);
    else if (block.type === 'code') parts.push(`\`\`\`\n${block.text}\n\`\`\``);
    else if (block.type === 'list') parts.push(block.items.map((item, i) => `${block.ordered ? `${i + 1}.` : '-'} ${item}`).join('\n'));
    else if (block.type === 'table') {
      const sep = block.headers.map(() => '---');
      parts.push([block.headers, sep, ...block.rows].map((row) => `| ${row.join(' | ')} |`).join('\n'));
    }
  }
  return parts.join('\n\n');
}

/** One markdown block per message: no speaker label glued onto the same line, so a
 *  list starting at "1." right after it can still open as a real list, not a
 *  paragraph continuation. */
export function buildConversationMarkdown(entries: ConsoleEntry[]): string {
  const parts: string[] = [];
  for (const entry of entries) {
    if (entry.kind === 'chat-user' || entry.kind === 'chat-assistant') {
      if (entry.kind === 'chat-assistant' && entry.content.trim().length === 0) continue;
      parts.push(entry.content.trim());
    } else if (entry.kind === 'run') {
      const text = entry.lines.map((l) => l.line).join('\n').trim();
      if (text.length > 0) parts.push(`\`\`\`\n${text}\n\`\`\``);
    }
  }
  return parts.join('\n\n');
}

function slugFilename(name: string, ext: string): string {
  const safe = name.trim().replace(/[^a-z0-9-_ ]/gi, '').replace(/\s+/g, '-').toLowerCase();
  return `${safe || 'export'}.${ext}`;
}

function downloadBlob(blob: Blob, filename: string): void {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
}

export function exportMarkdown(blocks: Block[], name: string): void {
  downloadBlob(new Blob([blocksToMarkdown(blocks)], { type: 'text/markdown' }), slugFilename(name, 'md'));
}

/** Shared with the popup's preview pane, so what's shown there is exactly what
 *  the .txt download contains, not a re-derived approximation of it. */
export function blocksToTextLines(blocks: Block[]): string[] {
  const lines: string[] = [];
  for (const block of blocks) {
    if (block.type === 'heading') lines.push(block.text.toUpperCase());
    else if (block.type === 'paragraph') lines.push(block.text);
    else if (block.type === 'list') block.items.forEach((item, i) => lines.push(`${block.ordered ? `${i + 1}.` : '-'} ${item}`));
    else if (block.type === 'code') lines.push(block.text);
    else if (block.type === 'table') {
      lines.push(block.headers.join('\t'));
      for (const row of block.rows) lines.push(row.join('\t'));
    }
    lines.push('');
  }
  return lines;
}

export function exportText(blocks: Block[], name: string): void {
  downloadBlob(new Blob([blocksToTextLines(blocks).join('\n').trim()], { type: 'text/plain' }), slugFilename(name, 'txt'));
}

function csvCell(value: string): string {
  return /[",\n]/.test(value) ? `"${value.replace(/"/g, '""')}"` : value;
}

// Tables become real rows; everything else becomes a one-column row, so a
// conversation with no table in it still exports to something readable. Shared
// by CSV, Excel, and the preview pane: all three are the same flattened grid.
export function blocksToRows(blocks: Block[]): string[][] {
  const rows: string[][] = [];
  for (const block of blocks) {
    if (block.type === 'table') {
      rows.push(block.headers, ...block.rows, []);
    } else if (block.type === 'heading' || block.type === 'paragraph' || block.type === 'code') {
      rows.push([block.text]);
    } else if (block.type === 'list') {
      block.items.forEach((item) => rows.push([item]));
    }
  }
  return rows;
}

export function exportCsv(blocks: Block[], name: string): void {
  const csv = blocksToRows(blocks)
    .map((row) => row.map(csvCell).join(','))
    .join('\n');
  downloadBlob(new Blob([csv], { type: 'text/csv' }), slugFilename(name, 'csv'));
}

// jsPDF's built-in fonts only cover WinAnsi/Latin-1; an emoji renders as
// mismatched bytes instead of being skipped. docx/xlsx use real Unicode text.
function stripUnsupportedGlyphs(text: string): string {
  return text
    .replace(/[\p{Extended_Pictographic}\u{1F3FB}-\u{1F3FF}\uFE0F\u200D]/gu, '')
    .replace(/[ \t]+/g, ' ')
    .trim();
}

function sanitizeForPdf(blocks: Block[]): Block[] {
  return blocks.map((block) => {
    if (block.type === 'heading' || block.type === 'paragraph' || block.type === 'code') {
      return { ...block, text: stripUnsupportedGlyphs(block.text) };
    }
    if (block.type === 'list') {
      return { ...block, items: block.items.map(stripUnsupportedGlyphs) };
    }
    return {
      ...block,
      headers: block.headers.map(stripUnsupportedGlyphs),
      rows: block.rows.map((row) => row.map(stripUnsupportedGlyphs)),
    };
  });
}

export async function exportPdf(rawBlocks: Block[], name: string): Promise<void> {
  const { jsPDF } = await import('jspdf');
  const autoTable = (await import('jspdf-autotable')).default;
  const blocks = sanitizeForPdf(rawBlocks);
  const doc = new jsPDF({ unit: 'pt' });
  const margin = 40;
  const pageWidth = doc.internal.pageSize.getWidth() - margin * 2;
  const pageHeight = doc.internal.pageSize.getHeight();
  let y = margin;
  // One color and body size for every block, table included: autoTable ships
  // its own defaults (a smaller, greyer body font) that read as a different
  // document from the paragraphs around it unless overridden to match.
  const TEXT_COLOR: [number, number, number] = [20, 20, 20];
  const BODY_SIZE = 11;
  const ensureRoom = (needed: number) => {
    if (y + needed <= pageHeight - margin) return;
    doc.addPage();
    y = margin;
  };
  for (const block of blocks) {
    if (block.type === 'heading') {
      const size = Math.max(BODY_SIZE, 18 - block.level * 2);
      doc.setFont('helvetica', 'bold');
      doc.setFontSize(size);
      doc.setTextColor(...TEXT_COLOR);
      const wrapped = doc.splitTextToSize(block.text, pageWidth);
      ensureRoom(wrapped.length * size * 1.25);
      doc.text(wrapped, margin, y);
      y += wrapped.length * size * 1.25 + 6;
    } else if (block.type === 'paragraph' || block.type === 'code') {
      doc.setFont(block.type === 'code' ? 'courier' : 'helvetica', 'normal');
      doc.setFontSize(block.type === 'code' ? 9 : BODY_SIZE);
      doc.setTextColor(...TEXT_COLOR);
      const wrapped = doc.splitTextToSize(block.text, pageWidth);
      ensureRoom(wrapped.length * 14);
      doc.text(wrapped, margin, y);
      y += wrapped.length * 14 + 8;
    } else if (block.type === 'list') {
      doc.setFont('helvetica', 'normal');
      doc.setFontSize(BODY_SIZE);
      doc.setTextColor(...TEXT_COLOR);
      block.items.forEach((item, i) => {
        const wrapped = doc.splitTextToSize(`${block.ordered ? `${i + 1}.` : '•'} ${item}`, pageWidth);
        ensureRoom(wrapped.length * 14);
        doc.text(wrapped, margin, y);
        y += wrapped.length * 14 + 2;
      });
      y += 6;
    } else if (block.type === 'table') {
      autoTable(doc, {
        startY: y,
        head: [block.headers],
        body: block.rows,
        margin: { left: margin, right: margin },
        // jspdf-autotable's default theme fills the header blue and sets its
        // own smaller, greyer body font; both overridden to match the plain
        // black-on-white, same-size look of the rest of the page.
        theme: 'grid',
        styles: { font: 'helvetica', fontSize: BODY_SIZE, textColor: TEXT_COLOR },
        headStyles: { fillColor: [240, 240, 240], textColor: TEXT_COLOR, fontStyle: 'bold' },
      });
      // biome-ignore lint/suspicious/noExplicitAny: jspdf-autotable augments the doc instance at runtime
      y = (doc as any).lastAutoTable.finalY + 16;
    }
  }
  doc.save(slugFilename(name, 'pdf'));
}

export async function exportDocx(blocks: Block[], name: string): Promise<void> {
  const { Document, HeadingLevel, Packer, Paragraph, Table, TableCell, TableRow, TextRun } = await import('docx');
  const HEADING_LEVELS = [
    HeadingLevel.HEADING_1,
    HeadingLevel.HEADING_2,
    HeadingLevel.HEADING_3,
    HeadingLevel.HEADING_4,
    HeadingLevel.HEADING_5,
    HeadingLevel.HEADING_6,
  ];
  const children: (InstanceType<typeof Paragraph> | InstanceType<typeof Table>)[] = [];
  for (const block of blocks) {
    if (block.type === 'heading') {
      children.push(new Paragraph({ text: block.text, heading: HEADING_LEVELS[Math.min(block.level, 6) - 1] }));
    } else if (block.type === 'paragraph') {
      children.push(new Paragraph({ children: [new TextRun(block.text)] }));
    } else if (block.type === 'code') {
      children.push(new Paragraph({ children: [new TextRun({ text: block.text, font: 'Courier New' })] }));
    } else if (block.type === 'list') {
      for (const item of block.items) children.push(new Paragraph({ text: item, bullet: { level: 0 } }));
    } else if (block.type === 'table') {
      const headerRow = new TableRow({
        children: block.headers.map(
          (h) => new TableCell({ children: [new Paragraph({ children: [new TextRun({ text: h, bold: true })] })] }),
        ),
      });
      const bodyRows = block.rows.map(
        (row) => new TableRow({ children: row.map((cell) => new TableCell({ children: [new Paragraph(cell)] })) }),
      );
      children.push(new Table({ rows: [headerRow, ...bodyRows] }));
      children.push(new Paragraph(''));
    }
  }
  const doc = new Document({ sections: [{ children }] });
  const blob = await Packer.toBlob(doc);
  downloadBlob(blob, slugFilename(name, 'docx'));
}

export async function exportXlsx(blocks: Block[], name: string): Promise<void> {
  const XLSX = await import('xlsx');
  const sheet = XLSX.utils.aoa_to_sheet(blocksToRows(blocks));
  const workbook = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(workbook, sheet, 'Export');
  XLSX.writeFile(workbook, slugFilename(name, 'xlsx'));
}

export async function runExport(format: ExportFormat, blocks: Block[], name: string): Promise<void> {
  if (format === 'markdown') return exportMarkdown(blocks, name);
  if (format === 'txt') return exportText(blocks, name);
  if (format === 'csv') return exportCsv(blocks, name);
  if (format === 'pdf') return exportPdf(blocks, name);
  if (format === 'docx') return exportDocx(blocks, name);
  return exportXlsx(blocks, name);
}
