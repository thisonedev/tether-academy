'use client';

import type { AcademyAPI, AcademyModelDownloadQueueState } from '@academy/validation';
import { Download, Square } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import { formatBytes } from './format-bytes.js';

declare global {
  interface Window {
    academy?: AcademyAPI;
  }
}

/**
 * Header icon for a Settings > Models download in progress, with a dropdown
 * for the detail. Lives inside the header rather than as its own bar: a
 * small icon showing/hiding in a fixed-height header doesn't reflow the
 * page, unlike a bar that changes the document's height when it appears.
 */
export function DownloadStatusBadge() {
  const [queue, setQueue] = useState<AcademyModelDownloadQueueState | null>(null);
  const [progress, setProgress] = useState<{ loaded: number; total: number } | null>(null);
  const [open, setOpen] = useState(false);
  const containerRef = useRef<HTMLDivElement>(null);
  const buttonRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    if (typeof window === 'undefined' || !window.academy?.models) return;
    let cancelled = false;
    // Tracks the name this subscription itself has seen. An initial catch-up
    // read (this badge mounting mid-batch) adopts whatever's already in
    // progress; only a live event reporting an actual new item resets it.
    let lastQueueName: string | null = null;
    window.academy.models
      .downloadQueueState()
      .then((state) => {
        if (cancelled || !state?.active) return;
        lastQueueName = state.name;
        setQueue(state);
        setProgress(state.progress);
      })
      .catch(() => {});
    const offQueue = window.academy.models.onDownloadQueueProgress((snapshot) => {
      if (!snapshot?.active) {
        lastQueueName = null;
        setQueue(null);
        setProgress(null);
        return;
      }
      if (snapshot.name !== lastQueueName) setProgress(snapshot.progress);
      lastQueueName = snapshot.name;
      setQueue(snapshot);
    });
    const offProgress = window.academy.models.onDownloadProgress((event) => {
      if (!event?.name) return;
      setProgress((prev) =>
        prev && prev.total === event.total
          ? { loaded: Math.max(prev.loaded, event.loaded), total: event.total }
          : { loaded: event.loaded, total: event.total },
      );
    });
    return () => {
      cancelled = true;
      offQueue();
      offProgress();
    };
  }, []);

  // Close on outside click and Escape, same as the account menu next to this.
  useEffect(() => {
    if (!open) return;
    const onMouseDown = (e: MouseEvent) => {
      if (!containerRef.current?.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        setOpen(false);
        buttonRef.current?.focus();
      }
    };
    document.addEventListener('mousedown', onMouseDown);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onMouseDown);
      document.removeEventListener('keydown', onKey);
    };
  }, [open]);

  if (!queue?.active) return null;

  const pct =
    progress && progress.total > 0 ? Math.min(100, Math.round((progress.loaded / progress.total) * 100)) : null;
  const remaining = queue.total - queue.done;

  return (
    <div ref={containerRef} className="relative">
      <button
        ref={buttonRef}
        type="button"
        onClick={() => setOpen((o) => !o)}
        aria-haspopup="menu"
        aria-expanded={open}
        aria-label={`Downloading ${queue.name}`}
        title={`Downloading ${queue.name}`}
        className="relative inline-flex size-8 items-center justify-center rounded-full border border-canvas-border bg-canvas-muted text-emerald-400 transition-colors hover:border-emerald-500/50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-emerald-500/40"
      >
        <span className="pointer-events-none absolute inset-[-3px] animate-spin rounded-full border-2 border-emerald-500/30 border-t-emerald-400" />
        <Download className="size-3.5" />
        {remaining > 1 ? (
          <span className="absolute -right-1 -top-1 flex h-[15px] min-w-[15px] items-center justify-center rounded-full border-2 border-canvas bg-emerald-500 px-[3px] text-[9px] font-bold text-canvas">
            {remaining}
          </span>
        ) : null}
      </button>

      {open ? (
        <div
          role="menu"
          aria-label="Downloads"
          className="fixed right-3 top-14 z-50 w-72 max-w-[calc(100vw-1.5rem)] overflow-hidden rounded-lg border border-canvas-border bg-canvas-muted shadow-2xl sm:absolute sm:right-0 sm:top-full sm:mt-2 sm:max-w-none"
        >
          <div className="px-4 py-3">
            <div className="flex items-center justify-between gap-2">
              <p className="truncate font-mono text-xs text-canvas-foreground">{queue.name}</p>
              <button
                type="button"
                onClick={() => void window.academy?.models?.cancelDownloadQueue?.()}
                title="Stop"
                className="flex size-5 shrink-0 items-center justify-center rounded text-canvas-muted-foreground transition-colors hover:bg-red-500/15 hover:text-red-400"
              >
                <Square className="size-2.5 fill-current" />
              </button>
            </div>
            <div className="mt-2 h-1.5 w-full overflow-hidden rounded-full bg-canvas">
              <div
                className="h-full rounded-full bg-emerald-500 transition-[width] duration-300"
                style={{ width: pct != null ? `${pct}%` : '15%' }}
              />
            </div>
            <p className="mt-1.5 flex items-center justify-between font-mono text-[11px] text-canvas-muted-foreground">
              <span>
                {progress && progress.total > 0
                  ? `${formatBytes(progress.loaded)} / ${formatBytes(progress.total)}`
                  : 'Preparing…'}
              </span>
              {queue.total > 1 ? (
                <span>
                  {queue.done + 1} of {queue.total}
                </span>
              ) : null}
            </p>
          </div>
        </div>
      ) : null}
    </div>
  );
}
