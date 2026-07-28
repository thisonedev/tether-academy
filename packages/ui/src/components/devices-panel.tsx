'use client';

import type {
  AcademyAPI,
  AcademyPeerAuditEntry,
  AcademyPeerIdentity,
  AcademyPeerInfo,
  AcademyPeerInvite,
  AcademyPeerPending,
} from '@academy/academy-bridge';
import { Check, Copy, Loader2, Lock, QrCode, ShieldAlert, ShieldCheck, Wifi, X } from 'lucide-react';
import { useCallback, useEffect, useState } from 'react';

declare global {
  interface Window {
    academy?: AcademyAPI;
  }
}

const AUDIT_DISPLAY_LIMIT = 50;

function shortHex(hex: string, head = 8, tail = 6): string {
  if (hex.length <= head + tail + 1) return hex;
  return `${hex.slice(0, head)}…${hex.slice(-tail)}`;
}

function copyToClipboard(text: string): Promise<void> {
  if (typeof navigator !== 'undefined' && navigator.clipboard?.writeText) {
    return navigator.clipboard.writeText(text);
  }
  return new Promise((resolve) => {
    const ta = document.createElement('textarea');
    ta.value = text;
    ta.style.position = 'fixed';
    ta.style.opacity = '0';
    document.body.appendChild(ta);
    ta.select();
    try {
      document.execCommand('copy');
    } catch {}
    document.removeChild(ta);
    resolve();
  });
}

function parsePairInput(input: string): { invite: string; code: string | null } | null {
  const trimmed = input.trim();
  if (!trimmed) return null;
  if (trimmed.startsWith('tether-academy://')) {
    try {
      const url = new URL(trimmed);
      const invite = url.searchParams.get('i');
      if (!invite) return null;
      return { invite, code: url.searchParams.get('c') };
    } catch {
      return null;
    }
  }
  if (trimmed.includes('?i=')) {
    const invite = trimmed.split('?i=')[1]?.split('&')[0];
    if (!invite) return null;
    const code = trimmed.includes('&c=') ? trimmed.split('&c=')[1]?.split('&')[0] ?? null : null;
    return { invite: decodeURIComponent(invite), code: code ? decodeURIComponent(code) : null };
  }
  return { invite: trimmed, code: null };
}

function pairUrl(invite: string, code: string): string {
  return `tether-academy://pair?i=${encodeURIComponent(invite)}&c=${encodeURIComponent(code)}`;
}

function pairUserDataLabel(info: { userData: unknown }): string {
  const data = info.userData;
  if (data && typeof data === 'object' && 'name' in data && typeof data.name === 'string') {
    return data.name;
  }
  if (data && typeof data === 'object' && 'hostname' in data && typeof data.hostname === 'string') {
    return String(data.hostname);
  }
  return 'Unknown device';
}

function formatRelativeTime(ts: number, now: number): string {
  const diff = Math.max(0, now - ts);
  const sec = Math.floor(diff / 1000);
  if (sec < 5) return 'just now';
  if (sec < 60) return `${sec}s ago`;
  const min = Math.floor(sec / 60);
  if (min < 60) return `${min}m ago`;
  const hr = Math.floor(min / 60);
  if (hr < 24) return `${hr}h ago`;
  const day = Math.floor(hr / 24);
  return `${day}d ago`;
}

function auditLabel(entry: AcademyPeerAuditEntry): string {
  switch (entry.type) {
    case 'peer:pending':
      return `Pair request from ${pairUserDataLabel({ userData: entry.remoteUserData })}`;
    case 'peer:paired':
      return `Paired with ${pairUserDataLabel({ userData: entry.remoteUserData })} (${entry.role ?? '?'})`;
    case 'peer:approved':
      return 'Pair request approved';
    case 'peer:rejected':
      if (entry.reason === 'pairing-code-mismatch') {
        return 'Unverified build attempt';
      }
      if (entry.reason === 'unverified-build') {
        return 'Unverified build attempt';
      }
      return 'Pair request rejected';
    case 'peer:dropped':
      return 'Pair dropped';
    case 'peer:lockdown':
      return `Lockdown: ${entry.dropped ?? 0} dropped`;
    default:
      return entry.type;
  }
}

