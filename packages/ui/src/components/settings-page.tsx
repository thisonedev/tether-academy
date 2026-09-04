'use client';

import type {
  AcademyAPI,
  AcademyDeviceInfo,
  AcademyModelCatalogueEntry,
  AcademyModelEntry,
  AcademyPeerAuditEntry,
  AcademyPeerInfo,
} from '@academy/validation';
import { useUserHydrated, useUserStore } from '@academy/core';
import { Box, Bot, Circle, CircleCheck, Cpu, Database, Eraser, HardDrive, Loader2, MemoryStick, RefreshCw, Trash2, Wifi, WifiOff } from 'lucide-react';
import { useRouter } from 'next/navigation';
import { useCallback, useEffect, useMemo, useState } from 'react';
import { AI_BOT_MODEL_NAMES } from './ai-bot-models.js';
import {
  DevicesPanel,
  ExecRunList,
  formatRelativeTime,
  pairUserDataLabel,
  PendingRequestsSection,
  shortHex,
} from './devices-panel.js';
import { ProfileOnboarding } from './profile-onboarding.js';

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

const SETTINGS_TABS = [
  { id: 'models', label: 'Models' },
  { id: 'profile', label: 'Profile' },
  { id: 'paired', label: 'Paired devices' },
  { id: 'device', label: 'My device' },
] as const;
type SettingsTabId = (typeof SETTINGS_TABS)[number]['id'];

interface RemoveState {
  // Model id showing the inline confirm, 'all' for the remove-all button, or null when closed.
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
  const [chatCatalogue, setChatCatalogue] = useState<AcademyModelCatalogueEntry[] | null>(null);
  const [configuredChatModel, setConfiguredChatModel] = useState<string | null>(null);
  const [configuringChatModel, setConfiguringChatModel] = useState<string | null>(null);
  const [modelProgress, setModelProgress] = useState<Record<string, { loaded: number; total: number }>>({});
  const [useFullDocs, setUseFullDocs] = useState(true);
  const [docsStatus, setDocsStatus] = useState<{ available: boolean; source: string; bytes: number; expiresAt: number } | null>(null);
  const [docsBusy, setDocsBusy] = useState(false);
  const [device, setDevice] = useState<AcademyDeviceInfo | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [remove, setRemove] = useState<RemoveState>({ pending: null, busy: false, error: null });
  const [isDesktop, setIsDesktop] = useState<boolean | null>(null);
  const [activeTab, setActiveTab] = useState<SettingsTabId>('models');

