'use client';

import { Check, ChevronDown } from 'lucide-react';
import { useLayoutEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';

export interface ThemedSelectOption {
  value: string;
  label?: string;
  disabled?: boolean;
  title?: string;
}

export interface ThemedSelectProps {
  id?: string;
  value: string;
  options: (string | ThemedSelectOption)[];
  onChange: (value: string) => void;
  disabled?: boolean;
  placeholder?: string;
  title?: string;
  ariaLabel?: string;
  className?: string;
}

const DEFAULT_BUTTON_CLASS =
  'flex w-full items-center justify-between rounded-lg border border-canvas-border bg-canvas px-2.5 py-2 text-left text-[12.5px] text-canvas-foreground transition-colors hover:border-emerald-500/40 focus:border-emerald-500/60 focus:outline-none focus:ring-1 focus:ring-emerald-500/30 disabled:cursor-not-allowed disabled:opacity-40';

function normalize(o: string | ThemedSelectOption): ThemedSelectOption {
  return typeof o === 'string' ? { value: o, label: o } : { label: o.value, ...o };
}

/** Native `<select>` popups render with the OS's light dropdown chrome and can't be
 *  restyled once open, so this is a real dropdown built to match the app's dark theme.
 *  Shared by the playground config popup and the lesson toolbar's run-mode/model pickers. */
export function ThemedSelect({
  id,
  value,
  options,
  onChange,
  disabled,
  placeholder,
  title,
  ariaLabel,
  className,
}: ThemedSelectProps) {
  const [open, setOpen] = useState(false);
  // `bottom`-anchored when opening up, so the browser sizes the box from its real
  // content: a `top` position pre-computed for a full 224px list left a visible
  // gap above a short one, which never actually grew that tall.
  const [pos, setPos] = useState<{ left: number; width: number; top?: number; bottom?: number } | null>(
    null,
  );
  const buttonRef = useRef<HTMLButtonElement>(null);
  const listRef = useRef<HTMLDivElement>(null);

  const normalized = options.map(normalize);
  const current = normalized.find((o) => o.value === value);
  const displayLabel = current?.label ?? placeholder ?? value;

  useLayoutEffect(() => {
    if (!open) return;
    const rect = buttonRef.current?.getBoundingClientRect();
    if (!rect) return;
    const maxListHeight = 224; // matches max-h-56 below
    const openUpward =
      window.innerHeight - rect.bottom < maxListHeight + 8 && rect.top > maxListHeight + 8;
    setPos(
      openUpward
        ? { left: rect.left, width: rect.width, bottom: window.innerHeight - rect.top + 4 }
        : { left: rect.left, width: rect.width, top: rect.bottom + 4 },
    );
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
        title={title}
        aria-label={ariaLabel}
        disabled={disabled}
        onClick={() => setOpen((o) => !o)}
        className={className ?? DEFAULT_BUTTON_CLASS}
      >
        <span className="truncate">{displayLabel}</span>
        <ChevronDown className="size-3.5 shrink-0 text-canvas-muted-foreground" />
      </button>
      {/* Portaled to body, fixed-positioned from the button's own rect: a popup that
       *  hosts this field can clip absolutely-positioned children via its own
       *  overflow-y-auto, which would silently truncate long option lists. */}
      {open &&
        pos &&
        createPortal(
          <div
            ref={listRef}
            data-themed-select-menu
            className="fixed z-[60] max-h-56 overflow-y-auto rounded-md border border-canvas-border bg-canvas p-1.5 shadow-lg"
            style={{ left: pos.left, minWidth: pos.width, top: pos.top, bottom: pos.bottom }}
          >
            {normalized.map((o) => (
              <button
                key={o.value}
                type="button"
                disabled={o.disabled}
                title={o.title}
                onClick={() => {
                  if (o.disabled) return;
                  onChange(o.value);
                  setOpen(false);
                }}
                className="flex w-full items-center justify-between gap-2.5 rounded px-1.5 py-1.5 text-left text-xs text-canvas-foreground hover:bg-canvas-muted disabled:cursor-not-allowed disabled:opacity-40 disabled:hover:bg-transparent"
              >
                <span className="whitespace-nowrap">{o.label}</span>
                {o.value === value && <Check className="size-3.5 shrink-0 text-canvas-muted-foreground" />}
              </button>
            ))}
          </div>,
          document.body,
        )}
    </div>
  );
}
