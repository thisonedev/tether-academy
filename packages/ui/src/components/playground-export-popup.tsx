'use client';

import { Download, FileSpreadsheet, FileText, GripVertical, Heading2, List, Plus, Table2, Type, X } from 'lucide-react';
import type { ComponentType } from 'react';
import { useRef, useState } from 'react';
import {
  type Block,
  blocksToMarkdown,
  blocksToRows,
  blocksToTextLines,
  type ExportFormat,
  markdownToBlocks,
  runExport,
} from './playground-export.js';

export interface PlaygroundExportPopupProps {
  title: string;
  initialMarkdown: string;
  /** Which formats make sense here: a table offers CSV/Excel, a whole conversation doesn't. */
  formats: ExportFormat[];
  /** Seeds the file-name field: the workflow's own name, not a generic constant. */
  defaultName: string;
  onClose: () => void;
}

/** Native HTML5 drag reorder, shared by list items and table rows: no library,
 *  just an index carried across the drag and applied on drop. */
function useDragReorder<T>(items: T[], onReorder: (next: T[]) => void) {
  const dragFrom = useRef<number | null>(null);
  return {
    onDragStart: (i: number) => () => {
      dragFrom.current = i;
    },
    onDragOver: (_i: number) => (e: React.DragEvent) => {
      e.preventDefault();
    },
    onDrop: (i: number) => (e: React.DragEvent) => {
      e.preventDefault();
      const from = dragFrom.current;
      dragFrom.current = null;
      if (from === null || from === i) return;
      const next = items.slice();
      const [moved] = next.splice(from, 1);
      next.splice(i, 0, moved);
      onReorder(next);
    },
  };
}

const FORMAT_LABEL: Record<ExportFormat, string> = {
  pdf: 'PDF',
  markdown: 'Markdown',
  txt: 'Text',
  csv: 'CSV',
  docx: 'Word',
  xlsx: 'Excel',
};

// Colors borrowed from each format's own native app (Adobe red, Word blue,
// Excel green), so the format picker and its preview read as that app's file,
// not a generic export.
const FORMAT_META: Record<ExportFormat, { icon: ComponentType<{ className?: string }>; accent: string; ext: string }> = {
  pdf: { icon: FileText, accent: '#dc2626', ext: '.pdf' },
  docx: { icon: FileText, accent: '#2b579a', ext: '.docx' },
  markdown: { icon: FileText, accent: '#9ca3af', ext: '.md' },
  txt: { icon: FileText, accent: '#9ca3af', ext: '.txt' },
  csv: { icon: FileSpreadsheet, accent: '#6b7280', ext: '.csv' },
  xlsx: { icon: FileSpreadsheet, accent: '#217346', ext: '.xlsx' },
};

const BLOCK_LABEL: Record<Block['type'], string> = {
  heading: 'Heading',
  paragraph: 'Text',
  list: 'List',
  table: 'Table',
  code: 'Code',
};

// What you can add by hand, in case the reply left something out: a code
// block only ever comes from a real run, so it's not on this list.
const ADDABLE_BLOCKS: { type: 'heading' | 'paragraph' | 'list' | 'table'; label: string; icon: ComponentType<{ className?: string }> }[] = [
  { type: 'heading', label: 'Heading', icon: Heading2 },
  { type: 'paragraph', label: 'Text', icon: Type },
  { type: 'list', label: 'List', icon: List },
  { type: 'table', label: 'Table', icon: Table2 },
];

function blankBlock(type: (typeof ADDABLE_BLOCKS)[number]['type']): Block {
  if (type === 'heading') return { type: 'heading', level: 2, text: '' };
  if (type === 'paragraph') return { type: 'paragraph', text: '' };
  if (type === 'list') return { type: 'list', ordered: false, items: [''] };
  return { type: 'table', headers: ['Column 1', 'Column 2'], rows: [['', '']] };
}

/** Centered, not anchored to a node: this can be triggered from the toolbar with
 *  nothing selected, unlike the per-node config popup. */
