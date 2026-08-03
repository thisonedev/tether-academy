'use client';

import type { AcademyAPI, AcademyIdentityStatus } from '@academy/validation';
import { useUserStore } from '@academy/core';
import { Check, KeyRound, Loader2, Shield } from 'lucide-react';
import { useCallback, useEffect, useState } from 'react';

declare global {
  interface Window {
    academy?: AcademyAPI;
  }
}

type Step = 'choose' | 'backup' | 'recover' | 'done';

function shortHex(hex: string | null | undefined, head = 10, tail = 6): string {
  if (!hex) return '-';
  if (hex.length <= head + tail + 1) return hex;
  return `${hex.slice(0, head)}…${hex.slice(-tail)}`;
}

/**
 * Identity setup for Settings: create, recover, or view/remove the local identity.
 * Multi-device link and Keet app interop are deferred.
 */
export function IdentityOnboarding({ onReady }: { onReady?: () => void }) {
  const resetUser = useUserStore((s) => s.reset);
  const [status, setStatus] = useState<AcademyIdentityStatus | null>(null);
  const [step, setStep] = useState<Step>('choose');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [mnemonic, setMnemonic] = useState<string | null>(null);
  const [backupChecked, setBackupChecked] = useState(false);
  const [recoverText, setRecoverText] = useState('');

  const refresh = useCallback(async () => {
    if (!window.academy?.identity) return null;
    const s = await window.academy.identity.status();
    setStatus(s);
    if (s.ready) {
      setStep('done');
      onReady?.();
    } else if (s.status !== 'pending-backup') {
      // No mnemonic to resume after a restart; fall back to choose.
      setStep('choose');
    }
    return s;
  }, [onReady]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const hasApi =
    typeof window !== 'undefined' && typeof window.academy?.identity?.status === 'function';
  if (!hasApi) {
    return (
      <div className="rounded-xl border border-canvas-border bg-canvas p-5 sm:p-6">
        <p className="text-sm text-canvas-muted-foreground">
          Identity setup is available in the desktop app.
        </p>
      </div>
    );
  }

  if (status?.ready && step === 'done') {
    return (
      <div className="rounded-xl border border-canvas-border bg-canvas p-5 sm:p-6">
        <p className="text-[11px] font-semibold uppercase tracking-wider text-canvas-muted-foreground">
          Identity
        </p>
        <p className="mt-1 text-sm text-canvas-foreground">Tether Academy identity ready</p>
        <p
          className="mt-2 font-mono text-xs text-canvas-muted-foreground"
          title={status.identityPublicKey ?? ''}
        >
          root {shortHex(status.identityPublicKey, 14, 10)}
        </p>
        <p
          className="mt-1 font-mono text-xs text-canvas-muted-foreground"
          title={status.devicePublicKey ?? ''}
        >
          device {shortHex(status.devicePublicKey, 14, 10)}
        </p>
        <p className="mt-3 text-xs text-canvas-muted-foreground">
          {status.holdsRoot
            ? 'This device holds recovery material. Keep your phrase offline.'
            : 'This device is set up under a root identity.'}
        </p>

        <div className="mt-6 border-t border-canvas-border pt-4">
          <p className="text-[11px] font-semibold uppercase tracking-wider text-canvas-muted-foreground">
            Remove from this device
          </p>
          <p className="mt-1 text-xs text-canvas-muted-foreground">
            Deletes the sealed identity keys on this machine only. You will need your recovery
            phrase to set up again.
          </p>
          <button
            type="button"
            disabled={busy}
            onClick={() => {
              if (
                !window.confirm(
                  'Remove identity from this device? You will need your recovery phrase to sign in again.',
                )
              ) {
                return;
              }
              setBusy(true);
              setError(null);
              void window.academy!.identity!.reset()
                .then(() => {
                  // Identity is gone; sign out too.
                  resetUser();
                  setStep('choose');
                  return refresh();
                })
                .catch((err) => {
                  setError(err instanceof Error ? err.message : String(err));
                })
                .finally(() => setBusy(false));
            }}
            className="mt-2 rounded border border-red-500/40 px-3 py-1.5 text-xs font-semibold text-red-400 hover:bg-red-500/10 disabled:opacity-50"
          >
            Remove identity from this device
          </button>
        </div>
        {error ? (
          <p className="mt-3 text-xs text-red-400" role="alert">
            {error}
          </p>
        ) : null}
      </div>
    );
  }

  async function onCreate() {
    setBusy(true);
    setError(null);
    try {
      const result = await window.academy!.identity!.create();
      setMnemonic(result.mnemonic);
      setBackupChecked(false);
      setStep('backup');
      await refresh();
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
      setStep('done');
      await refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }

  async function onRecover() {
    setBusy(true);
    setError(null);
    try {
      await window.academy!.identity!.recover(recoverText);
      setStep('done');
      await refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="rounded-xl border border-canvas-border bg-canvas p-5 sm:p-6">
      <p className="text-[11px] font-semibold uppercase tracking-wider text-canvas-muted-foreground">
        Identity setup
      </p>
      <p className="mt-1 text-sm text-canvas-muted-foreground">
        Create a new identity or restore one with your recovery phrase. Progress will attach to
        this identity later.
      </p>

      {error ? (
        <p className="mt-3 rounded-md border border-red-500/30 bg-red-500/10 px-3 py-2 text-xs text-red-300">
          {error}
        </p>
      ) : null}

      {step === 'choose' ? (
        <div className="mt-4 grid gap-3 sm:grid-cols-1">
          <button
            type="button"
            disabled={busy}
            onClick={() => void onCreate()}
            className="flex items-start gap-3 rounded-lg border border-canvas-border bg-canvas-muted px-4 py-3 text-left transition-colors hover:border-emerald-500/40 disabled:opacity-50"
          >
            <KeyRound className="mt-0.5 size-4 shrink-0 text-emerald-400" />
            <span>
              <span className="block text-sm font-semibold text-canvas-foreground">
                Create a new identity
              </span>
              <span className="mt-0.5 block text-xs text-canvas-muted-foreground">
                Recommended. New recovery phrase for this app only.
              </span>
            </span>
          </button>

          <button
            type="button"
            disabled={busy}
            onClick={() => setStep('recover')}
            className="flex items-start gap-3 rounded-lg border border-canvas-border bg-canvas-muted px-4 py-3 text-left transition-colors hover:border-emerald-500/40 disabled:opacity-50"
          >
            <Shield className="mt-0.5 size-4 shrink-0 text-canvas-muted-foreground" />
            <span>
              <span className="block text-sm font-semibold text-canvas-foreground">
                Recover with a phrase
              </span>
              <span className="mt-0.5 block text-xs text-canvas-muted-foreground">
                Enter the recovery phrase from a previous install.
              </span>
            </span>
          </button>
        </div>
      ) : null}

      {step === 'backup' && mnemonic ? (
        <div className="mt-4 space-y-3">
          <p className="text-sm text-canvas-foreground">
            Write down this recovery phrase. It is shown once and is the only way to recover this
            identity.
          </p>
          <pre className="whitespace-pre-wrap rounded-lg border border-amber-500/30 bg-amber-500/5 px-3 py-3 font-mono text-xs leading-relaxed text-canvas-foreground">
            {mnemonic}
          </pre>
          <label className="flex items-start gap-2 text-xs text-canvas-muted-foreground">
            <input
              type="checkbox"
              checked={backupChecked}
              onChange={(e) => setBackupChecked(e.target.checked)}
              className="mt-0.5"
            />
            I have saved this phrase offline. I understand it will not be shown again.
          </label>
          <div className="flex items-center justify-between gap-2">
            <button
              type="button"
              onClick={() => {
                setBackupChecked(false);
                setStep('choose');
                void refresh();
              }}
              className="rounded-md px-3 py-1.5 text-sm text-canvas-muted-foreground hover:text-canvas-foreground"
            >
              Back
            </button>
            <button
              type="button"
              disabled={busy || !backupChecked}
              onClick={() => void onConfirmBackup()}
              className="inline-flex items-center gap-1.5 rounded-md bg-emerald-500 px-3 py-1.5 text-sm font-semibold text-canvas disabled:opacity-50"
            >
              {busy ? <Loader2 className="size-3.5 animate-spin" /> : <Check className="size-3.5" />}
              Continue
            </button>
          </div>
        </div>
      ) : null}

      {step === 'recover' ? (
        <div className="mt-4 space-y-3">
          <p className="text-sm text-canvas-muted-foreground">
            Enter your Tether Academy recovery phrase.
          </p>
          <textarea
            value={recoverText}
            onChange={(e) => setRecoverText(e.target.value)}
            rows={3}
            spellCheck={false}
            className="w-full rounded-md border border-canvas-border bg-canvas-muted px-3 py-2 font-mono text-xs text-canvas-foreground"
            placeholder="word1 word2 …"
          />
          <div className="flex items-center gap-2">
            <button
              type="button"
              disabled={busy || !recoverText.trim()}
              onClick={() => void onRecover()}
              className="inline-flex items-center gap-1.5 rounded-md bg-emerald-500 px-3 py-1.5 text-sm font-semibold text-canvas disabled:opacity-50"
            >
              {busy ? <Loader2 className="size-3.5 animate-spin" /> : null}
              Recover
            </button>
            <button
              type="button"
              onClick={() => setStep('choose')}
              className="text-xs text-canvas-muted-foreground hover:text-canvas-foreground"
            >
              Back
            </button>
          </div>
        </div>
      ) : null}

      {busy && step === 'choose' ? (
        <p className="mt-3 flex items-center gap-2 text-xs text-canvas-muted-foreground">
          <Loader2 className="size-3 animate-spin" /> Working…
        </p>
      ) : null}
    </div>
  );
}
