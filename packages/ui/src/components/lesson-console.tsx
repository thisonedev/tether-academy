'use client';

import type { AcademyChatChunk, AcademyChatMessage, MatchStatus } from '@academy/validation';
import { ArrowUp, Check, ChevronDown, Loader2, Settings, Square, X } from 'lucide-react';
import Link from 'next/link';
import { useCallback, useEffect, useRef, useState } from 'react';
import { isAiBotModel } from './ai-bot-models.js';
import { type LessonProgress, parseProgress } from './lesson-progress.js';
import { formatSeconds, type RunSegment, type StageSegment, splitStages } from './lesson-stages.js';
import { QVAC_EDITOR_BACKGROUND } from './qvac-theme.js';
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

export type ConsoleEntry =
  | { kind: 'chat-user'; id: string; content: string }
  | { kind: 'chat-assistant'; id: string; content: string; streaming: boolean }
  | {
      kind: 'run';
      id: string;
      lines: OutputLine[];
      status: 'running' | 'ok' | 'err' | 'stopped';
      /** Paired device's display name; unset/null means this device. */
      deviceLabel?: string | null;
    }
  | {
      kind: 'check';
      id: string;
      structural: ConsoleCheckResult[];
      ai: 'idle' | 'loading' | 'done' | 'error' | 'unavailable';
      /** 'match' means a formatting-only comparison against the answer
       *  matched, decided client-side without calling the AI. */
      aiVerdict?: MatchStatus;
      aiReason?: string;
      aiError?: string;
    };

/** Timeline panel. Typing happens in the separate `ChatInputBar`, which
 *  appends into the same `entries`. */
export interface LessonConsoleProps {
  entries: ConsoleEntry[];
  /** Cancels an in-progress AI review for the given check entry. */
  onStopCheck: (entryId: string) => void;
}

/** Chat input for the bottom nav. Owns the model/send/stop machinery;
 *  replies land in the shared `entries` array. */
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

// Extracts the billions parameter count from filenames like Qwen3-0.6B-Q4_0
// → 0.6 or Llama-3.2-1B-Instruct-Q4_0 → 1. Only a number immediately
// followed by `B` counts, so version strings and quantisation tags skip.
// Unknown names sort last rather than collapsing to 0.
function paramCountB(filename: string): number {
  const match = /(\d+(?:\.\d+)?)B(?![a-z])/i.exec(filename);
  return match ? Number(match[1]) : Number.POSITIVE_INFINITY;
}

