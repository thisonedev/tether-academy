'use client';

import { Check, ChevronDown } from 'lucide-react';
import { useLayoutEffect, useRef, useState } from 'react';

export interface PlaygroundSelectProps {
  id?: string;
  value: string;
  options: string[];
  onChange: (value: string) => void;
}

/** Native `<select>` popups render with the OS's light dropdown chrome and can't be
 *  restyled once open, so this is a real dropdown built to match the app's dark theme. */
export function PlaygroundSelect({ id, value, options, onChange }: PlaygroundSelectProps) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  useLayoutEffect(() => {
    if (!open) return;
    function onDocClick(e: MouseEvent) {
      if (!ref.current?.contains(e.target as Node)) setOpen(false);
    }
    document.addEventListener('mousedown', onDocClick, true);
    return () => document.removeEventListener('mousedown', onDocClick, true);
  }, [open]);

  return (
    <div ref={ref} className="relative">
      <button
        id={id}
        type="button"
        onClick={() => setOpen((o) => !o)}
        className="flex w-full items-center justify-between rounded-lg border border-canvas-border bg-canvas px-2.5 py-2 text-left text-[12.5px] text-canvas-foreground transition-colors hover:border-emerald-500/40 focus:border-emerald-500/60 focus:outline-none focus:ring-1 focus:ring-emerald-500/30"
      >
        <span>{value}</span>
        <ChevronDown className="size-3.5 shrink-0 text-canvas-muted-foreground" />
      </button>
      {open && (
        <div className="absolute left-0 right-0 top-[calc(100%+4px)] z-10 overflow-hidden rounded-lg border border-canvas-border bg-canvas-muted py-1 shadow-xl">
          {options.map((o) => (
            <button
              key={o}
              type="button"
              onClick={() => {
                onChange(o);
                setOpen(false);
              }}
              className="flex w-full items-center justify-between px-2.5 py-2 text-left text-[12.5px] text-canvas-foreground transition-colors hover:bg-canvas"
            >
              {o}
              {o === value && <Check className="size-3.5 shrink-0 text-canvas-muted-foreground" />}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