  // Settings is desktop-only; on web, bounce back to the home page rather than show a dead page.
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
    // The catalogue carries each chat model's own install state, so a delete
    // that only refreshed the file list left the row looking untouched.
    const [list, cat] = await Promise.all([
      window.academy.models.list(),
      window.academy.models.catalogue().catch(() => null),
    ]);
    setModels(list);
    if (cat) {
      setChatCatalogue(
        AI_BOT_MODEL_NAMES.map((name) => cat.find((entry) => entry.name === name)).filter(
          (entry): entry is AcademyModelCatalogueEntry => entry != null,
        ),
      );
    }
  }, []);

  useEffect(() => {
    if (!hydrated) return;
    if (!username) {
      openSignInPrompt();
      return;
    }
    // Subscribe to model load progress once; the host emits events while a
    // chat:load call is downloading a model file.
    const offProgress = window.academy?.chat?.onLoadProgress?.((event) => {
      if (!event || !event.modelName) return;
      setModelProgress((prev) => ({
        ...prev,
        [event.modelName]: { loaded: event.loaded, total: event.total },
      }));
    });
    let cancelled = false;
    (async () => {
      setLoadError(null);
      try {
        const [list, dev, catalogue, configured, useFullDocsRaw, status] = await Promise.all([
          window.academy?.models?.list().catch(() => null) ?? Promise.resolve(null),
          window.academy?.device?.info().catch(() => null) ?? Promise.resolve(null),
          window.academy?.models?.catalogue().catch(() => []) ?? Promise.resolve([]),
          window.academy?.chat?.configuredModel().catch(() => null) ?? Promise.resolve(null),
          window.academy?.state?.get?.('ai.chat.useFullDocs').catch(() => null) ?? Promise.resolve(null),
          window.academy?.chat?.docsStatus?.().catch(() => null) ?? Promise.resolve(null),
        ]);
        if (cancelled) return;
        setModels(list ?? []);
        setChatCatalogue(
          AI_BOT_MODEL_NAMES.map((name) => (catalogue ?? []).find((entry) => entry.name === name)).filter(
            (entry): entry is AcademyModelCatalogueEntry => entry != null,
          ),
        );
        setConfiguredChatModel(configured);
        setDevice(dev);
        if (typeof useFullDocsRaw === 'string') setUseFullDocs(useFullDocsRaw !== 'false');
        if (status && typeof status === 'object') setDocsStatus(status);
      } catch (err) {
        if (cancelled) return;
        setLoadError(err instanceof Error ? err.message : 'Failed to load settings');
      }
    })();
    return () => {
      cancelled = true;
      offProgress?.();
    };
  }, [hydrated, username, openSignInPrompt]);

  const configureChatModel = useCallback(async (modelName: string) => {
    if (!window.academy?.chat) return;
    setConfiguringChatModel(modelName);
    setLoadError(null);
    setModelProgress((prev) => ({ ...prev, [modelName]: { loaded: 0, total: 0 } }));
    try {
      const result = await window.academy.chat.load(modelName);
      setConfiguredChatModel(result.modelName);
      await refreshModels();
    } catch (err) {
      setLoadError(err instanceof Error ? err.message : 'Could not configure the AI bot');
    } finally {
      setConfiguringChatModel(null);
      setModelProgress((prev) => {
        const next = { ...prev };
        delete next[modelName];
        return next;
      });
    }
  }, [refreshModels]);

  const toggleUseFullDocs = useCallback(async () => {
    const next = !useFullDocs;
    setUseFullDocs(next);
    try {
      await window.academy?.state?.set?.('ai.chat.useFullDocs', next ? 'true' : 'false');
    } catch {
      // best-effort; the next reload will recover
    }
    if (next) {
      setDocsBusy(true);
      try {
        const result = await window.academy?.chat?.docsRefresh?.();
        if (result && typeof result === 'object') setDocsStatus(result);
      } catch {
        // surface the existing status; don't block the toggle
      } finally {
        setDocsBusy(false);
      }
    }
  }, [useFullDocs]);

  const refreshDocs = useCallback(async () => {
    setDocsBusy(true);
    try {
      const result = await window.academy?.chat?.docsRefresh?.();
      if (result && typeof result === 'object') setDocsStatus(result);
    } finally {
      setDocsBusy(false);
    }
  }, []);

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

  // Arms the inline confirm for a row without deleting anything yet; the
  // actual delete only fires from the "Remove" button in that confirm state.
  const requestRemove = useCallback((id: string) => {
    setRemove({ pending: id, busy: false, error: null });
  }, []);

  const cancelRemove = useCallback(() => {
    setRemove({ pending: null, busy: false, error: null });
  }, []);

  // Two entries share the name Qwen3-4B-Q4_K_M.gguf, so removing by name could
  // take the lesson copy. The cache file names the one to delete.
  const modelIdByName = useMemo(() => {
    const map = new Map<string, string>();
    (models ?? []).forEach((m) => map.set(m.name, m.id));
    (chatCatalogue ?? []).forEach((entry) => {
      // Only a file actually on disk has anything to delete.
      if (entry.cacheFile && entry.installed) map.set(entry.name, entry.cacheFile);
      else if (entry.installed === false) map.delete(entry.name);
    });
    return map;
  }, [models, chatCatalogue]);

  // A download in progress already occupies its final filename, so the checkmark
  // needs completeness too, and for chat models only the host can resolve it.
  const modelCompleteByName = useMemo(() => {
    const map = new Map<string, boolean>();
    (models ?? []).forEach((m) => map.set(m.name, m.complete));
    (chatCatalogue ?? []).forEach((entry) => {
      if (typeof entry.installed === 'boolean') map.set(entry.name, entry.installed);
    });
    return map;
  }, [models, chatCatalogue]);

  if (!hydrated || isDesktop === null) {
    return (
      <main className="mx-auto w-full max-w-4xl px-4 py-10 sm:px-6 sm:py-14">
        <p className="text-sm text-canvas-muted-foreground">Loading…</p>
      </main>
    );
  }

  if (!isDesktop) {
    // Redirect already scheduled; render nothing so "Sign in" doesn't flash before it lands.
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

  // The AI bot's active model has its own section above; listing it again
  // here just makes it easy to remove by accident.
  const downloadedModels = (models ?? []).filter((m) => m.name !== configuredChatModel);
  const totalBytes = downloadedModels.reduce((sum, m) => sum + m.sizeBytes, 0);
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
          Manage the models downloaded for the lessons, pair with another device, and see
          what hardware QVAC runs on. Share the device details when reporting a lesson that
          misbehaves on your hardware.
        </p>
      </header>

      {loadError ? (
        <div className="mb-6 rounded-md border border-red-500/40 bg-red-500/10 p-3 text-sm text-red-400">
          {loadError}
        </div>
      ) : null}

      <div
        role="tablist"
        aria-label="Settings sections"
        className="mb-6 flex flex-wrap gap-1 border-b border-canvas-border"
      >
        {SETTINGS_TABS.map((t) => {
          const isActive = activeTab === t.id;
          return (
            <button
              key={t.id}
              type="button"
              role="tab"
              id={`settings-tab-${t.id}`}
              aria-selected={isActive}
              aria-controls={`settings-panel-${t.id}`}
              onClick={() => setActiveTab(t.id)}
              className={`relative -mb-px px-4 py-2.5 text-sm font-medium transition-colors ${
                isActive
                  ? 'text-emerald-400'
                  : 'text-canvas-muted-foreground hover:text-canvas-foreground'
              }`}
            >
              {t.label}
              {isActive ? (
                <span className="absolute inset-x-3 bottom-0 h-0.5 bg-emerald-400" />
              ) : null}
            </button>
          );
        })}
      </div>

      {activeTab === 'models' ? (
        <section
          role="tabpanel"
          id="settings-panel-models"
          aria-labelledby="settings-tab-models"
          className="rounded-xl border border-canvas-border bg-canvas-muted p-5 sm:p-6"
        >
          {remove.error ? (
            <p role="alert" className="mb-4 rounded-md border border-red-500/30 bg-red-500/10 px-3 py-2 text-xs text-red-400">
              {remove.error}
            </p>
          ) : null}

          <section className="mb-6 rounded-lg border border-canvas-border bg-canvas p-4 sm:p-5">
            <div className="flex items-start gap-3">
              <div className="mt-0.5 flex size-8 shrink-0 items-center justify-center rounded-md border border-emerald-500/40 bg-emerald-500/15 text-emerald-400">
                <Bot className="size-4" />
              </div>
              <div className="min-w-0">
                <h2 className="text-lg font-semibold text-canvas-foreground">AI bot models</h2>
                <p className="mt-1 text-sm text-canvas-muted-foreground">
                  Choose the local model the assistant uses in every lesson chat. You only need to configure it once.
                </p>
              </div>
            </div>
            <div className="mt-4 space-y-2">
              {chatCatalogue === null ? (
                <p className="text-sm text-canvas-muted-foreground">Loading chat models…</p>
              ) : chatCatalogue.length === 0 ? (
                <p className="rounded-md border border-canvas-border bg-canvas-muted p-3 text-sm text-canvas-muted-foreground">
                  No chat models are available yet.
                </p>
              ) : (
                chatCatalogue.map((entry) => {
                  const downloadedId = modelIdByName.get(entry.name);
                  const active =
                    configuredChatModel === entry.name && downloadedId != null && modelCompleteByName.get(entry.name) === true;
                  const busy = configuringChatModel === entry.name;
                  const progress = modelProgress[entry.name];
                  return (
                    <div key={entry.name} className="rounded-md border border-canvas-border bg-canvas-muted px-3 py-2.5">
                      <div className="flex items-center gap-3">
                        <div className="min-w-0 flex-1">
                          <p className="truncate text-sm font-medium text-canvas-foreground">{entry.name}</p>
                          <p className="mt-0.5 text-xs text-canvas-muted-foreground">
                            {entry.description || 'Local text-generation model'}
                          </p>
                        </div>
                        <span className="shrink-0 font-mono text-sm text-canvas-foreground">
                          {entry.sizeBytes ? formatBytes(entry.sizeBytes) : '—'}
                        </span>
                        <SelectModelButton
                          active={active}
                          busy={busy}
                          disabled={configuringChatModel !== null}
                          label={entry.name}
                          onSelect={() => void configureChatModel(entry.name)}
                        />
                        {downloadedId && !active ? (
                          <RemoveIconButton
                            id={downloadedId}
                            label={entry.name}
                            state={remove}
                            onRequestRemove={() => requestRemove(downloadedId)}
                            onConfirmRemove={() => onRemoveOne(downloadedId)}
                            onCancel={cancelRemove}
                          />
                        ) : null}
                      </div>
                      {busy ? (
                        <div className="mt-2">
                          <div className="h-1 w-full overflow-hidden rounded-full bg-canvas-muted">
                            <div
                              className="h-full rounded-full bg-emerald-500 transition-[width] duration-300"
                              style={{
                                width:
                                  progress && progress.total > 0
                                    ? `${Math.min(100, Math.round((progress.loaded / progress.total) * 100))}%`
                                    : '15%',
                              }}
                            />
                          </div>
                          <p className="mt-1 font-mono text-[10px] uppercase tracking-widest text-canvas-muted-foreground">
                            {progress && progress.total > 0
                              ? `${formatBytes(progress.loaded)} / ${formatBytes(progress.total)}`
                              : busy
                                ? 'Preparing model…'
                                : ''}
                          </p>
                        </div>
                      ) : null}
                    </div>
                  );
                })
              )}
            </div>
            <div className="mt-4 rounded-md border border-canvas-border bg-canvas p-3">
              <div className="flex items-start justify-between gap-3">
                <div className="min-w-0">
                  <p className="text-sm font-semibold text-canvas-foreground">Include QVAC documentation</p>
                  <p className="mt-0.5 text-xs text-canvas-muted-foreground">
                    When online, the assistant sees the full QVAC SDK docs alongside the current lesson. Disable to keep answers local-only.
                  </p>
                </div>
                <button
                  type="button"
                  role="switch"
                  aria-checked={useFullDocs}
                  onClick={() => void toggleUseFullDocs()}
                  className={`relative inline-flex h-5 w-9 shrink-0 items-center rounded-full transition-colors ${
                    useFullDocs ? 'bg-emerald-500' : 'bg-canvas-muted-foreground/40'
                  }`}
                >
                  <span
                    className={`inline-block size-4 transform rounded-full bg-canvas transition-transform ${
                      useFullDocs ? 'translate-x-4' : 'translate-x-0.5'
                    }`}
                  />
                </button>
              </div>
            </div>
          </section>

          <section className="rounded-lg border border-canvas-border bg-canvas p-4 sm:p-5">
            <div className="flex items-start gap-3">
              <div className="mt-0.5 flex size-8 shrink-0 items-center justify-center rounded-md border border-emerald-500/40 bg-emerald-500/15 text-emerald-400">
                <HardDrive className="size-4" />
              </div>
              <div className="min-w-0 flex-1">
                <div className="flex items-start justify-between gap-3">
                  <div>
                    <h2 className="text-lg font-semibold text-canvas-foreground">QVAC models</h2>
                    <p className="mt-1 text-sm text-canvas-muted-foreground">
                      {models === null
                        ? 'Scanning…'
                        : downloadedModels.length === 0
                          ? 'Nothing downloaded yet. Run a lesson to pull a model.'
                          : `${downloadedModels.length} ${downloadedModels.length === 1 ? 'model' : 'models'} · ${formatBytes(totalBytes)} on disk`}
                    </p>
                  </div>
                  {downloadedModels.length > 0 ? (
                    <RemoveAllButton
                      state={remove}
                      onRequestRemove={() => requestRemove('all')}
                      onConfirmRemove={onRemoveAll}
                      onCancel={cancelRemove}
                    />
                  ) : null}
                </div>
              </div>
            </div>

            <div className="mt-4 space-y-2">
              {!isDesktop ? (
                <p className="rounded-md border border-canvas-border bg-canvas-muted p-4 text-sm text-canvas-muted-foreground">
                  Open the desktop app to see and manage downloaded models.
                </p>
              ) : models === null ? (
                <p className="text-sm text-canvas-muted-foreground">Loading…</p>
              ) : downloadedModels.length === 0 ? (
                <p className="rounded-md border border-canvas-border bg-canvas-muted p-4 text-sm text-canvas-muted-foreground">
                  No models yet. Pick a lesson and hit run; QVAC downloads what it needs into your
                  home directory.
                </p>
              ) : (
                downloadedModels.map((m) => (
                  <ModelRow
                    key={m.id}
                    model={m}
                    state={remove}
                    onRequestRemove={() => requestRemove(m.id)}
                    onConfirmRemove={() => onRemoveOne(m.id)}
                    onCancel={cancelRemove}
                  />
                ))
              )}

              {downloadedModels.length > 0 ? (
                <p className="text-[11px] text-canvas-muted-foreground/70">
                  {downloadedModels.length} {downloadedModels.length === 1 ? 'model' : 'models'} downloaded
                </p>
              ) : null}
            </div>
          </section>
        </section>
      ) : null}

      {activeTab === 'profile' ? (
        <section
          role="tabpanel"
          id="settings-panel-profile"
          aria-labelledby="settings-tab-profile"
          className="space-y-5 pb-8 sm:pb-12"
        >
          <ProfileOnboarding />
        </section>
      ) : null}

      {activeTab === 'paired' ? (
        <section
          role="tabpanel"
          id="settings-panel-paired"
          aria-labelledby="settings-tab-paired"
          className="pb-8 sm:pb-12"
        >
          <div className="grid grid-cols-1 gap-5 lg:grid-cols-[minmax(0,1fr)_22rem]">
            <div className="rounded-xl border border-canvas-border bg-canvas-muted p-5 sm:p-6">
              <h2 className="mb-1 text-lg font-semibold text-canvas-foreground sm:text-xl">
                Paired devices
              </h2>
              <p className="mb-4 text-sm text-canvas-muted-foreground">
                Pair this desktop with another install to run lessons across machines. All
                pairing happens peer-to-peer, no server in the path.
              </p>
              <DevicesPanel />
            </div>
            <div className="rounded-xl border border-canvas-border bg-canvas-muted p-5 sm:p-6">
              <h2 className="mb-1 text-lg font-semibold text-canvas-foreground sm:text-xl">
                Activity
              </h2>
              <p className="mb-4 text-sm text-canvas-muted-foreground">
                Pending pair requests and run history for paired devices.
              </p>
              <div className="space-y-6">
                <PendingRequestsSection />
                <PerDeviceRunLog />
              </div>
            </div>
          </div>
        </section>
      ) : null}

      {activeTab === 'device' ? (
        <section
          role="tabpanel"
          id="settings-panel-device"
          aria-labelledby="settings-tab-device"
          className="rounded-xl border border-canvas-border bg-canvas-muted p-5 sm:p-6"
        >
          <h2 className="mb-1 text-lg font-semibold text-canvas-foreground sm:text-xl">
            My device
          </h2>
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
      ) : null}
    </main>
  );
}

