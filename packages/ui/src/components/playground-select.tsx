'use client';

import { Check, ChevronDown } from 'lucide-react';
import { useLayoutEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';

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
  const [pos, setPos] = useState<{ left: number; top: number; width: number } | null>(null);
  const buttonRef = useRef<HTMLButtonElement>(null);
  const listRef = useRef<HTMLDivElement>(null);

  useLayoutEffect(() => {
    if (!open) return;
    const rect = buttonRef.current?.getBoundingClientRect();
    if (!rect) return;
    // A long list (49 languages) opening downward with no room below ran off
    // the bottom of the screen with no way to scroll the page itself.
    const maxListHeight = 224; // matches max-h-56 below
    const openUpward =
      window.innerHeight - rect.bottom < maxListHeight + 8 && rect.top > maxListHeight + 8;
    const top = openUpward ? rect.top - maxListHeight - 4 : rect.bottom + 4;
    setPos({ left: rect.left, top, width: rect.width });
  }, [open]);

  useLayoutEffect(() => {
    if (!open) return;
    function onDocClick(e: MouseEvent) {
      const target = e.target as Node;
      if (buttonRef.current?.contains(target) || listRef.current?.contains(target)) return;
      setOpen(false);
    }
    document.addEventListener('mousedown', onDocClick, true);
    return () => document.removeEventListener('mousedown', onDocClick, true);
  }, [open]);

  return (
    <div className="relative">
      <button
        ref={buttonRef}
        id={id}
        type="button"
        onClick={() => setOpen((o) => !o)}
        className="flex w-full items-center justify-between rounded-lg border border-canvas-border bg-canvas px-2.5 py-2 text-left text-[12.5px] text-canvas-foreground transition-colors hover:border-emerald-500/40 focus:border-emerald-500/60 focus:outline-none focus:ring-1 focus:ring-emerald-500/30"
      >
        <span>{value}</span>
        <ChevronDown className="size-3.5 shrink-0 text-canvas-muted-foreground" />
      </button>
      {/* Portaled to body, fixed-positioned from the button's own rect: the popup that
       *  hosts this field clips absolutely-positioned children via its own overflow-y-auto,
       *  which was silently truncating long option lists to whatever space was left below. */}
      {open &&
        pos &&
        createPortal(
          <div
            ref={listRef}
            data-playground-select-menu
            className="fixed z-[60] max-h-56 overflow-y-auto rounded-lg border border-canvas-border bg-canvas-muted py-1 shadow-xl"
            style={{ left: pos.left, top: pos.top, width: pos.width }}
          >
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
          </div>,
          document.body,
        )}
    </div>
  );
}
