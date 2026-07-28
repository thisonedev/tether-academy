'use client';

import type {
  AcademyAPI,
  AcademyDeviceInfo,
  AcademyModelEntry,
} from '@academy/academy-bridge';
import { useUserHydrated, useUserStore } from '@academy/core';
import { Box, Cpu, Database, HardDrive, Loader2, MemoryStick, Trash2 } from 'lucide-react';
import { useRouter } from 'next/navigation';
import { useCallback, useEffect, useState } from 'react';
import { DevicesPanel } from './devices-panel.js';

declare global {
  interface Window {
    academy?: AcademyAPI;
  }
}

function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  let value = bytes;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }
  const fixed = value < 10 && unit > 0 ? value.toFixed(2) : value < 100 ? value.toFixed(1) : value.toFixed(0);
  return `${fixed} ${units[unit]}`;
}

function formatGb(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return '0 GB';
  const gb = bytes / 1024 ** 3;
  if (gb >= 100) return `${gb.toFixed(0)} GB`;
  if (gb >= 10) return `${gb.toFixed(1)} GB`;
  return `${gb.toFixed(2)} GB`;
}

const KIND_LABEL: Record<AcademyModelEntry['kind'], string> = {
  single: 'Single file',
  sharded: 'Sharded model',
  set: 'Companion set',
};

interface RemoveState {
  // The model id whose row is showing the inline confirm, or 'all' for the
  // "remove all" button, or null when no confirm is open.
  pending: string | 'all' | null;
  // Once confirmed, the row shows a busy state until the IPC resolves.
  busy: boolean;
  // Per-row error message; cleared on next action.
  error: string | null;
}

