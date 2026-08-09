'use client';

import type {
  AcademyAPI,
  AcademyPeerAuditEntry,
  AcademyPeerDeviceRequest,
  AcademyPeerInfo,
  AcademyPeerPending,
} from '@academy/validation';
import { Loader2, ShieldAlert, ShieldCheck, X } from 'lucide-react';
import { useCallback, useEffect, useRef, useState } from 'react';
import { pairUserDataLabel, shortHex } from './devices-panel.js';

declare global {
  interface Window {
    academy?: AcademyAPI;
  }
}

/**
 * Everything arriving from another device, surfaced where the user already is.
 * Settings keeps the full lists; this is what should not wait to be found.
 *
 *   amber   a decision is blocked on a human (device access, pairing)
 *   neutral a run in progress, its status text carrying the activity colours
 */
export function NotificationCenter() {
  const deviceRequests = useDeviceRequests();
  const pairRequests = usePairRequests();
  const runs = useRunNotices();
  // Outgoing runs render inside the lesson workspace's output panel instead.
  const topRuns = runs.items.filter((run) => run.direction === 'incoming');

  if (
    deviceRequests.items.length === 0 &&
    pairRequests.items.length === 0 &&
    topRuns.length === 0
  ) {
    return null;
  }

  return (
    <div className="sticky top-0 z-50 flex flex-col">
      {deviceRequests.items.map((request) => (
        <DeviceConsentRow
          key={request.requestId}
          request={request}
          onAnswer={deviceRequests.answer}
        />
      ))}
      {pairRequests.items.map((request) => (
        <PairRequestRow
          key={request.requestId}
          request={request}
          busy={pairRequests.busy === request.requestId}
          onAnswer={pairRequests.answer}
        />
      ))}
      {topRuns.map((run) => (
        <RunRow key={run.id} run={run} onDismiss={runs.dismiss} />
      ))}
    </div>
  );
}

// --- device access -----------------------------------------------------------

function useDeviceRequests() {
  const [items, setItems] = useState<AcademyPeerDeviceRequest[]>([]);

  useEffect(() => {
    if (typeof window === 'undefined' || !window.academy?.peer) return;
    let cancelled = false;
    const refresh = async () => {
      try {
        const list = (await window.academy?.peer?.deviceRequests?.()) ?? [];
        if (!cancelled) setItems(list);
      } catch {
        // Keep request lookup failures silent; no prompt appears.
      }
    };
    refresh();
    const off = window.academy.peer.onEvent((msg) => {
      if (msg?.event?.startsWith('peer:exec:device-')) refresh();
    });
    return () => {
      cancelled = true;
      off();
    };
  }, []);

  const answer = useCallback(async (requestId: string, approved: boolean) => {
    setItems((prev) => prev.filter((r) => r.requestId !== requestId));
    try {
      await window.academy?.peer?.resolveDeviceRequest?.(requestId, approved);
    } catch {
      // the run's own timeout denies it if this never lands
    }
  }, []);

  return { items, answer };
}

/** "your microphone and the network", for the sentence and the button. */
function consentAsks(request: AcademyPeerDeviceRequest): string {
  const asks = request.devices.map((d) => `your ${d}`);
  if (request.network) asks.push('the network');
  if (asks.length < 2) return asks[0] ?? 'access';
  return `${asks.slice(0, -1).join(', ')} and ${asks[asks.length - 1]}`;
}

