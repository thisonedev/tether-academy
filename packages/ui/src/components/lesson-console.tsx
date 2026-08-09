'use client';

import type { AcademyChatChunk, AcademyChatMessage, ChatVerifyVerdict } from '@academy/validation';
import { AlertTriangle, ArrowUp, Check, ChevronDown, Loader2, Sparkles, Square, X } from 'lucide-react';
import { useCallback, useEffect, useRef, useState } from 'react';
import type { OutputLine } from './lesson-workspace.js';

export interface LessonConsoleLessonContext {
  chapter: string;
  lesson: string;
  title?: string;
  reference?: string;
}

export interface ConsoleCheckResult {
  id: string;
  description: string;
  passed: boolean;
}

export interface ConsoleCheckAiItem {
  verdict: ChatVerifyVerdict;
  reason: string;
}

/** One block in the unified timeline. Different kinds render as different block
 *  types (chat bubble, run card, check card) in the same chronological feed. */
export type ConsoleEntry =
  | { kind: 'chat-user'; id: string; content: string }
  | { kind: 'chat-assistant'; id: string; content: string; streaming: boolean }
  | { kind: 'run'; id: string; lines: OutputLine[]; status: 'running' | 'ok' | 'err' | 'stopped' }
  | {
      kind: 'check';
      id: string;
      structural: ConsoleCheckResult[];
      ai: 'idle' | 'loading' | 'done' | 'error' | 'unavailable';
      aiItems?: Record<string, ConsoleCheckAiItem>;
      aiSummary?: string;
      aiError?: string;
    };

/** The output/timeline panel: run cards, check cards, and chat messages, in
 *  the order they happened. Lives in the editor column. Typing happens in
 *  the separate `ChatInputBar`, which appends into the same `entries`. */
export interface LessonConsoleProps {
  entries: ConsoleEntry[];
  /** Cancels an in-progress AI review for the given check entry. */
  onStopCheck: (entryId: string) => void;
}

/** Compact chat input, meant to sit in the bottom nav between Previous/Next.
 *  Owns the model/send/stop machinery; replies land in the shared `entries`
 *  array, which the `LessonConsole` panel elsewhere on the page renders. */
export interface ChatInputBarProps {
  entries: ConsoleEntry[];
  setEntries: React.Dispatch<React.SetStateAction<ConsoleEntry[]>>;
  lessonContext: LessonConsoleLessonContext | null;
  readOnly?: boolean;
}

// Turns a cache filename like "Qwen3-4B-Q4_K_M.gguf" into "Qwen3 4B" for display.
function shortName(filename: string | null | undefined): string {
  if (!filename) return '';
  let name = filename.replace(/\.(gguf|bin|safetensors|pth)$/i, '');
  name = name.replace(/-Instruct/gi, '');
  name = name.replace(/-(?:UD-)?Q\d\w*$/i, '');
  return name.replace(/-/g, ' ');
}

function toLessonKey(
  ctx: LessonConsoleLessonContext | null,
): { chapter: string; lesson: string } | null {
  if (!ctx) return null;
  return { chapter: ctx.chapter, lesson: ctx.lesson };
}

function newId(): string {
  return typeof crypto !== 'undefined' && crypto.randomUUID
    ? crypto.randomUUID()
    : `id-${Date.now()}-${Math.random().toString(16).slice(2)}`;
}

export function LessonConsole({ entries, onStopCheck }: LessonConsoleProps) {
  const scrollRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    el.scrollTop = el.scrollHeight;
  }, [entries]);

  return (
    <div
      ref={scrollRef}
      className="min-h-0 flex-1 space-y-3 overflow-y-auto border-t border-canvas-border bg-canvas-muted p-3 text-sm"
    >
      {entries.length === 0 ? <EmptyState /> : null}
      {entries.map((entry) => {
        if (entry.kind === 'chat-user') return <UserBubble key={entry.id} content={entry.content} />;
        if (entry.kind === 'chat-assistant') {
          if (entry.streaming && entry.content.length === 0) {
            return <ThinkingIndicator key={entry.id} />;
          }
          return <AssistantBubble key={entry.id} content={entry.content} />;
        }
        if (entry.kind === 'run') return <RunCard key={entry.id} entry={entry} />;
        return (
          <div key={entry.id} className="space-y-2">
            <CheckCard entry={entry} onStop={() => onStopCheck(entry.id)} />
            {entry.ai === 'done' && entry.aiSummary ? <AssistantBubble content={entry.aiSummary} /> : null}
          </div>
        );
      })}
    </div>
  );
}

