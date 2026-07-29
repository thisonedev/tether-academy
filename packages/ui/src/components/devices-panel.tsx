'use client';

import type {
  AcademyAPI,
  AcademyPeerAuditEntry,
  AcademyPeerIdentity,
  AcademyPeerInfo,
  AcademyPeerInvite,
  AcademyPeerPending,
} from '@academy/academy-bridge';
import { Check, Copy, Eraser, Loader2, Lock, QrCode, ShieldAlert, ShieldCheck, Wifi, X } from 'lucide-react';
import { useCallback, useEffect, useMemo, useState } from 'react';

declare global {
  interface Window {
    academy?: AcademyAPI;
  }
}

export function shortHex(hex: string, head = 8, tail = 6): string {
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

function parsePairInput(input: string): {
  invite: string;
  code: string | null;
  hostIdentity: string | null;
} | null {
  const trimmed = input.trim();
  if (!trimmed) return null;
  if (trimmed.startsWith('tether-academy://')) {
    try {
      const url = new URL(trimmed);
      const invite = url.searchParams.get('i');
      if (!invite) return null;
      return { invite, code: url.searchParams.get('c'), hostIdentity: url.searchParams.get('h') };
    } catch {
      return null;
    }
  }
  if (trimmed.includes('?i=')) {
    const invite = trimmed.split('?i=')[1]?.split('&')[0];
    if (!invite) return null;
    const code = trimmed.includes('&c=') ? trimmed.split('&c=')[1]?.split('&')[0] ?? null : null;
    const hostIdentity = trimmed.includes('&h=') ? trimmed.split('&h=')[1]?.split('&')[0] ?? null : null;
    return {
      invite: decodeURIComponent(invite),
      code: code ? decodeURIComponent(code) : null,
      hostIdentity: hostIdentity ? decodeURIComponent(hostIdentity) : null,
    };
  }
  return { invite: trimmed, code: null, hostIdentity: null };
}

function pairUrl(invite: string, code: string, hostIdentity: string | null): string {
  const base = `tether-academy://pair?i=${encodeURIComponent(invite)}&c=${encodeURIComponent(code)}`;
  return hostIdentity ? `${base}&h=${encodeURIComponent(hostIdentity)}` : base;
}

export function pairUserDataLabel(info: { userData: unknown }): string {
  const data = info.userData;
  if (data && typeof data === 'object' && 'name' in data && typeof data.name === 'string') {
    return data.name;
  }
  if (data && typeof data === 'object' && 'hostname' in data && typeof data.hostname === 'string') {
    return String(data.hostname);
  }
  return 'Unknown device';
}

export function formatRelativeTime(ts: number, now: number): string {
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

export function formatClockTime(ts: number): string {
  const d = new Date(ts);
  const hours24 = d.getHours();
  const minutes = d.getMinutes();
  const ampm = hours24 >= 12 ? 'pm' : 'am';
  const hours12 = hours24 % 12 === 0 ? 12 : hours24 % 12;
  return `${hours12}:${minutes.toString().padStart(2, '0')} ${ampm}`;
}

function formatExecSample(entry: AcademyPeerAuditEntry): string | null {
  if (entry.mode === 'inline') return 'inline snippet';
  if (entry.fileName) return entry.fileName;
  return null;
}

function auditLabel(entry: AcademyPeerAuditEntry, peerName?: string | null): string {
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
    case 'peer:exec:started': {
      const sample = formatExecSample(entry);
      const tail = sample ? ` · ${sample}` : '';
      return `Exec started on this device${tail}`;
    }
    case 'peer:exec:finished': {
      const sample = formatExecSample(entry);
      const tail = sample ? ` · ${sample}` : '';
      return `Exec finished on this device · code ${entry.code ?? '?'}${entry.signal ? `, ${entry.signal}` : ''}${tail}`;
    }
    case 'peer:exec:error': {
      const sample = formatExecSample(entry);
      const tail = sample ? ` · ${sample}` : '';
      return `Exec error on this device: ${entry.message ?? 'unknown'}${tail}`;
    }
    case 'peer:exec:remote-started': {
      const sample = formatExecSample(entry);
      const tail = sample ? ` · ${sample}` : '';
      const who = peerName ? ` on ${peerName}` : ' on paired device';
      return `Exec started${who}${tail}`;
    }
    case 'peer:exec:remote-finished': {
      const sample = formatExecSample(entry);
      const tail = sample ? ` · ${sample}` : '';
      const who = peerName ? ` on ${peerName}` : ' on paired device';
      return `Exec finished${who} · code ${entry.code ?? '?'}${entry.signal ? `, ${entry.signal}` : ''}${tail}`;
    }
    case 'peer:exec:remote-error': {
      const sample = formatExecSample(entry);
      const tail = sample ? ` · ${sample}` : '';
      const who = peerName ? ` on ${peerName}` : ' on paired device';
      return `Exec error${who}: ${entry.message ?? 'unknown'}${tail}`;
    }
    case 'peer:pair:sent':
      return 'Pair request sent, waiting for approval';
    case 'peer:pair:error':
      return `Pair failed: ${entry.message ?? 'unknown'}`;
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
  const [error, setError] = useState<string | null>(null);
  const [deeplinkToast, setDeeplinkToast] = useState<{ invite: string; code: string | null } | null>(null);

  const [inviteBusy, setInviteBusy] = useState(false);
  const [inviteModal, setInviteModal] = useState<{
    invite: AcademyPeerInvite;
    qrDataUrl: string;
    hostIdentity: string | null;
  } | null>(null);
  const [acceptBusy, setAcceptBusy] = useState(false);
  const [acceptText, setAcceptText] = useState('');
  const [acceptCode, setAcceptCode] = useState('');
  const [lockdownBusy, setLockdownBusy] = useState(false);
  const [lockdownConfirm, setLockdownConfirm] = useState(false);
  const [copied, setCopied] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    if (!window.academy?.peer) return;
    const id = await window.academy.peer.identity().catch(() => null);
    setIdentity(id);
  }, []);

  const [pairedPeers, setPairedPeers] = useState<AcademyPeerInfo[]>([]);
  const [pairedPeersLoaded, setPairedPeersLoaded] = useState(false);

  const refreshPeers = useCallback(async () => {
    if (!window.academy?.peer) return;
    const list = await window.academy.peer.list().catch(() => []);
    if (Array.isArray(list)) {
      setPairedPeers(list);
      setPairedPeersLoaded(true);
    }
  }, []);

  useEffect(() => {
    if (!window.academy?.peer) {
      setError('Peer layer unavailable in this build.');
      return;
    }
    refresh();
    refreshPeers();
    const off = window.academy.peer.onEvent((msg) => {
      if (msg.event === 'peer:deeplink') {
        const payload = msg.payload as unknown as {
          invite: string;
          pairingCode: string | null;
          hostIdentity: string | null;
        };
        setDeeplinkToast({ invite: payload.invite, code: payload.pairingCode });
        const url = pairUrl(
          payload.invite,
          payload.pairingCode ?? '',
          payload.hostIdentity ?? null,
        );
        setAcceptText(url);
        if (payload.pairingCode) setAcceptCode(payload.pairingCode);
        setTimeout(() => setDeeplinkToast(null), 8000);
      }
      if (msg.event === 'peer:paired') {
        setInviteModal(null);
        void refreshPeers();
      }
      if (msg.event === 'peer:dropped') {
        setInviteModal(null);
        setAcceptText('');
        setAcceptCode('');
        void refreshPeers();
      }
    });
    return () => {
      off();
    };
  }, [refresh, refreshPeers]);

  const onCreateInvite = useCallback(async () => {
    if (!window.academy?.peer) return;
    setInviteBusy(true);
    setError(null);
    try {
      const [invite, identityInfo] = await Promise.all([
        window.academy.peer.invite(),
        window.academy.peer.identity(),
      ]);
      const hostIdentity = identityInfo?.publicKey ?? null;
      const qrDataUrl = await window.academy.qr(
        pairUrl(invite.invite, invite.pairingCode, hostIdentity),
      );
      setInviteModal({ invite, qrDataUrl, hostIdentity });
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
        userData: { source: 'settings-panel' },
        code: acceptCode.trim() || parsed.code || undefined,
        hostIdentity: parsed.hostIdentity || undefined,
      });
      setAcceptText('');
      setAcceptCode('');
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Pair failed');
    } finally {
      setAcceptBusy(false);
    }
  }, [acceptText, acceptCode]);

  const onLockdown = useCallback(async () => {
    if (!window.academy?.peer) return;
    setLockdownConfirm(false);
    setLockdownBusy(true);
    try {
      await window.academy.peer.lockdown();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Lockdown failed');
    } finally {
      setLockdownBusy(false);
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
          <div className="min-w-0 flex-1">
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
            <ThisDeviceRoleSummary peers={pairedPeers} loaded={pairedPeersLoaded} />
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
              {acceptBusy ? 'Pairing…' : 'Pair'}
            </button>
          </div>
          <p className="mt-2 text-[11px] text-canvas-muted-foreground/80">
            {acceptBusy
              ? 'Waiting for the other device to approve. Open Settings > Devices on the other side, then click Approve.'
              : 'Code is required. Get it from the host via voice call or another channel. The link alone is not enough.'}
          </p>
        </div>
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
                  disabled={lockdownBusy}
                  className="inline-flex items-center gap-1 rounded bg-red-500 px-2.5 py-1 text-xs font-semibold text-canvas transition-colors hover:bg-red-400 disabled:opacity-50"
                >
                  {lockdownBusy ? (
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

      {inviteModal ? (
        <InviteModal
          invite={inviteModal.invite}
          qrDataUrl={inviteModal.qrDataUrl}
          hostIdentity={inviteModal.hostIdentity}
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
  hostIdentity,
  copied,
  onCopy,
  onClose,
}: {
  invite: AcademyPeerInvite;
  qrDataUrl: string;
  hostIdentity: string | null;
  copied: string | null;
  onCopy: (text: string, key: string) => void;
  onClose: () => void;
}) {
  const url = pairUrl(invite.invite, invite.pairingCode, hostIdentity);
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

const ACTIVITY_LIMIT = 100;

export function ActivitySection() {
  const [audit, setAudit] = useState<AcademyPeerAuditEntry[]>([]);
  const [peerNames, setPeerNames] = useState<Record<string, string>>({});

  useEffect(() => {
    if (!window.academy?.peer) return;
    let cancelled = false;
    const refresh = async () => {
      const [au, peers] = await Promise.all([
        window.academy?.peer?.audit({ limit: ACTIVITY_LIMIT }).catch(() => []) ?? [],
        window.academy?.peer?.list().catch(() => []) ?? [],
      ]);
      if (cancelled) return;
      setAudit(au.slice().reverse());
      const map: Record<string, string> = {};
      for (const p of peers) {
        if (p.discoveryKey) map[p.discoveryKey] = pairUserDataLabel(p);
      }
      setPeerNames(map);
    };
    refresh();
    const off = window.academy.peer.onEvent((msg) => {
      if (msg.event === 'peer:audit') {
        const entry = msg.payload as AcademyPeerAuditEntry;
        setAudit((prev) => [entry, ...prev].slice(0, ACTIVITY_LIMIT));
      }
      if (msg.event === 'peer:audit-cleared') {
        setAudit([]);
      }
      if (msg.event === 'peer:paired' || msg.event === 'peer:dropped') {
        refresh();
      }
    });
    return () => {
      cancelled = true;
      off();
    };
  }, []);

  return (
    <div className="flex flex-col rounded-xl border border-canvas-border bg-canvas p-5 sm:p-6">
      <div className="flex items-center justify-between">
        <p className="text-[11px] font-semibold uppercase tracking-wider text-canvas-muted-foreground">
          Activity
        </p>
        {audit.length > 0 ? (
          <button
            type="button"
            onClick={() => window.academy?.peer?.clearAudit?.()}
            title="Clear activity log"
            aria-label="Clear activity log"
            className="inline-flex shrink-0 items-center gap-1 rounded border border-canvas-border bg-canvas-muted p-1.5 text-canvas-muted-foreground transition-colors hover:border-canvas-foreground/40 hover:text-canvas-foreground"
          >
            <Eraser className="size-3" />
          </button>
        ) : null}
      </div>
      {audit.length === 0 ? (
        <p className="mt-3 text-sm text-canvas-muted-foreground">No activity yet.</p>
      ) : (
        <ul className="mt-3 max-h-40 space-y-1 overflow-y-auto rounded-lg border border-canvas-border bg-canvas-muted p-3 font-mono text-[11px] text-canvas-muted-foreground">
          {audit.map((entry, idx) => (
            <li key={`${entry.timestamp}-${idx}`} className="flex flex-wrap items-baseline gap-2">
              <span className="shrink-0 text-canvas-muted-foreground/60">
                {formatClockTime(entry.timestamp)}
              </span>
              <span className="text-canvas-foreground">
                {auditLabel(entry, entry.discoveryKey ? peerNames[entry.discoveryKey] : null)}
              </span>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

export function PendingRequestsSection() {
  const [pending, setPending] = useState<AcademyPeerPending[]>([]);
  const [actionBusy, setActionBusy] = useState<string | null>(null);
  const [now, setNow] = useState<number>(() => Date.now());

  const refresh = useCallback(async () => {
    const pn = (await window.academy?.peer?.pending?.().catch(() => [])) ?? [];
    if (Array.isArray(pn)) setPending(pn);
  }, []);

  useEffect(() => {
    if (!window.academy?.peer) return;
    let cancelled = false;
    refresh();
    const off = window.academy.peer.onEvent(() => {
      if (cancelled) return;
      refresh();
    });
    const tick = setInterval(() => setNow(Date.now()), 30_000);
    return () => {
      cancelled = true;
      off();
      clearInterval(tick);
    };
  }, [refresh]);

  const onApprove = useCallback(
    async (requestId: string) => {
      if (!window.academy?.peer) return;
      setActionBusy(requestId);
      try {
        const ok = await window.academy.peer.approve(requestId);
        if (ok) {
          setPending((prev) => prev.filter((p) => p.requestId !== requestId));
        } else {
          await refresh();
        }
      } catch {
        // approval errors are surfaced via audit; nothing to do here
      } finally {
        setActionBusy(null);
      }
    },
    [refresh],
  );

  const onReject = useCallback(async (requestId: string) => {
    if (!window.academy?.peer) return;
    setActionBusy(requestId);
    try {
      await window.academy.peer.reject(requestId);
    } catch {
      // surface via audit
    } finally {
      setActionBusy(null);
    }
  }, []);

  return (
    <div className="flex flex-col rounded-xl border border-canvas-border bg-canvas p-5 sm:p-6">
      <div className="flex items-baseline justify-between">
        <p className="text-[11px] font-semibold uppercase tracking-wider text-canvas-muted-foreground">
          Pending requests
        </p>
        <span className="text-xs text-canvas-muted-foreground">{pending.length}</span>
      </div>
      {pending.length === 0 ? (
        <p className="mt-3 text-sm text-canvas-muted-foreground">No pending requests.</p>
      ) : (
        <ul className="mt-3 max-h-40 divide-y divide-canvas-border overflow-y-auto overflow-x-hidden rounded-lg border border-canvas-border bg-canvas-muted">
          {pending.map((p) => {
            const codeMatches =
              p.enteredPairingCode &&
              p.enteredPairingCode.toLowerCase().split('-').join('-') ===
                p.expectedPairingCode.toLowerCase().split('-').join('-');
            return (
              <li key={p.requestId} className="flex flex-col gap-2 px-4 py-3">
                <div className="flex items-start justify-between gap-2">
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
                  <div className="flex shrink-0 items-center gap-1">
                    <button
                      type="button"
                      onClick={() => onReject(p.requestId)}
                      disabled={actionBusy === p.requestId}
                      className="rounded border border-canvas-border bg-canvas px-2 py-1 text-[11px] text-canvas-muted-foreground transition-colors hover:border-red-500/40 hover:text-red-400 disabled:opacity-50"
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
                      className="inline-flex items-center gap-1 rounded bg-emerald-500 px-2 py-1 text-[11px] font-semibold text-canvas transition-colors hover:bg-emerald-400 disabled:opacity-50"
                    >
                      {actionBusy === p.requestId ? (
                        <Loader2 className="size-3 animate-spin" />
                      ) : (
                        'Approve'
                      )}
                    </button>
                  </div>
                </div>
                <div className="flex items-center gap-3 text-[10px] text-canvas-muted-foreground">
                  <span className="font-mono">{p.expectedPairingCode}</span>
                  <span
                    className={
                      codeMatches
                        ? 'inline-flex items-center gap-1 font-mono text-emerald-400'
                        : 'inline-flex items-center gap-1 font-mono text-red-400'
                    }
                  >
                    {codeMatches ? (
                      <ShieldCheck className="size-3" />
                    ) : (
                      <ShieldAlert className="size-3" />
                    )}
                    {p.enteredPairingCode ?? 'no code'}
                  </span>
                </div>
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}

export function PairedDevicesSection() {
  const [peers, setPeers] = useState<AcademyPeerInfo[]>([]);
  const [actionBusy, setActionBusy] = useState<string | null>(null);
  const [now, setNow] = useState<number>(() => Date.now());

  const refresh = useCallback(async () => {
    const p = (await window.academy?.peer?.list?.().catch(() => [])) ?? [];
    if (Array.isArray(p)) setPeers(p);
  }, []);

  useEffect(() => {
    if (!window.academy?.peer) return;
    let cancelled = false;
    refresh();
    const off = window.academy.peer.onEvent(() => {
      if (cancelled) return;
      refresh();
    });
    const tick = setInterval(() => setNow(Date.now()), 30_000);
    return () => {
      cancelled = true;
      off();
      clearInterval(tick);
    };
  }, [refresh]);

  const onDrop = useCallback(
    async (discoveryKey: string) => {
      if (!window.academy?.peer) return;
      setActionBusy(discoveryKey);
      try {
        await window.academy.peer.drop(discoveryKey);
        await refresh();
      } catch {
        // surfaced via audit
      } finally {
        setActionBusy(null);
      }
    },
    [refresh],
  );

  return (
    <div className="flex flex-col rounded-xl border border-canvas-border bg-canvas p-5 sm:p-6">
      <div className="flex items-baseline justify-between">
        <p className="text-[11px] font-semibold uppercase tracking-wider text-canvas-muted-foreground">
          Paired devices
        </p>
        <span className="text-xs text-canvas-muted-foreground">{peers.length}</span>
      </div>
      {peers.length === 0 ? (
        <p className="mt-3 text-sm text-canvas-muted-foreground">
          No devices paired yet. Create or paste an invite to start.
        </p>
      ) : (
        <ul className="mt-3 max-h-40 divide-y divide-canvas-border overflow-y-auto rounded-lg border border-canvas-border bg-canvas-muted">
          {peers.map((p) => (
            <li
              key={p.discoveryKey}
              className="flex items-center justify-between gap-2 px-4 py-3"
            >
              <div className="min-w-0 flex-1">
                <div className="flex items-center gap-2">
                  <p className="truncate text-sm text-canvas-foreground">
                    {pairUserDataLabel(p)}
                  </p>
                  <RoleBadge role={p.role} />
                </div>
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
                className="inline-flex shrink-0 items-center gap-1 rounded border border-canvas-border bg-canvas px-2 py-1 text-[11px] text-canvas-muted-foreground transition-colors hover:border-red-500/40 hover:text-red-400 disabled:opacity-50"
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
  );
}

function RoleBadge({ role }: { role: 'host' | 'guest' }) {
  if (role === 'host') {
    return (
      <span
        title="This device runs the code; the other side is the guest."
        className="inline-flex shrink-0 items-center gap-1 rounded-md bg-emerald-500/15 px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wider text-emerald-400 ring-1 ring-emerald-500/30"
      >
        host
      </span>
    );
  }
  return (
    <span
      title="This device is the guest; the other side runs the code."
      className="inline-flex shrink-0 items-center gap-1 rounded-md bg-sky-500/15 px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wider text-sky-400 ring-1 ring-sky-500/30"
    >
      guest
    </span>
  );
}

function ThisDeviceRoleSummary({
  peers,
  loaded,
}: {
  peers: AcademyPeerInfo[];
  loaded: boolean;
}) {
  if (!loaded) return null;
  if (peers.length === 0) {
    return (
      <p className="mt-2 text-[11px] text-canvas-muted-foreground/80">
        No active pairings.
      </p>
    );
  }
  const hostCount = peers.filter((p) => p.role === 'host').length;
  const guestCount = peers.filter((p) => p.role === 'guest').length;
  return (
    <div className="mt-2 flex flex-wrap items-center gap-1.5">
      <span className="text-[10px] font-medium uppercase tracking-wider text-canvas-muted-foreground/80">
        Acting as
      </span>
      {hostCount > 0 ? <RoleChip role="host" count={hostCount} /> : null}
      {guestCount > 0 ? <RoleChip role="guest" count={guestCount} /> : null}
    </div>
  );
}

function RoleChip({ role, count }: { role: 'host' | 'guest'; count: number }) {
  const label = role === 'host' ? 'host' : 'guest';
  const base =
    role === 'host'
      ? 'bg-emerald-500/15 text-emerald-400 ring-emerald-500/30'
      : 'bg-sky-500/15 text-sky-400 ring-sky-500/30';
  return (
    <span
      className={`inline-flex items-center gap-1 rounded-md px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wider ring-1 ${base}`}
    >
      {label}
      {count > 1 ? <span className="opacity-70">× {count}</span> : null}
    </span>
  );
}

const EXEC_EVENT_TYPES = new Set<AcademyPeerAuditEntry['type']>([
  'peer:exec:started',
  'peer:exec:finished',
  'peer:exec:error',
  'peer:exec:remote-started',
  'peer:exec:remote-finished',
  'peer:exec:remote-error',
]);

function execEventLabel(
  entry: AcademyPeerAuditEntry,
  peerRole: 'host' | 'guest',
  peerName?: string | null,
): { text: string; tone: 'running' | 'ok' | 'err' | 'info' } {
  const sample = formatExecSample(entry);
  const sampleTail = sample ? ` · ${sample}` : '';
  const onPeer = peerRole === 'guest' && peerName ? ` on ${peerName}` : '';
  switch (entry.type) {
    case 'peer:exec:started':
    case 'peer:exec:remote-started':
      return { text: `Run started${onPeer}${sampleTail}`, tone: 'running' };
    case 'peer:exec:finished':
    case 'peer:exec:remote-finished': {
      const code = entry.code;
      const signal = entry.signal;
      const base =
        code === 0
          ? `Run finished${onPeer} · exit 0`
          : code != null
            ? `Run failed${onPeer} · exit ${code}`
            : signal
              ? `Run stopped${onPeer} · ${signal}`
              : `Run finished${onPeer}`;
      return { text: `${base}${sampleTail}`, tone: code === 0 ? 'ok' : 'err' };
    }
    case 'peer:exec:error':
    case 'peer:exec:remote-error':
      return {
        text: `Run error${onPeer}${entry.message ? `: ${entry.message}` : ''}${sampleTail}`,
        tone: 'err',
      };
    default:
      return { text: entry.type, tone: 'info' };
  }
}

function execEventToneClass(tone: 'running' | 'ok' | 'err' | 'info'): string {
  switch (tone) {
    case 'running':
      return 'text-sky-400';
    case 'ok':
      return 'text-emerald-400';
    case 'err':
      return 'text-red-400';
    default:
      return 'text-canvas-muted-foreground';
  }
}

function formatRunDuration(startTs: number, endTs: number): string {
  const sec = Math.max(0, Math.round((endTs - startTs) / 1000));
  if (sec < 60) return `${sec}s`;
  const min = Math.floor(sec / 60);
  const rest = sec % 60;
  return `${min}m ${rest}s`;
}

type ExecRunRow = {
  key: string;
  label: string;
  tone: 'running' | 'ok' | 'err' | 'info';
  ts: number;
  duration: string | null;
};

function useExecRunRows(peer: AcademyPeerInfo, audit: AcademyPeerAuditEntry[]): ExecRunRow[] {
  const events = useMemo(() => {
    const list = audit.filter(
      (e) => e.discoveryKey === peer.discoveryKey && EXEC_EVENT_TYPES.has(e.type),
    );
    list.sort((a, b) => a.timestamp - b.timestamp);
    return list;
  }, [audit, peer.discoveryKey]);

  const peerName = pairUserDataLabel(peer);

  return useMemo(() => {
    const result: ExecRunRow[] = [];
    const openStartByRun = new Map<string, number>();
    let runIndex = 0;
    for (const e of events) {
      const isStarted = e.type === 'peer:exec:started' || e.type === 'peer:exec:remote-started';
      const isFinished = e.type === 'peer:exec:finished' || e.type === 'peer:exec:remote-finished';
      const isError = e.type === 'peer:exec:error' || e.type === 'peer:exec:remote-error';
      if (isStarted) {
        openStartByRun.set(`run-${runIndex}`, e.timestamp);
        const { text, tone } = execEventLabel(e, peer.role, peerName);
        result.push({ key: `start-${e.timestamp}-${runIndex}`, label: text, tone, ts: e.timestamp, duration: null });
        runIndex += 1;
        continue;
      }
      if (isFinished || isError) {
        const startKey = Array.from(openStartByRun.keys()).pop();
        const startTs = startKey ? openStartByRun.get(startKey) : undefined;
        if (startKey && startTs != null) openStartByRun.delete(startKey);
        const { text, tone } = execEventLabel(e, peer.role, peerName);
        result.push({
          key: `end-${e.timestamp}-${runIndex}`,
          label: text,
          tone,
          ts: e.timestamp,
          duration: startTs != null ? formatRunDuration(startTs, e.timestamp) : null,
        });
        continue;
      }
    }
    for (const [key, startTs] of openStartByRun) {
      result.push({
        key: `unfinished-${key}-${startTs}`,
        label: 'Run started · no completion recorded',
        tone: 'err',
        ts: startTs,
        duration: null,
      });
    }
    return result.reverse();
  }, [events, peer.role, peerName]);
}

export function ExecRunList({
  rows,
  emptyHint,
}: {
  rows: ExecRunRow[];
  emptyHint?: string;
}) {
  if (rows.length === 0) {
    return (
      <p className="text-xs text-canvas-muted-foreground">
        {emptyHint ?? 'No code runs on this pair yet.'}
      </p>
    );
  }
  return (
    <ul className="max-h-40 space-y-1 overflow-y-auto rounded-lg border border-canvas-border bg-canvas-muted p-3 font-mono text-[11px] text-canvas-muted-foreground">
      {rows.map((row) => (
        <li key={row.key} className="flex flex-wrap items-baseline gap-2">
          <span className="shrink-0 text-canvas-muted-foreground/60">
            {formatClockTime(row.ts)}
            {row.duration ? ` • ${row.duration}` : ''}
          </span>
          <span className={execEventToneClass(row.tone)}>{row.label}</span>
        </li>
      ))}
    </ul>
  );
}

export function PairedDeviceActivity({
  peer,
  audit,
  now,
}: {
  peer: AcademyPeerInfo;
  audit: AcademyPeerAuditEntry[];
  now: number;
}) {
  const rows = useExecRunRows(peer, audit);

  return (
    <div className="flex flex-col rounded-xl border border-canvas-border bg-canvas p-5 sm:p-6">
      <div className="flex items-center gap-2">
        <p className="truncate text-sm font-medium text-canvas-foreground">
          {pairUserDataLabel(peer)}
        </p>
        <RoleBadge role={peer.role} />
        <span className="ml-auto text-xs text-canvas-muted-foreground">
          {rows.length} {rows.length === 1 ? 'run' : 'runs'}
        </span>
      </div>
      <p
        className="mt-0.5 truncate font-mono text-[11px] text-canvas-muted-foreground"
        title={peer.discoveryKey}
      >
        {shortHex(peer.discoveryKey, 10, 6)} · paired {formatRelativeTime(peer.pairedAt, now)}
      </p>
      <div className="mt-3">
        <ExecRunList
          rows={rows}
          emptyHint="No code runs on this pair yet. Open a lesson, switch run mode to Paired device, and pick this one to send a run here."
        />
      </div>
    </div>
  );
}