// Deny is the plain button; no answer times out as a denial on the host.
function DeviceConsentRow({
  request,
  onAnswer,
}: {
  request: AcademyPeerDeviceRequest;
  onAnswer: (requestId: string, approved: boolean) => void;
}) {
  const hasAccessAsk = request.devices.length > 0 || !!request.network;
  const asks = consentAsks(request);
  const what = request.label ? `"${request.label}"` : 'A run';
  return (
    <div className="flex flex-col gap-2 border-b border-amber-500/40 bg-amber-500/15 px-4 py-2.5 text-sm backdrop-blur">
      <div className="flex flex-wrap items-center gap-x-4 gap-y-2">
        <div className="min-w-0 flex-1 text-canvas-foreground">
          {hasAccessAsk ? (
            <>
              <span className="font-medium">{what}</span> wants to use{' '}
              <span className="font-medium">{asks}</span>
              {request.network ? <span className="text-canvas-muted-foreground"> ({request.network})</span> : null}.{' '}
            </>
          ) : (
            <span className="font-medium">{what}</span>
          )}
          {!hasAccessAsk && ' is waiting to run on this device. '}
          It stays blocked until you answer, and nothing is recorded or sent unless you allow it.
        </div>
        <div className="flex shrink-0 items-center gap-2">
          <button
            type="button"
            onClick={() => onAnswer(request.requestId, false)}
            className="rounded-md border border-canvas-border px-3 py-1 text-canvas-foreground hover:bg-canvas-muted"
          >
            Deny
          </button>
          <button
            type="button"
            onClick={() => onAnswer(request.requestId, true)}
            className="rounded-md bg-amber-500 px-3 py-1 font-medium text-black hover:bg-amber-400"
          >
            {hasAccessAsk ? `Allow ${asks}` : 'Allow'}
          </button>
        </div>
      </div>
      {request.sourcePreview ? (
        <details className="text-canvas-muted-foreground">
          <summary className="cursor-pointer select-none text-canvas-foreground hover:underline">
            View code
          </summary>
          <pre className="mt-1 max-h-64 overflow-auto rounded-md bg-canvas-muted p-2 text-xs text-canvas-foreground">
            {request.sourcePreview}
          </pre>
        </details>
      ) : null}
    </div>
  );
}

// --- pairing -----------------------------------------------------------------

function usePairRequests() {
  const [items, setItems] = useState<AcademyPeerPending[]>([]);
  const [busy, setBusy] = useState<string | null>(null);

  useEffect(() => {
    if (typeof window === 'undefined' || !window.academy?.peer) return;
    let cancelled = false;
    const refresh = async () => {
      try {
        const list = (await window.academy?.peer?.pending?.()) ?? [];
        if (!cancelled && Array.isArray(list)) setItems(list);
      } catch {
        // settings still lists them
      }
    };
    refresh();
    // Only the events that change the pending list; 'peer:audit' fires per audited action.
    const off = window.academy.peer.onEvent((msg) => {
      if (
        msg.event === 'peer:pending' ||
        msg.event === 'peer:paired' ||
        msg.event === 'peer:rejected' ||
        msg.event === 'peer:dropped'
      ) {
        refresh();
      }
    });
    return () => {
      cancelled = true;
      off();
    };
  }, []);

  const answer = useCallback(async (requestId: string, approved: boolean) => {
    if (!window.academy?.peer) return;
    setBusy(requestId);
    try {
      if (approved) await window.academy.peer.approve(requestId);
      else await window.academy.peer.reject(requestId);
      setItems((prev) => prev.filter((r) => r.requestId !== requestId));
    } catch {
      // the peer event stream corrects the list either way
    } finally {
      setBusy(null);
    }
  }, []);

  return { items, busy, answer };
}

/** Same rule as the settings list: approval stays disabled until the code the
 *  guest typed matches the one this device generated. */
function pairingCodeMatches(request: AcademyPeerPending): boolean {
  if (!request.enteredPairingCode) return false;
  return request.enteredPairingCode.toLowerCase() === request.expectedPairingCode.toLowerCase();
}

function PairRequestRow({
  request,
  busy,
  onAnswer,
}: {
  request: AcademyPeerPending;
  busy: boolean;
  onAnswer: (requestId: string, approved: boolean) => void;
}) {
  const matches = pairingCodeMatches(request);
  return (
    <div className="flex flex-wrap items-center gap-x-4 gap-y-2 border-b border-amber-500/40 bg-amber-500/15 px-4 py-2.5 text-sm backdrop-blur">
      <div className="min-w-0 flex-1 text-canvas-foreground">
        <span className="font-medium">{pairUserDataLabel(request)}</span> wants to pair. Once
        approved it can run code on this machine, confined by the OS but able to read much of
        what your account can.
        <span className="mt-0.5 flex flex-wrap items-center gap-2 font-mono text-[11px] text-canvas-muted-foreground">
          <span title={request.discoveryKey}>{shortHex(request.discoveryKey, 10, 6)}</span>
          <span>expected {request.expectedPairingCode}</span>
          <span
            className={
              matches
                ? 'inline-flex items-center gap-1 text-emerald-400'
                : 'inline-flex items-center gap-1 text-red-400'
            }
          >
            {matches ? <ShieldCheck className="size-3" /> : <ShieldAlert className="size-3" />}
            {request.enteredPairingCode ?? 'no code'}
          </span>
        </span>
      </div>
      <div className="flex shrink-0 items-center gap-2">
        <button
          type="button"
          onClick={() => onAnswer(request.requestId, false)}
          disabled={busy}
          className="rounded-md border border-canvas-border px-3 py-1 text-canvas-foreground hover:bg-canvas-muted disabled:opacity-50"
        >
          Reject
        </button>
        <button
          type="button"
          onClick={() => onAnswer(request.requestId, true)}
          disabled={busy || !matches}
          title={
            matches ? undefined : 'The code this device generated is not the one that was entered'
          }
          className="inline-flex items-center gap-1 rounded-md bg-amber-500 px-3 py-1 font-medium text-black hover:bg-amber-400 disabled:opacity-50"
        >
          {busy ? <Loader2 className="size-3 animate-spin" /> : null}
          Approve
        </button>
      </div>
    </div>
  );
}

