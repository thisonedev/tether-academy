'use client';

import { Sparkles } from 'lucide-react';
import { useUserHydrated, useUserStore } from '@/lib/store/user-store';

export function SignInBanner() {
  const hydrated = useUserHydrated();
  const username = useUserStore((s) => s.username);
  const openSignInPrompt = useUserStore((s) => s.openSignInPrompt);

  if (!hydrated || username) return null;

  return (
    <div className="mb-4 flex flex-wrap items-center justify-between gap-3 rounded-md border border-amber-500/30 bg-amber-500/[0.08] px-3 py-2.5 text-sm sm:flex-nowrap">
      <div className="flex items-start gap-2 text-amber-200 sm:items-center">
        <Sparkles className="size-4 shrink-0 text-amber-400" />
        <span className="leading-snug">
          You're browsing as a guest. Sign in to keep your progress.
        </span>
      </div>
      <button
        type="button"
        onClick={openSignInPrompt}
        className="rounded-md border border-amber-500/40 bg-canvas px-3 py-1 text-xs font-semibold uppercase tracking-wider text-amber-200 transition-colors hover:bg-amber-500/15 hover:text-amber-100"
      >
        Sign in
      </button>
    </div>
  );
}