'use client';

import type { AcademyAPI, AcademyModelDownloadQueueState, AcademyModelStatus } from '@academy/validation';
import { Download, Square } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import { formatBytes } from './format-bytes.js';

declare global {
  interface Window {
    academy?: AcademyAPI;
  }
}

/**
 * Header icon for a download in progress: a Settings > Models batch, or any
 * capability's own model load (chat, playground media, translate), so it's
 * visible while browsing away from wherever it started. A small icon avoids
 * reflowing the header, unlike a bar that changes its height.
 */
export function DownloadStatusBadge() {
  const [queue, setQueue] = useState<AcademyModelDownloadQueueState | null>(null);
  const [progress, setProgress] = useState<{ loaded: number; total: number } | null>(null);
  const [modelStatus, setModelStatus] = useState<AcademyModelStatus | null>(null);
  const [open, setOpen] = useState(false);
  const containerRef = useRef<HTMLDivElement>(null);
  const buttonRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    let cancelled = false;
    // Without this, the badge only learns about an in-flight load from the
    // next progress tick, so it blinks off on every page navigation (this
    // component remounts) until one arrives.
    void window.academy
      ?.currentModelStatus?.()
      .then((status) => {
        if (!cancelled) setModelStatus(status ?? null);
      })
      .catch(() => {});
    const off = window.academy?.onModelStatus?.((status) => {
      setModelStatus(status.phase === 'ready' ? null : status);
    });
    return () => {
      cancelled = true;
      off?.();
    };
  }, []);

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

  // Same badge for any source; an active queue takes priority since it can
  // hold several models where a single capability's load is always one.
  const activeQueue = queue?.active ? queue : null;
  const activeStatus = !activeQueue ? modelStatus : null;
  if (!activeQueue && !activeStatus) return null;

  const name = activeQueue?.name ?? activeStatus?.name ?? '';
  const remaining = activeQueue ? activeQueue.total - activeQueue.done : 0;
  const pct = activeQueue
    ? progress && progress.total > 0
      ? Math.min(100, Math.round((progress.loaded / progress.total) * 100))
      : null
    : activeStatus?.total
      ? Math.min(100, Math.round(((activeStatus.downloaded ?? 0) / activeStatus.total) * 100))
      : null;
  const byteLabel = activeQueue
    ? progress && progress.total > 0
      ? `${formatBytes(progress.loaded)} / ${formatBytes(progress.total)}`
      : 'Preparing…'
    : activeStatus?.total
      ? `${formatBytes(activeStatus.downloaded ?? 0)} / ${formatBytes(activeStatus.total)}`
      : activeStatus?.phase === 'loading'
        ? 'Loading…'
        : 'Preparing…';
  // Only chat and the batch queue can actually be cancelled today; the
  // playground media/translate loaders have no cancel path to call into.
  const onCancel = activeQueue
    ? () => void window.academy?.models?.cancelDownloadQueue?.()
    : activeStatus?.kind === 'ai'
      ? () => void window.academy?.chat?.cancelLoad?.()
      : null;

  return (
    <div ref={containerRef} className="relative">
      <button
        ref={buttonRef}
        type="button"
        onClick={() => setOpen((o) => !o)}
        aria-haspopup="menu"
        aria-expanded={open}
        aria-label={`Downloading ${name}`}
        title={`Downloading ${name}`}
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
              <p className="truncate font-mono text-xs text-canvas-foreground">{name}</p>
              {onCancel ? (
                <button
                  type="button"
                  onClick={onCancel}
                  title="Stop"
                  className="flex size-5 shrink-0 items-center justify-center rounded text-canvas-muted-foreground transition-colors hover:bg-red-500/15 hover:text-red-400"
                >
                  <Square className="size-2.5 fill-current" />
                </button>
              ) : null}
            </div>
            <div className="mt-2 h-1.5 w-full overflow-hidden rounded-full bg-canvas">
              <div
                className="h-full rounded-full bg-emerald-500 transition-[width] duration-300"
                style={{ width: pct != null ? `${pct}%` : '15%' }}
              />
            </div>
            <p className="mt-1.5 flex items-center justify-between font-mono text-[11px] text-canvas-muted-foreground">
              <span>{byteLabel}</span>
              {activeQueue && activeQueue.total > 1 ? (
                <span>
                  {activeQueue.done + 1} of {activeQueue.total}
                </span>
              ) : null}
            </p>
          </div>
        </div>
      ) : null}
    </div>
  );
}
