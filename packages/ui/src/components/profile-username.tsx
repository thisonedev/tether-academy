'use client';

import type { AcademyAPI } from '@academy/validation';
import { useUserStore } from '@academy/core';
import { ArrowRight, Check, Loader2, Shield, User, X } from 'lucide-react';
import { useCallback, useEffect, useState } from 'react';

declare global {
  interface Window {
    academy?: AcademyAPI;
  }
}

const USERNAME_RE = /^[a-z0-9](?:[a-z0-9_-]{1,28}[a-z0-9])?$/i;

function formatRelative(ts: number): string {
  const delta = Date.now() - ts;
  if (delta < 60_000) return 'just now';
  if (delta < 3600_000) return `${Math.floor(delta / 60_000)} min ago`;
  if (delta < 86_400_000) return `${Math.floor(delta / 3600_000)} h ago`;
  return new Date(ts).toLocaleDateString();
}

type IdentitySnapshot = {
  username: string;
  revision: number;
  updatedAt: number;
  published: boolean;
} | null;

/** Username editor for the Profile tab. Talks directly to the host IPC,
 *  which signs the payload with `IdentityKey.attestData`. */
export function ProfileUsernameSection() {
  const [hasApi, setHasApi] = useState(false);
  const [snapshot, setSnapshot] = useState<IdentitySnapshot>(null);
  const [value, setValue] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [editing, setEditing] = useState(false);
  const [success, setSuccess] = useState(false);

  const refresh = useCallback(async () => {
    if (typeof window === 'undefined' || !window.academy?.identity) {
      setHasApi(false);
      return;
    }
    setHasApi(true);
    try {
      const result = await window.academy.identity.getUsername();
      setSnapshot(result);
      if (result && !editing) setValue(result.username);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }, [editing]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  // First refresh may return null while init() is still hydrating; retry
  // once so opening Settings right after creating a profile isn't empty.
  useEffect(() => {
    if (snapshot) return;
    if (!hasApi) return;
    const timer = window.setTimeout(() => {
      void refresh();
    }, 250);
    return () => window.clearTimeout(timer);
  }, [snapshot, hasApi, refresh]);

  if (!hasApi) {
    return (
      <section
        aria-label="Username"
        className="rounded-xl border border-canvas-border bg-canvas p-5 sm:p-6"
      >
        <p className="text-[11px] font-semibold uppercase tracking-wider text-canvas-muted-foreground">
          Username
        </p>
        <p className="mt-2 text-sm text-canvas-muted-foreground">
          Username binding is available in the desktop app.
        </p>
      </section>
    );
  }

  const startEdit = () => {
    setEditing(true);
    setValue(snapshot?.username ?? '');
    setError(null);
    setSuccess(false);
  };

  const cancelEdit = () => {
    setEditing(false);
    setValue(snapshot?.username ?? '');
    setError(null);
  };

  const onSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    const trimmed = value.trim().toLowerCase();
    if (trimmed.length < 3 || trimmed.length > 30) {
      setError('Username must be 3 to 30 characters.');
      return;
    }
    if (!USERNAME_RE.test(trimmed)) {
      setError('Letters, digits, dashes, and underscores only. No leading or trailing dash or underscore.');
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const result = await window.academy!.identity!.setUsername({ username: trimmed });
      if (!result) {
        setError('Profile not ready.');
        return;
      }
      setSnapshot({ ...result, published: true });
      setEditing(false);
      // Mirror to the local store so the avatar initial and any other
      // components that read from `useUserStore.username` update instantly.
      useUserStore.getState().setUsername(result.username);
      setSuccess(true);
      window.setTimeout(() => setSuccess(false), 4000);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <section
      aria-label="Username"
      className="rounded-xl border border-canvas-border bg-canvas p-5 sm:p-6"
    >
      <div className="flex items-start justify-between gap-3">
        <div>
          <p className="text-[11px] font-semibold uppercase tracking-wider text-canvas-muted-foreground">
            Username
          </p>
          <p className="mt-1 text-sm text-canvas-muted-foreground">
            Ties your progress and any future identity features to this profile. Stored
            locally and signed with this profile's recovery key.
          </p>
        </div>
        {snapshot && !editing ? (
          <button
            type="button"
            onClick={startEdit}
            className="rounded border border-canvas-border px-3 py-1.5 text-xs font-semibold text-canvas-foreground hover:border-emerald-500/40"
          >
            Change
          </button>
        ) : null}
      </div>

      {snapshot && !editing ? (
        <div className="mt-4 flex items-center gap-3">
          <User className="size-4 shrink-0 text-emerald-400" />
          <span className="font-mono text-sm text-canvas-foreground">{snapshot.username}</span>
          <span className="text-xs text-canvas-muted-foreground">
            {snapshot.revision} username change{snapshot.revision === 1 ? '' : 's'},{' '}
            {formatRelative(snapshot.updatedAt)}
          </span>
        </div>
      ) : null}

      {!snapshot && !editing ? (
        <button
          type="button"
          onClick={startEdit}
          className="mt-4 inline-flex items-center gap-1.5 rounded-md bg-emerald-500 px-4 py-2 text-sm font-semibold text-canvas transition-colors hover:bg-emerald-400"
        >
          Pick a username
          <ArrowRight className="size-4" />
        </button>
      ) : null}

      {editing ? (
        <form onSubmit={onSubmit} className="mt-4 space-y-2">
          <label
            htmlFor="profile-username-input"
            className="block text-xs font-semibold uppercase tracking-widest text-canvas-muted-foreground"
          >
            Username
          </label>
          <input
            id="profile-username-input"
            // biome-ignore lint/a11y/noAutofocus: profile-first-input UX
            autoFocus
            autoComplete="username"
            spellCheck={false}
            value={value}
            onChange={(e) => {
              setValue(e.target.value);
              setError(null);
            }}
            placeholder="your-handle"
            maxLength={30}
            className="w-full rounded-md border border-canvas-border bg-canvas-muted px-3 py-2 font-mono text-sm text-canvas-foreground placeholder:text-canvas-muted-foreground/60 focus:border-emerald-500 focus:outline-none focus:ring-2 focus:ring-emerald-500/30"
          />
          <p className="text-xs text-canvas-muted-foreground">
            3 to 30 characters. Lowercase letters, digits, dashes, underscores.
          </p>
          {error ? (
            <p
              role="alert"
              className="rounded-md border border-red-500/30 bg-red-500/10 px-3 py-2 text-xs text-red-300"
            >
              {error}
            </p>
          ) : null}
          <div className="flex items-center gap-2 pt-1">
            <button
              type="submit"
              disabled={busy}
              className="inline-flex items-center gap-1.5 rounded-md bg-emerald-500 px-4 py-2 text-sm font-semibold text-canvas transition-colors hover:bg-emerald-400 disabled:opacity-50"
            >
              {busy ? <Loader2 className="size-4 animate-spin" /> : <Check className="size-4" />}
              Save username
            </button>
            <button
              type="button"
              onClick={cancelEdit}
              className="inline-flex items-center gap-1.5 rounded-md border border-canvas-border px-4 py-2 text-sm text-canvas-muted-foreground hover:text-canvas-foreground"
            >
              <X className="size-4" />
              Cancel
            </button>
          </div>
        </form>
      ) : null}

      {success ? (
        <p
          role="status"
          className="mt-3 inline-flex items-center gap-1.5 text-xs text-emerald-400"
        >
          <Shield className="size-3.5" />
          Username saved and signed to your profile.
        </p>
      ) : null}
    </section>
  );
}