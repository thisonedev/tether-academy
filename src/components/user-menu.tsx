'use client';

import { useEffect, useRef, useState } from 'react';
import { LogOut } from 'lucide-react';
import { getLevel, useUserHydrated, useUserStore } from '@/lib/store/user-store';

const XP_PER_LEVEL = 100;

/** Header account handle: avatar (initial) that opens a dropdown with the
 *  username, level/XP, and sign out. The sectioned menu is the long-term
 *  home for account items (settings, profile, theme, shortcuts). */
export function UserMenu() {
  const hydrated = useUserHydrated();
  const username = useUserStore((s) => s.username);
  const points = useUserStore((s) => s.points);
  const reset = useUserStore((s) => s.reset);

  const [open, setOpen] = useState(false);
  const [confirming, setConfirming] = useState(false);
  const containerRef = useRef<HTMLDivElement>(null);
  const buttonRef = useRef<HTMLButtonElement>(null);

  // Close on outside click and Escape; restore focus to the trigger.
  useEffect(() => {
    if (!open) return;
    const onMouseDown = (e: MouseEvent) => {
      if (!containerRef.current?.contains(e.target as Node)) {
        setOpen(false);
        setConfirming(false);
      }
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        setOpen(false);
        setConfirming(false);
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

  // Hydration placeholder matches the button footprint to avoid layout shift.
  if (!hydrated) {
    return (
      <span
        aria-hidden
        className="inline-flex size-8 items-center justify-center rounded-full border border-canvas-border bg-canvas-muted"
      />
    );
  }
  if (!username) return null;

  const level = getLevel(points);
  const initial = username.charAt(0).toUpperCase();
  const xpInLevel = points % XP_PER_LEVEL;
  const xpToNext = XP_PER_LEVEL - xpInLevel;
  const progressPct = (xpInLevel / XP_PER_LEVEL) * 100;

  const handleSignOut = () => {
    reset();
    setOpen(false);
    setConfirming(false);
  };

  return (
    <div ref={containerRef} className="relative">
      <button
        ref={buttonRef}
        type="button"
        onClick={() => {
          setOpen((o) => !o);
          setConfirming(false);
        }}
        aria-haspopup="menu"
        aria-expanded={open}
        aria-label={`Account menu for ${username}`}
        title={`@${username}`}
        className="inline-flex items-center justify-center rounded-full border border-canvas-border bg-canvas-muted p-0.5 text-canvas-foreground transition-colors hover:border-emerald-500/50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-emerald-500/40"
      >
        <span className="inline-flex size-7 items-center justify-center rounded-full bg-emerald-500/15 font-semibold text-emerald-400 text-sm">
          {initial}
        </span>
      </button>

      {open ? (
        <div
          role="menu"
          aria-label="Account"
          className="fixed right-3 top-14 z-50 mt-0 w-64 max-w-[calc(100vw-1.5rem)] overflow-hidden rounded-lg border border-canvas-border bg-canvas-muted shadow-2xl sm:absolute sm:right-0 sm:top-full sm:mt-2 sm:max-w-none"
        >
          <div className="border-b border-canvas-border px-4 py-3">
            <p className="truncate font-mono text-sm font-semibold text-canvas-foreground">
              @{username}
            </p>
          </div>

          <div className="px-4 py-3">
            <div className="flex items-center justify-between text-xs">
              <span className="text-canvas-muted-foreground">Level</span>
              <span className="font-mono text-canvas-foreground">{level}</span>
            </div>
            <div className="mt-1 flex items-center justify-between text-xs">
              <span className="text-canvas-muted-foreground">XP</span>
              <span className="font-mono text-canvas-foreground">{points}</span>
            </div>
            <div
              className="mt-2 h-1.5 w-full overflow-hidden rounded-full bg-canvas"
              role="progressbar"
              aria-valuenow={xpInLevel}
              aria-valuemin={0}
              aria-valuemax={XP_PER_LEVEL}
              aria-label={`Progress to level ${level + 1}`}
            >
              <div
                className="h-full rounded-full bg-emerald-500"
                style={{ width: `${progressPct}%` }}
              />
            </div>
            <p className="mt-1 text-right text-[10px] text-canvas-muted-foreground/70">
              {xpToNext} XP to Lv {level + 1}
            </p>
          </div>

          <div className="border-t border-canvas-border p-1">
            {confirming ? (
              <div className="p-2">
                <div className="flex items-center justify-end gap-1">
                  <button
                    type="button"
                    onClick={() => setConfirming(false)}
                    className="rounded px-2 py-1 text-canvas-muted-foreground hover:bg-canvas hover:text-canvas-foreground"
                  >
                    Cancel
                  </button>
                  <button
                    type="button"
                    onClick={handleSignOut}
                    className="rounded bg-red-500/15 px-2 py-1 font-semibold text-red-400 hover:bg-red-500/25"
                  >
                    Sign out
                  </button>
                </div>
                <p className="mt-1.5 text-right text-[10px] text-canvas-muted-foreground/80">
                  This will reset the local progress.
                </p>
              </div>
            ) : (
              <button
                type="button"
                role="menuitem"
                onClick={() => setConfirming(true)}
                className="flex w-full items-center gap-2 rounded px-2.5 py-1.5 text-sm text-canvas-muted-foreground transition-colors hover:bg-canvas hover:text-canvas-foreground"
              >
                <LogOut className="size-4" />
                Sign out
              </button>
            )}
          </div>
        </div>
      ) : null}
    </div>
  );
}