function ModelRow({
  model,
  state,
  onRequestRemove,
  onConfirmRemove,
  onCancel,
}: {
  model: AcademyModelEntry;
  state: RemoveState;
  onRequestRemove: () => void;
  onConfirmRemove: () => void;
  onCancel: () => void;
}) {
  return (
    <div className="rounded-md border border-canvas-border bg-canvas-muted px-3 py-2.5">
      <div className="flex items-center gap-3">
        <div className="min-w-0 flex-1">
          <p className="truncate font-mono text-sm text-canvas-foreground" title={model.name}>
            {model.name}
          </p>
          <p className="mt-0.5 text-xs text-canvas-muted-foreground">
            {KIND_LABEL[model.kind]}
            {model.fileCount > 1 ? ` · ${model.fileCount} files` : ''}
            {model.sourceHash ? ` · ${model.sourceHash}` : ''}
          </p>
          <UsageHint description={model.description} usedIn={model.usedIn} />
        </div>
        <span className="shrink-0 font-mono text-sm text-canvas-foreground">{formatBytes(model.sizeBytes)}</span>
        <RemoveIconButton
          id={model.id}
          label={model.name}
          state={state}
          onRequestRemove={onRequestRemove}
          onConfirmRemove={onConfirmRemove}
          onCancel={onCancel}
        />
      </div>
    </div>
  );
}

