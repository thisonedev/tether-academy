'use client';

import { useEffect, useState } from 'react';
import { ArrowRight, User, X } from 'lucide-react';
import { useUserHydrated, useUserStore } from '@/lib/store/user-store';

const MIN_LEN = 3;
const MAX_LEN = 20;
const VALID_RE = /^[a-zA-Z0-9_-]+$/;

/** Sign-in modal controlled by `signInPromptOpen`. Closes on X / Escape / Maybe later / backdrop, or when a username is set. */
export function UsernamePrompt() {
  const hydrated = useUserHydrated();
  const promptOpen = useUserStore((s) => s.signInPromptOpen);
  const username = useUserStore((s) => s.username);
  const setUsername = useUserStore((s) => s.setUsername);
  const closeSignInPrompt = useUserStore((s) => s.closeSignInPrompt);

  const [value, setValue] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [touched, setTouched] = useState(false);

  // Esc dismisses; matches the lesson-complete-modal pattern.
  useEffect(() => {
    if (!promptOpen) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') closeSignInPrompt();
    };
    document.addEventListener('keydown', onKey);
    document.body.style.overflow = 'hidden';
    return () => {
      document.removeEventListener('keydown', onKey);
      document.body.style.overflow = '';
    };
  }, [promptOpen, closeSignInPrompt]);

  if (!hydrated) return null;
  if (!promptOpen) return null;
  if (username) return null;

  const submit = (e: React.FormEvent) => {
    e.preventDefault();
    setTouched(true);
    const trimmed = value.trim();
    if (trimmed.length < MIN_LEN) {
      setError(`Username must be at least ${MIN_LEN} characters.`);
      return;
    }
    if (trimmed.length > MAX_LEN) {
      setError(`Username must be at most ${MAX_LEN} characters.`);
      return;
    }
    if (!VALID_RE.test(trimmed)) {
      setError('Letters, numbers, dashes, and underscores only.');
      return;
    }
    setError(null);
    setUsername(trimmed);
    setValue('');
    setTouched(false);
  };

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-labelledby="username-prompt-title"
      className="fixed inset-0 z-50 flex items-center justify-center px-4"
    >
      <button
        type="button"
        aria-label="Dismiss"
        onClick={closeSignInPrompt}
        className="absolute inset-0 bg-canvas/85 backdrop-blur"
      />

      <form
        onSubmit={submit}
        className="relative w-full max-w-md rounded-xl border border-canvas-border bg-canvas-muted p-6 shadow-2xl sm:p-8"
      >
        <button
          type="button"
          aria-label="Close"
          onClick={closeSignInPrompt}
          className="absolute right-3 top-3 rounded p-1.5 text-canvas-muted-foreground transition-colors hover:bg-canvas hover:text-canvas-foreground"
        >
          <X className="size-4" />
        </button>

        <div className="mb-5 inline-flex size-10 items-center justify-center rounded-md bg-canvas text-emerald-400">
          <User className="size-5" />
        </div>
        <h2
          id="username-prompt-title"
          className="mb-2 text-2xl font-bold tracking-tight text-canvas-foreground"
        >
          {value.length === 0 && !touched
            ? 'Pick a username'
            : 'Sign in'}
        </h2>
        <p className="mb-6 text-sm leading-relaxed text-canvas-muted-foreground">
          Track your progress, points, and completed lessons across
          rebuilds. Stored locally in your browser. Sign-in via a real
          account comes in the next version.
        </p>

        <label
          htmlFor="username-input"
          className="mb-2 block text-xs font-semibold uppercase tracking-widest text-canvas-muted-foreground"
        >
          Username
        </label>
        <input
          id="username-input"
          // biome-ignore lint/a11y/noAutofocus: modal-first-input UX
          autoFocus
          autoComplete="username"
          spellCheck={false}
          value={value}
          onChange={(e) => {
            setValue(e.target.value);
            if (touched) setError(null);
          }}
          placeholder="your-handle"
          maxLength={MAX_LEN}
          className="mb-2 w-full rounded-md border border-canvas-border bg-canvas px-3 py-2 font-mono text-sm text-canvas-foreground placeholder:text-canvas-muted-foreground/60 focus:border-emerald-500 focus:outline-none focus:ring-2 focus:ring-emerald-500/30"
        />
        {error ? (
          <p
            role="alert"
            className="mb-3 text-xs text-red-400"
          >
            {error}
          </p>
        ) : (
          <p className="mb-3 text-xs text-canvas-muted-foreground">
            {MIN_LEN}–{MAX_LEN} characters. Letters, numbers, dashes,
            underscores.
          </p>
        )}

        <div className="flex items-center justify-between gap-2">
          <button
            type="button"
            onClick={closeSignInPrompt}
            className="rounded-md px-3 py-2 text-sm text-canvas-muted-foreground transition-colors hover:text-canvas-foreground"
          >
            Maybe later
          </button>
          <button
            type="submit"
            className="inline-flex items-center gap-1.5 rounded-md bg-emerald-500 px-4 py-2 text-sm font-semibold text-canvas transition-colors hover:bg-emerald-400"
          >
            Continue
            <ArrowRight className="size-4" />
          </button>
        </div>
      </form>
    </div>
  );
}