function formatPairingCode(code: string): string {
  const upper = code.toUpperCase().replace(/[^A-Z2-9]/g, '');
  if (upper.length <= 4) return upper;
  return `${upper.slice(0, 4)}-${upper.slice(4)}`;
}

function PairingCodeDisplay({ code, label }: { code: string; label: string }) {
  return (
    <div>
      <p className="mb-1 text-[11px] font-semibold uppercase tracking-wider text-canvas-muted-foreground">
        {label}
      </p>
      <p className="rounded-md border border-canvas-border bg-canvas-muted px-4 py-3 font-mono text-2xl font-semibold tracking-widest text-canvas-foreground">
        {formatPairingCode(code)}
      </p>
    </div>
  );
}

export function DevicesPanel() {
  const [identity, setIdentity] = useState<AcademyPeerIdentity | null | 'loading'>('loading');
  const [peers, setPeers] = useState<AcademyPeerInfo[]>([]);
  const [pending, setPending] = useState<AcademyPeerPending[]>([]);
  const [audit, setAudit] = useState<AcademyPeerAuditEntry[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [deeplinkToast, setDeeplinkToast] = useState<{ invite: string; code: string | null } | null>(null);
  const [now, setNow] = useState<number>(() => Date.now());

  const [inviteBusy, setInviteBusy] = useState(false);
  const [inviteModal, setInviteModal] = useState<{ invite: AcademyPeerInvite; qrDataUrl: string } | null>(null);
  const [acceptBusy, setAcceptBusy] = useState(false);
  const [acceptText, setAcceptText] = useState('');
  const [acceptCode, setAcceptCode] = useState('');
  const [actionBusy, setActionBusy] = useState<string | null>(null);
  const [lockdownConfirm, setLockdownConfirm] = useState(false);
  const [copied, setCopied] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    if (!window.academy?.peer) return;
    const [id, p, pn, au] = await Promise.all([
      window.academy.peer.identity().catch(() => null),
      window.academy.peer.list().catch(() => []),
      window.academy.peer.pending().catch(() => []),
      window.academy.peer.audit({ limit: AUDIT_DISPLAY_LIMIT }).catch(() => []),
    ]);
    setIdentity(id);
    setPeers(p);
    setPending(pn);
    setAudit(au.slice().reverse());
  }, []);

  useEffect(() => {
    if (!window.academy?.peer) {
      setError('Peer layer unavailable in this build.');
      return;
    }
    refresh();
    const off = window.academy.peer.onEvent((msg) => {
      if (msg.event === 'peer:deeplink') {
        const payload = msg.payload as { invite: string; pairingCode: string | null };
        setDeeplinkToast({ invite: payload.invite, code: payload.pairingCode });
        setAcceptText(`tether-academy://pair?i=${encodeURIComponent(payload.invite)}`);
        if (payload.pairingCode) setAcceptCode(payload.pairingCode);
        setTimeout(() => setDeeplinkToast(null), 8000);
      }
      if (msg.event === 'peer:audit') {
        const entry = msg.payload as AcademyPeerAuditEntry;
        setAudit((prev) => [entry, ...prev].slice(0, AUDIT_DISPLAY_LIMIT));
        if (
          entry.type === 'peer:paired' ||
          entry.type === 'peer:dropped' ||
          entry.type === 'peer:lockdown'
        ) {
          window.academy?.peer?.list().then(setPeers).catch(() => {});
        }
        if (
          entry.type === 'peer:pending' ||
          entry.type === 'peer:rejected' ||
          entry.type === 'peer:approved'
        ) {
          window.academy?.peer?.pending().then(setPending).catch(() => {});
        }
      }
      if (msg.event === 'peer:paired' || msg.event === 'peer:dropped') {
        window.academy?.peer?.list().then(setPeers).catch(() => {});
      }
      if (msg.event === 'peer:pending' || msg.event === 'peer:rejected') {
        window.academy?.peer?.pending().then(setPending).catch(() => {});
      }
    });
    const tick = setInterval(() => setNow(Date.now()), 30_000);
    return () => {
      off();
      clearInterval(tick);
    };
  }, [refresh]);

  const onCreateInvite = useCallback(async () => {
    if (!window.academy?.peer) return;
    setInviteBusy(true);
    setError(null);
    try {
      const invite = await window.academy.peer.invite();
      const qrDataUrl = await window.academy.qr(pairUrl(invite.invite, invite.pairingCode));
      setInviteModal({ invite, qrDataUrl });
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to create invite');
    } finally {
      setInviteBusy(false);
    }
  }, []);

  const onAccept = useCallback(async () => {
    if (!window.academy?.peer || !acceptText.trim()) return;
    setAcceptBusy(true);
    setError(null);
    try {
      const parsed = parsePairInput(acceptText);
      if (!parsed) {
        setError('Could not parse the invite. Paste a tether-academy:// link or a raw invite.');
        return;
      }
      await window.academy.peer.accept(parsed.invite, {
        userData: { name: 'controller', source: 'settings-panel' },
        code: acceptCode.trim() || parsed.code || undefined,
      });
      setAcceptText('');
      setAcceptCode('');
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Pair failed');
    } finally {
      setAcceptBusy(false);
    }
  }, [acceptText, acceptCode]);

  const onApprove = useCallback(async (requestId: string) => {
    if (!window.academy?.peer) return;
    setActionBusy(requestId);
    try {
      await window.academy.peer.approve(requestId);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Approve failed');
    } finally {
      setActionBusy(null);
    }
  }, []);

  const onReject = useCallback(async (requestId: string) => {
    if (!window.academy?.peer) return;
    setActionBusy(requestId);
    try {
      await window.academy.peer.reject(requestId);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Reject failed');
    } finally {
      setActionBusy(null);
    }
  }, []);

  const onDrop = useCallback(async (discoveryKey: string) => {
    if (!window.academy?.peer) return;
    setActionBusy(discoveryKey);
    try {
      await window.academy.peer.drop(discoveryKey);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Drop failed');
    } finally {
      setActionBusy(null);
    }
  }, []);

  const onLockdown = useCallback(async () => {
    if (!window.academy?.peer) return;
    setLockdownConfirm(false);
    setActionBusy('lockdown');
    try {
      await window.academy.peer.lockdown();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Lockdown failed');
    } finally {
      setActionBusy(null);
    }
  }, []);

  const onCopy = useCallback(async (text: string, key: string) => {
    await copyToClipboard(text);
    setCopied(key);
    setTimeout(() => setCopied((prev) => (prev === key ? null : prev)), 1500);
  }, []);

  if (error && identity === 'loading') {
    return (
      <p className="rounded-md border border-red-500/40 bg-red-500/10 p-3 text-sm text-red-400">
        {error}
      </p>
    );
  }

  return (
    <div className="space-y-6">
      {error ? (
        <p className="rounded-md border border-red-500/40 bg-red-500/10 p-3 text-sm text-red-400">
          {error}
        </p>
      ) : null}

      {deeplinkToast ? (
        <div className="rounded-md border border-emerald-500/40 bg-emerald-500/10 p-3 text-sm text-emerald-400">
          Pair link opened. Tell the host the code and wait for their approval.
        </div>
      ) : null}

      <div className="rounded-xl border border-canvas-border bg-canvas p-5 sm:p-6">
        <div className="flex items-start justify-between gap-3">
          <div>
            <p className="text-[11px] font-semibold uppercase tracking-wider text-canvas-muted-foreground">
              This device
            </p>
            {identity === 'loading' ? (
              <p className="mt-1 text-sm text-canvas-muted-foreground">Loading…</p>
            ) : identity === null ? (
              <p className="mt-1 text-sm text-canvas-muted-foreground">No identity yet.</p>
            ) : (
              <p
                className="mt-1 font-mono text-sm text-canvas-foreground"
                title={identity.publicKey}
              >
                {shortHex(identity.publicKey, 12, 8)}
              </p>
            )}
          </div>
          {identity && identity !== 'loading' ? (
            <button
              type="button"
              onClick={() => onCopy(identity.publicKey, 'identity')}
              className="inline-flex shrink-0 items-center gap-1 rounded-md border border-canvas-border bg-canvas-muted px-2.5 py-1 text-xs text-canvas-muted-foreground transition-colors hover:border-emerald-500/40 hover:text-canvas-foreground"
            >
              {copied === 'identity' ? (
                <>
                  <Check className="size-3 text-emerald-400" /> Copied
                </>
              ) : (
                <>
                  <Copy className="size-3" /> Copy
                </>
              )}
            </button>
          ) : null}
        </div>
      </div>

      <div className="rounded-xl border border-canvas-border bg-canvas p-5 sm:p-6">
        <p className="text-[11px] font-semibold uppercase tracking-wider text-canvas-muted-foreground">
          Pair a new device
        </p>
        <p className="mt-1 text-sm text-canvas-muted-foreground">
          Create a one-time invite. Share the link and the 6-character code out-of-band. Both
          must be known to the other side for the pair to succeed.
        </p>

        <div className="mt-4 flex flex-wrap items-center gap-3">
          <button
            type="button"
            onClick={onCreateInvite}
            disabled={inviteBusy}
            className="inline-flex items-center gap-1.5 rounded-md bg-emerald-500 px-3 py-1.5 text-sm font-semibold text-canvas transition-colors hover:bg-emerald-400 disabled:opacity-50"
          >
            {inviteBusy ? <Loader2 className="size-3.5 animate-spin" /> : <QrCode className="size-3.5" />}
            Create invite
          </button>
        </div>

        <div className="mt-5 border-t border-canvas-border pt-4">
          <label
            htmlFor="peer-accept-input"
            className="text-[11px] font-semibold uppercase tracking-wider text-canvas-muted-foreground"
          >
            Paste an invite link
          </label>
          <div className="mt-2 flex flex-col gap-2 sm:flex-row">
            <input
              id="peer-accept-input"
              type="text"
              value={acceptText}
              onChange={(e) => {
                setAcceptText(e.target.value);
                const parsed = parsePairInput(e.target.value);
                if (parsed?.code) setAcceptCode(parsed.code);
              }}
              placeholder="tether-academy://pair?i=…"
              spellCheck={false}
              autoComplete="off"
              className="flex-1 rounded-md border border-canvas-border bg-canvas-muted px-3 py-2 font-mono text-xs text-canvas-foreground placeholder:text-canvas-muted-foreground/60 focus:border-emerald-500/60 focus:outline-none"
            />
          </div>
          <label
            htmlFor="peer-accept-code"
            className="mt-3 block text-[11px] font-semibold uppercase tracking-wider text-canvas-muted-foreground"
          >
            Pairing code
          </label>
          <div className="mt-2 flex flex-col gap-2 sm:flex-row">
            <input
              id="peer-accept-code"
              type="text"
              value={acceptCode}
              onChange={(e) => setAcceptCode(e.target.value)}
              placeholder="A3F2-9C"
              spellCheck={false}
              autoComplete="off"
              className="flex-1 rounded-md border border-canvas-border bg-canvas-muted px-3 py-2 font-mono text-xs uppercase tracking-widest text-canvas-foreground placeholder:text-canvas-muted-foreground/60 focus:border-emerald-500/60 focus:outline-none"
            />
            <button
              type="button"
              onClick={onAccept}
              disabled={acceptBusy || !acceptText.trim() || !acceptCode.trim()}
              className="inline-flex items-center justify-center gap-1.5 rounded-md border border-canvas-border bg-canvas-muted px-3 py-2 text-sm font-semibold text-canvas-foreground transition-colors hover:border-emerald-500/40 disabled:opacity-50"
            >
              {acceptBusy ? <Loader2 className="size-3.5 animate-spin" /> : <Wifi className="size-3.5" />}
              Pair
            </button>
          </div>
          <p className="mt-2 text-[11px] text-canvas-muted-foreground/80">
            Code is required. Get it from the host via voice call or another channel. The link alone is not enough.
          </p>
        </div>
      </div>

      <div className="rounded-xl border border-canvas-border bg-canvas p-5 sm:p-6">
        <div className="flex items-baseline justify-between">
          <p className="text-[11px] font-semibold uppercase tracking-wider text-canvas-muted-foreground">
            Pending requests
          </p>
          <span className="text-xs text-canvas-muted-foreground">{pending.length}</span>
        </div>
        {pending.length === 0 ? (
          <p className="mt-2 text-sm text-canvas-muted-foreground">No pending requests.</p>
        ) : (
          <>
          <ul className="mt-3 max-h-[24rem] divide-y divide-canvas-border overflow-y-auto overflow-x-hidden rounded-lg border border-canvas-border bg-canvas-muted">
            {pending.map((p) => {
              const codeMatches =
                p.enteredPairingCode &&
                p.enteredPairingCode.toLowerCase().split('-').join('-') ===
                  p.expectedPairingCode.toLowerCase().split('-').join('-');
              return (
                <li
                  key={p.requestId}
                  className="flex flex-col gap-3 px-4 py-3 sm:px-5"
                >
                  <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
                    <div className="min-w-0 flex-1">
                      <p className="truncate text-sm text-canvas-foreground">
                        {pairUserDataLabel(p)}
                      </p>
                      <p
                        className="mt-0.5 truncate font-mono text-[11px] text-canvas-muted-foreground"
                        title={p.discoveryKey}
                      >
                        {shortHex(p.discoveryKey, 10, 6)} · {formatRelativeTime(p.receivedAt, now)}
                      </p>
                    </div>
                    <div className="flex shrink-0 items-center gap-2">
                      <button
                        type="button"
                        onClick={() => onReject(p.requestId)}
                        disabled={actionBusy === p.requestId}
                        className="rounded border border-canvas-border bg-canvas px-2.5 py-1 text-xs text-canvas-muted-foreground transition-colors hover:border-red-500/40 hover:text-red-400 disabled:opacity-50"
                      >
                        {actionBusy === p.requestId ? (
                          <Loader2 className="size-3 animate-spin" />
                        ) : (
                          'Reject'
                        )}
                      </button>
                      <button
                        type="button"
                        onClick={() => onApprove(p.requestId)}
                        disabled={actionBusy === p.requestId || !codeMatches}
                        className="inline-flex items-center gap-1 rounded bg-emerald-500 px-2.5 py-1 text-xs font-semibold text-canvas transition-colors hover:bg-emerald-400 disabled:opacity-50"
                      >
                        {actionBusy === p.requestId ? (
                          <Loader2 className="size-3 animate-spin" />
                        ) : (
                          'Approve'
                        )}
                      </button>
                    </div>
                  </div>
                  <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
                    <div>
                      <p className="text-[10px] font-semibold uppercase tracking-wider text-canvas-muted-foreground">
                        You told them
                      </p>
                      <p className="mt-0.5 font-mono text-xs text-canvas-foreground">
                        {p.expectedPairingCode}
                      </p>
                    </div>
                    <div>
                      <p className="text-[10px] font-semibold uppercase tracking-wider text-canvas-muted-foreground">
                        They entered
                      </p>
                      <p
                        className={
                          codeMatches
                            ? 'mt-0.5 inline-flex items-center gap-1 font-mono text-xs text-emerald-400'
                            : 'mt-0.5 inline-flex items-center gap-1 font-mono text-xs text-red-400'
                        }
                      >
                        {codeMatches ? (
                          <ShieldCheck className="size-3" />
                        ) : (
                          <ShieldAlert className="size-3" />
                        )}
                        {p.enteredPairingCode ?? 'no code'}
                      </p>
                    </div>
                  </div>
                </li>
              );
            })}
          </ul>
          {pending.length > 4 ? (
            <p className="mt-2 text-[11px] text-canvas-muted-foreground/70">
              {pending.length} pending · scroll to see the rest
            </p>
          ) : null}
          </>
        )}
      </div>

      <div className="rounded-xl border border-canvas-border bg-canvas p-5 sm:p-6">
        <div className="flex items-baseline justify-between">
          <p className="text-[11px] font-semibold uppercase tracking-wider text-canvas-muted-foreground">
            Paired devices
          </p>
          <span className="text-xs text-canvas-muted-foreground">{peers.length}</span>
        </div>
        {peers.length === 0 ? (
          <p className="mt-2 text-sm text-canvas-muted-foreground">
            No devices paired yet. Create or paste an invite to start.
          </p>
        ) : (
          <ul className="mt-3 divide-y divide-canvas-border overflow-hidden rounded-lg border border-canvas-border bg-canvas-muted">
            {peers.map((p) => (
              <li
                key={p.discoveryKey}
                className="flex flex-col gap-2 px-4 py-3 sm:flex-row sm:items-center sm:justify-between sm:px-5"
              >
                <div className="min-w-0 flex-1">
                  <p className="truncate text-sm text-canvas-foreground">
                    {pairUserDataLabel(p)}
                    <span className="ml-2 text-xs text-canvas-muted-foreground">({p.role})</span>
                  </p>
                  <p
                    className="mt-0.5 truncate font-mono text-[11px] text-canvas-muted-foreground"
                    title={p.discoveryKey}
                  >
                    {shortHex(p.discoveryKey, 10, 6)} · paired {formatRelativeTime(p.pairedAt, now)}
                  </p>
                </div>
                <button
                  type="button"
                  onClick={() => onDrop(p.discoveryKey)}
                  disabled={actionBusy === p.discoveryKey}
                  className="inline-flex shrink-0 items-center gap-1 rounded border border-canvas-border bg-canvas px-2.5 py-1 text-xs text-canvas-muted-foreground transition-colors hover:border-red-500/40 hover:text-red-400 disabled:opacity-50"
                >
                  {actionBusy === p.discoveryKey ? (
                    <Loader2 className="size-3 animate-spin" />
                  ) : (
                    'Drop'
                  )}
                </button>
              </li>
            ))}
          </ul>
        )}
      </div>

      <div className="rounded-xl border border-canvas-border bg-canvas p-5 sm:p-6">
        <div className="flex items-start justify-between gap-3">
          <div>
            <p className="text-[11px] font-semibold uppercase tracking-wider text-canvas-muted-foreground">
              Lockdown
            </p>
            <p className="mt-1 text-sm text-canvas-muted-foreground">
              Drop every active pair and reject every pending request. You can re-pair afterwards.
            </p>
          </div>
          {lockdownConfirm ? (
            <div className="flex flex-col items-end gap-1">
              <div className="flex items-center gap-2">
                <button
                  type="button"
                  onClick={() => setLockdownConfirm(false)}
                  className="rounded px-2 py-1 text-xs text-canvas-muted-foreground hover:text-canvas-foreground"
                >
                  Cancel
                </button>
                <button
                  type="button"
                  onClick={onLockdown}
                  disabled={actionBusy === 'lockdown'}
                  className="inline-flex items-center gap-1 rounded bg-red-500 px-2.5 py-1 text-xs font-semibold text-canvas transition-colors hover:bg-red-400 disabled:opacity-50"
                >
                  {actionBusy === 'lockdown' ? (
                    <Loader2 className="size-3 animate-spin" />
                  ) : (
                    <ShieldAlert className="size-3" />
                  )}
                  Drop everything
                </button>
              </div>
              <p className="text-right text-[10px] text-canvas-muted-foreground/80">
                Disconnects all peers immediately.
              </p>
            </div>
          ) : (
            <button
              type="button"
              onClick={() => setLockdownConfirm(true)}
              className="inline-flex shrink-0 items-center gap-1.5 rounded-md border border-red-500/40 bg-red-500/10 px-3 py-1.5 text-sm font-semibold text-red-400 transition-colors hover:bg-red-500/20"
            >
              <Lock className="size-3.5" />
              Lockdown
            </button>
          )}
        </div>
      </div>

      <div className="rounded-xl border border-canvas-border bg-canvas p-5 sm:p-6">
        <p className="text-[11px] font-semibold uppercase tracking-wider text-canvas-muted-foreground">
          Activity
        </p>
        {audit.length === 0 ? (
          <p className="mt-2 text-sm text-canvas-muted-foreground">No activity yet.</p>
        ) : (
          <ul className="mt-3 h-48 space-y-1 overflow-y-auto rounded-lg border border-canvas-border bg-canvas-muted p-3 font-mono text-[11px] text-canvas-muted-foreground">
            {audit.map((entry, idx) => (
              <li key={`${entry.timestamp}-${idx}`} className="flex gap-2">
                <span className="shrink-0 text-canvas-muted-foreground/60">
                  {new Date(entry.timestamp).toLocaleTimeString()}
                </span>
                <span className="text-canvas-foreground">{auditLabel(entry)}</span>
              </li>
            ))}
          </ul>
        )}
      </div>

      {inviteModal ? (
        <InviteModal
          invite={inviteModal.invite}
          qrDataUrl={inviteModal.qrDataUrl}
          copied={copied}
          onCopy={onCopy}
          onClose={() => setInviteModal(null)}
        />
      ) : null}
    </div>
  );
}

