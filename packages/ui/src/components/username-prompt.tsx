'use client';

import type { AcademyAPI } from '@academy/validation';
import { useUserHydrated, useUserStore } from '@academy/core';
import { ArrowRight, Check, KeyRound, Loader2, Shield, User, X } from 'lucide-react';
import { useCallback, useEffect, useRef, useState } from 'react';

declare global {
  interface Window {
    academy?: AcademyAPI;
  }
}

const MIN_LEN = 3;
const MAX_LEN = 20;
const VALID_RE = /^[a-zA-Z0-9_-]+$/;

type DesktopStep = 'choose' | 'backup' | 'recover' | 'username';

function WindowsFirewallNote() {
  return (
    <p className="flex items-start gap-2 rounded-lg border border-sky-500/30 bg-sky-500/5 px-3 py-2 text-xs text-canvas-foreground">
      <Shield className="mt-0.5 size-3.5 shrink-0 text-sky-400" />
      Windows may ask for firewall permission for background peer-to-peer networking used
      by model downloads and device pairing. Click Allow to continue.
    </p>
  );
}

/** Sign-in modal. Desktop: create identity, recover with phrase, or continue if already set up. Web: local display name only. */
export function UsernamePrompt() {
  const hydrated = useUserHydrated();
  const promptOpen = useUserStore((s) => s.signInPromptOpen);
  const username = useUserStore((s) => s.username);
  const setUsername = useUserStore((s) => s.setUsername);
  const restoreProgress = useUserStore((s) => s.restoreProgress);
  const closeSignInPrompt = useUserStore((s) => s.closeSignInPrompt);

  const [isDesktop, setIsDesktop] = useState(
    () => typeof window !== 'undefined' && !!window.academy?.identity,
  );
  const [step, setStep] = useState<DesktopStep>('choose');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const [value, setValue] = useState('');
  const [touched, setTouched] = useState(false);

  const [mnemonic, setMnemonic] = useState<string | null>(null);
  const [backupChecked, setBackupChecked] = useState(false);
  const [recoverText, setRecoverText] = useState('');
  const [identityReady, setIdentityReady] = useState(false);
  const [identityLabel, setIdentityLabel] = useState<string | null>(null);
  // Username already signed to this identity, if any (sign-out doesn't clear it).
  const [existingUsername, setExistingUsername] = useState<string | null>(null);
  // confirmBackup()/recover() both start the P2P mesh, and Windows shows its
  // own firewall prompt for that unprompted; this note gets ahead of it.
  const [isWindows, setIsWindows] = useState(false);

  // Latest-value ref: lets refreshIdentity read mnemonic without a dep.
  const mnemonicRef = useRef<string | null>(null);
  mnemonicRef.current = mnemonic;

  const refreshIdentity = useCallback(async () => {
    if (typeof window === 'undefined' || !window.academy?.identity) {
      setIdentityReady(false);
      return false;
    }
    try {
      const s = await window.academy.identity.status();
      setIdentityReady(!!s.ready);
      if (s.ready) {
        setIdentityLabel('Tether Academy profile');
        try {
          const host = await window.academy.identity.getUsername();
          setExistingUsername(host?.username ?? null);
        } catch {
          setExistingUsername(null);
        }
      } else {
        setExistingUsername(null);
      }
      if (s.status === 'pending-backup' && mnemonicRef.current) {
        // Only resume backup if we still hold the phrase this session.
        setStep('backup');
      } else if (!s.ready) {
        setStep('choose');
      }
      return !!s.ready;
    } catch {
      setIdentityReady(false);
      return false;
    }
  }, []);

  useEffect(() => {
    const desktop = typeof window !== 'undefined' && !!window.academy?.identity;
    setIsDesktop(desktop);
  }, [promptOpen]);

  useEffect(() => {
    void window.academy?.device
      ?.info()
      .then((info) => setIsWindows(info.os === 'windows'))
      .catch(() => {});
  }, []);

  useEffect(() => {
    if (!promptOpen || !isDesktop) return;
    setError(null);
    setBusy(false);
    setValue('');
    setTouched(false);
    // Reset to the choice screen; refreshIdentity() below may move to 'backup'.
    setStep('choose');
    void refreshIdentity();
  }, [promptOpen, isDesktop, refreshIdentity]);

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

  // Recomputes local points/chapters/lessons from the host's signed record,
  // so progress survives sign-out instead of resetting to zero.
  const restoreProgressFromHost = async () => {
    if (typeof window === 'undefined' || !window.academy?.identity?.getProgress) return;
    try {
      const result = await window.academy.identity.getProgress();
      const entries = result?.progress ?? {};
      const completedLessonKeys = Object.keys(entries).filter((k) => {
        const v = entries[k];
        return !!v && typeof v === 'object' && 'completedAt' in (v as Record<string, unknown>);
      });
      restoreProgress(completedLessonKeys);
    } catch {
      // best-effort: leave local progress alone if the host is unreachable
    }
  };

  const finishWithUsername = (name: string) => {
    setUsername(name);
    setValue('');
    setTouched(false);
    setMnemonic(null);
    setRecoverText('');
    // Push the username to the host IPC so it persists cryptographically
    // and shows up in the Profile tab's revision counter. Skip silently
    // when the host API isn't available (web build).
    if (typeof window !== 'undefined' && window.academy?.identity?.setUsername) {
      void window.academy.identity.setUsername({ username: name }).catch(() => {
        // Best-effort: the local store is the source of truth for the
        // username prompt; failure here is surfaced in the Profile tab.
      });
    }
    // Covers a recovered identity with host progress but no username yet.
    void restoreProgressFromHost();
  };

  const submitUsername = (e: React.FormEvent) => {
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
    finishWithUsername(trimmed);
  };

  async function wipeIdentityIfNeeded(): Promise<boolean> {
    if (!identityReady) return true;
    if (
      !window.confirm(
        'Remove the current identity from this device? You will need your recovery phrase to use it again.',
      )
    ) {
      return false;
    }
    await window.academy!.identity!.reset();
    setIdentityReady(false);
    setIdentityLabel(null);
    setMnemonic(null);
    return true;
  }

  async function onCreate() {
    setBusy(true);
    setError(null);
    try {
      if (!(await wipeIdentityIfNeeded())) return;
      const result = await window.academy!.identity!.create();
      setMnemonic(result.mnemonic);
      setBackupChecked(false);
      setStep('backup');
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }

  async function onConfirmBackup() {
    if (!backupChecked) {
      setError('Confirm you saved the recovery phrase before continuing.');
      return;
    }
    setBusy(true);
    setError(null);
    try {
      await window.academy!.identity!.confirmBackup();
      setMnemonic(null);
      setIdentityReady(true);
      setIdentityLabel('Tether Academy profile');
      setStep('username');
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }

  async function onStartRecover() {
    setError(null);
    if (identityReady) {
      setBusy(true);
      try {
        if (!(await wipeIdentityIfNeeded())) return;
      } catch (err) {
        setError(err instanceof Error ? err.message : String(err));
        return;
      } finally {
        setBusy(false);
      }
    }
    setStep('recover');
  }

  async function onRecover() {
    setBusy(true);
    setError(null);
    try {
      await window.academy!.identity!.recover(recoverText);
      setIdentityReady(true);
      setIdentityLabel('Tether Academy profile');
      // This mnemonic's blob store may already have a username; restore it
      // instead of asking again.
      try {
        const host = await window.academy!.identity!.getUsername();
        if (host?.username) {
          setUsername(host.username);
          await restoreProgressFromHost();
          return;
        }
      } catch {
        // fall through to asking for a username
      }
      setStep('username');
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }

  const title = !isDesktop
    ? value.length === 0 && !touched
      ? 'Pick a username'
      : 'Sign in'
    : step === 'choose'
      ? 'Sign in'
      : step === 'backup'
        ? 'Save your recovery phrase'
        : step === 'recover'
          ? 'Recover identity'
          : 'Pick a username';

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

      <div className="relative w-full max-w-md rounded-xl border border-canvas-border bg-canvas-muted p-6 shadow-2xl sm:p-8">
        <button
          type="button"
          aria-label="Close"
          onClick={closeSignInPrompt}
          className="absolute right-3 top-3 rounded p-1.5 text-canvas-muted-foreground transition-colors hover:bg-canvas hover:text-canvas-foreground"
        >
          <X className="size-4" />
        </button>

        <div className="mb-5 inline-flex size-10 items-center justify-center rounded-md bg-canvas text-emerald-400">
          {isDesktop && step === 'choose' ? (
            <KeyRound className="size-5" />
          ) : (
            <User className="size-5" />
          )}
        </div>
        <h2
          id="username-prompt-title"
          className="mb-2 text-2xl font-bold tracking-tight text-canvas-foreground"
        >
          {title}
        </h2>

        {error ? (
          <p
            role="alert"
            className="mb-3 rounded-md border border-red-500/30 bg-red-500/10 px-3 py-2 text-xs text-red-300"
          >
            {error}
          </p>
        ) : null}

        {!isDesktop ? (
          <form onSubmit={submitUsername}>
            <p className="mb-6 text-sm leading-relaxed text-canvas-muted-foreground">
              Track your progress, points, and completed lessons across rebuilds. Stored locally
              in your browser. Crypto identity is available in the desktop app.
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
            <p className="mb-3 text-xs text-canvas-muted-foreground">
              {MIN_LEN}-{MAX_LEN} characters. Letters, numbers, dashes, underscores.
            </p>
            <div className="flex items-center justify-between gap-2">
              <button
                type="submit"
                className="inline-flex items-center gap-1.5 rounded-md bg-emerald-500 px-4 py-2 text-sm font-semibold text-canvas transition-colors hover:bg-emerald-400"
              >
                Continue
                <ArrowRight className="size-4" />
              </button>
            </div>
          </form>
        ) : null}

        {isDesktop && step === 'choose' ? (
          <div className="space-y-3">
            {identityReady ? (
              <>
                <p className="mb-4 text-sm leading-relaxed text-canvas-muted-foreground">
                  This device already has an identity. Continue, or replace it.
                </p>
                <button
                  type="button"
                  disabled={busy}
                  onClick={() => {
                    setError(null);
                    if (existingUsername) {
                      // Local-only restore, no host round-trip or revision
                      // bump; progress still needs one host read below.
                      setUsername(existingUsername);
                      void restoreProgressFromHost();
                      return;
                    }
                    setStep('username');
                  }}
                  className="flex w-full items-start gap-3 rounded-lg border border-emerald-500/40 bg-emerald-500/10 px-4 py-3 text-left transition-colors hover:border-emerald-500/60 disabled:opacity-50"
                >
                  <Check className="mt-0.5 size-4 shrink-0 text-emerald-400" />
                  <span>
                    <span className="block text-sm font-semibold text-canvas-foreground">
                      Continue with existing profile
                    </span>
                    <span className="mt-0.5 block text-xs text-canvas-muted-foreground">
                      {existingUsername
                        ? `Sign back in as @${existingUsername}.`
                        : `${identityLabel ?? 'Profile on this device'}. Pick a display name to continue.`}
                    </span>
                  </span>
                </button>
                <button
                  type="button"
                  disabled={busy}
                  onClick={() => void onCreate()}
                  className="flex w-full items-start gap-3 rounded-lg border border-canvas-border bg-canvas px-4 py-3 text-left transition-colors hover:border-emerald-500/40 disabled:opacity-50"
                >
                  <KeyRound className="mt-0.5 size-4 shrink-0 text-emerald-400" />
                  <span>
                    <span className="block text-sm font-semibold text-canvas-foreground">
                      Create a new identity
                    </span>
                    <span className="mt-0.5 block text-xs text-canvas-muted-foreground">
                      Removes the current identity from this device, then creates a new recovery
                      phrase.
                    </span>
                  </span>
                </button>
                <button
                  type="button"
                  disabled={busy}
                  onClick={() => void onStartRecover()}
                  className="flex w-full items-start gap-3 rounded-lg border border-canvas-border bg-canvas px-4 py-3 text-left transition-colors hover:border-emerald-500/40 disabled:opacity-50"
                >
                  <Shield className="mt-0.5 size-4 shrink-0 text-canvas-muted-foreground" />
                  <span>
                    <span className="block text-sm font-semibold text-canvas-foreground">
                      Recover with a phrase
                    </span>
                    <span className="mt-0.5 block text-xs text-canvas-muted-foreground">
                      Enter a recovery phrase. Current identity will be removed first (after you
                      confirm).
                    </span>
                  </span>
                </button>
              </>
            ) : (
              <>
                <p className="mb-4 text-sm leading-relaxed text-canvas-muted-foreground">
                  Create a new identity and save the recovery phrase, or restore one you already
                  have.
                </p>
                <button
                  type="button"
                  disabled={busy}
                  onClick={() => void onCreate()}
                  className="flex w-full items-start gap-3 rounded-lg border border-emerald-500/40 bg-emerald-500/10 px-4 py-3 text-left transition-colors hover:border-emerald-500/60 disabled:opacity-50"
                >
                  <KeyRound className="mt-0.5 size-4 shrink-0 text-emerald-400" />
                  <span>
                    <span className="block text-sm font-semibold text-canvas-foreground">
                      Create a new identity
                    </span>
                    <span className="mt-0.5 block text-xs text-canvas-muted-foreground">
                      Recommended. You'll get a recovery phrase to write down offline.
                    </span>
                  </span>
                </button>
                <button
                  type="button"
                  disabled={busy}
                  onClick={() => void onStartRecover()}
                  className="flex w-full items-start gap-3 rounded-lg border border-canvas-border bg-canvas px-4 py-3 text-left transition-colors hover:border-emerald-500/40 disabled:opacity-50"
                >
                  <Shield className="mt-0.5 size-4 shrink-0 text-canvas-muted-foreground" />
                  <span>
                    <span className="block text-sm font-semibold text-canvas-foreground">
                      Sign in with recovery phrase
                    </span>
                    <span className="mt-0.5 block text-xs text-canvas-muted-foreground">
                      Restore an identity you created before. Current identity will be replaced with the new one.
                    </span>
                  </span>
                </button>
              </>
            )}

            <div className="flex items-center justify-between pt-2">
              {busy ? (
                <span className="inline-flex items-center gap-1.5 text-xs text-canvas-muted-foreground">
                  <Loader2 className="size-3.5 animate-spin" /> Working…
                </span>
              ) : null}
            </div>
          </div>
        ) : null}

        {isDesktop && step === 'backup' ? (
          <div className="space-y-3">
            {mnemonic ? (
              <>
                <p className="text-sm text-canvas-muted-foreground">
                  Write this phrase down offline. It is shown once and is the only way to recover
                  this identity.
                </p>
                <pre className="whitespace-pre-wrap rounded-lg border border-amber-500/30 bg-amber-500/5 px-3 py-3 font-mono text-xs leading-relaxed text-canvas-foreground">
                  {mnemonic}
                </pre>
                {isWindows ? <WindowsFirewallNote /> : null}
              </>
            ) : (
              <p className="text-sm text-canvas-muted-foreground">
                You already created an identity on this device. Confirm you still have the recovery
                phrase, or go back and use Recover if you need to enter it again.
              </p>
            )}
            <label className="flex items-start gap-2 text-xs text-canvas-muted-foreground">
              <input
                type="checkbox"
                checked={backupChecked}
                onChange={(e) => setBackupChecked(e.target.checked)}
                className="mt-0.5"
              />
              {mnemonic
                ? 'I have saved this phrase. I understand it will not be shown again.'
                : 'I have my recovery phrase saved offline.'}
            </label>
            <div className="flex items-center justify-between gap-2 pt-1">
              <div className="flex items-center gap-1">
                <button
                  type="button"
                  onClick={() => {
                    setError(null);
                    setBackupChecked(false);
                    setStep('choose');
                  }}
                  className="rounded-md px-3 py-2 text-sm text-canvas-muted-foreground hover:text-canvas-foreground"
                >
                  Back
                </button>
              </div>
              <button
                type="button"
                disabled={busy || !backupChecked}
                onClick={() => void onConfirmBackup()}
                className="inline-flex items-center gap-1.5 rounded-md bg-emerald-500 px-4 py-2 text-sm font-semibold text-canvas disabled:opacity-50"
              >
                {busy ? <Loader2 className="size-4 animate-spin" /> : null}
                Continue
                <ArrowRight className="size-4" />
              </button>
            </div>
          </div>
        ) : null}

        {isDesktop && step === 'recover' ? (
          <div className="space-y-3">
            <p className="text-sm text-canvas-muted-foreground">
              Enter your Tether Academy recovery phrase.
            </p>
            <textarea
              value={recoverText}
              onChange={(e) => setRecoverText(e.target.value)}
              rows={3}
              spellCheck={false}
              className="w-full rounded-md border border-canvas-border bg-canvas px-3 py-2 font-mono text-xs text-canvas-foreground"
              placeholder="word1 word2 …"
            />
            {isWindows ? <WindowsFirewallNote /> : null}
            <div className="flex items-center justify-between gap-2">
              <button
                type="button"
                onClick={() => setStep('choose')}
                className="text-sm text-canvas-muted-foreground"
              >
                Back
              </button>
              <button
                type="button"
                disabled={busy || !recoverText.trim()}
                onClick={() => void onRecover()}
                className="inline-flex items-center gap-1.5 rounded-md bg-emerald-500 px-4 py-2 text-sm font-semibold text-canvas disabled:opacity-50"
              >
                {busy ? <Loader2 className="size-4 animate-spin" /> : null}
                Recover
              </button>
            </div>
          </div>
        ) : null}

        {isDesktop && step === 'username' ? (
          <form onSubmit={submitUsername}>
            <p className="mb-4 text-sm leading-relaxed text-canvas-muted-foreground">
              {identityLabel ? `${identityLabel} is ready on this device. ` : ''}
              Choose your username.
            </p>
            <label
              htmlFor="username-input-desktop"
              className="mb-2 block text-xs font-semibold uppercase tracking-widest text-canvas-muted-foreground"
            >
              Username
            </label>
            <input
              id="username-input-desktop"
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
            <p className="mb-3 text-xs text-canvas-muted-foreground">
              {MIN_LEN}-{MAX_LEN} characters. Letters, numbers, dashes, underscores.
            </p>
            <div className="flex items-center justify-between gap-2">
              <button
                type="button"
                onClick={() => setStep('choose')}
                className="rounded-md px-3 py-2 text-sm text-canvas-muted-foreground transition-colors hover:text-canvas-foreground"
              >
                Back
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
        ) : null}
      </div>
    </div>
  );
}
