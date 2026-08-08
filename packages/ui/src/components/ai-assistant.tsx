'use client';

import type { AcademyChatChunk, AcademyChatMessage } from '@academy/validation';
import { Bot, Check, ChevronDown, Eraser, Loader2, Send, Sparkles, Square, X } from 'lucide-react';
import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  forwardRef,
} from 'react';
import { createPortal } from 'react-dom';

const MD_QUERY = '(min-width: 768px)';

export interface AiAssistantLessonContext {
  chapter: string;
  lesson: string;
  title?: string;
  reference?: string;
}

export interface AiAssistantProps {
  /** Anchor element the popover positions against. The component is a controlled
   *  popover: it doesn't render the trigger itself, so the parent decides when
   *  to mount it. Pass `open` to control visibility. */
  open: boolean;
  onClose: () => void;
  /** Ref to the button that triggered the popover. Used to position it. */
  anchorRef: React.RefObject<HTMLElement | null>;
  lessonContext: AiAssistantLessonContext | null;
}

type Phase =
  | { kind: 'loading' }
  | { kind: 'chat'; modelName: string | null; messages: AcademyChatMessage[]; pendingRequestId: string | null };

// Turns a cache filename like "Qwen3-4B-Q4_K_M.gguf" into "Qwen3 4B" for display.
function shortName(filename: string | null | undefined): string {
  if (!filename) return '';
  let name = filename.replace(/\.(gguf|bin|safetensors|pth)$/i, '');
  name = name.replace(/-Instruct/gi, '');
  name = name.replace(/-(?:UD-)?Q\d\w*$/i, '');
  return name.replace(/-/g, ' ');
}

