'use client';

import { X } from 'lucide-react';
import { useLayoutEffect, useRef, useState } from 'react';
import { PLAYGROUND_NODE_DEFS } from './playground-node-defs.js';
import { PlaygroundSelect } from './playground-select.js';

export interface PlaygroundConfigPopupProps {
  nodeId: string;
  kind: string;
  fields: Record<string, string>;
  anchorEl: HTMLElement;
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
  onChange,
  onDelete,
  onClose,
}: PlaygroundConfigPopupProps) {
  const def = PLAYGROUND_NODE_DEFS[kind];
  const ref = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState<{ left: number; top: number } | null>(null);

  useLayoutEffect(() => {
    const rect = anchorEl.getBoundingClientRect();
    const fitsRight = rect.right + 16 + POPUP_WIDTH <= window.innerWidth;
    const left = fitsRight ? rect.right + 16 : Math.max(12, rect.left - 16 - POPUP_WIDTH);
    const top = Math.max(12, Math.min(window.innerHeight - 320, rect.top - 20));
    setPos({ left, top });
  }, [anchorEl]);

  useLayoutEffect(() => {
    function onDocClick(e: MouseEvent) {
      const target = e.target as HTMLElement;
      if (ref.current?.contains(target)) return;
      if (target.closest(`[data-id="${nodeId}"]`)) return;
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
      <div className="flex items-center gap-2 border-b border-canvas-border px-4 py-3">
        <div className="text-sm font-semibold text-canvas-foreground">{def.label}</div>
        <button
          type="button"
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
        {def.fields.map((f) => (
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
