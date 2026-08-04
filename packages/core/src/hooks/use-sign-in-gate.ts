'use client';

import type { MouseEvent } from 'react';
import { useUserHydrated, useUserStore } from '../store/user-store.js';

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
