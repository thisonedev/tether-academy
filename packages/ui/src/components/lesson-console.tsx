'use client';

import type { AcademyChatChunk, AcademyChatMessage, MatchStatus } from '@academy/validation';
import { Check, Loader2, Settings, Square, X } from 'lucide-react';
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

// A run whose checks are all cached finishes its stages inside one frame, so
// they all appear at once and nothing reads as having happened. Revealing them a
// beat apart paces only when a row appears; its duration stays the measured one.
const STAGE_REVEAL_MS = 1200;

/**
 * How many rows to show, in order, so output never appears above a stage still
 * waiting its turn. `paced` marks the rows that wait, read through a ref so a
 * fresh array each render does not restart the timer. `settled` shows a run
 * that was already over on mount all at once.
 */
function useRevealed(total: number, paced: boolean[], settled: boolean): number {
  const pacedRef = useRef(paced);
  pacedRef.current = paced;
  // Read once on mount and never again: a run that finishes mid-reveal keeps
  // revealing rather than dumping the rest at once.
  const [shown, setShown] = useState(() => (settled ? total : 0));
  useEffect(() => {
    if (shown >= total) return;
    const id = setTimeout(() => setShown((n) => n + 1), pacedRef.current[shown] ? STAGE_REVEAL_MS : 0);
    return () => clearTimeout(id);
  }, [shown, total]);
  return Math.min(shown, total);
}

// Gutter dot + connector rail. User bubbles skip this. Dot color: grey=in flight, green=ok, red=fail.
type TimelineState = 'thinking' | 'success' | 'failure' | 'neutral';

// Grey while it is happening or when it is only output, green once it
// finished, red when it did not.
const DOT_BUSY = 'bg-canvas-muted-foreground animate-pulse';
const DOT_DONE = 'bg-emerald-500';
const DOT_FAIL = 'bg-red-500';
const DOT_IDLE = 'bg-canvas-muted-foreground';

const TIMELINE_DOT: Record<TimelineState, string> = {
  thinking: DOT_BUSY,
  success: DOT_DONE,
  failure: DOT_FAIL,
  neutral: DOT_IDLE,
};

// One geometry for every row on the rail, so a chat reply, a host stage and a
// line of output all hang off one line at one size.
const RAIL_ROW = 'relative pl-[22px]';
const RAIL_LINE = 'absolute inset-y-0 left-[5px] w-px bg-canvas-border';
const RAIL_DOT = 'absolute left-[1px] size-[9px] rounded-full';
// Every row pads itself equally, so one offset serves all of them.
// Padding the children instead left the dot centred on some rows, adrift on others.
const ROW_PAD = 3;
// A boxed row starts its text one border and one padding lower, so the dot has
// to know which it is marking. Change one of these and the other has to follow.
const RAIL_CARD = 'max-w-full overflow-hidden rounded-lg border border-canvas-border px-2.5 py-1.5';
const CARD_INSET = 1 + 6;
// Centre of a 16px first line, less half the dot, plus a point and a half:
// a monospace glyph reads low in its line box because of the ascender space.
const DOT_OFFSET = 5;

function RailRow({
  dot,
  card = false,
  children,
}: {
  dot: string;
  /** Wrap the content in a box. The row owns this so the dot can allow for it. */
  card?: boolean;
  children: React.ReactNode;
}) {
  return (
    <div className={RAIL_ROW} style={{ paddingTop: ROW_PAD, paddingBottom: ROW_PAD }}>
      {/* Padding, not margin: the line spans the full row, so spacing a row
          out does not leave a gap in the rail. */}
      <span className={RAIL_LINE} />
      {/* Ringed in the panel background so the line does not run through it. */}
      <span
        className={`${RAIL_DOT} ${dot}`}
        style={{
          top: ROW_PAD + (card ? CARD_INSET : 0) + DOT_OFFSET,
          boxShadow: `0 0 0 3px ${QVAC_EDITOR_BACKGROUND}`,
        }}
      />
      <div className="min-w-0">{card ? <div className={RAIL_CARD}>{children}</div> : children}</div>
    </div>
  );
}

