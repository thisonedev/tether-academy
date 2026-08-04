import type { AcademyStateAPI } from '@academy/validation';

function getAcademyState(): AcademyStateAPI | null {
  if (typeof window === 'undefined') return null;
  const academy = (window as unknown as { academy?: { state?: AcademyStateAPI } })
    .academy;
  return academy?.state ?? null;
}

function hasLocalStorage(): boolean {
  return typeof window !== 'undefined' && typeof window.localStorage !== 'undefined';
}

// localStorage is a hot cache; getItem falls back to the durable main-process Corestore copy when empty.
export const academyStorage = {
  getItem(name: string): string | null | Promise<string | null> {
    if (hasLocalStorage()) {
      try {
        const cached = window.localStorage.getItem(name);
        if (cached !== null) return cached;
      } catch {
        // fall through to the durable copy
      }
    }
    const state = getAcademyState();
    if (!state) return null;
    return state.get(name).catch(() => null);
  },
  setItem(name: string, value: string): void {
    if (hasLocalStorage()) {
      try {
        window.localStorage.setItem(name, value);
      } catch {
        // Quota / privacy mode: best effort, the main process is the durable copy.
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
