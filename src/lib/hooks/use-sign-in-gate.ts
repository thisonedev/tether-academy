'use client';

import type { MouseEvent } from 'react';
import { useUserHydrated, useUserStore } from '@/lib/store/user-store';

/** Returns an `onClick` handler that opens the sign-in prompt for unsigned visitors. */
export function useSignInGate() {
  const hydrated = useUserHydrated();
  const username = useUserStore((s) => s.username);
  const openSignInPrompt = useUserStore((s) => s.openSignInPrompt);
  return (e: MouseEvent) => {
    if (hydrated && !username) {
      e.preventDefault();
      openSignInPrompt();
    }
  };
}