// Smallest model first, so the picker reads as a size ladder instead of
// whatever order the on-disk listing happened to produce.
function byParamCount(a: string, b: string): number {
  return paramCountB(a) - paramCountB(b) || a.localeCompare(b);
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

// One per download tick, rendered as the progress bar instead of as output.
const DOWNLOAD_TICK_LINE = /^\s*▸\s*Downloading\s+\d+(?:\.\d+)?%/;

// Rotating word so a slow model doesn't look frozen.
const SHUFFLE_WORDS = [
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

function useShuffleWord(active: boolean): string {
  const [index, setIndex] = useState(0);
  useEffect(() => {
    if (!active) {
      setIndex(0);
      return;
    }
    const id = setInterval(() => setIndex((i) => (i + 1) % SHUFFLE_WORDS.length), 1000);
    return () => clearInterval(id);
  }, [active]);
  return SHUFFLE_WORDS[index];
}

function ShuffleWord({ active, className = '' }: { active: boolean; className?: string }) {
  const word = useShuffleWord(active);
  return (
    <span key={word} className={`inline-block animate-in fade-in slide-in-from-left-2 duration-200 ${className}`}>
      {word}…
    </span>
  );
}

// Gutter dot + connector rail. User bubbles skip this. Dot color: grey=in flight, green=ok, red=fail.
type TimelineState = 'thinking' | 'success' | 'failure' | 'neutral';

const TIMELINE_DOT: Record<TimelineState, string> = {
  thinking: 'bg-canvas-muted-foreground animate-pulse',
  success: 'bg-emerald-500',
  failure: 'bg-red-500',
  neutral: 'bg-canvas-muted-foreground',
};

function TimelineRow({ state, children }: { state: TimelineState; children: React.ReactNode }) {
  return (
    <div className="flex gap-3">
      <div className="relative flex w-3 shrink-0 justify-center">
        {/* Rail first, dot second: keeps the colored dot on top of the line. */}
        <span className="absolute inset-y-0 top-1.5 left-1/2 w-px -translate-x-1/2 bg-canvas-border" />
        <span className={`relative z-10 mt-1.5 size-1.5 shrink-0 rounded-full ${TIMELINE_DOT[state]}`} />
      </div>
      <div className="min-w-0 flex-1">{children}</div>
    </div>
  );
}

export function LessonConsole({ entries, onStopCheck }: LessonConsoleProps) {
  const scrollRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    el.scrollTop = el.scrollHeight;
  }, [entries]);

  // Whatever is still going, named once for the pinned line below. Keeping it
  // out of the scroller is the point: it used to sit after the last output and
  // walk down the panel as more arrived.
  const busy = entries.some(
    (e) => (e.kind === 'run' && e.status === 'running') || (e.kind === 'chat-assistant' && e.streaming),
  );

  return (
    <div className="flex min-h-0 flex-1 flex-col border-t border-canvas-border">
    <div
      ref={scrollRef}
      className="min-h-0 flex-1 space-y-0 overflow-y-auto p-3 text-sm"
      style={{ backgroundColor: QVAC_EDITOR_BACKGROUND }}
    >
      {entries.length === 0 ? <EmptyState /> : null}
      {entries.map((entry) => {
        if (entry.kind === 'chat-user') return <UserBubble key={entry.id} content={entry.content} />;
        if (entry.kind === 'chat-assistant') {
          // The pinned line below already covers an answer with nothing in it
          // yet, so it gets no row of its own until it has something to say.
          if (entry.streaming && entry.content.length === 0) return null;
          return (
            <TimelineRow key={entry.id} state={entry.streaming ? 'thinking' : 'success'}>
              <AssistantBubble content={entry.content} />
            </TimelineRow>
          );
        }
        if (entry.kind === 'run') {
          return (
            <TimelineRow
              key={entry.id}
              state={entry.status === 'running' ? 'thinking' : entry.status === 'ok' ? 'success' : 'failure'}
            >
              <RunCard entry={entry} />
            </TimelineRow>
          );
        }
        return (
          <TimelineRow key={entry.id} state={checkState(entry)}>
            <div className="space-y-2">
              <CheckCard entry={entry} onStop={() => onStopCheck(entry.id)} />
            </div>
          </TimelineRow>
        );
      })}
    </div>
    {busy ? (
      <p
        className="flex items-center gap-2 px-4 py-2 font-mono text-xs text-canvas-muted-foreground"
        style={{ backgroundColor: QVAC_EDITOR_BACKGROUND }}
      >
        <Loader2 className="size-3 animate-spin" />
        <ShuffleWord active />
      </p>
    ) : null}
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
  const [installedAiBotModels, setInstalledAiBotModels] = useState<string[]>([]);
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
      const [current, configured, installed] = await Promise.all([
        window.academy!.chat!.currentModel().catch(() => null),
        window.academy!.chat!.configuredModel().catch(() => null),
        window.academy!.models?.list().catch(() => []) ?? Promise.resolve([]),
      ]);
      if (cancelled) return;
      if (current) {
        setModelName(current);
        setModelLoading(false);
        return;
      }
      if (!configured || !installed.some((m) => m.name === configured && m.complete)) {
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
      const models = await window.academy.models.list();
      // A download in progress already exists at its final filename; only offer models that are actually done.
      const installedNames = models.filter((m) => isAiBotModel(m.name) && m.complete).map((m) => m.name);
      setInstalledAiBotModels(installedNames.sort(byParamCount));
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

  // Chat replies stream in via onChunk, matched to the waiting entry by requestId.
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
  const noModelConfigured = !readOnly && !chatUnavailable && !modelLoading && !modelName;
  const disabledReason = readOnly
    ? undefined
    : chatUnavailable
      ? 'AI chat is only available in the desktop app.'
      : noModelConfigured
        ? 'Configure AI bot to ask questions'
        : undefined;

  return (
    <div className="w-full min-w-0">
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
          placeholder={disabledReason ?? 'How can I help you today?'}
          className="min-w-0 flex-1 resize-none bg-transparent font-mono text-xs leading-4 text-canvas-muted-foreground outline-none placeholder:text-canvas-muted-foreground/60 disabled:cursor-not-allowed"
          style={{ height: '16px' }}
        />
        <ModelSwitcher
          modelName={modelName}
          options={installedAiBotModels}
          busy={switchingModel}
          onSelect={handleSwitchModel}
        />
        {isStreaming ? (
          <button
            type="button"
            onClick={handleStop}
            aria-label="Stop response"
            className="inline-flex shrink-0 items-center justify-center gap-1 rounded text-red-400 transition-colors hover:bg-red-500/10 hover:text-red-300"
            style={{ height: '24px', width: '24px', boxSizing: 'border-box', padding: 0 }}
          >
            <Square className="size-4 fill-current" />
          </button>
        ) : noModelConfigured ? (
          <Link
            href="/settings"
            aria-label="Pick a model in Settings to enable chat"
            title="Pick a model in Settings to enable chat"
            className="inline-flex shrink-0 items-center justify-center gap-1 rounded bg-canvas-muted text-canvas-muted-foreground transition-colors hover:bg-canvas-border hover:text-canvas-foreground"
            style={{ height: '24px', width: '24px', boxSizing: 'border-box', padding: 0 }}
          >
            <Settings className="size-3.5" />
          </Link>
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
    <div ref={ref} className="relative min-w-0 shrink-0" style={{ height: '24px', marginBottom: '5px' }}>
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        disabled={busy || options.length === 0}
        aria-haspopup="listbox"
        aria-expanded={open}
        className="inline-flex max-w-[8rem] items-center gap-1 rounded bg-emerald-500/15 px-1.5 font-mono text-[9px] uppercase leading-none tracking-widest text-emerald-400 transition-colors hover:bg-emerald-500/25 disabled:cursor-not-allowed disabled:opacity-60"
        style={{ height: '24px', width: '100%', boxSizing: 'border-box', lineHeight: '1' }}
      >
        <span className="truncate">{modelName ? shortName(modelName) : 'Pick model'}</span>
        {busy ? (
          <Loader2 className="size-2.5 shrink-0 animate-spin" />
        ) : options.length > 0 ? (
          <ChevronDown className="size-2.5 shrink-0" />
        ) : null}
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

function EntryCard({
  label,
  icon,
  children,
}: {
  label: string;
  icon?: React.ReactNode;
  children: React.ReactNode;
}) {
  return (
    <div className="max-w-full overflow-hidden">
      <div className="flex items-center gap-1.5 pb-1 text-[10px] font-semibold uppercase tracking-wider text-canvas-muted-foreground">
        {icon}
        <span>{label}</span>
      </div>
      {children}
    </div>
  );
}

function UserBubble({ content }: { content: string }) {
  return (
    <div className="my-3 max-w-full overflow-hidden rounded-md border border-canvas-border/60 bg-canvas-muted/40 px-3 py-2">
      <p className="whitespace-pre-wrap font-mono text-xs text-canvas-foreground">{content}</p>
    </div>
  );
}

function AssistantBubble({ content }: { content: string }) {
  return <p className="whitespace-pre-wrap px-1 font-mono text-xs text-canvas-muted-foreground">{content}</p>;
}

// Label shown for each whole-submission verdict. 'match' is set client-side
// (no AI call); the rest come from the AI's own reply.
const VERDICT_WORD: Record<MatchStatus, string> = {
  match: 'Matches',
  complete: 'Complete',
  'different-but-valid': 'Valid',
  unfinished: 'Unfinished',
  wrong: 'Not there yet',
};

// Bare period for anything the AI grades; a fixed filler phrase would
// drown out the AI's own one-sentence reason, which carries the real detail.
const VERDICT_REST: Record<MatchStatus, string> = {
  match: ' the reference solution.',
  complete: '.',
  'different-but-valid': '.',
  unfinished: '.',
  wrong: '.',
};

const PASSING_VERDICTS = new Set<MatchStatus>(['match', 'complete', 'different-but-valid']);

// A failing structural check or AI verdict fails the entry; missing AI review only passes if every structural check did.
function checkState(entry: Extract<ConsoleEntry, { kind: 'check' }>): TimelineState {
  if (entry.ai === 'loading') return 'thinking';
  const structuralPassed = entry.structural.every((r) => r.passed);
  if (entry.ai === 'error') return 'failure';
  if (entry.ai === 'done') {
    const verdictPassed = entry.aiVerdict ? PASSING_VERDICTS.has(entry.aiVerdict) : false;
    return structuralPassed && verdictPassed ? 'success' : 'failure';
  }
  return structuralPassed ? 'success' : 'failure';
}

function CheckCard({
  entry,
  onStop,
}: {
  entry: Extract<ConsoleEntry, { kind: 'check' }>;
  onStop: () => void;
}) {
  const verdictPassed = entry.aiVerdict ? PASSING_VERDICTS.has(entry.aiVerdict) : false;
  return (
    <EntryCard label="check">
      <div className="px-3 py-2.5 font-mono text-xs">
      <ul className="space-y-1.5">
        {entry.structural.map((r) => (
          <li key={r.id} className="flex items-start gap-2">
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
          </li>
        ))}
        {entry.ai === 'done' && entry.aiVerdict ? (
          <li className="flex items-start gap-2">
            <span
              className={`mt-0.5 flex size-4 shrink-0 items-center justify-center rounded-sm border ${
                verdictPassed
                  ? 'border-emerald-500/60 bg-emerald-500/15 text-emerald-400'
                  : 'border-canvas-border text-canvas-muted-foreground'
              }`}
            >
              {verdictPassed ? <Check className="size-3" /> : <X className="size-3" />}
            </span>
            <span className={verdictPassed ? 'text-canvas-foreground' : 'text-canvas-muted-foreground'}>
              <span className="font-semibold">AI reviewer:</span> {VERDICT_WORD[entry.aiVerdict]}
              {VERDICT_REST[entry.aiVerdict]}
              {entry.aiReason ? ` ${entry.aiReason}` : ''}
            </span>
          </li>
        ) : null}
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
          AI review unavailable. Showing structural checks only.
        </p>
      ) : null}
      {entry.ai === 'error' ? (
        <p className="mt-2 text-xs text-amber-400">{entry.aiError ?? 'AI review failed. Try Check Answer again.'}</p>
      ) : null}
      </div>
    </EntryCard>
  );
}

// No "View code" here: the editor is right next to it. That's for the
// receiving device instead (notification-center.tsx, devices-panel.tsx).
// No spinner on the row: the pinned line below already owns the one spinner
// on screen, and a second for the same run reads as a second thing running.
function RunCard({ entry }: { entry: Extract<ConsoleEntry, { kind: 'run' }> }) {
  return (
    <div className="font-mono text-xs">
      <OutputView lines={entry.lines} isAnimating={entry.status === 'running'} />
    </div>
  );
}

function EmptyState() {
  return (
    <p className="px-1 py-1 font-mono text-xs text-canvas-muted-foreground">
      Run your code, check your answer, or ask a question. It all shows up here.
    </p>
  );
}

// --- Run output rendering ---

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
    let objectUrl: string | null = null;
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
        // Route audio/video through a blob URL so Chromium can stream-decode
        // it and fire loadedmetadata — the data: URL path sometimes leaves the
        // player stuck at 0:00 / 0:00. Images keep the data: URL; CSP forbids
        // blobs for them anyway.
        if (lower.endsWith('.wav') || lower.endsWith('.mp3') || lower.endsWith('.mp4') || lower.endsWith('.webm') || lower.endsWith('.mov') || lower.endsWith('.avi')) {
          const bytes = Uint8Array.from(atob(res.base64), (c) => c.charCodeAt(0));
          const blob = new Blob([bytes], { type: res.mime });
          objectUrl = URL.createObjectURL(blob);
          setSrc(objectUrl);
        } else {
          setSrc(`data:${res.mime};base64,${res.base64}`);
        }
      })
      .catch(() => {});
    return () => {
      cancelled = true;
      if (objectUrl) URL.revokeObjectURL(objectUrl);
    };
  }, [file]);

  if (!kind || !src) return null;
  if (kind === 'image') {
    return <img src={src} alt="Saved by this run" className="max-h-72 max-w-full rounded" />;
  }
  if (kind === 'video') {
    return <video src={src} controls preload="metadata" className="max-h-72 max-w-full rounded" />;
  }
  return <audio src={src} controls preload="metadata" className="w-full" />;
}