export function SettingsPage() {
  const hydrated = useUserHydrated();
  const username = useUserStore((s) => s.username);
  const openSignInPrompt = useUserStore((s) => s.openSignInPrompt);
  const router = useRouter();

  const [models, setModels] = useState<AcademyModelEntry[] | null>(null);
  const [device, setDevice] = useState<AcademyDeviceInfo | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [remove, setRemove] = useState<RemoveState>({ pending: null, busy: false, error: null });
  const [isDesktop, setIsDesktop] = useState<boolean | null>(null);

  // Settings is desktop-only: model management and device info both depend on
  // the `window.academy` bridge. On web, bounce back to the home page so a
  // typed URL or stale bookmark doesn't show a dead page.
  useEffect(() => {
    setIsDesktop(typeof window !== 'undefined' && !!window.academy);
  }, []);

  useEffect(() => {
    if (isDesktop === false) router.replace('/');
  }, [isDesktop, router]);

  const refreshModels = useCallback(async () => {
    if (!window.academy?.models) {
      setModels([]);
      return;
    }
    const list = await window.academy.models.list();
    setModels(list);
  }, []);

  useEffect(() => {
    if (!hydrated) return;
    if (!username) {
      openSignInPrompt();
      return;
    }
    let cancelled = false;
    (async () => {
      setLoadError(null);
      try {
        const [list, dev] = await Promise.all([
          window.academy?.models?.list().catch(() => null) ?? Promise.resolve(null),
          window.academy?.device?.info().catch(() => null) ?? Promise.resolve(null),
        ]);
        if (cancelled) return;
        setModels(list ?? []);
        setDevice(dev);
      } catch (err) {
        if (cancelled) return;
        setLoadError(err instanceof Error ? err.message : 'Failed to load settings');
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [hydrated, username, openSignInPrompt]);

  const onRemoveOne = useCallback(
    async (id: string) => {
      if (!window.academy?.models) return;
      setRemove({ pending: id, busy: true, error: null });
      try {
        await window.academy.models.remove(id);
        await refreshModels();
        setRemove({ pending: null, busy: false, error: null });
      } catch (err) {
        setRemove({
          pending: null,
          busy: false,
          error: err instanceof Error ? err.message : 'Remove failed',
        });
      }
    },
    [refreshModels],
  );

  const onRemoveAll = useCallback(async () => {
    if (!window.academy?.models) return;
    setRemove({ pending: 'all', busy: true, error: null });
    try {
      await window.academy.models.removeAll();
      await refreshModels();
      setRemove({ pending: null, busy: false, error: null });
    } catch (err) {
      setRemove({
        pending: null,
        busy: false,
        error: err instanceof Error ? err.message : 'Remove all failed',
      });
    }
  }, [refreshModels]);

  if (!hydrated || isDesktop === null) {
    return (
      <main className="mx-auto w-full max-w-4xl px-4 py-10 sm:px-6 sm:py-14">
        <p className="text-sm text-canvas-muted-foreground">Loading…</p>
      </main>
    );
  }

  if (!isDesktop) {
    // Redirect already scheduled; render nothing so a brief flash of "Sign in"
    // doesn't appear before the navigation lands.
    return null;
  }

  if (!username) {
    return (
      <main className="mx-auto w-full max-w-4xl px-4 py-10 sm:px-6 sm:py-14">
        <header className="mb-6">
          <p className="mb-2 text-xs font-semibold uppercase tracking-widest text-emerald-400">
            Settings
          </p>
          <h1 className="mb-2 text-3xl font-bold tracking-tight text-canvas-foreground sm:text-4xl">
            Sign in to continue
          </h1>
          <p className="max-w-xl text-sm text-canvas-muted-foreground sm:text-base">
            Settings are tied to your account so progress, downloaded models, and device details
            stay together across rebuilds.
          </p>
        </header>
        <button
          type="button"
          onClick={openSignInPrompt}
          className="inline-flex items-center rounded-md bg-emerald-500 px-4 py-2 text-sm font-semibold text-canvas transition-colors hover:bg-emerald-400"
        >
          Sign in
        </button>
      </main>
    );
  }

  const totalBytes = (models ?? []).reduce((sum, m) => sum + m.sizeBytes, 0);
  const removingAll = remove.pending === 'all';

  return (
    <main className="mx-auto w-full max-w-4xl px-4 py-10 sm:px-6 sm:py-14">
      <button
        type="button"
        onClick={() => router.back()}
        className="mb-6 inline-flex items-center gap-1 text-xs text-canvas-muted-foreground transition-colors hover:text-canvas-foreground"
      >
        <span aria-hidden>←</span>
        <span>Back</span>
      </button>
      <header className="mb-8">
        <p className="mb-2 text-xs font-semibold uppercase tracking-widest text-emerald-400">
          Settings
        </p>
        <h1 className="mb-2 text-3xl font-bold tracking-tight text-canvas-foreground sm:text-4xl">
          Your workspace
        </h1>
        <p className="max-w-2xl text-sm text-canvas-muted-foreground sm:text-base">
          Manage the models downloaded for the lessons on this device, and see the hardware
          QVAC runs on. Share the device details when reporting a lesson that misbehaves on your
          hardware.
        </p>
      </header>

      {loadError ? (
        <div className="mb-6 rounded-md border border-red-500/40 bg-red-500/10 p-3 text-sm text-red-400">
          {loadError}
        </div>
      ) : null}

      <section className="mb-10 rounded-xl border border-canvas-border bg-canvas-muted p-5 sm:p-6">
        <div className="mb-4 flex items-start justify-between gap-3">
          <div>
            <h2 className="text-lg font-semibold text-canvas-foreground sm:text-xl">
              Downloaded models
            </h2>
            <p className="mt-1 text-sm text-canvas-muted-foreground">
              {models === null
                ? 'Scanning…'
                : models.length === 0
                  ? 'Nothing downloaded yet. Run a lesson to pull a model.'
                  : `${models.length} ${models.length === 1 ? 'model' : 'models'} · ${formatBytes(totalBytes)} on disk`}
            </p>
          </div>
          {models && models.length > 0 ? (
            <RemoveAllButton
              state={remove}
              onConfirm={onRemoveAll}
              onCancel={() => setRemove({ pending: null, busy: false, error: null })}
            />
          ) : null}
        </div>

        {!isDesktop ? (
          <p className="rounded-md border border-canvas-border bg-canvas p-4 text-sm text-canvas-muted-foreground">
            Open the desktop app to see and manage downloaded models.
          </p>
        ) : models === null ? (
          <p className="text-sm text-canvas-muted-foreground">Loading…</p>
        ) : models.length === 0 ? (
          <p className="rounded-md border border-canvas-border bg-canvas p-4 text-sm text-canvas-muted-foreground">
            No models yet. Pick a lesson and hit run; QVAC downloads what it needs into your
            home directory.
          </p>
        ) : (
          <ul className="max-h-[28rem] divide-y divide-canvas-border overflow-y-auto overflow-x-hidden rounded-lg border border-canvas-border bg-canvas">
            {models.map((m) => (
              <ModelRow
                key={m.id}
                model={m}
                state={remove}
                onConfirm={() => onRemoveOne(m.id)}
                onCancel={() => setRemove({ pending: null, busy: false, error: null })}
              />
            ))}
          </ul>
        )}

        {models && models.length > 0 ? (
          <p className="mt-2 text-[11px] text-canvas-muted-foreground/70">
            {models.length} {models.length === 1 ? 'model' : 'models'} downloaded
            {models.length > 6 ? ' · scroll to see the rest' : ''}
          </p>
        ) : null}

        {remove.error ? (
          <p role="alert" className="mt-3 text-xs text-red-400">
            {remove.error}
          </p>
        ) : null}
      </section>

      <section className="mb-10 rounded-xl border border-canvas-border bg-canvas-muted p-5 sm:p-6">
        <h2 className="mb-1 text-lg font-semibold text-canvas-foreground sm:text-xl">Paired devices</h2>
        <p className="mb-4 text-sm text-canvas-muted-foreground">
          Pair this desktop with another install to run lessons across machines. All pairing
          happens peer-to-peer, no server in the path.
        </p>
        <DevicesPanel />
      </section>

      <section className="rounded-xl border border-canvas-border bg-canvas-muted p-5 sm:p-6">
        <h2 className="mb-1 text-lg font-semibold text-canvas-foreground sm:text-xl">Device</h2>
        <p className="mb-4 text-sm text-canvas-muted-foreground">
          Hardware QVAC sees on this machine. Different devices run the same lesson at very
          different speeds.
        </p>
        {device === null ? (
          <p className="text-sm text-canvas-muted-foreground">
            {isDesktop ? 'Loading…' : 'Open the desktop app to see device details.'}
          </p>
        ) : (
          <DeviceTable info={device} />
        )}
      </section>
    </main>
  );
}

function ModelRow({
  model,
  state,
  onConfirm,
  onCancel,
}: {
  model: AcademyModelEntry;
  state: RemoveState;
  onConfirm: () => void;
  onCancel: () => void;
}) {
  const confirming = state.pending === model.id;
  const busy = confirming && state.busy;
  return (
    <li className="flex items-center justify-between gap-3 px-4 py-3 sm:px-5">
      <div className="min-w-0 flex-1">
        <p className="truncate font-mono text-sm text-canvas-foreground" title={model.name}>
          {model.name}
        </p>
        <p className="mt-0.5 text-xs text-canvas-muted-foreground">
          {KIND_LABEL[model.kind]}
          {model.fileCount > 1 ? ` · ${model.fileCount} files` : ''}
          {model.sourceHash ? ` · ${model.sourceHash}` : ''}
        </p>
        <UsageHint usedIn={model.usedIn} />
      </div>
      <div className="flex shrink-0 items-center gap-3">
        <span className="font-mono text-sm text-canvas-foreground">{formatGb(model.sizeBytes)}</span>
        {confirming ? (
          <div className="flex items-center gap-1">
            <button
              type="button"
              onClick={onCancel}
              disabled={busy}
              className="rounded px-2 py-1 text-xs text-canvas-muted-foreground hover:text-canvas-foreground disabled:opacity-50"
            >
              Cancel
            </button>
            <button
              type="button"
              onClick={onConfirm}
              disabled={busy}
              className="inline-flex items-center gap-1 rounded bg-red-500/15 px-2 py-1 text-xs font-semibold text-red-400 hover:bg-red-500/25 disabled:opacity-50"
            >
              {busy ? <Loader2 className="size-3 animate-spin" /> : null}
              Remove
            </button>
          </div>
        ) : (
          <button
            type="button"
            onClick={() => onConfirm()}
            disabled={state.busy}
            aria-label={`Remove ${model.name}`}
            className="rounded p-1.5 text-canvas-muted-foreground transition-colors hover:bg-canvas hover:text-red-400 disabled:opacity-40"
          >
            <Trash2 className="size-4" />
          </button>
        )}
      </div>
    </li>
  );
}

function UsageHint({ usedIn }: { usedIn: AcademyModelEntry['usedIn'] }) {
  if (!usedIn || usedIn.length === 0) {
    return (
      <p className="mt-1 text-[11px] text-canvas-muted-foreground/70">
        Not used in any lesson. Safe to remove
      </p>
    );
  }
  const labels = usedIn.map((ref) => chapterLabel(ref.chapter));
  return (
    <p className="mt-1 text-[11px] text-canvas-muted-foreground">
      Used in: {joinChapters(labels)}
    </p>
  );
}

function joinChapters(items: string[]): string {
  if (items.length === 0) return '';
  if (items.length === 1) return items[0];
  if (items.length === 2) return `${items[0]} and ${items[1]}`;
  return `${items.slice(0, -1).join(', ')} and ${items[items.length - 1]}`;
}

const CHAPTER_LABELS: Record<string, string> = {
  'getting-started': 'Getting started',
  'text-generation': 'Text generation',
  'text-embeddings': 'Text embeddings',
  rag: 'RAG',
  'fine-tuning': 'Fine-tuning',
  multimodal: 'Multimodal',
  'image-generation': 'Image generation',
  'video-generation': 'Video generation',
  transcription: 'Transcription',
  'text-to-speech': 'Text-to-speech',
  translation: 'Translation',
  'voice-assistant': 'Voice assistant',
  ocr: 'OCR',
  'image-classification': 'Image classification',
  bci: 'BCI',
  vla: 'VLA',
  p2p: 'P2P',
  'delegated-inference': 'Delegated inference',
};
function chapterLabel(slug: string): string {
  return CHAPTER_LABELS[slug] ?? slug;
}

function RemoveAllButton({
  state,
  onConfirm,
  onCancel,
}: {
  state: RemoveState;
  onConfirm: () => void;
  onCancel: () => void;
}) {
  const confirming = state.pending === 'all';
  const busy = confirming && state.busy;
  if (confirming) {
    return (
      <div className="flex flex-col items-end gap-1">
        <div className="flex items-center gap-1">
          <button
            type="button"
            onClick={onCancel}
            disabled={busy}
            className="rounded px-2 py-1 text-xs text-canvas-muted-foreground hover:text-canvas-foreground disabled:opacity-50"
          >
            Cancel
          </button>
          <button
            type="button"
            onClick={onConfirm}
            disabled={busy}
            className="inline-flex items-center gap-1 rounded bg-red-500/15 px-2.5 py-1 text-xs font-semibold text-red-400 hover:bg-red-500/25 disabled:opacity-50"
          >
            {busy ? <Loader2 className="size-3 animate-spin" /> : null}
            Remove all
          </button>
        </div>
        <p className="text-right text-[10px] text-canvas-muted-foreground/80">
          Frees all model files on this device.
        </p>
      </div>
    );
  }
  return (
    <button
      type="button"
      onClick={onConfirm}
      disabled={state.busy}
      className="inline-flex items-center gap-1.5 rounded-md border border-red-500/40 bg-red-500/10 px-3 py-1.5 text-sm font-semibold text-red-400 transition-colors hover:bg-red-500/20 disabled:opacity-40"
    >
      <Trash2 className="size-3.5" />
      Remove all
    </button>
  );
}

function DeviceTable({ info }: { info: AcademyDeviceInfo }) {
  const rows: { icon: React.ReactNode; label: string; value: string; hint?: string }[] = [
    { icon: <Box className="size-4" />, label: 'Operating system', value: info.osLabel, hint: info.arch },
    {
      icon: <Cpu className="size-4" />,
      label: 'Processor',
      value: info.model,
      hint: `${info.cpuPhysicalCores} physical · ${info.cpuCores} logical cores`,
    },
    { icon: <MemoryStick className="size-4" />, label: 'Memory', value: formatGb(info.memoryBytes) },
    {
      icon: <HardDrive className="size-4" />,
      label: 'Storage',
      value: formatGb(info.storageBytes),
      hint: `${formatGb(info.storageFreeBytes)} free · ${info.storagePath}`,
    },
    {
      icon: <Database className="size-4" />,
      label: 'Graphics',
      value: info.gpu ?? 'Not detected',
      hint: info.gpu ? undefined : 'GPU info is unavailable on this platform.',
    },
  ];
  return (
    <ul className="divide-y divide-canvas-border overflow-hidden rounded-lg border border-canvas-border bg-canvas">
      {rows.map((r) => (
        <li
          key={r.label}
          className="flex items-start gap-3 px-4 py-3 sm:px-5"
        >
          <span className="mt-0.5 inline-flex size-8 shrink-0 items-center justify-center rounded-md bg-canvas-muted text-emerald-400">
            {r.icon}
          </span>
          <div className="min-w-0 flex-1">
            <p className="text-[11px] font-semibold uppercase tracking-wider text-canvas-muted-foreground">
              {r.label}
            </p>
            <p className="mt-0.5 truncate font-mono text-sm text-canvas-foreground" title={r.value}>
              {r.value}
            </p>
            {r.hint ? <p className="mt-0.5 text-xs text-canvas-muted-foreground">{r.hint}</p> : null}
          </div>
        </li>
      ))}
    </ul>
  );
}
