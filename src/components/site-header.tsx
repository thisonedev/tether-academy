'use client';

import Link from 'next/link';
import { Box } from 'lucide-react';
import { UserMenu } from '@/components/user-menu';
import { useUserStore, useUserHydrated } from '@/lib/store/user-store';

export function SiteHeader() {
  const hydrated = useUserHydrated();
  const username = useUserStore((s) => s.username);
  const openSignInPrompt = useUserStore((s) => s.openSignInPrompt);

  return (
    <header className="sticky top-0 z-10 flex h-14 w-full items-center justify-between border-b border-canvas-border bg-canvas/90 px-4 backdrop-blur sm:px-6">
      <Link
        href="/"
        className="flex items-center gap-2 text-base font-bold tracking-tight"
      >
        <Box className="size-5 fill-emerald-500 text-emerald-500" strokeWidth={1.5} />
        <span>
          <span className="text-emerald-400">Tether</span>
          <span className="text-canvas-foreground"> Academy</span>
        </span>
      </Link>

      <nav className="flex items-center gap-1 sm:gap-3 text-sm">
        {hydrated && username ? (
          <UserMenu />
        ) : (
          <button
            type="button"
            onClick={openSignInPrompt}
            className="inline-flex items-center gap-1.5 rounded-md border border-canvas-border bg-canvas-muted px-3 py-1.5 text-sm font-medium text-canvas-foreground transition-colors hover:border-emerald-500/40 hover:bg-canvas"
          >
            Sign in
          </button>
        )}
        <Link
          href="/courses"
          className="rounded-md px-2 py-1.5 text-canvas-muted-foreground transition-colors hover:bg-canvas-muted hover:text-canvas-foreground sm:px-3"
        >
          Courses
        </Link>
        <a
          href="https://github.com/thisonedev/tether-academy"
          target="_blank"
          rel="noreferrer"
          className="rounded-md border border-canvas-border px-2.5 py-1 text-xs text-canvas-muted-foreground transition-colors hover:bg-canvas-muted hover:text-canvas-foreground sm:px-3 sm:text-sm"
        >
          GitHub
        </a>
      </nav>
    </header>
  );
}