export function PlaygroundExportPopup({ title, initialMarkdown, formats, defaultName, onClose }: PlaygroundExportPopupProps) {
  const [blocks, setBlocks] = useState<Block[]>(() => markdownToBlocks(initialMarkdown));
  const [format, setFormat] = useState<ExportFormat>(formats[0]);
  const [name, setName] = useState(defaultName);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const removeBlock = (index: number) => setBlocks((bs) => bs.filter((_, i) => i !== index));
  const updateBlock = (index: number, next: Block) => setBlocks((bs) => bs.map((b, i) => (i === index ? next : b)));
  const addBlock = (type: (typeof ADDABLE_BLOCKS)[number]['type']) => setBlocks((bs) => [...bs, blankBlock(type)]);
  const blockDrag = useDragReorder(blocks, setBlocks);

  const handleExport = async () => {
    setBusy(true);
    setError(null);
    try {
      await runExport(format, blocks, name);
      onClose();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Export failed.');
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4" onClick={onClose}>
      <div
        className="flex max-h-[85vh] w-full max-w-4xl flex-col overflow-hidden rounded-2xl border border-canvas-border bg-canvas-muted font-mono shadow-2xl"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center gap-2 border-b border-canvas-border px-4 py-3">
          <div className="text-sm font-semibold text-canvas-foreground">{title}</div>
          <button
            type="button"
            onClick={onClose}
            className="ml-auto text-canvas-muted-foreground hover:text-canvas-foreground"
            aria-label="Close"
          >
            <X className="size-4" />
          </button>
        </div>

        <div className="border-b border-canvas-border px-4 py-3">
          <div className="flex flex-wrap gap-1.5">
            {formats.map((f) => {
              const meta = FORMAT_META[f];
              const Icon = meta.icon;
              const active = format === f;
              return (
                <button
                  key={f}
                  type="button"
                  onClick={() => setFormat(f)}
                  aria-pressed={active}
                  style={active ? { borderColor: meta.accent, color: meta.accent } : undefined}
                  className={`flex items-center gap-1.5 rounded-md border px-3 py-1.5 text-[12.5px] transition-colors ${
                    active
                      ? 'bg-canvas'
                      : 'border-canvas-border text-canvas-muted-foreground hover:text-canvas-foreground'
                  }`}
                >
                  <Icon className="size-3.5" />
                  {FORMAT_LABEL[f]}
                </button>
              );
            })}
          </div>
        </div>

        <div className="flex min-h-0 flex-1">
          <div className="min-h-0 flex-1 overflow-y-auto border-r border-canvas-border bg-canvas p-4">
            <div className="mb-2 text-[11.5px] text-canvas-muted-foreground">
              Preview of the {FORMAT_LABEL[format]} export
            </div>
            <ExportPreview format={format} blocks={blocks} name={name} />
          </div>

          <div className="flex min-h-0 w-[340px] shrink-0 flex-col gap-3 overflow-y-auto px-4 py-3.5">
            <div>
              <label className="mb-1 block text-[11.5px] text-canvas-muted-foreground" htmlFor="pg-export-name">
                File name
              </label>
              <input
                id="pg-export-name"
                type="text"
                value={name}
                onChange={(e) => setName(e.target.value)}
                className="w-full rounded-lg border border-canvas-border bg-canvas px-2.5 py-2 text-[12.5px] text-canvas-foreground focus:border-emerald-500/60 focus:outline-none focus:ring-1 focus:ring-emerald-500/30"
              />
            </div>

            <div>
              <div className="mb-1 text-[11.5px] text-canvas-muted-foreground">
                Remove or edit any section before exporting
              </div>
              <div className="space-y-2">
                {blocks.map((block, i) => (
                  <BlockCard
                    // biome-ignore lint/suspicious/noArrayIndexKey: blocks have no stable id and only ever reorder by removal
                    key={i}
                    block={block}
                    onChange={(next) => updateBlock(i, next)}
                    onRemove={() => removeBlock(i)}
                    onDragStart={blockDrag.onDragStart(i)}
                    onDragOver={blockDrag.onDragOver(i)}
                    onDrop={blockDrag.onDrop(i)}
                  />
                ))}
                {blocks.length === 0 ? (
                  <p className="text-[12px] text-canvas-muted-foreground">Nothing left to export.</p>
                ) : null}
              </div>
            </div>

            <div>
              <div className="mb-1 text-[11.5px] text-canvas-muted-foreground">Add a section</div>
              <div className="flex flex-wrap gap-1.5">
                {ADDABLE_BLOCKS.map(({ type, label, icon: Icon }) => (
                  <button
                    key={type}
                    type="button"
                    onClick={() => addBlock(type)}
                    className="flex items-center gap-1 rounded-md border border-canvas-border px-2 py-1 text-[11.5px] text-canvas-muted-foreground transition-colors hover:border-emerald-500/60 hover:text-emerald-400"
                  >
                    <Plus className="size-3" />
                    <Icon className="size-3" />
                    {label}
                  </button>
                ))}
              </div>
            </div>

            {error ? <p className="text-[11.5px] text-red-400">{error}</p> : null}
          </div>
        </div>

        <div className="border-t border-canvas-border px-4 py-3">
          <button
            type="button"
            onClick={handleExport}
            disabled={busy || blocks.length === 0}
            className="flex w-full items-center justify-center gap-2 rounded-md border border-emerald-500/60 px-3 py-1.5 text-[12.5px] font-semibold text-emerald-400 transition-colors hover:bg-emerald-500/10 disabled:cursor-not-allowed disabled:opacity-40"
          >
            <Download className="size-3.5" />
            {busy ? 'Exporting…' : 'Export'}
          </button>
        </div>
      </div>
    </div>
  );
}

// Column letters (A, B, C, ... AA, AB, ...), same convention every spreadsheet
// app uses, so the grid reads as "a spreadsheet" rather than just a table.
function columnLetter(index: number): string {
  let n = index;
  let out = '';
  do {
    out = String.fromCharCode(65 + (n % 26)) + out;
    n = Math.floor(n / 26) - 1;
  } while (n >= 0);
  return out;
}

// A tab bar naming the actual output file, same idea an editor or a browser
// download bar uses, so every format's preview is titled consistently.
function PreviewTab({ name, ext, accent }: { name: string; ext: string; accent: string }) {
  return (
    <div className="flex items-center gap-1.5 border-b border-canvas-border bg-canvas-muted px-3 py-1.5 text-[11px] text-canvas-muted-foreground">
      <span className="size-1.5 shrink-0 rounded-full" style={{ backgroundColor: accent }} />
      <span className="truncate">
        {name.trim() || 'export'}
        {ext}
      </span>
    </div>
  );
}

// A light "page" for pdf/docx, a file-tab dump for markdown/txt (byte-identical
// to what downloads), a real row/column grid for csv/xlsx.
function ExportPreview({ format, blocks, name }: { format: ExportFormat; blocks: Block[]; name: string }) {
  const meta = FORMAT_META[format];
  if (blocks.length === 0) {
    return <p className="text-[12px] text-canvas-muted-foreground">Nothing to preview.</p>;
  }
  if (format === 'markdown' || format === 'txt') {
    const text = format === 'markdown' ? blocksToMarkdown(blocks) : blocksToTextLines(blocks).join('\n').trim();
    return (
      <div className="overflow-hidden rounded-lg border border-canvas-border">
        <PreviewTab name={name} ext={meta.ext} accent={meta.accent} />
        <pre className="wrap-anywhere whitespace-pre-wrap bg-canvas-muted p-3 font-mono text-[11.5px] text-canvas-foreground">
          {text}
        </pre>
      </div>
    );
  }
  if (format === 'csv' || format === 'xlsx') {
    const rows = blocksToRows(blocks).filter((r) => r.length > 0);
    const columnCount = Math.max(1, ...rows.map((r) => r.length));
    return (
      <div className="overflow-hidden rounded-lg border border-canvas-border">
        <PreviewTab name={name} ext={meta.ext} accent={meta.accent} />
        <div className="overflow-auto">
          <table className="w-full border-collapse text-left">
            <thead>
              <tr>
                <th className="border border-neutral-300 bg-neutral-100 px-2 py-1" />
                {Array.from({ length: columnCount }, (_, c) => (
                  <th
                    key={columnLetter(c)}
                    className="border border-neutral-300 px-2 py-1 text-center text-[10.5px] font-semibold text-white"
                    style={{ backgroundColor: meta.accent }}
                  >
                    {columnLetter(c)}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {rows.map((row, r) => (
                // biome-ignore lint/suspicious/noArrayIndexKey: row position is the identity here, preview is read-only
                <tr key={r}>
                  <td className="border border-neutral-300 bg-neutral-100 px-2 py-1 text-center text-[10.5px] text-neutral-500">
                    {r + 1}
                  </td>
                  {Array.from({ length: columnCount }, (_, c) => (
                    // biome-ignore lint/suspicious/noArrayIndexKey: column position is the identity here, preview is read-only
                    <td key={c} className="border border-neutral-300 bg-white px-2 py-1 text-[11px] text-neutral-800">
                      {row[c] ?? ''}
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>
    );
  }
  // pdf / docx: a floating page on the panel's dark backdrop, with the
  // app's own accent as the top edge, same as a native viewer's page border.
  return (
    <div className="mx-auto max-w-md overflow-hidden rounded-lg shadow-xl">
      <PreviewTab name={name} ext={meta.ext} accent={meta.accent} />
      <div className="h-1.5" style={{ backgroundColor: meta.accent }} />
      <div className="bg-white p-6">
        <p className="mb-3 border-b border-neutral-200 pb-2 text-lg font-bold text-neutral-900">
          {name.trim() || 'Untitled'}
        </p>
        {blocks.map((block, i) => (
          // biome-ignore lint/suspicious/noArrayIndexKey: block position is the identity here, preview is read-only
          <DocBlock key={i} block={block} />
        ))}
      </div>
    </div>
  );
}

const HEADING_SIZE = ['text-2xl', 'text-xl', 'text-lg', 'text-base', 'text-sm', 'text-sm'];

function DocBlock({ block }: { block: Block }) {
  if (block.type === 'heading') {
    return (
      <p className={`${HEADING_SIZE[Math.min(block.level, 6) - 1]} mt-3 mb-2 font-bold text-neutral-900 first:mt-0`}>
        {block.text}
      </p>
    );
  }
  if (block.type === 'paragraph') {
    return <p className="mb-2 text-[13px] leading-relaxed text-neutral-800">{block.text}</p>;
  }
  if (block.type === 'code') {
    return <pre className="wrap-anywhere mb-2 whitespace-pre-wrap rounded bg-neutral-100 p-2 font-mono text-[11px] text-neutral-800">{block.text}</pre>;
  }
  if (block.type === 'list') {
    const items = block.items.map((item, i) => (
      // biome-ignore lint/suspicious/noArrayIndexKey: item position is the identity here, preview is read-only
      <li key={i}>{item}</li>
    ));
    return block.ordered ? (
      <ol className="mb-2 list-decimal space-y-0.5 pl-6 text-[13px] text-neutral-800">{items}</ol>
    ) : (
      <ul className="mb-2 list-disc space-y-0.5 pl-6 text-[13px] text-neutral-800">{items}</ul>
    );
  }
  return (
    <table className="mb-2 w-full border-collapse text-left text-[12px]">
      <thead>
        <tr>
          {block.headers.map((h, i) => (
            // biome-ignore lint/suspicious/noArrayIndexKey: column position is the identity here, preview is read-only
            <th key={i} className="border border-neutral-300 bg-neutral-100 px-2 py-1 font-semibold text-neutral-900">
              {h}
            </th>
          ))}
        </tr>
      </thead>
      <tbody>
        {block.rows.map((row, r) => (
          // biome-ignore lint/suspicious/noArrayIndexKey: row position is the identity here, preview is read-only
          <tr key={r}>
            {row.map((cell, c) => (
              // biome-ignore lint/suspicious/noArrayIndexKey: column position is the identity here, preview is read-only
              <td key={c} className="border border-neutral-300 px-2 py-1 text-neutral-800">
                {cell}
              </td>
            ))}
          </tr>
        ))}
      </tbody>
    </table>
  );
}

function BlockCard({
  block,
  onChange,
  onRemove,
  onDragStart,
  onDragOver,
  onDrop,
}: {
  block: Block;
  onChange: (next: Block) => void;
  onRemove: () => void;
  onDragStart: () => void;
  onDragOver: (e: React.DragEvent) => void;
  onDrop: (e: React.DragEvent) => void;
}) {
  return (
    <div onDragOver={onDragOver} onDrop={onDrop} className="group relative rounded-lg border border-canvas-border bg-canvas p-2.5 pr-7">
      <div className="mb-1 flex items-center gap-1.5 text-[10px] font-semibold tracking-wider text-canvas-muted-foreground uppercase">
        {/* Only this handle is draggable, not the whole card: the card also holds
            nested draggable rows (list items, table rows), and a card-wide drag
            would fight the nearest-draggable-ancestor rule those rely on. */}
        <span draggable onDragStart={onDragStart} className="cursor-grab active:cursor-grabbing">
          <GripVertical className="size-3" />
        </span>
        {BLOCK_LABEL[block.type]}
      </div>
      <button
        type="button"
        onClick={onRemove}
        aria-label="Remove this section"
        title="Remove this section"
        className="absolute top-2 right-2 text-canvas-muted-foreground opacity-0 transition-opacity hover:text-red-400 group-hover:opacity-100"
      >
        <X className="size-3.5" />
      </button>
      {block.type === 'table' ? (
        <TableBlockEditor block={block} onChange={onChange} />
      ) : block.type === 'list' ? (
        <ListBlockEditor block={block} onChange={onChange} />
      ) : (
        <textarea
          value={block.text}
          onChange={(e) => onChange({ ...block, text: e.target.value })}
          rows={Math.min(8, Math.max(1, Math.ceil(block.text.length / 60)))}
          className="w-full resize-y rounded border border-canvas-border bg-canvas-muted px-2 py-1.5 font-mono text-[12px] text-canvas-foreground focus:border-emerald-500/60 focus:outline-none focus:ring-1 focus:ring-emerald-500/30"
        />
      )}
    </div>
  );
}

function ListBlockEditor({
  block,
  onChange,
}: {
  block: Extract<Block, { type: 'list' }>;
  onChange: (next: Block) => void;
}) {
  const setItem = (index: number, value: string) => {
    onChange({ ...block, items: block.items.map((item, i) => (i === index ? value : item)) });
  };
  const removeItem = (index: number) => {
    onChange({ ...block, items: block.items.filter((_, i) => i !== index) });
  };
  const addItem = () => onChange({ ...block, items: [...block.items, ''] });
  const drag = useDragReorder(block.items, (items) => onChange({ ...block, items }));
  return (
    <div className="space-y-1">
      {block.items.map((item, i) => (
        <div
          // biome-ignore lint/suspicious/noArrayIndexKey: item position is the identity here
          key={i}
          draggable
          onDragStart={drag.onDragStart(i)}
          onDragOver={drag.onDragOver(i)}
          onDrop={drag.onDrop(i)}
          className="flex items-center gap-1.5"
        >
          <GripVertical className="size-3.5 shrink-0 cursor-grab text-canvas-muted-foreground/60 active:cursor-grabbing" />
          <span className="w-5 shrink-0 text-right font-mono text-[11px] text-canvas-muted-foreground">
            {block.ordered ? `${i + 1}.` : '•'}
          </span>
          <input
            value={item}
            onChange={(e) => setItem(i, e.target.value)}
            className="min-w-0 flex-1 rounded border border-canvas-border bg-canvas-muted px-2 py-1 text-[12px] text-canvas-foreground focus:border-emerald-500/60 focus:outline-none focus:ring-1 focus:ring-emerald-500/30"
          />
          <button
            type="button"
            onClick={() => removeItem(i)}
            aria-label="Remove item"
            title="Remove item"
            className="shrink-0 text-canvas-muted-foreground hover:text-red-400"
          >
            <X className="size-3" />
          </button>
        </div>
      ))}
      <button
        type="button"
        onClick={addItem}
        className="flex items-center gap-1 pl-5 text-[11.5px] text-canvas-muted-foreground transition-colors hover:text-emerald-400"
      >
        <Plus className="size-3" />
        Add item
      </button>
    </div>
  );
}

function TableBlockEditor({
  block,
  onChange,
}: {
  block: Extract<Block, { type: 'table' }>;
  onChange: (next: Block) => void;
}) {
  const setCell = (rowIndex: number, colIndex: number, value: string) => {
    const rows = block.rows.map((row, r) => (r === rowIndex ? row.map((cell, c) => (c === colIndex ? value : cell)) : row));
    onChange({ ...block, rows });
  };
  const setHeader = (colIndex: number, value: string) => {
    onChange({ ...block, headers: block.headers.map((h, c) => (c === colIndex ? value : h)) });
  };
  const removeRow = (rowIndex: number) => {
    onChange({ ...block, rows: block.rows.filter((_, r) => r !== rowIndex) });
  };
  const addRow = () => onChange({ ...block, rows: [...block.rows, block.headers.map(() => '')] });
  const cellClass =
    'w-full min-w-0 bg-transparent px-1.5 py-1 text-[11.5px] text-canvas-foreground focus:outline-none focus:ring-1 focus:ring-emerald-500/40';
  const drag = useDragReorder(block.rows, (rows) => onChange({ ...block, rows }));
  return (
    <div className="overflow-x-auto">
      <table className="w-full border-collapse text-left">
        <thead className="bg-canvas-muted">
          <tr>
            <th className="w-6 border border-canvas-border" />
            {block.headers.map((h, c) => (
              // biome-ignore lint/suspicious/noArrayIndexKey: column position is the identity here
              <th key={c} className="border border-canvas-border p-0">
                <input value={h} onChange={(e) => setHeader(c, e.target.value)} className={`${cellClass} font-semibold`} />
              </th>
            ))}
            <th className="w-6 border border-canvas-border" />
          </tr>
        </thead>
        <tbody>
          {block.rows.map((row, r) => (
            <tr
              // biome-ignore lint/suspicious/noArrayIndexKey: row position is the identity here
              key={r}
              draggable
              onDragStart={drag.onDragStart(r)}
              onDragOver={drag.onDragOver(r)}
              onDrop={drag.onDrop(r)}
            >
              <td className="cursor-grab border border-canvas-border text-center active:cursor-grabbing">
                <GripVertical className="mx-auto size-3.5 text-canvas-muted-foreground/60" />
              </td>
              {row.map((cell, c) => (
                // biome-ignore lint/suspicious/noArrayIndexKey: column position is the identity here
                <td key={c} className="border border-canvas-border p-0">
                  <input value={cell} onChange={(e) => setCell(r, c, e.target.value)} className={cellClass} />
                </td>
              ))}
              <td className="border border-canvas-border text-center">
                <button
                  type="button"
                  onClick={() => removeRow(r)}
                  aria-label="Remove row"
                  title="Remove row"
                  className="text-canvas-muted-foreground hover:text-red-400"
                >
                  <X className="size-3" />
                </button>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      <button
        type="button"
        onClick={addRow}
        className="mt-1 flex items-center gap-1 text-[11.5px] text-canvas-muted-foreground transition-colors hover:text-emerald-400"
      >
        <Plus className="size-3" />
        Add row
      </button>
    </div>
  );
}
