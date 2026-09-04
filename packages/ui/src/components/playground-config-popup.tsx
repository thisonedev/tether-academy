'use client';

import { Paperclip, X } from 'lucide-react';
import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { parsePickedFiles, type PickedFile, readFileAsDataUrl } from './playground-files.js';
import { PLAYGROUND_NODE_DEFS } from './playground-node-defs.js';
import { PlaygroundSelect } from './playground-select.js';
import { samplesFor } from './playground-sample-data.js';
import type { PlaygroundDataType } from './playground-types.js';

function FileFieldInput({
  id,
  accept,
  multiple,
  value,
  onChange,
}: {
  id: string;
  accept?: string;
  multiple?: boolean;
  value: string;
  onChange: (value: string) => void;
}) {
  const inputRef = useRef<HTMLInputElement>(null);
  const [mode, setMode] = useState<'sample' | 'upload'>('sample');
  // Tracks which tab actually produced the current value, so switching to
  // "Your file" after picking a sample shows a fresh picker, not the sample's
  // name looking like it came from the filesystem.
  const [source, setSource] = useState<'sample' | 'upload' | null>(null);
  const files = parsePickedFiles(value);
  const uploadFiles = source === 'upload' ? files : [];
  const [samples, setSamples] = useState<PickedFile[]>([]);
  useEffect(() => {
    let cancelled = false;
    samplesFor(accept).then((s) => {
      if (!cancelled) setSamples(s);
    });
    return () => {
      cancelled = true;
    };
  }, [accept]);
  // A value already on the field (loaded from a saved workflow) has no tab
  // click to infer source from: guess from whether its name(s) match a sample.
  useEffect(() => {
    if (source !== null || files.length === 0 || samples.length === 0) return;
    const isSample = files.every((f) => samples.some((s) => s.name === f.name));
    setSource(isSample ? 'sample' : 'upload');
    setMode(isSample ? 'sample' : 'upload');
  }, [samples]);

  async function handlePick(e: React.ChangeEvent<HTMLInputElement>) {
    const picked = Array.from(e.target.files ?? []);
    e.target.value = '';
    if (picked.length === 0) return;
    const read = await Promise.all(picked.map(async (f) => ({ name: f.name, dataUrl: await readFileAsDataUrl(f) })));
    setSource('upload');
    onChange(multiple ? JSON.stringify(read) : JSON.stringify(read[0]));
  }

  function toggleSample(sample: PickedFile) {
    setSource('sample');
    if (!multiple) {
      onChange(JSON.stringify(sample));
      return;
    }
    const already = files.some((f) => f.name === sample.name);
    const next = already ? files.filter((f) => f.name !== sample.name) : [...files, sample];
    onChange(JSON.stringify(next));
  }

  return (
    <div>
      <div className="mb-1.5 flex rounded-md border border-canvas-border p-0.5 text-[11px]">
        <button
          type="button"
          onClick={() => setMode('sample')}
          className={`flex-1 rounded px-2 py-1 ${mode === 'sample' ? 'bg-canvas-muted text-canvas-foreground' : 'text-canvas-muted-foreground'}`}
        >
          Sample
        </button>
        <button
          type="button"
          onClick={() => setMode('upload')}
          className={`flex-1 rounded px-2 py-1 ${mode === 'upload' ? 'bg-canvas-muted text-canvas-foreground' : 'text-canvas-muted-foreground'}`}
        >
          Your file
        </button>
      </div>
      {mode === 'sample' ? (
        <div className="max-h-32 space-y-0.5 overflow-y-auto rounded-lg border border-canvas-border bg-canvas p-1">
          {samples.length === 0 && <div className="px-1.5 py-1 text-[11px] text-canvas-muted-foreground">No bundled samples for this field.</div>}
          {samples.map((s) => {
            const selected = files.some((f) => f.name === s.name);
            return (
              <button
                key={s.name}
                type="button"
                onClick={() => toggleSample(s)}
                className={`flex w-full items-center gap-1.5 truncate rounded px-1.5 py-1 text-left text-[11.5px] hover:bg-canvas-muted ${selected ? 'text-emerald-400' : 'text-canvas-foreground'}`}
              >
                {selected ? '✓' : '·'} {s.name}
              </button>
            );
          })}
        </div>
      ) : (
        <>
          <input ref={inputRef} id={id} type="file" accept={accept} multiple={multiple} onChange={handlePick} className="hidden" />
          <button
            type="button"
            onClick={() => inputRef.current?.click()}
            className="flex w-full items-center gap-1.5 rounded-lg border border-canvas-border bg-canvas px-2.5 py-2 text-left text-[12.5px] text-canvas-foreground hover:bg-canvas-muted"
          >
            <Paperclip className="size-3.5 shrink-0 text-canvas-muted-foreground" />
            <span className="truncate">
              {uploadFiles.length === 0
                ? multiple
                  ? 'Choose files…'
                  : 'Choose file…'
                : multiple
                  ? `${uploadFiles.length} file${uploadFiles.length === 1 ? '' : 's'} selected`
                  : uploadFiles[0]?.name}
            </span>
          </button>
        </>
      )}
      {files.length > 0 && (
        <div className="mt-1 truncate text-[10.5px] text-canvas-muted-foreground" title={files.map((f) => f.name).join(', ')}>
          Using {source === 'sample' ? 'sample' : 'your file'}: {files.map((f) => f.name).join(', ')}
        </div>
      )}
    </div>
  );
}