// Icon-only radio-style control for picking the active AI-bot model: an
// empty circle to select, a filled check when it's the configured one.
function SelectModelButton({
  active,
  busy,
  disabled,
  label,
  onSelect,
}: {
  active: boolean;
  busy: boolean;
  disabled: boolean;
  label: string;
  onSelect: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onSelect}
      disabled={disabled}
      aria-pressed={active}
      aria-label={active ? `${label} is configured` : `Use ${label}`}
      title={active ? 'Configured' : 'Use this model'}
      className={`shrink-0 rounded p-1.5 transition-colors disabled:cursor-wait disabled:opacity-40 ${
        active ? 'text-emerald-400' : 'text-canvas-muted-foreground hover:bg-canvas hover:text-emerald-400'
      }`}
    >
      {busy ? (
        <Loader2 className="size-4 animate-spin" />
      ) : active ? (
        <CircleCheck className="size-4" />
      ) : (
        <Circle className="size-4" />
      )}
    </button>
  );
}

// Shared remove control for a model row: clicking the trash icon only arms
// the inline Cancel/Remove confirm (`onRequestRemove`); the actual delete
// fires from the "Remove" button (`onConfirmRemove`). Keyed off
// `state.pending` so only one row confirms at a time. Used by both the AI
// bot list and Downloaded models.
function RemoveIconButton({
  id,
  label,
  state,
  onRequestRemove,
  onConfirmRemove,
  onCancel,
}: {
  id: string;
  label: string;
  state: RemoveState;
  onRequestRemove: () => void;
  onConfirmRemove: () => void;
  onCancel: () => void;
}) {
  const confirming = state.pending === id;
  const busy = confirming && state.busy;
  if (confirming) {
    return (
      <div className="flex shrink-0 items-center gap-1">
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
          onClick={onConfirmRemove}
          disabled={busy}
          className="inline-flex items-center gap-1 rounded bg-red-500/15 px-2 py-1 text-xs font-semibold text-red-400 hover:bg-red-500/25 disabled:opacity-50"
        >
          {busy ? <Loader2 className="size-3 animate-spin" /> : null}
          Remove
        </button>
      </div>
    );
  }
  return (
    <button
      type="button"
      onClick={onRequestRemove}
      disabled={state.busy}
      aria-label={`Remove ${label}`}
      className="shrink-0 rounded p-1.5 text-canvas-muted-foreground transition-colors hover:bg-canvas hover:text-red-400 disabled:opacity-40"
    >
      <Trash2 className="size-4" />
    </button>
  );
}