// --- runs --------------------------------------------------------------------

export type RunTone = 'running' | 'ok' | 'err';

export type RunNotice = {
  id: string;
  /** incoming: a peer is running code here. outgoing: our code is running there. */
  direction: 'incoming' | 'outgoing';
  discoveryKey: string;
  label: string | null;
  tone: RunTone;
  status: string;
  startedAt: number;
  endedAt: number | null;
  /** Set on the 'started' event; carried forward through later updates
   *  (finished/error events don't repeat it) so "View code" survives the run. */
  sourcePreview?: string;
};

// Long enough to read after the run ends, short enough not to pile up.
const RUN_DISMISS_MS = 10_000;

function runIdFor(entry: AcademyPeerAuditEntry, direction: RunNotice['direction']): string {
  return `${direction}:${entry.discoveryKey ?? 'unknown'}`;
}

export function useRunNotices() {
  const [items, setItems] = useState<RunNotice[]>([]);
  const [names, setNames] = useState<Record<string, string>>({});
  const timers = useRef(new Map<string, ReturnType<typeof setTimeout>>());

  const dismiss = useCallback((id: string) => {
    setItems((prev) => prev.filter((r) => r.id !== id));
    const timer = timers.current.get(id);
    if (timer) clearTimeout(timer);
    timers.current.delete(id);
  }, []);

  const scheduleDismiss = useCallback(
    (id: string) => {
      const existing = timers.current.get(id);
      if (existing) clearTimeout(existing);
      timers.current.set(
        id,
        setTimeout(() => dismiss(id), RUN_DISMISS_MS),
      );
    },
    [dismiss],
  );

  useEffect(() => {
    if (typeof window === 'undefined' || !window.academy?.peer) return;
    const pending = timers.current;
    let cancelled = false;

    const refreshNames = async () => {
      const peers = (await window.academy?.peer?.list().catch(() => [])) ?? [];
      if (cancelled) return;
      const map: Record<string, string> = {};
      for (const p of peers as AcademyPeerInfo[]) {
        if (p.discoveryKey) map[p.discoveryKey] = pairUserDataLabel(p);
      }
      setNames(map);
    };
    refreshNames();

    const off = window.academy.peer.onEvent((msg) => {
      if (msg.event === 'peer:paired' || msg.event === 'peer:dropped') refreshNames();
      if (msg.event !== 'peer:audit') return;
      const entry = msg.payload as AcademyPeerAuditEntry;
      const notice = noticeFor(entry);
      if (!notice) return;

      setItems((prev) => {
        const rest = prev.filter((r) => r.id !== notice.id);
        const previous = prev.find((r) => r.id === notice.id);
        return [
          ...rest,
          {
            ...notice,
            startedAt: previous?.startedAt ?? notice.startedAt,
            sourcePreview: notice.sourcePreview ?? previous?.sourcePreview,
          },
        ];
      });
      if (notice.endedAt != null) scheduleDismiss(notice.id);
    });

    return () => {
      cancelled = true;
      off();
      for (const timer of pending.values()) clearTimeout(timer);
      pending.clear();
    };
  }, [scheduleDismiss]);

  const named = items.map((run) => ({
    ...run,
    peerLabel: names[run.discoveryKey] ?? shortHex(run.discoveryKey, 6, 4),
  }));

  return { items: named, dismiss };
}

