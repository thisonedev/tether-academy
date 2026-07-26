import type { AcademyStateAPI } from '@academy/academy-bridge';

function getAcademyState(): AcademyStateAPI | null {
  if (typeof window === 'undefined') return null;
  const academy = (window as unknown as { academy?: { state?: AcademyStateAPI } })
    .academy;
  return academy?.state ?? null;
}

function hasLocalStorage(): boolean {
  return typeof window !== 'undefined' && typeof window.localStorage !== 'undefined';
}

// Sync storage interface for Zustand's persist so the first render already has
// the persisted user.
export const academyStorage = {
  getItem(name: string): string | null {
    if (!hasLocalStorage()) return null;
    try {
      return window.localStorage.getItem(name);
    } catch {
      return null;
    }
  },
  setItem(name: string, value: string): void {
    if (hasLocalStorage()) {
      try {
        window.localStorage.setItem(name, value);
      } catch {
        // Quota / privacy mode — best effort, the main process is the durable copy.
      }
    }
    const state = getAcademyState();
    if (state) {
      state.set(name, value).catch(() => {});
    }
  },
  removeItem(name: string): void {
    if (hasLocalStorage()) {
      try {
        window.localStorage.removeItem(name);
      } catch {
        // Best effort.
      }
    }
    const state = getAcademyState();
    if (state) {
      state.remove(name).catch(() => {});
    }
  },
};