export function AiAssistant({ open, onClose, anchorRef, lessonContext }: AiAssistantProps) {
  const [mounted, setMounted] = useState(false);
  const [isDesktop, setIsDesktop] = useState(false);
  const [position, setPosition] = useState<{ top: number; right: number } | null>(null);
  const [phase, setPhase] = useState<Phase>({ kind: 'loading' });
  const [draft, setDraft] = useState('');
  const [error, setError] = useState<string | null>(null);
  const historyRef = useRef<{ key: string; messages: AcademyChatMessage[] } | null>(null);
  const popoverRef = useRef<HTMLDivElement>(null);
  const messagesRef = useRef<HTMLDivElement>(null);
  const [useFullDocs, setUseFullDocs] = useState(true);
  const [docsStatus, setDocsStatus] = useState<{ available: boolean; source: string; bytes: number; expiresAt: number } | null>(null);
  const [installedChatModels, setInstalledChatModels] = useState<string[]>([]);
  const [switchingModel, setSwitchingModel] = useState(false);

  useEffect(() => {
    setMounted(true);
    const mq = window.matchMedia(MD_QUERY);
    const update = () => setIsDesktop(mq.matches);
    update();
    mq.addEventListener('change', update);
    return () => mq.removeEventListener('change', update);
  }, []);

  // Reposition on scroll/resize while open on desktop; mirrors HelpPanel.
  useLayoutEffect(() => {
    if (!open || !isDesktop) return;
    const update = () => {
      const rect = anchorRef.current?.getBoundingClientRect();
      if (!rect) return;
      setPosition({
        top: rect.bottom + 8,
        right: Math.max(8, window.innerWidth - rect.right),
      });
    };
    update();
    window.addEventListener('resize', update);
    window.addEventListener('scroll', update, true);
    return () => {
      window.removeEventListener('resize', update);
      window.removeEventListener('scroll', update, true);
    };
  }, [open, isDesktop, anchorRef]);

  useEffect(() => {
    if (!open) return;
    const onMouseDown = (e: MouseEvent) => {
      const target = e.target as Node;
      if (
        popoverRef.current?.contains(target) ||
        anchorRef.current?.contains(target)
      ) {
        return;
      }
      onClose();
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    document.addEventListener('mousedown', onMouseDown);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onMouseDown);
      document.removeEventListener('keydown', onKey);
    };
  }, [open, onClose, anchorRef]);

  useEffect(() => {
    if (!open) return;
    const offChunk = window.academy?.chat?.onChunk?.((chunk: AcademyChatChunk) => {
      setPhase((prev) => {
        if (
          prev.kind !== 'chat' ||
          (prev.pendingRequestId !== '__pending__' && prev.pendingRequestId !== chunk.requestId)
        ) return prev;
        const pendingRequestId = chunk.done || chunk.error ? null : chunk.requestId;
        if (chunk.error) {
          setError(chunk.error);
          return { ...prev, pendingRequestId };
        }
        if (chunk.done) {
          return { ...prev, pendingRequestId };
        }
        const next = [...prev.messages];
        const last = next[next.length - 1];
        if (last && last.role === 'assistant') {
          if (chunk.replace) {
            next[next.length - 1] = { role: 'assistant', content: chunk.delta };
          } else {
            next[next.length - 1] = { role: 'assistant', content: last.content + chunk.delta };
          }
        } else {
          next.push({ role: 'assistant', content: chunk.delta });
        }
        return { ...prev, messages: next, pendingRequestId: chunk.requestId };
      });
    });
    return () => {
      offChunk?.();
    };
  }, [open]);

  useEffect(() => {
    if (!open) return;
    if (!window.academy?.chat) {
      setError('AI assistant is only available in the desktop app.');
      return;
    }
    let cancelled = false;
    (async () => {
      setError(null);
      const [current, configured] = await Promise.all([
        window.academy!.chat!.currentModel().catch(() => null),
        window.academy!.chat!.configuredModel().catch(() => null),
      ]);
      if (cancelled) return;
      const historyKey = historyKeyFor(lessonContext);
      const savedMessages = historyKey === historyRef.current?.key ? historyRef.current.messages : [];
      if (current) {
        setPhase({ kind: 'chat', modelName: current, messages: savedMessages, pendingRequestId: null });
        return;
      }
      if (!configured) {
        setPhase({ kind: 'chat', modelName: null, messages: savedMessages, pendingRequestId: null });
        return;
      }
      try {
        const loaded = await window.academy!.chat!.load(configured);
        if (!cancelled) {
          setPhase({ kind: 'chat', modelName: loaded.modelName, messages: savedMessages, pendingRequestId: null });
        }
      } catch (err) {
        if (cancelled) return;
        setError(err instanceof Error ? err.message : 'Could not load the configured model.');
        setPhase({ kind: 'chat', modelName: null, messages: savedMessages, pendingRequestId: null });
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [open, lessonContext]);

  // When the user toggles "include QVAC docs" in Settings, refresh the
  // cached status so the next send picks up the change.
  useEffect(() => {
    let cancelled = false;
    if (window.academy?.state) {
      window.academy.state
        .get('ai.chat.useFullDocs')
        .then((value) => {
          if (cancelled) return;
          if (typeof value === 'string' && value === 'false') setUseFullDocs(false);
        })
        .catch(() => undefined);
    }
    if (window.academy?.chat?.docsStatus) {
      window.academy!.chat!.docsStatus()
        .then((status) => {
          if (cancelled || !status) return;
          setDocsStatus(status);
        })
        .catch(() => undefined);
    }
    function onChange() {
      if (cancelled) return;
      window.academy?.chat?.docsStatus?.()
        .then((status) => {
          if (!cancelled && status) setDocsStatus(status);
        })
        .catch(() => undefined);
    }
    window.addEventListener('online', onChange);
    window.addEventListener('offline', onChange);
    return () => {
      cancelled = true;
      window.removeEventListener('online', onChange);
      window.removeEventListener('offline', onChange);
    };
  }, []);

  useEffect(() => {
    if (phase.kind !== 'chat') return;
    historyRef.current = {
      key: historyKeyFor(lessonContext),
      messages: phase.messages,
    };
  }, [phase, lessonContext]);

  useEffect(() => {
    const key = historyKeyFor(lessonContext);
    if (historyRef.current && historyRef.current.key !== key) {
      historyRef.current = null;
    }
  }, [lessonContext]);

  useEffect(() => {
    if (phase.kind !== 'chat') return;
    const el = messagesRef.current;
    if (!el) return;
    el.scrollTop = el.scrollHeight;
  }, [phase]);

  // Populates the model-switcher dropdown with chat models already on disk.
  // The models list alone doesn't carry `family`, so cross-reference against
  // the catalogue.
  const refreshInstalledChatModels = useCallback(async () => {
    if (!window.academy?.models) return;
    try {
      const [models, catalogue] = await Promise.all([
        window.academy.models.list(),
        window.academy.models.catalogue(),
      ]);
      const chatNames = new Set(
        catalogue.filter((c) => c.family === 'chat').map((c) => c.name),
      );
      // Dedupe by display name: the cache can hold more than one file for
      // the same model (e.g. a stale hash-prefixed copy alongside a fresh one).
      const installedChatNames = new Set(models.filter((m) => chatNames.has(m.name)).map((m) => m.name));
      setInstalledChatModels(Array.from(installedChatNames));
    } catch {
    }
  }, []);

  useEffect(() => {
    if (!open) return;
    void refreshInstalledChatModels();
  }, [open, refreshInstalledChatModels]);

  const handleSwitchModel = useCallback(
    async (modelName: string) => {
      if (phase.kind !== 'chat' || modelName === phase.modelName) return;
      setSwitchingModel(true);
      setError(null);
      try {
        const result = await window.academy!.chat!.load(modelName);
        setPhase((prev) => (prev.kind === 'chat' ? { ...prev, modelName: result.modelName } : prev));
      } catch (err) {
        setError(err instanceof Error ? err.message : 'Could not switch models.');
      } finally {
        setSwitchingModel(false);
      }
    },
    [phase],
  );

  const handleSend = useCallback(async () => {
    if (phase.kind !== 'chat') return;
    const content = draft.trim();
    if (content.length === 0) return;
    setError(null);
    setDraft('');
    const next: AcademyChatMessage[] = [
      ...phase.messages,
      { role: 'user', content },
    ];
    setPhase({ ...phase, messages: next, pendingRequestId: '__pending__' });
    try {
      // No modelHint: chat.load() already loaded a model when the user
      // picked one. Forcing a hint here would re-trigger ensureLoaded()
      // and could race the SDK's in-process registry.
      const { requestId } = await window.academy!.chat!.send({
        messages: next,
        lessonKey: toLessonKey(lessonContext),
        lessonReference: lessonContext?.reference,
        useFullDocs: navigator.onLine && useFullDocs,
      });
      setPhase((prev) =>
        prev.kind === 'chat' && prev.pendingRequestId === '__pending__'
          ? { ...prev, pendingRequestId: requestId }
          : prev,
      );
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Could not send the message.';
      setError(message);
      setPhase((prev) => (prev.kind === 'chat' ? { ...prev, pendingRequestId: null } : prev));
    }
  }, [draft, phase, lessonContext]);

  const handleStop = useCallback(() => {
    if (phase.kind !== 'chat' || !phase.pendingRequestId) return;
    if (phase.pendingRequestId === '__pending__') return;
    void window.academy?.chat?.stop?.(phase.pendingRequestId).catch(() => undefined);
    setPhase((prev) => (prev.kind === 'chat' ? { ...prev, pendingRequestId: null } : prev));
  }, [phase]);

  const handleClearChat = useCallback(() => {
    if (phase.kind !== 'chat') return;
    if (phase.pendingRequestId && phase.pendingRequestId !== '__pending__') {
      void window.academy?.chat?.stop?.(phase.pendingRequestId).catch(() => undefined);
    }
    setError(null);
    setPhase({ ...phase, messages: [], pendingRequestId: null });
  }, [phase]);

  if (!mounted || !open) return null;

  const popover = (
    <>
      {/* Mobile backdrop; on desktop the click-outside handler covers dismissal. */}
      {!isDesktop ? (
        <button
          type="button"
          aria-label="Close assistant"
          onClick={onClose}
          className="fixed inset-0 z-30 bg-canvas/50 backdrop-blur-sm"
        />
      ) : null}
      <div
        ref={popoverRef}
        role="dialog"
        aria-label="AI assistant"
        className="fixed inset-x-0 bottom-0 z-50 flex h-[80vh] flex-col rounded-t-2xl border-t border-canvas-border bg-canvas shadow-[0_-12px_40px_-12px_rgba(0,0,0,0.7)] md:inset-x-auto md:bottom-auto md:left-auto md:h-[520px] md:max-h-[80vh] md:w-[24rem] md:rounded-lg md:border md:shadow-2xl md:shadow-black/40"
        style={
          isDesktop && position
            ? { top: position.top, right: position.right }
            : undefined
        }
      >
        {/* Mobile drag handle */}
        <div className="mb-2 mt-2 flex justify-center md:hidden">
          <span className="h-1 w-10 rounded-full bg-canvas-muted-foreground/40" />
        </div>

        <Header
          onClose={onClose}
          modelName={phase.kind === 'chat' ? phase.modelName : null}
          loading={phase.kind === 'loading'}
          installedModels={installedChatModels}
          switchingModel={switchingModel}
          onSwitchModel={handleSwitchModel}
          canClear={phase.kind === 'chat' && phase.messages.length > 0}
          onClear={handleClearChat}
        />

        {phase.kind === 'loading' ? (
          <div className="flex flex-1 items-center justify-center text-sm text-canvas-muted-foreground">
            <Loader2 className="mr-2 size-4 animate-spin" />
            Loading…
          </div>
        ) : null}

        {phase.kind === 'chat' ? (
          <ChatBody
            modelName={phase.modelName}
            messages={phase.messages}
            pendingRequestId={phase.pendingRequestId}
            draft={draft}
            setDraft={setDraft}
            onSend={handleSend}
            onStop={handleStop}
            error={error}
            messagesRef={messagesRef}
            lessonContext={lessonContext}
            onOpenSettings={() => {
              onClose();
              if (typeof window !== 'undefined') window.location.assign('/settings');
            }}
          />
        ) : null}
      </div>
    </>
  );

  return createPortal(popover, document.body);
}

export interface AiAssistantButtonProps {
  open: boolean;
  onToggle: () => void;
  disabled?: boolean;
}

export const AiAssistantButton = forwardRef<HTMLButtonElement, AiAssistantButtonProps>(
  function AiAssistantButton({ open, onToggle, disabled }, ref) {
    return (
      <button
        ref={ref}
        type="button"
        onClick={onToggle}
        disabled={disabled}
        aria-label="Ask the AI assistant"
        aria-expanded={open}
        title={open ? 'Close AI assistant' : 'Ask the AI assistant'}
        className={
          open
            ? 'relative inline-flex items-center justify-center rounded p-1.5 text-emerald-400 bg-emerald-500/10 ring-1 ring-emerald-500/40 transition-colors'
            : 'relative inline-flex items-center justify-center rounded p-1.5 text-canvas-muted-foreground transition-colors hover:bg-canvas-muted hover:text-canvas-foreground disabled:cursor-not-allowed disabled:opacity-40'
        }
      >
        <Bot className="size-4" />
      </button>
    );
  },
);

function Header({
  onClose,
  modelName,
  loading,
  installedModels,
  switchingModel,
  onSwitchModel,
  canClear,
  onClear,
}: {
  onClose: () => void;
  modelName: string | null;
  loading: boolean;
  installedModels: string[];
  switchingModel: boolean;
  onSwitchModel: (modelName: string) => void;
  canClear: boolean;
  onClear: () => void;
}) {
  return (
    <div className="flex items-center justify-between gap-2 px-3 py-2 md:px-4">
      <div className="flex min-w-0 items-center gap-2">
        <div className="flex size-6 shrink-0 items-center justify-center rounded-md border border-emerald-500/30 bg-emerald-500/10 text-emerald-400">
          <Bot className="size-3" />
        </div>
        <p className="shrink-0 text-xs font-semibold text-canvas-foreground">Ask the assistant</p>
        {!loading ? (
          <ModelSwitcher
            modelName={modelName}
            options={installedModels}
            busy={switchingModel}
            onSelect={onSwitchModel}
          />
        ) : null}
      </div>
      <div className="flex shrink-0 items-center gap-1">
        {canClear ? (
          <button
            type="button"
            onClick={onClear}
            aria-label="Clear chat"
            title="Clear chat"
            className="rounded p-1 text-canvas-muted-foreground transition-colors hover:bg-canvas-muted hover:text-canvas-foreground"
          >
            <Eraser className="size-3.5" />
          </button>
        ) : null}
        <button
          type="button"
          onClick={onClose}
          aria-label="Close assistant"
          className="rounded p-1 text-canvas-muted-foreground transition-colors hover:bg-canvas-muted hover:text-canvas-foreground"
        >
          <X className="size-3.5" />
        </button>
      </div>
    </div>
  );
}

// Switch the active chat model without leaving the popover. Only lists
// models already on disk; downloading a new one still happens from Settings.
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
    <div ref={ref} className="relative min-w-0">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        disabled={busy || options.length === 0}
        aria-haspopup="listbox"
        aria-expanded={open}
        className="inline-flex max-w-full items-center gap-1 rounded border border-emerald-500/40 bg-emerald-500/10 px-1.5 py-0.5 font-mono text-[9px] uppercase tracking-widest text-emerald-400 transition-colors hover:bg-emerald-500/20 disabled:cursor-not-allowed disabled:opacity-60"
      >
        {busy ? <Loader2 className="size-2.5 shrink-0 animate-spin" /> : null}
        <span className="truncate">{modelName ? shortName(modelName) : 'Pick model'}</span>
        {options.length > 0 ? <ChevronDown className="size-2.5 shrink-0" /> : null}
      </button>
      {open ? (
        <div
          role="listbox"
          aria-label="Chat model"
          className="absolute left-0 top-full z-10 mt-1 w-48 overflow-hidden rounded-md border border-canvas-border bg-canvas-muted py-1 shadow-lg shadow-black/30"
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

function ChatBody({
  modelName,
  messages,
  pendingRequestId,
  draft,
  setDraft,
  onSend,
  onStop,
  error,
  messagesRef,
  lessonContext,
  onOpenSettings,
}: {
  modelName: string | null;
  messages: AcademyChatMessage[];
  pendingRequestId: string | null;
  draft: string;
  setDraft: (v: string) => void;
  onSend: () => void;
  onStop: () => void;
  error: string | null;
  messagesRef: React.RefObject<HTMLDivElement | null>;
  lessonContext: AiAssistantLessonContext | null;
  onOpenSettings: () => void;
}) {
  const isStreaming = pendingRequestId !== null;
  if (!modelName) {
    return (
      <div className="flex flex-1 items-center justify-center p-6 text-center">
        <div className="max-w-xs">
          <div className="mx-auto flex size-9 items-center justify-center rounded-md border border-emerald-500/30 bg-emerald-500/10 text-emerald-400">
            <Bot className="size-4" />
          </div>
          <p className="mt-3 text-sm text-canvas-foreground">Configure the AI bot first in Settings.</p>
          <button
            type="button"
            onClick={onOpenSettings}
            className="mt-3 text-xs font-semibold text-emerald-400 hover:text-emerald-300"
          >
            Open Settings →
          </button>
        </div>
      </div>
    );
  }
  return (
    <div className="flex min-h-0 flex-1 flex-col">
      {lessonContext ? (
        <div className="border-b border-canvas-border bg-canvas-muted/40 px-3 py-1.5 text-[10px] text-canvas-muted-foreground md:px-4">
          <span className="text-canvas-foreground">Context:</span> {lessonContext.chapter} · {lessonContext.title ?? lessonContext.lesson}
        </div>
      ) : null}

      <div ref={messagesRef} className="flex-1 space-y-3 overflow-y-auto p-3 md:p-4">
        {messages.length === 0 ? (
          <EmptyState lessonContext={lessonContext} />
        ) : (
          messages.map((msg, i) => <MessageBubble key={i} message={msg} />)
        )}
        {isStreaming ? <ThinkingIndicator /> : null}
        {error ? (
          <div className="rounded-md border border-red-500/30 bg-red-500/10 px-2.5 py-1.5 text-[11px] text-red-400">
            {error}
          </div>
        ) : null}
      </div>

      <div className="border-t border-canvas-border p-2 md:p-3">
        <div className="flex items-end gap-2 rounded-md border border-canvas-border bg-canvas-muted px-2.5 py-1.5">
          <textarea
            rows={1}
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && !e.shiftKey) {
                e.preventDefault();
                onSend();
              }
            }}
            placeholder="Ask about this lesson…"
            className="flex-1 resize-none bg-transparent text-xs text-canvas-foreground outline-none placeholder:text-canvas-muted-foreground"
            style={{ minHeight: '28px', maxHeight: '100px' }}
          />
          {isStreaming ? (
            <button
              type="button"
              onClick={onStop}
              aria-label="Stop response"
              className="inline-flex shrink-0 items-center gap-1 rounded bg-red-500/20 px-2 py-1 text-[10px] font-semibold text-red-400 transition-colors hover:bg-red-500/30"
            >
              <Square className="size-3 fill-current" />
              Stop
            </button>
          ) : (
            <button
              type="button"
              onClick={onSend}
              disabled={draft.trim().length === 0}
              aria-label="Send"
              className="inline-flex shrink-0 items-center gap-1 rounded bg-emerald-500 px-2 py-1 text-[10px] font-semibold text-canvas transition-colors hover:bg-emerald-400 disabled:cursor-not-allowed disabled:opacity-50"
            >
              <Send className="size-3" />
              Send
            </button>
          )}
        </div>
        <p className="mt-1 px-1 font-mono text-[9px] uppercase tracking-widest text-canvas-muted-foreground/70">
          Runs locally · nothing leaves your machine
        </p>
      </div>
    </div>
  );
}

function ThinkingIndicator() {
  return (
    <div className="flex items-center gap-2 text-xs text-canvas-muted-foreground">
      <div className="flex size-6 shrink-0 items-center justify-center rounded-full bg-emerald-500/20 text-emerald-400">
        <Loader2 className="size-3 animate-spin" />
      </div>
      <span>Thinking…</span>
      <span className="inline-flex gap-0.5" aria-hidden="true">
        <span className="size-1 animate-pulse rounded-full bg-emerald-400 [animation-delay:-300ms]" />
        <span className="size-1 animate-pulse rounded-full bg-emerald-400 [animation-delay:-150ms]" />
        <span className="size-1 animate-pulse rounded-full bg-emerald-400" />
      </span>
    </div>
  );
}

function MessageBubble({ message }: { message: AcademyChatMessage }) {
  if (message.role === 'user') {
    return (
      <div className="flex gap-2">
        <div className="flex size-6 shrink-0 items-center justify-center rounded-full bg-canvas-muted text-[10px] font-semibold text-canvas-muted-foreground">
          You
        </div>
        <div className="rounded-lg rounded-tl-sm bg-canvas-muted px-3 py-2 text-sm text-canvas-foreground">
          {message.content}
        </div>
      </div>
    );
  }
  if (message.role === 'assistant') {
    return (
      <div className="flex justify-end gap-2">
        <div className="whitespace-pre-wrap rounded-lg rounded-tr-sm bg-canvas-border px-3 py-2 text-sm text-canvas-foreground">
          {message.content}
        </div>
        <div className="flex size-6 shrink-0 items-center justify-center rounded-full bg-emerald-500/20 text-emerald-400">
          <Sparkles className="size-3" />
        </div>
      </div>
    );
  }
  return null;
}

function EmptyState({ lessonContext }: { lessonContext: AiAssistantLessonContext | null }) {
  const suggestions = lessonContext
    ? [
        'Explain the key idea in one paragraph.',
        'What would break if I changed this?',
        'Show me a simpler example.',
      ]
    : [
        'What can you do?',
        'Which model are you running on?',
      ];
  return (
    <div className="flex h-full flex-col items-center justify-center gap-3 text-center text-canvas-muted-foreground">
      <div className="flex size-9 items-center justify-center rounded-md border border-emerald-500/30 bg-emerald-500/10 text-emerald-400">
        <Bot className="size-4" />
      </div>
      <p className="text-xs">
        Ask anything about{' '}
        <span className="text-canvas-foreground">
          {lessonContext?.title ?? lessonContext?.lesson ?? 'this lesson'}
        </span>
        .
      </p>
      <div className="flex flex-wrap justify-center gap-1.5">
        {suggestions.map((s) => (
          <span
            key={s}
            className="rounded-full border border-canvas-border bg-canvas-muted px-2.5 py-1 text-[10px]"
          >
            {s}
          </span>
        ))}
      </div>
    </div>
  );
}

// Strip the UI-only `title` to match the strict IPC schema (chapter + lesson only).
function toLessonKey(
  ctx: AiAssistantLessonContext | null,
): { chapter: string; lesson: string } | null {
  if (!ctx) return null;
  return { chapter: ctx.chapter, lesson: ctx.lesson };
}

// History is scoped per chapter. The local context window can't hold an
// entire chapter's worth of back-and-forth, so it resets on chapter change
// or via the clear-chat button.
function historyKeyFor(ctx: AiAssistantLessonContext | null): string {
  return ctx?.chapter ?? '__no-lesson__';
}
