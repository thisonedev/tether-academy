'use client';

import { Eye, Lightbulb, X } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';

interface HelpPanelProps {
  hints: string[];
  answer: string;
  onReveal: () => void;
  disabled?: boolean;
}

export function HelpPanel({ hints, answer, onReveal, disabled = false }: HelpPanelProps) {
  const [open, setOpen] = useState(false);
  const [hintsRevealed, setHintsRevealed] = useState(0);
  const containerRef = useRef<HTMLDivElement>(null);

  // Close on outside click
  useEffect(() => {
    if (!open) return;
    const handler = (e: MouseEvent) => {
      if (!containerRef.current?.contains(e.target as Node)) {
        setOpen(false);
      }
    };
    document.addEventListener('mousedown', handler);
    return () => document.removeEventListener('mousedown', handler);
  }, [open]);

  // Close on Escape
  useEffect(() => {
    if (!open) return;
    const handler = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setOpen(false);
    };
    document.addEventListener('keydown', handler);
    return () => document.removeEventListener('keydown', handler);
  }, [open]);

  // Reset hint state when the lesson changes
  // biome-ignore lint/correctness/useExhaustiveDependencies: re-run only when the lesson's hints array identity changes
  useEffect(() => {
    setHintsRevealed(0);
    setOpen(false);
  }, [hints]);

  const hasHints = hints.length > 0;
  const hasAnswer = answer.length > 0;
  if (!hasHints && !hasAnswer) return null;

  const remaining = hints.length - hintsRevealed;
  const showCount = remaining > 0;

  return (
    <div ref={containerRef} className="relative">
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        disabled={disabled}
        aria-expanded={open}
        aria-haspopup="dialog"
        title="Get unstuck"
        className="relative inline-flex items-center justify-center rounded p-1.5 text-canvas-muted-foreground transition-colors hover:bg-canvas-muted hover:text-canvas-foreground disabled:cursor-not-allowed disabled:opacity-40"
      >
        <Lightbulb className="size-4" />
        {showCount ? (
          <span className="absolute -right-0.5 -top-0.5 inline-flex h-4 min-w-4 items-center justify-center rounded-full bg-emerald-500 px-1 text-[10px] font-semibold text-canvas">
            {remaining}
          </span>
        ) : null}
      </button>

      {open ? (
        <>
          {/* Backdrop — only on mobile, where the sheet covers the editor. */}
          <button
            type="button"
            aria-label="Close help"
            onClick={() => setOpen(false)}
            className="fixed inset-0 z-30 bg-canvas/50 backdrop-blur-sm md:hidden"
          />
          <div
            role="dialog"
            className="fixed inset-x-0 bottom-0 z-40 max-h-[80vh] overflow-y-auto rounded-t-2xl border-t border-canvas-border bg-canvas p-5 pb-[max(1.25rem,env(safe-area-inset-bottom))] text-sm shadow-[0_-12px_40px_-12px_rgba(0,0,0,0.7)] md:absolute md:inset-auto md:right-0 md:top-full md:mt-2 md:w-[22rem] md:max-h-none md:rounded-lg md:border md:p-4 md:shadow-2xl md:shadow-black/40"
          >
            {/* Mobile drag handle — purely decorative */}
            <div className="mb-3 flex justify-center md:hidden">
              <span className="h-1 w-10 rounded-full bg-canvas-muted-foreground/40" />
            </div>

            <div className="mb-2 flex items-center justify-between">
              <p className="font-semibold text-canvas-foreground">Get unstuck</p>
              <button
                type="button"
                onClick={() => setOpen(false)}
                aria-label="Close help"
                className="rounded p-1 text-canvas-muted-foreground transition-colors hover:bg-canvas-muted hover:text-canvas-foreground"
              >
                <X className="size-3.5" />
              </button>
            </div>

            {hasHints ? (
              <div>
                <div className="mb-2 flex items-center justify-between">
                  <p className="text-xs font-semibold uppercase tracking-wider text-canvas-muted-foreground">
                    Hints
                  </p>
                  {hintsRevealed < hints.length ? (
                    <button
                      type="button"
                      onClick={() => setHintsRevealed((n) => Math.min(n + 1, hints.length))}
                      className="whitespace-nowrap rounded-md border border-emerald-500/40 bg-emerald-500/10 px-2.5 py-1 text-xs font-semibold text-emerald-400 transition-colors hover:bg-emerald-500/20"
                    >
                      Reveal hint {hintsRevealed + 1}/{hints.length}
                    </button>
                  ) : (
                    <span className="text-xs text-canvas-muted-foreground">All revealed</span>
                  )}
                </div>
                {hintsRevealed > 0 ? (
                  <ul className="mb-3 space-y-2">
                    {hints.slice(0, hintsRevealed).map((h) => (
                      <li
                        key={h}
                        className="rounded-md border border-canvas-border bg-canvas-muted p-2.5 text-sm text-canvas-foreground"
                      >
                        <span className="mr-1.5 font-mono text-xs text-emerald-400">
                          H{hints.indexOf(h) + 1}.
                        </span>
                        {h}
                      </li>
                    ))}
                  </ul>
                ) : (
                  <p className="mb-3 text-xs text-canvas-muted-foreground">
                    Hints appear here one at a time as you click the button.
                  </p>
                )}
              </div>
            ) : null}

            {hasAnswer ? (
              <div>
                <p className="mb-2 text-xs font-semibold uppercase tracking-wider text-canvas-muted-foreground">
                  Stumped
                </p>
                <button
                  type="button"
                  onClick={() => {
                    onReveal();
                    setOpen(false);
                  }}
                  className="inline-flex w-full items-center justify-center gap-1.5 rounded-md border border-canvas-border bg-canvas-muted px-3 py-2 text-sm font-semibold text-canvas-foreground transition-colors hover:bg-canvas"
                >
                  <Eye className="size-3.5" />
                  Reveal answer
                </button>
                <p className="mt-2 text-[11px] leading-relaxed text-canvas-muted-foreground">
                  Replaces the editor with the canonical solution. Try to write the code yourself
                  first.
                </p>
              </div>
            ) : null}

            {/* Mobile "Back to editor" CTA — sits at the bottom of the sheet so
              the user has a clear way to dismiss and get back to typing. */}
            <button
              type="button"
              onClick={() => setOpen(false)}
              className="mt-5 inline-flex w-full items-center justify-center gap-1.5 rounded-md bg-emerald-500 px-3 py-2.5 text-sm font-semibold text-canvas transition-colors hover:bg-emerald-400 md:hidden"
            >
              Back to editor
            </button>
          </div>
        </>
      ) : null}
    </div>
  );
}