export interface PlaygroundConfigPopupProps {
  nodeId: string;
  kind: string;
  fields: Record<string, string>;
  anchorEl: HTMLElement;
  // The actual output type of whatever's wired into this node right now (null
  // when nothing is), so a field like If's "Column" can hide itself when it
  // doesn't apply instead of sitting there ignored.
  inputKind: PlaygroundDataType | null;
  onChange: (key: string, value: string) => void;
  onDelete: () => void;
  onClose: () => void;
}

const POPUP_WIDTH = 300;

/** Floats next to the node that opened it, flipping to the left edge if there's no room on the right. */
export function PlaygroundConfigPopup({
  nodeId,
  kind,
  fields,
  anchorEl,
  inputKind,
  onChange,
  onDelete,
  onClose,
}: PlaygroundConfigPopupProps) {
  const def = PLAYGROUND_NODE_DEFS[kind];
  const ref = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState<{ left: number; top: number } | null>(null);
  const dragStartRef = useRef<{ x: number; y: number; left: number; top: number } | null>(null);
  const [isDragging, setIsDragging] = useState(false);

  useLayoutEffect(() => {
    const rect = anchorEl.getBoundingClientRect();
    const fitsRight = rect.right + 16 + POPUP_WIDTH <= window.innerWidth;
    const left = fitsRight ? rect.right + 16 : Math.max(12, rect.left - 16 - POPUP_WIDTH);
    const top = Math.max(12, Math.min(window.innerHeight - 320, rect.top - 20));
    setPos({ left, top });
  }, [anchorEl]);

  // Dragging by the header overrides the anchored position above; re-selecting
  // the node (a new anchorEl) resets it via the effect above.
  useEffect(() => {
    if (!isDragging) return;
    const onMove = (e: PointerEvent) => {
      const start = dragStartRef.current;
      if (!start) return;
      setPos({ left: start.left + (e.clientX - start.x), top: start.top + (e.clientY - start.y) });
    };
    const onUp = () => setIsDragging(false);
    window.addEventListener('pointermove', onMove);
    window.addEventListener('pointerup', onUp);
    return () => {
      window.removeEventListener('pointermove', onMove);
      window.removeEventListener('pointerup', onUp);
    };
  }, [isDragging]);

  useLayoutEffect(() => {
    function onDocClick(e: MouseEvent) {
      const target = e.target as HTMLElement;
      if (ref.current?.contains(target)) return;
      if (target.closest(`[data-id="${nodeId}"]`)) return;
      // A select field's open dropdown is portaled to <body>, outside both checks
      // above, so without this an option click closed the popup before it applied.
      if (target.closest('[data-playground-select-menu]')) return;
      onClose();
    }
    document.addEventListener('mousedown', onDocClick, true);
    return () => document.removeEventListener('mousedown', onDocClick, true);
  }, [nodeId, onClose]);

  if (!def || !pos) return null;

  return (
    <div
      ref={ref}
      className="fixed z-50 w-[300px] overflow-hidden rounded-2xl border border-canvas-border bg-canvas-muted font-mono shadow-2xl"
      style={{ left: pos.left, top: pos.top }}
    >
      <div
        onPointerDown={(e) => {
          if (!pos) return;
          dragStartRef.current = { x: e.clientX, y: e.clientY, left: pos.left, top: pos.top };
          setIsDragging(true);
        }}
        className="flex cursor-move select-none items-center gap-2 border-b border-canvas-border px-4 py-3"
      >
        <div className="text-sm font-semibold text-canvas-foreground">{def.label}</div>
        <button
          type="button"
          onPointerDown={(e) => e.stopPropagation()}
          onClick={onClose}
          className="ml-auto text-canvas-muted-foreground hover:text-canvas-foreground"
        >
          <X className="size-4" />
        </button>
      </div>
      <div className="max-h-[56vh] overflow-y-auto px-4 py-3.5">
        {def.fields.length === 0 && (
          <div className="text-xs text-canvas-muted-foreground">Nothing to configure, just wire it up.</div>
        )}
        {def.fields.filter((f) => !f.hiddenWhen?.(fields, inputKind)).map((f) => (
          <div key={f.key} className="mb-3 last:mb-0">
            <label className="mb-1 block text-[11.5px] text-canvas-muted-foreground" htmlFor={`${nodeId}-${f.key}`}>
              {f.label}
            </label>
            {f.type === 'select' ? (
              <PlaygroundSelect
                id={`${nodeId}-${f.key}`}
                value={fields[f.key] ?? ''}
                options={f.options ?? []}
                onChange={(v) => onChange(f.key, v)}
              />
            ) : f.type === 'textarea' ? (
              <textarea
                id={`${nodeId}-${f.key}`}
                rows={3}
                value={fields[f.key] ?? ''}
                onChange={(e) => onChange(f.key, e.target.value)}
                className="w-full resize-none rounded-lg border border-canvas-border bg-canvas px-2.5 py-2 text-[12.5px] text-canvas-foreground focus:border-emerald-500/60 focus:outline-none focus:ring-1 focus:ring-emerald-500/30"
              />
            ) : f.type === 'file' ? (
              <FileFieldInput
                id={`${nodeId}-${f.key}`}
                accept={f.accept}
                multiple={f.multiple}
                value={fields[f.key] ?? ''}
                onChange={(v) => onChange(f.key, v)}
              />
            ) : (
              <input
                id={`${nodeId}-${f.key}`}
                type="text"
                value={fields[f.key] ?? ''}
                onChange={(e) => onChange(f.key, e.target.value)}
                className="w-full rounded-lg border border-canvas-border bg-canvas px-2.5 py-2 text-[12.5px] text-canvas-foreground focus:border-emerald-500/60 focus:outline-none focus:ring-1 focus:ring-emerald-500/30"
              />
            )}
          </div>
        ))}
      </div>
      {kind !== 'start' && (
        <div className="px-4 pb-3.5">
          <button
            type="button"
            onClick={onDelete}
            className="w-full rounded-md border border-canvas-border bg-canvas px-3 py-1.5 text-center text-[12.5px] text-canvas-foreground hover:bg-canvas-muted"
          >
            Delete block
          </button>
        </div>
      )}
    </div>
  );
}