function OutputView({ lines: allLines, isAnimating }: { lines: OutputLine[]; isAnimating: boolean }) {
  const savedFiles = savedFilesFrom(allLines);
  const progress = parseProgress(allLines);
  const segments = splitStages(allLines);
  const firstLines = segments.find((s) => s.kind === 'lines');
  // Each host stage becomes an opener and (when the stage closes) a closer.
  const body = segments.map((segment, i) => {
    if (segment.kind === 'stage') {
      // biome-ignore lint/suspicious/noArrayIndexKey: position in the run is the identity
      return <StageTranscript key={`stage-${i}`} stage={segment} />;
    }
    return (
      <SegmentLines
        // biome-ignore lint/suspicious/noArrayIndexKey: position in the run is the identity
        key={`lines-${i}`}
        lines={allLines}
        segment={segment}
        progress={progress}
        // Only the run's opening output can be a preamble, so a later segment
        // does not dim its own first paragraph too.
        dimPreamble={segment === firstLines}
      />
    );
  });

  return (
    <div className="space-y-1 text-canvas-muted-foreground">
      {allLines.length === 0 && !isAnimating ? (
        <>
          <p className="text-emerald-400">$ Run your code to see results</p>
          <p>
            <span className="text-emerald-400">$</span>
            <span className="ml-1 inline-block h-3 w-2 animate-pulse bg-emerald-400 align-middle" />
          </p>
        </>
      ) : null}
      {body}
      {savedFiles.length > 0 ? <SavedFilesBar files={savedFiles} /> : null}
    </div>
  );
}