/** One audit entry to a notice, or null when the entry is not about a run. */
function noticeFor(entry: AcademyPeerAuditEntry): RunNotice | null {
  const base = {
    discoveryKey: entry.discoveryKey ?? 'unknown',
    label: entry.label ?? entry.fileName ?? null,
    startedAt: entry.timestamp,
    endedAt: null as number | null,
  };

  switch (entry.type) {
    case 'peer:exec:started':
      return {
        ...base,
        id: runIdFor(entry, 'incoming'),
        direction: 'incoming',
        tone: 'running',
        status: 'Running',
        sourcePreview: entry.sourcePreview,
      };
    case 'peer:exec:remote-started':
      return {
        ...base,
        id: runIdFor(entry, 'outgoing'),
        direction: 'outgoing',
        tone: 'running',
        status: 'Running',
      };
    case 'peer:exec:finished':
    case 'peer:exec:remote-finished': {
      const direction = entry.type === 'peer:exec:finished' ? 'incoming' : 'outgoing';
      const ok = entry.code === 0;
      const status = ok
        ? 'Finished · exit 0'
        : entry.code != null
          ? `Failed · exit ${entry.code}`
          : entry.signal
            ? `Stopped · ${entry.signal}`
            : 'Finished';
      return {
        ...base,
        id: runIdFor(entry, direction),
        direction,
        tone: ok ? 'ok' : 'err',
        status,
        endedAt: entry.timestamp,
      };
    }
    case 'peer:exec:error':
    case 'peer:exec:remote-error': {
      const direction = entry.type === 'peer:exec:error' ? 'incoming' : 'outgoing';
      return {
        ...base,
        id: runIdFor(entry, direction),
        direction,
        tone: 'err',
        status: entry.message ? `Failed · ${entry.message}` : 'Failed',
        endedAt: entry.timestamp,
      };
    }
    default:
      return null;
  }
}

function formatElapsed(ms: number): string {
  const sec = Math.max(0, Math.round(ms / 1000));
  if (sec < 60) return `${sec}s`;
  return `${Math.floor(sec / 60)}m ${sec % 60}s`;
}

/** Ticks only while something is running, so a settled stack does no work. */
function useElapsedTick(active: boolean): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!active) return;
    const id = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(id);
  }, [active]);
  return now;
}

// The same three colours the activity list uses, so a run reads the same in both places.
function runToneClass(tone: RunTone): string {
  switch (tone) {
    case 'running':
      return 'text-sky-400';
    case 'ok':
      return 'text-emerald-400';
    default:
      return 'text-red-400';
  }
}

export function RunRow({
  run,
  onDismiss,
}: {
  run: RunNotice & { peerLabel: string };
  onDismiss: (id: string) => void;
}) {
  const now = useElapsedTick(run.endedAt == null);
  const elapsed = formatElapsed((run.endedAt ?? now) - run.startedAt);
  const sentence =
    run.direction === 'incoming' ? (
      <>
        <span className="font-small">{run.peerLabel}</span> is running code on this device
      </>
    ) : (
      <>
        Your code is running on <span className="font-small">{run.peerLabel}</span>
      </>
    );

  return (
    <div className="flex flex-col gap-1 border-b border-canvas-border bg-canvas-muted/95 px-2 py-2 text-sm backdrop-blur">
      <div className="flex flex-wrap items-center gap-x-4 gap-y-1">
        {run.tone === 'running' ? (
          <Loader2 className="size-3.5 shrink-0 animate-spin text-sky-400" />
        ) : null}
        <div className="min-w-0 flex-1 text-canvas-foreground">
          {sentence}
          {run.label ? <span className="text-canvas-muted-foreground"> · {run.label}</span> : null}
        </div>
        <span className={`shrink-0 font-medium ${runToneClass(run.tone)}`}>{run.status}</span>
        <span className="shrink-0 text-xs text-canvas-muted-foreground">{elapsed}</span>
        <button
          type="button"
          onClick={() => onDismiss(run.id)}
          aria-label="Dismiss"
          className="shrink-0 rounded p-1 text-canvas-muted-foreground transition-colors hover:bg-canvas hover:text-canvas-foreground"
        >
          <X className="size-3.5" />
        </button>
      </div>
      {run.sourcePreview ? (
        <details className="font-mono text-xs text-canvas-muted-foreground">
          <summary className="cursor-pointer select-none hover:text-canvas-foreground hover:underline">
            View code
          </summary>
          <pre className="mt-1 max-h-64 overflow-auto rounded-md bg-canvas p-2 text-canvas-foreground">
            {run.sourcePreview}
          </pre>
        </details>
      ) : null}
    </div>
  );
}