function UsageHint({
  description,
  usedIn,
}: {
  description: string;
  usedIn: AcademyModelEntry['usedIn'];
}) {
  if (!usedIn || usedIn.length === 0) {
    return (
      <div className="mt-1 space-y-0.5">
        {description ? (
          <p className="text-[11px] text-canvas-muted-foreground">{description}</p>
        ) : null}
        <p className="text-[11px] text-canvas-muted-foreground/70">
          Not used in any lesson. Safe to remove
        </p>
      </div>
    );
  }
  const labels = usedIn.map((ref) => chapterLabel(ref.chapter));
  return (
    <div className="mt-1 space-y-0.5">
      {description ? (
        <p className="text-[11px] text-canvas-muted-foreground">{description}</p>
      ) : null}
      <p className="text-[11px] text-canvas-muted-foreground">
        Used in: {joinChapters(labels)}
      </p>
    </div>
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
  onRequestRemove,
  onConfirmRemove,
  onCancel,
}: {
  state: RemoveState;
  onRequestRemove: () => void;
  onConfirmRemove: () => void;
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
            onClick={onConfirmRemove}
            disabled={busy}
            className="inline-flex items-center gap-1 rounded bg-red-500/15 px-2.5 py-1 text-xs font-semibold text-red-400 hover:bg-red-500/25 disabled:opacity-50"
          >
            {busy ? <Loader2 className="size-3 animate-spin" /> : null}
            Remove all
          </button>
        </div>
        <p className="text-right text-[10px] text-canvas-muted-foreground/80">
          Frees all model files on this device except the AI bot's active model.
        </p>
      </div>
    );
  }
  return (
    <button
      type="button"
      onClick={onRequestRemove}
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

function PerDeviceRunLog() {
  const [peers, setPeers] = useState<AcademyPeerInfo[]>([]);
  const [audit, setAudit] = useState<AcademyPeerAuditEntry[]>([]);
  const [now, setNow] = useState<number>(() => Date.now());
  const [actionBusy, setActionBusy] = useState<string | null>(null);
  const [clearBusy, setClearBusy] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    if (!window.academy?.peer) return;
    const [p, au] = await Promise.all([
      window.academy.peer.list().catch(() => []),
      window.academy.peer.audit({ limit: 500 }).catch(() => []),
    ]);
    setPeers(Array.isArray(p) ? p : []);
    setAudit(Array.isArray(au) ? au : []);
  }, []);

  useEffect(() => {
    let cancelled = false;
    refresh();
    const off = window.academy?.peer?.onEvent?.((msg) => {
      if (cancelled) return;
      if (
        msg.event === 'peer:audit' ||
        msg.event === 'peer:paired' ||
        msg.event === 'peer:dropped' ||
        msg.event === 'peer:audit-cleared' ||
        msg.event === 'peer:audit-cleared-for-peer'
      ) {
        refresh();
      }
    });
    const tick = setInterval(() => setNow(Date.now()), 30_000);
    return () => {
      cancelled = true;
      if (typeof off === 'function') off();
      clearInterval(tick);
    };
  }, [refresh]);

  const onDrop = useCallback(async (discoveryKey: string) => {
    if (!window.academy?.peer) return;
    setActionBusy(discoveryKey);
    try {
      await window.academy.peer.drop(discoveryKey);
    } catch {
    } finally {
      setActionBusy(null);
    }
  }, []);

  const onClear = useCallback(async (discoveryKey: string) => {
    if (!window.academy?.peer) return;
    setClearBusy(discoveryKey);
    try {
      await window.academy.peer.clearPeerAudit(discoveryKey);
    } catch {
    } finally {
      setClearBusy(null);
    }
  }, []);

  if (peers.length === 0) {
    return (
      <p className="rounded-md border border-canvas-border bg-canvas-muted p-4 text-sm text-canvas-muted-foreground">
        No paired devices. Pair one in the form above, then come back to see run history for
        that pair here.
      </p>
    );
  }

  return (
    <div className="space-y-4">
      {peers.map((peer) => (
          <PairedDeviceCard
            key={peer.discoveryKey}
            peer={peer}
            audit={audit}
            now={now}
            busy={actionBusy === peer.discoveryKey}
            clearBusy={clearBusy === peer.discoveryKey}
            onDrop={() => onDrop(peer.discoveryKey)}
            onClear={() => onClear(peer.discoveryKey)}
          />
        ))}
    </div>
  );
}