function InviteModal({
  invite,
  qrDataUrl,
  copied,
  onCopy,
  onClose,
}: {
  invite: AcademyPeerInvite;
  qrDataUrl: string;
  copied: string | null;
  onCopy: (text: string, key: string) => void;
  onClose: () => void;
}) {
  const url = pairUrl(invite.invite, invite.pairingCode);
  return (
    <div
      role="dialog"
      aria-modal="true"
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4"
      onClick={onClose}
    >
      <div
        className="w-full max-w-md overflow-y-auto rounded-xl border border-canvas-border bg-canvas p-6 shadow-2xl"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="mb-4 flex items-start justify-between">
          <div>
            <p className="text-[11px] font-semibold uppercase tracking-wider text-emerald-400">
              Pair a device
            </p>
            <h2 className="mt-1 text-lg font-semibold text-canvas-foreground">Share these with the other person</h2>
          </div>
          <button
            type="button"
            onClick={onClose}
            aria-label="Close"
            className="rounded p-1 text-canvas-muted-foreground transition-colors hover:bg-canvas-muted hover:text-canvas-foreground"
          >
            <X className="size-4" />
          </button>
        </div>
        <div className="flex justify-center rounded-lg border border-canvas-border bg-canvas-muted p-4">
          <img src={qrDataUrl} alt="Pair invite QR code" className="h-56 w-56" />
        </div>
        <div className="mt-4 space-y-4">
          <PairingCodeDisplay code={invite.pairingCode} label="Pairing code (read aloud or share separately)" />
          <p className="text-[11px] text-canvas-muted-foreground/80">
            Both the link and the code are required. Anyone with just the link cannot pair.
          </p>
        </div>
        <div className="mt-4 flex flex-col gap-2">
          <button
            type="button"
            onClick={() => onCopy(url, 'url')}
            className="inline-flex items-center justify-center gap-1.5 rounded-md border border-canvas-border bg-canvas-muted px-3 py-2 text-xs text-canvas-foreground transition-colors hover:border-emerald-500/40"
          >
            {copied === 'url' ? (
              <>
                <Check className="size-3 text-emerald-400" /> Copied link
              </>
            ) : (
              <>
                <Copy className="size-3" /> Copy invite link
              </>
            )}
          </button>
          <button
            type="button"
            onClick={() => onCopy(invite.pairingCode, 'code')}
            className="inline-flex items-center justify-center gap-1.5 rounded-md border border-canvas-border bg-canvas-muted px-3 py-2 text-xs text-canvas-foreground transition-colors hover:border-emerald-500/40"
          >
            {copied === 'code' ? (
              <>
                <Check className="size-3 text-emerald-400" /> Copied code
              </>
            ) : (
              <>
                <Copy className="size-3" /> Copy pairing code
              </>
            )}
          </button>
        </div>
        <p className="mt-4 break-all text-center font-mono text-[10px] text-canvas-muted-foreground/70">
          {url}
        </p>
      </div>
    </div>
  );
}