function TimelineRow({
  state,
  card,
  children,
}: {
  state: TimelineState;
  card?: boolean;
  children: React.ReactNode;
}) {
  return (
    <RailRow dot={TIMELINE_DOT[state]} card={card}>
      {children}
    </RailRow>
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
      className="min-h-0 flex-1 space-y-0 overflow-x-hidden overflow-y-auto p-3 text-sm"
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
            <TimelineRow key={entry.id} state={entry.streaming ? 'thinking' : 'success'} card>
              <AssistantBubble content={entry.content} />
            </TimelineRow>
          );
        }
        // No outer dot: the run's own stages carry theirs, and this one used
        // to appear the moment a run started, before it had anything to show.
        if (entry.kind === 'run') return <RunCard key={entry.id} entry={entry} />;
        return (
          <TimelineRow key={entry.id} state={checkState(entry)} card>
            <CheckCard entry={entry} onStop={() => onStopCheck(entry.id)} />
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
      const [current, configured, suggestion] = await Promise.all([
        window.academy!.chat!.currentModel().catch(() => null),
        window.academy!.chat!.configuredModel().catch(() => null),
        window.academy!.models?.recommend(null).catch(() => null) ?? Promise.resolve(null),
      ]);
      if (cancelled) return;
      if (current) {
        setModelName(current);
        setModelLoading(false);
        return;
      }
      // The configured model can be one this device never finished
      // downloading, so only auto-load it if it's actually on disk; an
      // uninstalled recommendation is not consent to download it.
      const onDisk = new Set((suggestion?.ranked ?? []).filter((e) => e.installed).map((e) => e.name));
      const wanted = configured && onDisk.has(configured) ? configured : null;
      if (!wanted) {
        setModelLoading(false);
        return;
      }
      try {
        const loaded = await window.academy!.chat!.load(wanted);
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
      // The catalogue resolves each preset to its own file. The file list is
      // keyed by display name, which offered a chat model whose copy was still
      // downloading.
      const entries = await window.academy.models.catalogue();
      const installedNames = entries
        .filter((e) => e.family === 'chat' && e.installed && isAiBotModel(e.name))
        .map((e) => e.name);
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
    <div className="w-full min-w-0" style={{ backgroundColor: QVAC_EDITOR_BACKGROUND }}>
      {/* No box of its own: the editor's background carries through and only a
          rule above and below separates it, so it reads as part of the panel. */}
      <div
        className="flex h-9 items-center gap-2 border-t border-canvas-border px-3"
        title={disabledReason}
      >
        <span aria-hidden className="shrink-0 font-mono text-xs leading-4 text-canvas-muted-foreground/70">
          &rsaquo;
        </span>
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
          // The `›` already says "type here", so the only placeholder left is
          // the one that explains why you cannot.
          placeholder={disabledReason ?? ''}
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
        ) : null}
      </div>
      {chatError ? <p className="mt-1 px-1 text-[10px] text-red-400">{chatError}</p> : null}
    </div>
  );
}

// Same control as the run-mode and paired-device pickers in the editor
// toolbar: a native select, so the three read as one family and the popup
// this used to open is the platform's.
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
  if (!modelName && options.length === 0) return null;

  return (
    <div className="flex shrink-0 items-center gap-1">
      {busy ? <Loader2 className="size-2.5 shrink-0 animate-spin text-canvas-muted-foreground" /> : null}
      <select
        aria-label="Chat model"
        title="Chat model"
        value={modelName ?? ''}
        onChange={(e) => onSelect(e.target.value)}
        disabled={busy || options.length === 0}
        suppressHydrationWarning
        className="min-w-0 max-w-[6rem] truncate rounded border border-canvas-border bg-transparent px-1.5 py-1 sm:max-w-[9rem] text-[10px] font-medium tracking-wider text-canvas-muted-foreground uppercase transition-colors hover:text-canvas-foreground focus:border-emerald-500/60 focus:ring-1 focus:ring-emerald-500/30 focus:outline-none disabled:cursor-not-allowed disabled:opacity-40"
      >
        {modelName ? null : <option value="">Pick model</option>}
        {options.map((name) => (
          <option key={name} value={name}>
            {shortName(name)}
          </option>
        ))}
      </select>
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
      <div className="flex items-center gap-1.5 pb-1 text-[10px] font-semibold uppercase leading-4 tracking-wider text-canvas-muted-foreground">
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
      <p className="wrap-anywhere whitespace-pre-wrap font-mono text-xs text-canvas-foreground">{content}</p>
    </div>
  );
}