function formatExecSample(entry: AcademyPeerAuditEntry): string | null {
  if (entry.mode === 'inline') return 'inline snippet';
  if (entry.label) return entry.label;
  return null;
}

function useExecRows(peer: AcademyPeerInfo, audit: AcademyPeerAuditEntry[]) {
  return useMemo(() => {
    const events = audit
      .filter(
        (e) =>
          e.discoveryKey === peer.discoveryKey &&
          (e.type === 'peer:exec:started' ||
            e.type === 'peer:exec:finished' ||
            e.type === 'peer:exec:error' ||
            e.type === 'peer:exec:remote-started' ||
            e.type === 'peer:exec:remote-finished' ||
            e.type === 'peer:exec:remote-error'),
      )
      .sort((a, b) => a.timestamp - b.timestamp);
    const rows: Array<{
      key: string;
      label: string;
      tone: 'running' | 'ok' | 'err' | 'info';
      ts: number;
      duration: string | null;
    }> = [];
    const openStartByRun = new Map<string, number>();
    let runIndex = 0;
    for (const e of events) {
      const isStarted =
        e.type === 'peer:exec:started' || e.type === 'peer:exec:remote-started';
      const isFinished =
        e.type === 'peer:exec:finished' || e.type === 'peer:exec:remote-finished';
      const isError = e.type === 'peer:exec:error' || e.type === 'peer:exec:remote-error';
      const isOk = isFinished && e.code === 0;
      const baseTone: 'running' | 'ok' | 'err' = isStarted
        ? 'running'
        : isError
          ? 'err'
          : isOk
            ? 'ok'
            : 'err';
      const sample = formatExecSample(e);
      const sampleTail = sample ? ` · ${sample}` : '';
      const baseLabel = isStarted
        ? `Run started${sampleTail}`
        : isOk
          ? `Run finished · exit 0${sampleTail}`
          : isError && e.code != null
            ? `Run failed · exit ${e.code}${sampleTail}`
            : isError && e.signal
              ? `Run stopped · ${e.signal}${sampleTail}`
              : isError && e.message
                ? `Run error: ${e.message}${sampleTail}`
                : `Run finished${sampleTail}`;
      if (isStarted) {
        openStartByRun.set(`run-${runIndex}`, e.timestamp);
        rows.push({
          key: `start-${e.timestamp}-${runIndex}`,
          label: baseLabel,
          tone: baseTone,
          ts: e.timestamp,
          duration: null,
        });
        runIndex += 1;
        continue;
      }
      const startKey = Array.from(openStartByRun.keys()).pop();
      const startTs = startKey ? openStartByRun.get(startKey) : undefined;
      if (startKey && startTs != null) openStartByRun.delete(startKey);
      const duration = startTs != null ? `${Math.max(0, Math.round((e.timestamp - startTs) / 1000))}s` : null;
      rows.push({
        key: `end-${e.timestamp}-${runIndex}`,
        label: baseLabel,
        tone: baseTone,
        ts: e.timestamp,
        duration,
      });
    }
    return rows.reverse();
  }, [audit, peer.discoveryKey]);
}