// Re-emits a host phase as its `→ Open...` and `  ✓ Close (1.2s)` lines.
// A `note` (a `✓` with no opener) shows only the close; a still-open stage
// shows only the opener. The closer pads 2ch in from the opener.
function StageTranscript({ stage }: { stage: StageSegment }) {
  const showOpener = stage.state !== 'note';
  const showCloser = stage.state !== 'open';
  return (
    <>
      {showOpener ? <p className="text-canvas-foreground/80">→ {stage.openLabel}</p> : null}
      {showCloser ? (
        <p className="pl-[2ch] text-canvas-foreground/80">
          ✓ {stage.closeLabel}
          {stage.seconds !== null ? ` (${stage.seconds.toFixed(1)}s)` : ''}
        </p>
      ) : null}
    </>
  );
}

// A run longer than this is a wall of text in a panel a few hundred pixels
// tall, so the tail stays on screen and the rest folds behind one click.
const FOLD_AFTER = 200;

// Output printed while a stage was open, rendered under that stage's row. The
// progress bar renders inside the segment that produced it, so reading a run
// top to bottom does not mean scrolling back up for the bar.
function SegmentLines({
  lines,
  segment,
  progress,
  dimPreamble,
}: {
  lines: OutputLine[];
  segment: Extract<RunSegment, { kind: 'lines' }>;
  progress: LessonProgress | null;
  dimPreamble: boolean;
}) {
  const [expanded, setExpanded] = useState(false);
  const end = segment.from + segment.count;

  // Download ticks render as the bar rather than as lines, so the fold counts
  // what is on screen instead of what the run printed.
  const shown: number[] = [];
  for (let i = segment.from; i < end; i++) {
    if (!DOWNLOAD_TICK_LINE.test(lines[i].line)) shown.push(i);
  }
  const foldable = Math.max(0, shown.length - FOLD_AFTER);
  const start = foldable === 0 || expanded ? segment.from : shown[foldable];

  const own = progress && progress.at >= segment.from && progress.at < end ? progress : null;
  // A bar whose ticks are folded away still belongs on screen, so it leads the
  // visible lines rather than disappearing with them.
  const barLeads = own !== null && own.at < start;
  return (
    <div className="my-1.5">
      {foldable > 0 ? (
        <button
          type="button"
          onClick={() => setExpanded((v) => !v)}
          className="font-mono text-[11px] text-canvas-muted-foreground transition-colors hover:text-canvas-foreground"
        >
          {expanded ? `▴ Hide ${foldable} earlier lines` : `▾ ${foldable} earlier lines`}
        </button>
      ) : null}
      {barLeads && own ? <ProgressBar progress={own} /> : null}
      {own && !barLeads ? (
        <>
          <OutputLines lines={lines.slice(start, own.at + 1)} dimPreamble={dimPreamble} />
          <ProgressBar progress={own} />
          <OutputLines lines={lines.slice(own.at + 1, end)} dimPreamble={false} />
        </>
      ) : (
        <OutputLines lines={lines.slice(start, end)} dimPreamble={dimPreamble} />
      )}
    </div>
  );
}