function AssistantBubble({ content }: { content: string }) {
  return (
    <p className="wrap-anywhere whitespace-pre-wrap font-mono text-xs text-canvas-muted-foreground">{content}</p>
  );
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
      <div className="font-mono text-xs">
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
  // One rail row per segment: a stage as a labelled row, output as a card.
  const body: React.ReactNode[] = [];
  // Parallel to `body`: true where the row is a host stage, the only kind the
  // reveal below paces. Output is never held back.
  const paced: boolean[] = [];
  for (let i = 0; i < segments.length; i++) {
    const segment = segments[i];
    if (segment.kind === 'stage') {
      body.push(<StageRow key={`stage-${i}`} stage={segment} />);
      // Only the host's own stages are paced. A call already appears at the
      // moment the lesson makes it.
      paced.push(!segment.call);
      continue;
    }
    // Blank lines between two stages would otherwise draw a rail dot with
    // nothing beside it. A progress bar counts as content, download ticks or not.
    const own = progress && progress.at >= segment.from && progress.at < segment.from + segment.count;
    const speaks = allLines
      .slice(segment.from, segment.from + segment.count)
      .some((l) => l.line.trim().length > 0);
    if (!speaks && !own) continue;
    const out = (
      <SegmentLines
        lines={allLines}
        segment={segment}
        progress={progress}
        // Only the run's opening output can be a preamble, so a later segment
        // does not dim its own first paragraph too.
        dimPreamble={segment === firstLines}
      />
    );
    body.push(<OutputRow key={`lines-${i}`}>{out}</OutputRow>);
    paced.push(false);
  }

  const revealed = useRevealed(body.length, paced, !isAnimating);
  const visible = body.slice(0, revealed);

  // The rail line is drawn once behind every row, so consecutive stages share
  // one continuous line instead of each stacking its own segment.
  return (
    <div className="text-canvas-muted-foreground">
      {allLines.length === 0 && !isAnimating ? (
        <>
          <p className="text-emerald-400">$ Run your code to see results</p>
          <p>
            <span className="text-emerald-400">$</span>
            <span className="ml-1 inline-block h-3 w-2 animate-pulse bg-emerald-400 align-middle" />
          </p>
        </>
      ) : null}
      <div>{visible}</div>
      {savedFiles.length > 0 ? <SavedFilesBar files={savedFiles} /> : null}
    </div>
  );
}

// A stage still open pulses; one the host skipped is a passive row with no
// time of its own. The wording is the closer once there is one, since that
// carries the outcome the opener could only promise.
function StageRow({ stage }: { stage: StageSegment }) {
  const open = stage.state === 'open';
  const passive = stage.state === 'note';
  const label = stage.call || open ? stage.openLabel.replace(/\.{3}$/, '') : stage.closeLabel;
  const dot = open ? DOT_BUSY : passive ? `${DOT_IDLE}/50` : DOT_DONE;
  return (
    <RailRow dot={dot}>
      <div className="flex justify-between gap-3">
        <span className={passive ? 'text-canvas-muted-foreground/75' : 'text-canvas-foreground'}>{label}</span>
        {stage.seconds !== null ? (
          <span className="shrink-0 text-[11px] whitespace-nowrap text-canvas-muted-foreground">
            {formatSeconds(stage.seconds)}
          </span>
        ) : null}
      </div>
    </RailRow>
  );
}

// Program output, as its own row rather than loose text under the last stage.
// The dot stays neutral, since the lesson printed this and the host did not.
function OutputRow({ children }: { children: React.ReactNode }) {
  return (
    <RailRow dot={DOT_IDLE} card>
      {children}
    </RailRow>
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
                ? 'wrap-anywhere whitespace-pre-wrap text-canvas-muted-foreground/60 italic'
                : 'wrap-anywhere whitespace-pre-wrap';
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
        const dim = 'wrap-anywhere whitespace-pre-wrap text-canvas-muted-foreground/60 italic';

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
                  <p key={`out-${g}-${i}`} className={isPrefix ? dim : 'wrap-anywhere whitespace-pre-wrap'}>
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