function PairedDeviceCard({
  peer,
  audit,
  now,
  busy,
  clearBusy,
  onDrop,
  onClear,
}: {
  peer: AcademyPeerInfo;
  audit: AcademyPeerAuditEntry[];
  now: number;
  busy: boolean;
  clearBusy: boolean;
  onDrop: () => void;
  onClear: () => void;
}) {
  const rows = useExecRows(peer, audit);
  return (
    <div className="rounded-xl border border-canvas-border bg-canvas p-4">
      <div className="flex items-center gap-2">
        <p
          className="min-w-0 flex-1 truncate text-sm font-medium text-canvas-foreground"
          title={pairUserDataLabel(peer)}
        >
          {pairUserDataLabel(peer)}
        </p>
        <button
          type="button"
          onClick={onClear}
          disabled={clearBusy || rows.length === 0}
          title="Clear this device's run history"
          aria-label="Clear this device's run history"
          className="inline-flex shrink-0 items-center rounded border border-canvas-border bg-canvas-muted p-1.5 text-canvas-muted-foreground transition-colors hover:border-canvas-foreground/40 hover:text-canvas-foreground disabled:opacity-50"
        >
          {clearBusy ? <Loader2 className="size-3 animate-spin" /> : <Eraser className="size-3" />}
        </button>
        <button
          type="button"
          onClick={onDrop}
          disabled={busy}
          title="Drop this pair"
          aria-label="Drop this pair"
          className="inline-flex shrink-0 items-center rounded border border-canvas-border bg-canvas-muted p-1.5 text-canvas-muted-foreground transition-colors hover:border-red-500/40 hover:text-red-400 disabled:opacity-50"
        >
          {busy ? <Loader2 className="size-3 animate-spin" /> : <Trash2 className="size-3" />}
        </button>
      </div>
      <div className="mt-2 flex flex-wrap items-center gap-2">
        <RoleBadgeLite role={peer.role} />
        <span
          className="truncate font-mono text-[11px] text-canvas-muted-foreground"
          title={peer.discoveryKey}
        >
          {shortHex(peer.discoveryKey, 10, 6)} · paired {formatRelativeTime(peer.pairedAt, now)}
        </span>
      </div>
      <div className="mt-3">
        <ExecRunList
          rows={rows}
          emptyHint="No code runs on this pair yet. Open a lesson, switch run mode to Paired device, and pick this one."
        />
      </div>
    </div>
  );
}

function RoleBadgeLite({ role }: { role: 'host' | 'guest' }) {
  if (role === 'host') {
    return (
      <span className="inline-flex shrink-0 items-center rounded-md bg-emerald-500/15 px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wider text-emerald-400 ring-1 ring-emerald-500/30">
        host
      </span>
    );
  }
  return (
    <span className="inline-flex shrink-0 items-center rounded-md bg-sky-500/15 px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wider text-sky-400 ring-1 ring-sky-500/30">
      guest
    </span>
  );
}