function ProgressBar({ progress }: { progress: LessonProgress }) {
  return (
    <div className="my-2">
      <div className="mb-1 flex items-center justify-between font-mono text-xs">
        <span className="text-emerald-400">
          {progress.completed ? `${progress.label} complete` : `${progress.label}: ${progress.detail}`}
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
  );
}

function OutputLines({ lines: allLines, dimPreamble }: { lines: OutputLine[]; dimPreamble: boolean }) {
  return (
    <>
      {(() => {
        const lines = allLines.filter((e) => !DOWNLOAD_TICK_LINE.test(e.line));
        // Falls back to line-by-line when finetune progress lines are present.
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

        // Grouped by consecutive stream rather than stdout-then-stderr: the
        // host's stage lines are stderr, so splitting the two puts a result
        // above the steps that produced it.
        const groups: { stream: string; lines: string[] }[] = [];
        for (const entry of lines) {
          const last = groups[groups.length - 1];
          if (last && last.stream === entry.stream) last.lines.push(entry.line);
          else groups.push({ stream: entry.stream, lines: [entry.line] });
        }
        const dim = 'whitespace-pre-wrap text-canvas-muted-foreground/60 italic';

        let stdoutSeen = 0;
        return (
          <>
            {groups.flatMap((group, g) => {
              if (group.stream === 'stderr') {
                return group.lines.map((line, i) => (
                  <p key={`err-${g}-${i}`} className={dim}>
                    {line}
                  </p>
                ));
              }
              const paragraphs = group.lines
                .join('\n')
                .split(/\n{2,}/)
                .map((p) => p.replace(/\n+/g, ' ').trim())
                .filter(Boolean);
              return paragraphs.map((para, i) => {
                // Lessons open with a preamble before their real output; it
                // stays dimmed, but only the very first one across the run.
                const isPrefix = dimPreamble && stdoutSeen++ === 0 && paragraphs.length + g > 1;
                return (
                  <p key={`out-${g}-${i}`} className={isPrefix ? dim : 'whitespace-pre-wrap'}>
                    {para}
                  </p>
                );
              });
            })}
          </>
        );
      })()}
    </>
  );
}
