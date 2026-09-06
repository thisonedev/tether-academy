'use client';

import { Download, FileSpreadsheet, FileText, GripVertical, Heading2, List, Plus, Table2, Type, X } from 'lucide-react';
import type { ComponentType } from 'react';
import { useEffect, useRef, useState } from 'react';
import { type Block, type ExportFormat, markdownToBlocks, runExport } from './playground-export.js';

export interface PlaygroundExportPopupProps {
  title: string;
  initialMarkdown: string;
  /** Which formats make sense here: a table offers CSV/Excel, a whole conversation doesn't. */
  formats: ExportFormat[];
  /** Seeds the file-name field: the workflow's own name, not a generic constant. */
  defaultName: string;
  onClose: () => void;
}

/** Drag-to-reorder via raw pointer tracking, not the HTML5 drag-and-drop API,
 *  which behaved inconsistently for real mouse input here; tracks the mouse
 *  directly and commits an insertion index on release, Notion/Trello-style. */
function usePointerReorder<T>(items: T[], onReorder: (next: T[]) => void) {
  const [dragIndex, setDragIndex] = useState<number | null>(null);
  const [overIndex, setOverIndex] = useState<number | null>(null);
  const itemRefs = useRef<(HTMLElement | null)[]>([]);
  const overIndexRef = useRef<number | null>(null);
  const itemsRef = useRef(items);
  itemsRef.current = items;

  const setItemRef = (i: number) => (el: HTMLElement | null) => {
    itemRefs.current[i] = el;
  };

  const startDrag = (fromIndex: number) => (e: React.MouseEvent) => {
    if (e.button !== 0) return;
    e.preventDefault();
    setDragIndex(fromIndex);
    setOverIndex(fromIndex);
    overIndexRef.current = fromIndex;
    const prevUserSelect = document.body.style.userSelect;
    document.body.style.userSelect = 'none';

    // Compares the cursor to every item's own midpoint rather than asking
    // which one it's "over", so it can also target the gap after the last item.
    const handleMove = (ev: MouseEvent) => {
      const refs = itemRefs.current;
      let insertAt = refs.length;
      for (let idx = 0; idx < refs.length; idx++) {
        const rect = refs[idx]?.getBoundingClientRect();
        if (rect && ev.clientY < rect.top + rect.height / 2) {
          insertAt = idx;
          break;
        }
      }
      overIndexRef.current = insertAt;
      setOverIndex(insertAt);
    };
    const handleUp = () => {
      window.removeEventListener('mousemove', handleMove);
      window.removeEventListener('mouseup', handleUp);
      document.body.style.userSelect = prevUserSelect;
      const to = overIndexRef.current;
      setDragIndex(null);
      setOverIndex(null);
      overIndexRef.current = null;
      if (to !== null && to !== fromIndex && to !== fromIndex + 1) {
        const next = itemsRef.current.slice();
        const [moved] = next.splice(fromIndex, 1);
        next.splice(to > fromIndex ? to - 1 : to, 0, moved);
        onReorder(next);
      }
    };
    window.addEventListener('mousemove', handleMove);
    window.addEventListener('mouseup', handleUp);
  };

  return { dragIndex, overIndex, setItemRef, startDrag };
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

// A grid preview (csv/xlsx) is the one format family that's a flat sheet
// instead of a document; every other format shares the same page-like canvas.
const isGridFormat = (format: ExportFormat) => format === 'csv' || format === 'xlsx';
// Markdown is the only format whose page hints its own syntax ("# ", "- ")
// inline; docx/pdf/txt just show the plain text.
const isMarkdownFormat = (format: ExportFormat) => format === 'markdown';

type AddableType = 'heading' | 'paragraph' | 'list' | 'table';

const ADDABLE_BLOCKS: { type: AddableType; label: string; icon: ComponentType<{ className?: string }> }[] = [
  { type: 'heading', label: 'Heading', icon: Heading2 },
  { type: 'paragraph', label: 'Text', icon: Type },
  { type: 'list', label: 'List', icon: List },
  { type: 'table', label: 'Table', icon: Table2 },
];

function blankBlock(type: AddableType): Block {
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

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [onClose]);

  const updateBlock = (index: number, next: Block) => setBlocks((bs) => bs.map((b, i) => (i === index ? next : b)));
  const removeBlock = (index: number) => setBlocks((bs) => bs.filter((_, i) => i !== index));
  const insertBlock = (index: number, type: AddableType) =>
    setBlocks((bs) => {
      const next = bs.slice();
      next.splice(index, 0, blankBlock(type));
      return next;
    });
  const reorderBlocks = (next: Block[]) => setBlocks(next);

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

        <div className="min-h-0 flex-1 overflow-y-auto bg-canvas p-4">
          {blocks.length === 0 ? (
            <p className="text-[12px] text-canvas-muted-foreground">
              Nothing to export.{' '}
              <button type="button" onClick={() => insertBlock(0, 'paragraph')} className="text-emerald-400 hover:underline">
                Add a text block
              </button>
              .
            </p>
          ) : isGridFormat(format) ? (
            <EditableGrid format={format} blocks={blocks} name={name} onUpdateBlock={updateBlock} />
          ) : (
            <EditableDocument
              format={format}
              blocks={blocks}
              name={name}
              onUpdateBlock={updateBlock}
              onRemoveBlock={removeBlock}
              onInsertBlock={insertBlock}
              onReorderBlocks={reorderBlocks}
            />
          )}
        </div>

        <div className="flex items-center gap-2.5 border-t border-canvas-border px-4 py-3">
          <input
            aria-label="File name"
            type="text"
            value={name}
            onChange={(e) => setName(e.target.value)}
            className="w-44 shrink-0 rounded-lg border border-canvas-border bg-canvas px-2.5 py-2 text-[12.5px] text-canvas-foreground focus:border-emerald-500/60 focus:outline-none focus:ring-1 focus:ring-emerald-500/30"
          />
          {error ? <p className="flex-1 truncate text-[11.5px] text-red-400">{error}</p> : <div className="flex-1" />}
          <button
            type="button"
            onClick={handleExport}
            disabled={busy || blocks.length === 0}
            className="flex shrink-0 items-center gap-2 rounded-md border border-emerald-500/60 px-3.5 py-1.5 text-[12.5px] font-semibold text-emerald-400 transition-colors hover:bg-emerald-500/10 disabled:cursor-not-allowed disabled:opacity-40"
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

/** A single-line or wrapping text node that only writes DOM -> block on blur,
 *  so mid-edit keystrokes never fight React's own re-render of the block
 *  above (a real risk with contentEditable driven straight off props). */
function EditableText({
  as: Tag,
  value,
  prefix,
  className,
  onCommit,
  onFocusChange,
}: {
  as: 'div' | 'p' | 'li' | 'th' | 'td';
  value: string;
  /** A markdown syntax hint ("# ", "- ") shown before the text but excluded from what's saved. */
  prefix?: string;
  className?: string;
  onCommit: (next: string) => void;
  onFocusChange?: (focused: boolean) => void;
}) {
  const ref = useRef<HTMLElement | null>(null);
  const shown = (prefix ?? '') + value;
  useEffect(() => {
    const el = ref.current;
    if (el && el.textContent !== shown) el.textContent = shown;
  }, [shown]);
  return (
    <Tag
      ref={ref as never}
      className={className}
      contentEditable
      suppressContentEditableWarning
      onFocus={() => onFocusChange?.(true)}
      onBlur={(e: React.FocusEvent<HTMLElement>) => {
        onFocusChange?.(false);
        const text = (e.currentTarget.textContent ?? '').slice((prefix ?? '').length);
        if (text !== value) onCommit(text);
      }}
    />
  );
}

const HEADING_SIZE = ['text-2xl', 'text-xl', 'text-lg', 'text-base', 'text-sm', 'text-sm'];

/** The single editable canvas for every non-grid format (pdf/docx/markdown/txt):
 *  one block-rendering path, only the surrounding page chrome changes by format. */
function EditableDocument({
  format,
  blocks,
  name,
  onUpdateBlock,
  onRemoveBlock,
  onInsertBlock,
  onReorderBlocks,
}: {
  format: ExportFormat;
  blocks: Block[];
  name: string;
  onUpdateBlock: (index: number, next: Block) => void;
  onRemoveBlock: (index: number) => void;
  onInsertBlock: (index: number, type: AddableType) => void;
  onReorderBlocks: (next: Block[]) => void;
}) {
  const meta = FORMAT_META[format];
  const md = isMarkdownFormat(format);
  const dark = md || format === 'txt';
  const blockDrag = usePointerReorder(blocks, onReorderBlocks);
  const [openGap, setOpenGap] = useState<number | null>(null);

  const pageClass = dark
    ? 'bg-[#0d1117] text-[#e6edf3] p-7 font-mono text-[13px] leading-relaxed'
    : 'mx-auto max-w-2xl bg-white text-neutral-900 p-11 text-[14px] leading-relaxed shadow-xl';
  const borderColor = dark ? '#30363d' : '#e4e4e7';
  const headBg = dark ? '#161b22' : '#f4f4f5';

  return (
    <div className="overflow-hidden rounded-lg border border-canvas-border">
      <PreviewTab name={name} ext={meta.ext} accent={meta.accent} />
      <div className={pageClass}>
        <Gap index={0} open={openGap === 0} onToggle={() => setOpenGap(openGap === 0 ? null : 0)} onPick={(t) => { onInsertBlock(0, t); setOpenGap(null); }} dark={dark} />
        {blocks.map((block, i) => (
          <div
            key={i}
            ref={blockDrag.setItemRef(i)}
            className={`group/block relative -mx-3 mb-1 rounded-lg px-3 py-1 hover:bg-emerald-500/[0.06] ${blockDrag.overIndex === i ? 'border-t-2 border-emerald-400' : 'border-t-2 border-transparent'} ${blockDrag.dragIndex === i ? 'opacity-40' : ''} ${blockDrag.overIndex === blocks.length && i === blocks.length - 1 ? 'border-b-2 border-b-emerald-400' : ''}`}
          >
            <span
              onMouseDown={blockDrag.startDrag(i)}
              title="Drag to reorder"
              className={`absolute top-1.5 -left-[26px] cursor-grab opacity-0 transition-opacity group-hover/block:opacity-100 active:cursor-grabbing ${dark ? 'text-[#6e7681]' : 'text-neutral-400'}`}
            >
              <GripVertical className="size-3.5" />
            </span>
            <button
              type="button"
              onClick={() => onRemoveBlock(i)}
              aria-label="Remove this section"
              title="Remove this section"
              className={`absolute top-1.5 right-1.5 rounded p-0.5 opacity-0 transition-opacity group-hover/block:opacity-100 ${dark ? 'text-[#8b949e] hover:bg-white/10' : 'text-neutral-400 hover:bg-black/5'} hover:text-red-400`}
            >
              <X className="size-3.5" />
            </button>

            {block.type === 'heading' ? (
              <EditableText
                as="div"
                value={block.text}
                prefix={md ? `${'#'.repeat(block.level)} ` : undefined}
                className={`${HEADING_SIZE[Math.min(block.level, 6) - 1]} font-extrabold outline-none first:mt-0`}
                onCommit={(text) => onUpdateBlock(i, { ...block, text })}
              />
            ) : block.type === 'paragraph' ? (
              <EditableText as="p" value={block.text} className="m-0 outline-none" onCommit={(text) => onUpdateBlock(i, { ...block, text })} />
            ) : block.type === 'code' ? (
              <EditableText
                as="p"
                value={block.text}
                className={`m-0 rounded p-2 font-mono text-[12px] whitespace-pre-wrap outline-none ${dark ? 'bg-white/5' : 'bg-neutral-100'}`}
                onCommit={(text) => onUpdateBlock(i, { ...block, text })}
              />
            ) : block.type === 'list' ? (
              <EditableList block={block} md={md} dark={dark} onChange={(next) => onUpdateBlock(i, next)} />
            ) : (
              <EditableTable block={block} borderColor={borderColor} headBg={headBg} onChange={(next) => onUpdateBlock(i, next)} />
            )}
          </div>
        ))}
        <Gap index={blocks.length} open={openGap === blocks.length} onToggle={() => setOpenGap(openGap === blocks.length ? null : blocks.length)} onPick={(t) => { onInsertBlock(blocks.length, t); setOpenGap(null); }} dark={dark} />
      </div>
    </div>
  );
}

/** The gap between two blocks: hover reveals a + that opens a tiny type
 *  picker, so inserting a block never needs a separate sidebar section. */
function Gap({
  index: _index,
  open,
  onToggle,
  onPick,
  dark,
}: {
  index: number;
  open: boolean;
  onToggle: () => void;
  onPick: (type: AddableType) => void;
  dark: boolean;
}) {
  return (
    <div className="group/gap relative h-2.5">
      {open ? (
        <div
          className={`absolute top-1/2 left-1/2 z-10 flex -translate-x-1/2 -translate-y-1/2 items-center gap-1 rounded-lg border p-1 shadow-lg ${dark ? 'border-[#30363d] bg-[#161b22]' : 'border-neutral-200 bg-white'}`}
        >
          {ADDABLE_BLOCKS.map(({ type, label, icon: Icon }) => (
            <button
              key={type}
              type="button"
              title={label}
              onClick={() => onPick(type)}
              className={`flex size-6 items-center justify-center rounded ${dark ? 'text-[#8b949e] hover:bg-white/10 hover:text-emerald-400' : 'text-neutral-500 hover:bg-neutral-100 hover:text-emerald-600'}`}
            >
              <Icon className="size-3.5" />
            </button>
          ))}
        </div>
      ) : (
        <button
          type="button"
          onClick={onToggle}
          title="Insert block here"
          className={`absolute top-1/2 left-1/2 flex size-5 -translate-x-1/2 -translate-y-1/2 scale-75 items-center justify-center rounded-full border opacity-0 transition-all group-hover/gap:scale-100 group-hover/gap:opacity-100 ${dark ? 'border-emerald-400 bg-[#0d1117] text-emerald-400' : 'border-emerald-500 bg-white text-emerald-600'}`}
        >
          <Plus className="size-3" />
        </button>
      )}
    </div>
  );
}

function EditableList({
  block,
  md,
  dark,
  onChange,
}: {
  block: Extract<Block, { type: 'list' }>;
  md: boolean;
  dark: boolean;
  onChange: (next: Block) => void;
}) {
  const setItem = (index: number, value: string) => onChange({ ...block, items: block.items.map((it, i) => (i === index ? value : it)) });
  const removeItem = (index: number) => onChange({ ...block, items: block.items.filter((_, i) => i !== index) });
  const addItem = () => onChange({ ...block, items: [...block.items, ''] });
  const drag = usePointerReorder(block.items, (items) => onChange({ ...block, items }));
  const Tag = block.ordered ? 'ol' : 'ul';
  return (
    <Tag className="m-0 list-none pl-0">
      {block.items.map((item, i) => (
        <li
          key={i}
          ref={drag.setItemRef(i)}
          className={`group/item flex items-start gap-1.5 border-t-2 ${drag.overIndex === i ? 'border-emerald-400' : 'border-transparent'} ${drag.dragIndex === i ? 'opacity-40' : ''} ${drag.overIndex === block.items.length && i === block.items.length - 1 ? 'border-b-2 border-b-emerald-400' : ''}`}
        >
          <span
            onMouseDown={drag.startDrag(i)}
            className={`mt-1 cursor-grab opacity-0 transition-opacity group-hover/item:opacity-100 active:cursor-grabbing ${dark ? 'text-[#6e7681]' : 'text-neutral-400'}`}
          >
            <GripVertical className="size-3 shrink-0" />
          </span>
          {!md && <span className="mt-0.5 shrink-0 select-none">{block.ordered ? `${i + 1}.` : '•'}</span>}
          <EditableText
            as="p"
            value={item}
            prefix={md ? (block.ordered ? `${i + 1}. ` : '- ') : undefined}
            className="m-0 flex-1 outline-none"
            onCommit={(text) => setItem(i, text)}
          />
          <button
            type="button"
            onClick={() => removeItem(i)}
            aria-label="Remove item"
            className={`mt-0.5 shrink-0 opacity-0 transition-opacity group-hover/item:opacity-100 ${dark ? 'text-[#6e7681] hover:text-red-400' : 'text-neutral-400 hover:text-red-500'}`}
          >
            <X className="size-3" />
          </button>
        </li>
      ))}
      <button
        type="button"
        onClick={addItem}
        className={`mt-1 flex items-center gap-1 pl-5 text-[12px] ${dark ? 'text-[#8b949e] hover:text-emerald-400' : 'text-neutral-400 hover:text-emerald-600'}`}
      >
        <Plus className="size-3" />
        Add item
      </button>
    </Tag>
  );
}

function EditableTable({
  block,
  borderColor,
  headBg,
  onChange,
}: {
  block: Extract<Block, { type: 'table' }>;
  borderColor: string;
  headBg: string;
  onChange: (next: Block) => void;
}) {
  const setHeader = (colIndex: number, value: string) => onChange({ ...block, headers: block.headers.map((h, c) => (c === colIndex ? value : h)) });
  const setCell = (rowIndex: number, colIndex: number, value: string) =>
    onChange({ ...block, rows: block.rows.map((row, r) => (r === rowIndex ? row.map((c, ci) => (ci === colIndex ? value : c)) : row)) });
  const removeRow = (rowIndex: number) => onChange({ ...block, rows: block.rows.filter((_, r) => r !== rowIndex) });
  const addRow = () => onChange({ ...block, rows: [...block.rows, block.headers.map(() => '')] });
  const drag = usePointerReorder(block.rows, (rows) => onChange({ ...block, rows }));
  const cellStyle = { borderColor };
  return (
    <div className="overflow-x-auto">
      <table className="w-full border-collapse text-[13px]">
        <thead>
          <tr>
            <th className="w-6 border p-0" style={cellStyle} />
            {block.headers.map((h, c) => (
              <th key={c} className="border p-0 text-left font-semibold" style={{ ...cellStyle, background: headBg }}>
                <EditableText as="th" value={h} className="block px-2.5 py-1.5 outline-none" onCommit={(text) => setHeader(c, text)} />
              </th>
            ))}
            <th className="w-6 border p-0" style={cellStyle} />
          </tr>
        </thead>
        <tbody>
          {block.rows.map((row, r) => (
            <tr
              key={r}
              ref={drag.setItemRef(r)}
              className={`group/row border-t-2 ${drag.overIndex === r ? 'border-t-emerald-400' : 'border-t-transparent'} ${drag.dragIndex === r ? 'opacity-40' : ''} ${drag.overIndex === block.rows.length && r === block.rows.length - 1 ? 'border-b-2 border-b-emerald-400' : ''}`}
            >
              {/* The only non-editable cell in the row: every other cell is
                  contentEditable, which swallows a drag gesture started on it. */}
              <td className="cursor-grab border p-0 text-center active:cursor-grabbing" style={cellStyle} onMouseDown={drag.startDrag(r)}>
                <GripVertical className="mx-auto size-3.5 text-neutral-400" />
              </td>
              {row.map((cell, c) => (
                <td key={c} className="border p-0" style={cellStyle}>
                  <EditableText as="td" value={cell} className="block px-2.5 py-1.5 outline-none" onCommit={(text) => setCell(r, c, text)} />
                </td>
              ))}
              <td className="border p-0 text-center opacity-0 group-hover/row:opacity-100" style={cellStyle}>
                <button type="button" onClick={() => removeRow(r)} aria-label="Remove row" className="text-neutral-400 hover:text-red-500">
                  <X className="size-3" />
                </button>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      <button type="button" onClick={addRow} className="mt-1.5 flex items-center gap-1 text-[12px] text-neutral-400 hover:text-emerald-600">
        <Plus className="size-3" />
        Add row
      </button>
    </div>
  );
}

// Locates one grid cell back in the block it came from, so editing a
// flattened spreadsheet row writes into the same block every other
// format's preview reads from, rather than a separate copy of the text.
type CellSource =
  | { blockIndex: number; kind: 'text' }
  | { blockIndex: number; kind: 'item'; itemIndex: number }
  | { blockIndex: number; kind: 'header'; colIndex: number }
  | { blockIndex: number; kind: 'cell'; rowIndex: number; colIndex: number };

/** Same row shape as blocksToRows() (including its trailing blank row after
 *  a table), just with each cell's block-of-origin attached for write-back. */
function blocksToEditableRows(blocks: Block[]): { text: string; source: CellSource | null }[][] {
  const rows: { text: string; source: CellSource | null }[][] = [];
  blocks.forEach((block, blockIndex) => {
    if (block.type === 'table') {
      rows.push(block.headers.map((h, colIndex) => ({ text: h, source: { blockIndex, kind: 'header', colIndex } })));
      block.rows.forEach((row, rowIndex) => {
        rows.push(row.map((c, colIndex) => ({ text: c, source: { blockIndex, kind: 'cell', rowIndex, colIndex } })));
      });
      rows.push([]);
    } else if (block.type === 'heading' || block.type === 'paragraph' || block.type === 'code') {
      rows.push([{ text: block.text, source: { blockIndex, kind: 'text' } }]);
    } else if (block.type === 'list') {
      block.items.forEach((item, itemIndex) => rows.push([{ text: item, source: { blockIndex, kind: 'item', itemIndex } }]));
    }
  });
  return rows;
}

function applyCellEdit(block: Block, source: CellSource, value: string): Block {
  if (source.kind === 'text' && (block.type === 'heading' || block.type === 'paragraph' || block.type === 'code')) {
    return { ...block, text: value };
  }
  if (source.kind === 'item' && block.type === 'list') {
    return { ...block, items: block.items.map((it, i) => (i === source.itemIndex ? value : it)) };
  }
  if (source.kind === 'header' && block.type === 'table') {
    return { ...block, headers: block.headers.map((h, i) => (i === source.colIndex ? value : h)) };
  }
  if (source.kind === 'cell' && block.type === 'table') {
    return { ...block, rows: block.rows.map((r, i) => (i === source.rowIndex ? r.map((c, j) => (j === source.colIndex ? value : c)) : r)) };
  }
  return block;
}

/** csv/xlsx: the same flattened sheet blocksToRows() produces for the real
 *  export, but every populated cell edits in place and writes back to its
 *  source block - there's no separate "grid data" to fall out of sync. */
function EditableGrid({
  format,
  blocks,
  name,
  onUpdateBlock,
}: {
  format: ExportFormat;
  blocks: Block[];
  name: string;
  onUpdateBlock: (index: number, next: Block) => void;
}) {
  const meta = FORMAT_META[format];
  const rows = blocksToEditableRows(blocks);
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
              // biome-ignore lint/suspicious/noArrayIndexKey: row position is the identity here, blocks may reorder by removal only
              <tr key={r}>
                <td className="border border-neutral-300 bg-neutral-100 px-2 py-1 text-center text-[10.5px] text-neutral-500">{r + 1}</td>
                {Array.from({ length: columnCount }, (_, c) => {
                  const cell = row[c];
                  return (
                    // biome-ignore lint/suspicious/noArrayIndexKey: column position is the identity here
                    <td key={c} className="border border-neutral-300 bg-white p-0 text-[11px] text-neutral-800">
                      {cell ? (
                        <EditableText
                          as="td"
                          value={cell.text}
                          className="block min-w-[90px] px-2 py-1 outline-none focus:bg-emerald-50"
                          onCommit={(text) => {
                            if (!cell.source) return;
                            onUpdateBlock(cell.source.blockIndex, applyCellEdit(blocks[cell.source.blockIndex], cell.source, text));
                          }}
                        />
                      ) : null}
                    </td>
                  );
                })}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