export function ChatInputBar({ entries, setEntries, lessonContext, readOnly }: ChatInputBarProps) {
  const [modelName, setModelName] = useState<string | null>(null);
  const [modelLoading, setModelLoading] = useState(true);
  const [chatUnavailable, setChatUnavailable] = useState(false);
  const [chatError, setChatError] = useState<string | null>(null);
  const [draft, setDraft] = useState('');
  const [chatPendingRequestId, setChatPendingRequestId] = useState<string | null>(null);
  const [installedChatModels, setInstalledChatModels] = useState<string[]>([]);
  const [switchingModel, setSwitchingModel] = useState(false);
  const [useFullDocs, setUseFullDocs] = useState(true);
  const pendingChatRequestIdRef = useRef<string | null>(null);
  const pendingChatEntryIdRef = useRef<string | null>(null);

  useEffect(() => {
    if (typeof window === 'undefined' || !window.academy?.chat) {
      setChatUnavailable(true);
      setModelLoading(false);
      return;
    }
    let cancelled = false;
    (async () => {
      const [current, configured] = await Promise.all([
        window.academy!.chat!.currentModel().catch(() => null),
        window.academy!.chat!.configuredModel().catch(() => null),
      ]);
      if (cancelled) return;
      if (current) {
        setModelName(current);
        setModelLoading(false);
        return;
      }
      if (!configured) {
        setModelLoading(false);
        return;
      }
      try {
        const loaded = await window.academy!.chat!.load(configured);
        if (!cancelled) setModelName(loaded.modelName);
      } catch (err) {
        if (!cancelled) {
          setChatError(err instanceof Error ? err.message : 'Could not load the configured model.');
        }
      } finally {
        if (!cancelled) setModelLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    if (typeof window === 'undefined' || !window.academy?.state) return;
    let cancelled = false;
    window.academy.state
      .get('ai.chat.useFullDocs')
      .then((value) => {
        if (!cancelled && typeof value === 'string' && value === 'false') setUseFullDocs(false);
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, []);

  const refreshInstalledChatModels = useCallback(async () => {
    if (typeof window === 'undefined' || !window.academy?.models) return;
    try {
      const [models, catalogue] = await Promise.all([
        window.academy.models.list(),
        window.academy.models.catalogue(),
      ]);
      const chatNames = new Set(catalogue.filter((c) => c.family === 'chat').map((c) => c.name));
      const installedChatNames = new Set(models.filter((m) => chatNames.has(m.name)).map((m) => m.name));
      setInstalledChatModels(Array.from(installedChatNames));
    } catch {
    }
  }, []);

  useEffect(() => {
    void refreshInstalledChatModels();
  }, [refreshInstalledChatModels]);

  const handleSwitchModel = useCallback(
    async (name: string) => {
      if (name === modelName) return;
      setSwitchingModel(true);
      setChatError(null);
      try {
        const result = await window.academy!.chat!.load(name);
        setModelName(result.modelName);
      } catch (err) {
        setChatError(err instanceof Error ? err.message : 'Could not switch models.');
      } finally {
        setSwitchingModel(false);
      }
    },
    [modelName],
  );

  // Free-form chat replies stream in via onChunk; matched to the entry that's
  // waiting for them by requestId, same protocol the old popover used.
  useEffect(() => {
    const offChunk = window.academy?.chat?.onChunk?.((chunk: AcademyChatChunk) => {
      if (chunk.requestId !== pendingChatRequestIdRef.current) return;
      const entryId = pendingChatEntryIdRef.current;
      if (chunk.error) setChatError(chunk.error);
      if (chunk.done) {
        pendingChatRequestIdRef.current = null;
        pendingChatEntryIdRef.current = null;
        setChatPendingRequestId(null);
        if (entryId) {
          setEntries((prev) =>
            prev.map((e) => (e.id === entryId && e.kind === 'chat-assistant' ? { ...e, streaming: false } : e)),
          );
        }
        return;
      }
      if (!entryId) return;
      setEntries((prev) =>
        prev.map((e) => {
          if (e.id !== entryId || e.kind !== 'chat-assistant') return e;
          return { ...e, content: chunk.replace ? chunk.delta : e.content + chunk.delta };
        }),
      );
    });
    return () => {
      offChunk?.();
    };
  }, [setEntries]);

  const handleSend = useCallback(async () => {
    if (!modelName || readOnly) return;
    const content = draft.trim();
    if (content.length === 0) return;
    setChatError(null);
    setDraft('');

    const history: AcademyChatMessage[] = [
      ...entries
        .filter((e): e is Extract<ConsoleEntry, { kind: 'chat-user' | 'chat-assistant' }> =>
          e.kind === 'chat-user' || e.kind === 'chat-assistant',
        )
        .map((e) => ({ role: e.kind === 'chat-user' ? ('user' as const) : ('assistant' as const), content: e.content })),
      { role: 'user', content },
    ];

    const assistantId = newId();
    setEntries((prev) => [
      ...prev,
      { kind: 'chat-user', id: newId(), content },
      { kind: 'chat-assistant', id: assistantId, content: '', streaming: true },
    ]);

    try {
      const { requestId } = await window.academy!.chat!.send({
        messages: history,
        lessonKey: toLessonKey(lessonContext),
        lessonReference: lessonContext?.reference,
        useFullDocs: typeof navigator !== 'undefined' && navigator.onLine && useFullDocs,
      });
      pendingChatRequestIdRef.current = requestId;
      pendingChatEntryIdRef.current = assistantId;
      setChatPendingRequestId(requestId);
    } catch (err) {
      setChatError(err instanceof Error ? err.message : 'Could not send the message.');
      setEntries((prev) =>
        prev.map((e) => (e.id === assistantId && e.kind === 'chat-assistant' ? { ...e, streaming: false } : e)),
      );
    }
  }, [draft, entries, lessonContext, modelName, readOnly, useFullDocs, setEntries]);

  const handleStop = useCallback(() => {
    const requestId = pendingChatRequestIdRef.current;
    if (!requestId) return;
    void window.academy?.chat?.stop?.(requestId).catch(() => undefined);
    pendingChatRequestIdRef.current = null;
    pendingChatEntryIdRef.current = null;
    setChatPendingRequestId(null);
  }, []);

  const isStreaming = chatPendingRequestId !== null;
  const disabledReason = readOnly
    ? undefined
    : chatUnavailable
      ? 'AI chat is only available in the desktop app.'
      : !modelName && !modelLoading
        ? 'Configure the AI bot in Settings to ask questions.'
        : undefined;

  return (
    <div className="mx-auto w-full min-w-0 max-w-sm">
      <div
        className="flex h-9 items-center gap-1.5 rounded-md border border-canvas-border bg-canvas px-2"
        title={disabledReason}
      >
        <textarea
          rows={1}
          value={draft}
          disabled={readOnly || !modelName}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && !e.shiftKey) {
              e.preventDefault();
              void handleSend();
            }
          }}
          placeholder={disabledReason ?? 'Ask about this lesson…'}
          className="min-w-0 flex-1 resize-none bg-transparent font-mono text-xs text-canvas-muted-foreground outline-none placeholder:text-canvas-muted-foreground/60 disabled:cursor-not-allowed"
          style={{ height: '20px' }}
        />
        <ModelSwitcher
          modelName={modelName}
          options={installedChatModels}
          busy={switchingModel}
          onSelect={handleSwitchModel}
        />
        {isStreaming ? (
          <button
            type="button"
            onClick={handleStop}
            aria-label="Stop response"
            className="inline-flex shrink-0 items-center justify-center gap-1 rounded bg-red-500/20 text-red-400 transition-colors hover:bg-red-500/30"
            style={{ height: '24px', width: '24px', boxSizing: 'border-box', padding: 0 }}
          >
            <Square className="size-3 fill-current" />
          </button>
        ) : (
          <button
            type="button"
            onClick={() => void handleSend()}
            disabled={readOnly || !modelName || draft.trim().length === 0}
            aria-label="Send"
            className="inline-flex shrink-0 items-center justify-center gap-1 rounded bg-emerald-500 text-canvas transition-colors hover:bg-emerald-400 disabled:cursor-not-allowed disabled:opacity-50"
            style={{ height: '24px', width: '24px', boxSizing: 'border-box', padding: 0 }}
          >
            <ArrowUp className="size-3.5" />
          </button>
        )}
      </div>
      {chatError ? <p className="mt-1 px-1 text-[10px] text-red-400">{chatError}</p> : null}
    </div>
  );
}

function ModelSwitcher({
  modelName,
  options,
  busy,
  onSelect,
}: {
  modelName: string | null;
  options: string[];
  busy: boolean;
  onSelect: (modelName: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const onMouseDown = (e: MouseEvent) => {
      if (!ref.current?.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener('mousedown', onMouseDown);
    return () => document.removeEventListener('mousedown', onMouseDown);
  }, [open]);

  if (!modelName && options.length === 0) return null;

  return (
    <div ref={ref} className="relative min-w-0 shrink-0" style={{ height: '24px' }}>
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        disabled={busy || options.length === 0}
        aria-haspopup="listbox"
        aria-expanded={open}
        className="inline-flex max-w-[8rem] items-center gap-1 rounded border border-emerald-500/40 bg-emerald-500/10 px-1.5 font-mono text-[9px] uppercase tracking-widest text-emerald-400 transition-colors hover:bg-emerald-500/20 disabled:cursor-not-allowed disabled:opacity-60"
        style={{ height: '24px', width: '100%', boxSizing: 'border-box' }}
      >
        {busy ? <Loader2 className="size-2.5 shrink-0 animate-spin" /> : null}
        <span className="truncate">{modelName ? shortName(modelName) : 'Pick model'}</span>
        {options.length > 0 ? <ChevronDown className="size-2.5 shrink-0" /> : null}
      </button>
      {open ? (
        <div
          role="listbox"
          aria-label="Chat model"
          className="absolute bottom-full right-0 z-10 mb-1 w-48 overflow-hidden rounded-md border border-canvas-border bg-canvas-muted py-1 shadow-lg shadow-black/30"
        >
          {options.map((name) => (
            <button
              key={name}
              type="button"
              role="option"
              aria-selected={name === modelName}
              onClick={() => {
                setOpen(false);
                onSelect(name);
              }}
              className={`flex w-full items-center justify-between gap-2 px-2.5 py-1.5 text-left text-[11px] transition-colors hover:bg-canvas ${
                name === modelName ? 'text-emerald-400' : 'text-canvas-foreground'
              }`}
            >
              <span className="truncate">{shortName(name)}</span>
              {name === modelName ? <Check className="size-3 shrink-0" /> : null}
            </button>
          ))}
        </div>
      ) : null}
    </div>
  );
}

// Every entry kind (run, check, user, assistant) shares this shape — a
// small uppercase label bar over content — so the timeline reads as one
// consistent surface instead of code-output cards next to chat bubbles.
function EntryCard({
  label,
  icon,
  accent = false,
  children,
}: {
  label: string;
  icon?: React.ReactNode;
  accent?: boolean;
  children: React.ReactNode;
}) {
  return (
    <div className="max-w-full overflow-hidden rounded-lg border border-canvas-border bg-canvas">
      <div
        className={`flex items-center gap-1.5 border-b border-canvas-border px-2.5 py-1 text-[10px] font-semibold uppercase tracking-wider ${
          accent ? 'text-emerald-400' : 'text-canvas-muted-foreground'
        }`}
      >
        {icon}
        <span>{label}</span>
      </div>
      {children}
    </div>
  );
}

function ThinkingIndicator() {
  return (
    <EntryCard label="assistant" icon={<Loader2 className="size-2.5 animate-spin" />} accent>
      <p className="px-3 py-2 font-mono text-xs text-canvas-muted-foreground">Thinking…</p>
    </EntryCard>
  );
}

function UserBubble({ content }: { content: string }) {
  return (
    <EntryCard label="you">
      <p className="whitespace-pre-wrap px-3 py-2 font-mono text-xs text-canvas-muted-foreground">{content}</p>
    </EntryCard>
  );
}

function AssistantBubble({ content }: { content: string }) {
  return (
    <EntryCard label="assistant" icon={<Sparkles className="size-2.5" />} accent>
      <p className="whitespace-pre-wrap px-3 py-2 font-mono text-xs text-canvas-muted-foreground">{content}</p>
    </EntryCard>
  );
}

function CheckCard({
  entry,
  onStop,
}: {
  entry: Extract<ConsoleEntry, { kind: 'check' }>;
  onStop: () => void;
}) {
  return (
    <EntryCard label="check">
      <div className="px-3 py-2.5">
      <ul className="space-y-1.5">
        {entry.structural.map((r) => {
          const aiItem = entry.aiItems?.[r.id];
          const flagged = r.passed && entry.ai === 'done' && aiItem && aiItem.verdict !== 'pass';
          return (
            <li key={r.id}>
              <div className="flex items-start gap-2">
                <span
                  className={`mt-0.5 flex size-4 shrink-0 items-center justify-center rounded-sm border ${
                    r.passed
                      ? 'border-emerald-500/60 bg-emerald-500/15 text-emerald-400'
                      : 'border-canvas-border text-canvas-muted-foreground'
                  }`}
                >
                  {r.passed ? <Check className="size-3" /> : <X className="size-3" />}
                </span>
                <span className={r.passed ? 'text-canvas-foreground' : 'text-canvas-muted-foreground'}>
                  {r.description}
                </span>
              </div>
              {flagged ? (
                <div className="ml-6 mt-1 flex items-start gap-1.5 text-xs text-amber-400">
                  <AlertTriangle className="mt-0.5 size-3.5 shrink-0" />
                  <span>{aiItem.reason}</span>
                </div>
              ) : null}
            </li>
          );
        })}
      </ul>
      {entry.ai === 'loading' ? (
        <div className="mt-2 flex items-center gap-2 text-xs text-canvas-muted-foreground">
          <Loader2 className="size-3 animate-spin" />
          <span>Reviewing your code…</span>
          <button
            type="button"
            onClick={onStop}
            className="ml-1 rounded px-1.5 py-0.5 font-semibold text-canvas-muted-foreground transition-colors hover:bg-canvas-muted hover:text-canvas-foreground"
          >
            Stop
          </button>
        </div>
      ) : null}
      {entry.ai === 'unavailable' ? (
        <p className="mt-2 text-xs text-canvas-muted-foreground">
          AI review unavailable — showing structural checks only.
        </p>
      ) : null}
      {entry.ai === 'error' ? (
        <p className="mt-2 text-xs text-amber-400">{entry.aiError ?? 'AI review failed. Try Check Answer again.'}</p>
      ) : null}
      </div>
    </EntryCard>
  );
}

function RunCard({ entry }: { entry: Extract<ConsoleEntry, { kind: 'run' }> }) {
  return (
    <EntryCard label="run" icon={entry.status === 'running' ? <Loader2 className="size-2.5 animate-spin" /> : undefined}>
      <div className="max-h-72 overflow-auto font-mono text-xs">
        <OutputView lines={entry.lines} isAnimating={entry.status === 'running'} />
      </div>
    </EntryCard>
  );
}

function EmptyState() {
  return (
    <p className="px-1 py-1 text-xs text-canvas-muted-foreground">
      Run your code, check your answer, or ask a question. It all shows up here.
    </p>
  );
}

// --- Run output rendering, moved here from lesson-workspace.tsx: this is the
// console's job now that run output is a card in the timeline, not a tab. ---

// Every write logs `[saved] <absolute path>`, which the footer makes clickable.
const SAVED_LINE = /^\[saved\]\s+(.+)$/;

function savedFilesFrom(lines: OutputLine[]): string[] {
  const out: string[] = [];
  for (const { line } of lines) {
    const m = line.match(SAVED_LINE);
    if (m?.[1] && !out.includes(m[1])) out.push(m[1]);
  }
  return out;
}

function SavedFilesBar({ files }: { files: string[] }) {
  const home = files[0]?.match(/^(\/Users\/[^/]+|\/home\/[^/]+|[A-Z]:\\Users\\[^\\]+)/)?.[1];
  const pretty = (p: string) => (home && p.startsWith(home) ? `~${p.slice(home.length)}` : p);
  return (
    <div className="mt-3 space-y-2 border-t border-canvas-border pt-2 font-sans text-xs">
      {files.map((file) => (
        <SavedPreview key={`preview-${file}`} file={file} />
      ))}
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1 font-sans text-xs">
        <span className="text-canvas-muted-foreground">
          Saved {files.length === 1 ? 'file' : `${files.length} files`} to
        </span>
        {files.map((file) => (
          <button
            key={file}
            type="button"
            onClick={() => void window.academy?.reveal?.(file)}
            className="max-w-full truncate rounded border border-canvas-border px-2 py-0.5 text-canvas-foreground hover:bg-canvas-muted"
            title={`Show ${file} in your file manager`}
          >
            {pretty(file)}
          </button>
        ))}
      </div>
    </div>
  );
}

const PREVIEWABLE_EXTS = new Set(['png', 'jpg', 'jpeg', 'webp', 'gif', 'mp4', 'webm', 'mov', 'avi', 'mp3', 'wav']);

function isPreviewable(file: string): boolean {
  const m = file.toLowerCase().match(/[^./]+\.([a-z0-9]+)$/);
  return !!m && PREVIEWABLE_EXTS.has(m[1]);
}

function SavedPreview({ file }: { file: string }) {
  const [src, setSrc] = useState<string | null>(null);
  const [kind, setKind] = useState<'image' | 'video' | 'audio' | null>(null);

  useEffect(() => {
    let cancelled = false;
    setSrc(null);
    setKind(null);
    if (!isPreviewable(file)) return () => {};
    if (typeof window === 'undefined' || !window.academy?.readSaved) return () => {};
    void window.academy
      .readSaved(file)
      .then((res) => {
        if (cancelled || !res) return;
        const lower = file.toLowerCase();
        if (
          lower.endsWith('.png') ||
          lower.endsWith('.jpg') ||
          lower.endsWith('.jpeg') ||
          lower.endsWith('.webp') ||
          lower.endsWith('.gif')
        ) {
          setKind('image');
        } else if (
          lower.endsWith('.mp4') ||
          lower.endsWith('.webm') ||
          lower.endsWith('.mov') ||
          lower.endsWith('.avi')
        ) {
          setKind('video');
        } else if (lower.endsWith('.mp3') || lower.endsWith('.wav')) {
          setKind('audio');
        }
        setSrc(`data:${res.mime};base64,${res.base64}`);
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [file]);

  if (!kind || !src) return null;
  if (kind === 'image') {
    return <img src={src} alt="Saved by this run" className="max-h-72 max-w-full rounded" />;
  }
  if (kind === 'video') {
    return <video src={src} controls className="max-h-72 max-w-full rounded" />;
  }
  return <audio src={src} controls className="w-full" />;
}

function OutputView({ lines, isAnimating }: { lines: OutputLine[]; isAnimating: boolean }) {
  const savedFiles = savedFilesFrom(lines);
  // Find the latest finetune tick. Format: `▸ epoch=1 step=1 batch=1/16 ...`.
  const tickPattern = /epoch=(\d+)\s+step=(\d+)\s+batch=(\d+)\/(\d+)/;
  // The trainer skips a tick on the last step, so without this the bar caps below 100%.
  const completedPattern = /(Training completed through step \d+|status:\s*COMPLETED)/;
  const progress = (() => {
    let latestStep = 0;
    let latestEpoch = 1;
    let totalBatches = 0;
    let completed = false;
    for (const { line } of lines) {
      const m = line.match(tickPattern);
      if (m) {
        latestEpoch = Number(m[1]);
        latestStep = Number(m[2]);
        if (Number(m[4]) > totalBatches) totalBatches = Number(m[4]);
      }
      if (completedPattern.test(line)) completed = true;
    }
    if (totalBatches === 0) return null;
    const totalEpochs = Math.max(1, Math.ceil(latestStep / totalBatches));
    const totalSteps = totalEpochs * totalBatches;
    const percent = completed ? 100 : Math.min(100, Math.round((latestStep / totalSteps) * 100));
    return {
      currentStep: latestStep,
      totalSteps,
      epoch: latestEpoch,
      totalEpochs,
      percent,
      completed,
    };
  })();
  // Rotating word indicator so a slow first-token latency doesn't look like a frozen run.
  const THINKING_WORDS = [
    'Thinking',
    'Strategizing',
    'Analyzing',
    'Reasoning',
    'Considering',
    'Advancing',
    'Processing',
    'Reflecting',
    'Pondering',
    'Adjusting',
    'Distilling',
    'Synthesizing',
    'Working',
    'Computing',
    'Crunching',
  ];
  const [wordIndex, setWordIndex] = useState(0);
  useEffect(() => {
    if (!isAnimating) {
      setWordIndex(0);
      return;
    }
    const id = setInterval(() => {
      setWordIndex((i) => (i + 1) % THINKING_WORDS.length);
    }, 1000);
    return () => clearInterval(id);
  }, [isAnimating]);

  return (
    <div className="space-y-1 p-4 text-canvas-muted-foreground">
      {lines.length === 0 && !isAnimating ? (
        <>
          <p className="text-emerald-400">$ Run your code to see results</p>
          <p>
            <span className="text-emerald-400">$</span>
            <span className="ml-1 inline-block h-3 w-2 animate-pulse bg-emerald-400 align-middle" />
          </p>
        </>
      ) : null}
      {progress ? (
        <div className="mb-2 rounded border border-canvas-border bg-canvas/50 p-2">
          <div className="mb-1 flex items-center justify-between font-mono text-xs">
            <span className="text-emerald-400">
              {progress.completed
                ? 'Training complete'
                : `Training: step ${progress.currentStep} / ${progress.totalSteps} (epoch ${progress.epoch} / ${progress.totalEpochs})`}
            </span>
            <span className="text-canvas-muted-foreground">{progress.percent}%</span>
          </div>
          <div className="h-1.5 w-full overflow-hidden rounded-full bg-canvas-muted">
            <div
              className="h-full bg-emerald-500 transition-all duration-300 ease-out"
              style={{ width: `${progress.percent}%` }}
            />
          </div>
        </div>
      ) : null}
      {(() => {
        // Collapses single newlines to spaces and keeps double as paragraph breaks; falls back to line-by-line when finetune progress lines are present.
        const hasFinetuneProgress = lines.some((e) => e.stream === 'stdout' && /^▸\s+epoch=/.test(e.line));

        if (hasFinetuneProgress) {
          const firstBlank = lines.findIndex((e) => e.stream === 'stdout' && e.line === '');
          const prefixEnd = firstBlank === -1 ? lines.length : firstBlank;
          return lines.map((entry, i) => {
            const isStderr = entry.stream === 'stderr';
            const isPrefix = !isStderr && i < prefixEnd;
            const className =
              isStderr || isPrefix
                ? 'whitespace-pre-wrap text-canvas-muted-foreground/60 italic'
                : 'whitespace-pre-wrap';
            return (
              <p key={i} className={className}>
                {entry.line}
              </p>
            );
          });
        }

        const stdoutText = lines
          .filter((e) => e.stream === 'stdout')
          .map((e) => e.line)
          .join('\n');
        const stdoutParagraphs = stdoutText
          .split(/\n{2,}/)
          .map((p) => p.replace(/\n+/g, ' ').trim())
          .filter(Boolean);
        const dimFirstStdout = stdoutParagraphs.length > 1;

        const stderrLines = lines.filter((e) => e.stream === 'stderr');

        const renderStdout = stdoutParagraphs.map((para, i) => {
          const isPrefix = dimFirstStdout && i === 0;
          return (
            <p
              key={`out-${i}`}
              className={isPrefix ? 'whitespace-pre-wrap text-canvas-muted-foreground/60 italic' : 'whitespace-pre-wrap'}
            >
              {para}
            </p>
          );
        });

        const renderStderr = stderrLines.map((entry, i) => (
          <p key={`err-${i}`} className="whitespace-pre-wrap text-canvas-muted-foreground/60 italic">
            {entry.line}
          </p>
        ));

        return (
          <>
            {renderStdout}
            {renderStderr}
          </>
        );
      })()}
      {isAnimating ? (
        <p className="text-emerald-400">
          <span
            key={wordIndex}
            className="inline-block animate-pulse animate-in fade-in slide-in-from-left-2 duration-200"
          >
            {THINKING_WORDS[wordIndex]}...
          </span>
        </p>
      ) : null}
      {savedFiles.length > 0 ? <SavedFilesBar files={savedFiles} /> : null}
    </div>
  );
}
