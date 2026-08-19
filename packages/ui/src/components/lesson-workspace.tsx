'use client';

import { useUserStore } from '@academy/core';
import type { CurriculumChapter, CurriculumLesson } from '@academy/courses';
import { normalizeLessonCode } from '@academy/validation/lesson-code';
import type { AcademyAPI, AcademyRunChunk, ChatSecurityResult, MatchStatus } from '@academy/validation';
// Subpath, not the package root: the root re-exports the MDX frontmatter config, pulling fumadocs-mdx's fs/promises import into the browser bundle.
import {
  ArrowRight,
  Check,
  Copy,
  Loader2,
  Pencil,
  Play,
  RotateCcw,
  Square,
  X,
} from 'lucide-react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { type ReactNode, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { CurriculumStrip } from './curriculum-strip.js';
import { HelpPanel } from './help-panel.js';
import { LessonCompleteModal } from './lesson-complete-modal.js';
import { MonacoLessonEditor } from './monaco-lesson-editor.js';
import { QuestionCheck } from './question-check.js';
import { ChatInputBar, LessonConsole } from './lesson-console.js';
import type { ConsoleEntry } from './lesson-console.js';
import { QVAC_EDITOR_BACKGROUND } from './qvac-theme.js';

export interface LessonTest {
  id: string;
  description: string;
  pattern?: string;
  contains?: string;
}

export interface LessonQuestionAnswer {
  text: string;
  correct: boolean;
  /** Shown when this wrong answer is picked. */
  feedback?: string;
}

export interface LessonQuestion {
  id: string;
  text: string;
  answers: LessonQuestionAnswer[];
}

export interface LessonArgvSlot {
  name: string;
  from: 'state:lastProviderPublicKey' | 'literal';
  default?: string;
  label?: string;
}

export type OutputLine = {
  stream: 'stdout' | 'stderr';
  line: string;
};

export interface LessonData {
  title: string;
  description?: string;
  startingCode: string;
  lessonReference?: string;
  answer: string;
  tests: LessonTest[];
  hints: string[];
  expectedOutput: string[];
  questions?: LessonQuestion[];
  platforms: Array<'node' | 'web' | 'mobile' | 'desktop'>;
  sourceExample?: string;
  prevUrl?: string;
  nextUrl?: string;
  position?: { current: number; total: number };
  firstLessonHref?: string;
  currentChapter?: CurriculumChapter;
  currentLesson?: CurriculumLesson;
  readOnly?: boolean;
  argv?: LessonArgvSlot[];
  /** False for a lesson that only works on the machine running it, e.g. one
   *  that serves a port a paired device could never reach. Defaults to true. */
  pairedMode?: boolean;
}

const RUN_MODES = ['simulated', 'this-device', 'remote'] as const;
type RunMode = (typeof RUN_MODES)[number];

const ARGV_OVERRIDE_PREFIX = 'argv.override.';
const ARGV_CAPTURED_PREFIX = 'argv.captured.';

const CAPTURE_MARKERS: Array<{ pattern: RegExp; target: string }> = [
  { pattern: /▸\s+Provider Public Key:\s+([a-f0-9]{64})/i, target: 'lastProviderPublicKey' },
];

// Which check-entry verdicts count as the lesson being done. 'match' is set
// client-side by normalizeLessonCode, never returned by the AI itself.
const PASSING_MATCH_STATUSES = new Set<MatchStatus>(['match', 'complete', 'different-but-valid']);

// Streamed chunks rarely align with real newlines; treating each chunk as
// its own line inserted a phantom space at every boundary once rejoined.
function appendChunkLines(lines: OutputLine[], chunk: { stream: OutputLine['stream']; data: string }): OutputLine[] {
  const segments = chunk.data.split('\n');
  const last = lines[lines.length - 1];
  const merged =
    last && last.stream === chunk.stream
      ? [...lines.slice(0, -1), { stream: chunk.stream, line: last.line + segments[0] }]
      : [...lines, { stream: chunk.stream, line: segments[0] }];
  for (let i = 1; i < segments.length; i++) {
    merged.push({ stream: chunk.stream, line: segments[i] });
  }
  return merged;
}

// Matches the label shown in the device picker below, so a run's "ran on X"
// header always agrees with what X was called when it was selected.
function peerDisplayName(p: { discoveryKey: string; userData: unknown }): string {
  return p.userData && typeof p.userData === 'object' && 'name' in p.userData
    ? String((p.userData as { name: unknown }).name)
    : p.discoveryKey.slice(0, 8);
}

function overrideKey(slotName: string): string {
  return `${ARGV_OVERRIDE_PREFIX}${slotName}`;
}

function capturedKey(source: string): string {
  return `${ARGV_CAPTURED_PREFIX}${source}`;
}

function sourceFromArgvFrom(from: LessonArgvSlot['from']): string | null {
  const m = from.match(/^state:(.+)$/);
  return m ? m[1] : null;
}

function peerLabel(peer: { discoveryKey: string; userData: unknown }): string {
  const data = peer.userData;
  if (
    data &&
    typeof data === 'object' &&
    'name' in data &&
    typeof (data as { name: unknown }).name === 'string'
  ) {
    return (data as { name: string }).name;
  }
  if (
    data &&
    typeof data === 'object' &&
    'hostname' in data &&
    typeof (data as { hostname: unknown }).hostname === 'string'
  ) {
    return (data as { hostname: string }).hostname;
  }
  return peer.discoveryKey.slice(0, 12);
}

function argInputPlaceholder(slot: LessonArgvSlot, captured: Record<string, string>): string {
  const source = sourceFromArgvFrom(slot.from);
  if (source) {
    const value = captured[source];
    if (value) return `auto-captured: ${value}`;
    return `auto from previous run (${source})`;
  }
  if (slot.from === 'literal' && slot.default) return slot.default;
  return 'optional';
}

function runFileName(data: LessonData): string {
  const slug = data.title
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
  return `${slug || 'lesson'}.mts`;
}

function runLabel(data: LessonData): string {
  if (data.currentLesson?.title) return data.currentLesson.title;
  const chapter = data.currentChapter?.slug;
  const lesson = data.currentLesson?.slug;
  if (chapter && lesson) return `${chapter}/${lesson}`;
  return data.title;
}

/** The part of a run's final `output` the live stream never carried; appending all of `output` would print a failed run's log twice. */
function unstreamed(output: string, streamed: OutputLine[]): string {
  let rest = output;
  for (const stream of ['stdout', 'stderr'] as const) {
    const text = streamed
      .filter((entry) => entry.stream === stream)
      .map((entry) => entry.line)
      .join('\n');
    if (text) rest = rest.replace(text, '');
  }
  return rest.trim();
}

declare global {
  interface Window {
    academy?: AcademyAPI;
  }
}

export function LessonWorkspace({ data, children }: { data: LessonData; children: ReactNode }) {
  const [userCode, setUserCode] = useState(data.startingCode);
  const [questionsCorrect, setQuestionsCorrect] = useState(false);
  const [platform, setPlatform] = useState<LessonData['platforms'][number]>('node');
  // Deferred to useEffect so the first client render matches the SSR'd HTML.
  const [isDesktop, setIsDesktop] = useState(false);
  useEffect(() => {
    setIsDesktop(typeof window !== 'undefined' && typeof window.academy?.run === 'function');
  }, []);

  useEffect(() => {
    if (!isDesktop) return;
    let cancelled = false;
    const fetchPeers = async () => {
      try {
        const peers = await window.academy?.peer?.list?.();
        if (!cancelled && Array.isArray(peers)) {
          setRemotePeers(
            peers.map((p) => ({
              discoveryKey: p.discoveryKey,
              userData: p.userData,
              role: p.role,
              pairedAt: p.pairedAt,
              hostIdentity: p.hostIdentity ?? null,
            })),
          );
        }
      } catch {
        // silent; UI shows the empty state
      }
    };
    fetchPeers();
    const unsubscribe = window.academy?.peer?.onEvent?.(() => {
      fetchPeers();
    });
    return () => {
      cancelled = true;
      if (typeof unsubscribe === 'function') unsubscribe();
    };
  }, [isDesktop]);
  // Poll identity briefly: peer.init runs after app.whenReady, so an early-mounted workspace may see null for a beat.
  const [localPublicKey, setLocalPublicKey] = useState<string | null>(null);
  useEffect(() => {
    if (!isDesktop) return;
    let cancelled = false;
    let pollId: ReturnType<typeof setInterval> | null = null;
    const fetchIdentity = async () => {
      try {
        const id = await window.academy?.peer?.identity?.();
        if (cancelled) return;
        if (id?.publicKey) {
          setLocalPublicKey(id.publicKey);
          if (pollId) {
            clearInterval(pollId);
            pollId = null;
          }
        }
      } catch {
        // silent; treat as no identity until it loads
      }
    };
    fetchIdentity();
    pollId = setInterval(fetchIdentity, 500);
    const unsubscribe = window.academy?.peer?.onEvent?.(() => {
      fetchIdentity();
    });
    return () => {
      cancelled = true;
      if (pollId) clearInterval(pollId);
      if (typeof unsubscribe === 'function') unsubscribe();
    };
  }, [isDesktop]);
  const [runMode, setRunMode] = useState<RunMode>('simulated');
  const [remotePeers, setRemotePeers] = useState<
    Array<{
      discoveryKey: string;
      userData: unknown;
      role: string;
      pairedAt: number;
      hostIdentity: string | null;
    }>
  >([]);
  // Two app instances sharing a userData dir pair as the same identity, and the exec channel
  // can't route between matching keys, so filter self-pairs and keep only guest-role peers.
  const realRemotePeers = useMemo(() => {
    const notSelf = localPublicKey
      ? remotePeers.filter((p) => p.hostIdentity !== localPublicKey)
      : remotePeers;
    return notSelf.filter((p) => p.role === 'guest');
  }, [remotePeers, localPublicKey]);
  const selfPairCount = remotePeers.length - realRemotePeers.length;
  const localIsOnlyHost = remotePeers.length > 0 && remotePeers.every((p) => p.role === 'host');
  const [selectedPeerId, setSelectedPeerId] = useState<string>('');
  useEffect(() => {
    if (runMode !== 'remote') return;
    if (realRemotePeers.length === 0) return;
    if (realRemotePeers.some((p) => p.discoveryKey === selectedPeerId)) return;
    const latest = realRemotePeers.reduce((a, b) => (a.pairedAt >= b.pairedAt ? a : b));
    setSelectedPeerId(latest.discoveryKey);
  }, [runMode, realRemotePeers, selectedPeerId]);
  const [entries, setEntries] = useState<ConsoleEntry[]>([]);
  // Tracks the AI verify call the most recent Check Answer kicked off, so a
  // later click can cancel a still-running review instead of leaving it
  // orphaned, and so onVerifyResult knows which entry to update.
  const pendingVerifyRef = useRef<{ requestId: string; entryId: string } | null>(null);
  const [isAnimating, setIsAnimating] = useState(false);
  const [stopRequested, setStopRequested] = useState(false);
  const [showCompleteModal, setShowCompleteModal] = useState(false);
  const [chapterReady, setChapterReady] = useState(false);
  const [argvOverrides, setArgvOverrides] = useState<Record<string, string>>({});
  const [argvCaptured, setArgvCaptured] = useState<Record<string, string>>({});
  const [lastRemoteRun, setLastRemoteRun] = useState<
    | { kind: 'running'; peerId: string; startedAt: number }
    | { kind: 'ok'; peerId: string; startedAt: number; endedAt: number }
    | {
        kind: 'err';
        peerId: string;
        startedAt: number;
        endedAt: number;
        code: number | null;
        signal: string | null;
        message: string | null;
      }
    | null
  >(null);

  useEffect(() => {
    if (data.readOnly) {
      setUserCode(data.startingCode || '// This section is informational. No code to run here.\n');
    } else {
      setUserCode(data.startingCode);
    }
    setEntries([]);
    pendingVerifyRef.current = null;
    setRunMode(isDesktop ? 'this-device' : 'simulated');
    setShowCompleteModal(false);
    setChapterReady(false);
    setQuestionsCorrect(false);
  }, [data.startingCode, data.readOnly, isDesktop]);

  useEffect(() => {
    if (!isDesktop || !data.argv || data.argv.length === 0) return;
    let cancelled = false;
    (async () => {
      const nextOverrides: Record<string, string> = {};
      const nextCaptured: Record<string, string> = {};
      for (const slot of data.argv ?? []) {
        const overrideValue = await window.academy?.state?.get(overrideKey(slot.name));
        if (cancelled) return;
        if (typeof overrideValue === 'string' && overrideValue.length > 0) {
          nextOverrides[slot.name] = overrideValue;
        }
        const source = sourceFromArgvFrom(slot.from);
        if (source) {
          const capturedValue = await window.academy?.state?.get(capturedKey(source));
          if (cancelled) return;
          if (typeof capturedValue === 'string' && capturedValue.length > 0) {
            nextCaptured[source] = capturedValue;
          }
        }
      }
      if (!cancelled) {
        setArgvOverrides(nextOverrides);
        setArgvCaptured(nextCaptured);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [isDesktop, data.argv]);

  // An empty value keeps the override session active. Only non-empty values persist.
  const setArgvOverrideValue = useCallback(
    (name: string, value: string) => {
      setArgvOverrides((prev) => {
        if (!(name in prev) && value.length === 0) return prev;
        return { ...prev, [name]: value };
      });
      if (isDesktop && value.length > 0) {
        void window.academy?.state?.set(overrideKey(name), value);
      }
    },
    [isDesktop],
  );

  const startArgvOverride = useCallback((name: string) => {
    setArgvOverrides((prev) => {
      if (name in prev) return prev;
      return { ...prev, [name]: '' };
    });
  }, []);

  const clearArgvOverride = useCallback(
    (name: string) => {
      setArgvOverrides((prev) => {
        if (!(name in prev)) return prev;
        const next = { ...prev };
        delete next[name];
        return next;
      });
      if (isDesktop) {
        void window.academy?.state?.remove(overrideKey(name));
      }
    },
    [isDesktop],
  );

  const resolveArgv = useCallback(async (): Promise<string[]> => {
    if (!data.argv || data.argv.length === 0) return [];
    const out: string[] = [];
    for (const slot of data.argv) {
      const override = argvOverrides[slot.name];
      if (override && override.length > 0) {
        out.push(override);
        continue;
      }
      const source = sourceFromArgvFrom(slot.from);
      if (source && isDesktop) {
        const captured = await window.academy?.state?.get(capturedKey(source));
        if (typeof captured === 'string' && captured.length > 0) {
          out.push(captured);
          continue;
        }
      }
      out.push(slot.default ?? '');
    }
    return out;
  }, [data.argv, argvOverrides, isDesktop]);

  // The most recent 'check' entry drives completion; earlier ones (from a
  // prior Check Answer click) are history, not the gate.
  const latestCheck = useMemo(() => {
    for (let i = entries.length - 1; i >= 0; i--) {
      const e = entries[i];
      if (e.kind === 'check') return e;
    }
    return null;
  }, [entries]);

  const structuralPassed = latestCheck?.structural.every((r) => r.passed) ?? false;
  // AI review gates completion, but never blocks it when unavailable (no
  // model, web build, error); otherwise it'd brick lessons outright.
  const aiGate =
    !latestCheck || latestCheck.ai === 'unavailable' || latestCheck.ai === 'error'
      ? true
      : latestCheck.ai === 'done'
        ? PASSING_MATCH_STATUSES.has(latestCheck.aiVerdict ?? 'wrong')
        : false;
  const hasTests = data.tests.length > 0;
  const hasQuestions = (data.questions?.length ?? 0) > 0;
  const codeCheckPassed = hasTests ? structuralPassed && aiGate : true;
  const allPassed = codeCheckPassed && (!hasQuestions || questionsCorrect);
  const blockedReason =
    hasQuestions && hasTests
      ? 'Pass the code check and answer the questions to continue'
      : hasQuestions
        ? 'Answer the questions to continue'
        : 'Pass the code check to continue';

  // Subscribed for the workspace's lifetime (not just while checking) so a
  // review that's still running when the user navigates away is ignored
  // cleanly rather than updating a stale entry.
  useEffect(() => {
    const off = window.academy?.chat?.onVerifyResult?.((payload) => {
      const pending = pendingVerifyRef.current;
      if (!pending || pending.requestId !== payload.requestId) return;
      pendingVerifyRef.current = null;
      setEntries((prev) =>
        prev.map((e) => {
          if (e.id !== pending.entryId || e.kind !== 'check') return e;
          if (payload.error || !payload.result) {
            return { ...e, ai: 'error', aiError: payload.error ?? 'AI review failed.' };
          }
          return { ...e, ai: 'done', aiVerdict: payload.result.verdict, aiReason: payload.result.reason };
        }),
      );
    });
    return () => {
      off?.();
    };
  }, []);

  // Section = the chapter. The modal only fires on the last lesson of a chapter.
  const isLastLessonOfChapter =
    !!data.currentChapter &&
    !!data.currentLesson &&
    data.currentChapter.lessons.at(-1)?.num === data.currentLesson.num;

  const markLessonComplete = useUserStore((s) => s.markLessonComplete);

  useEffect(() => {
    if (!allPassed || !data.currentChapter || !data.currentLesson) return;
    // Deduped in the store, so re-runs on the same lesson are no-ops.
    markLessonComplete(data.currentChapter.slug, data.currentLesson.slug);
    // Best-effort mirror to the host's progress blob (desktop only); the
    // local store stays the source of truth for UI if this fails.
    if (typeof window !== 'undefined' && window.academy?.identity?.setProgress) {
      const chapterSlug = data.currentChapter.slug;
      const lessonSlug = data.currentLesson.slug;
      const lessonKey = `${chapterSlug}-${lessonSlug}`;
      void (async () => {
        let hostProgress: Record<string, unknown> = {};
        try {
          const cur = await window.academy!.identity!.getProgress();
          if (cur?.progress && typeof cur.progress === 'object') {
            hostProgress = cur.progress as Record<string, unknown>;
          }
        } catch {
        }
        const next = {
          ...hostProgress,
          [lessonKey]: { completedAt: Date.now() },
        };
        try {
          await window.academy!.identity!.setProgress({ progress: next });
        } catch {
        }
      })();
    }
    if (isLastLessonOfChapter) {
      // Don't auto-pop the celebration modal; let the reader check the run
      // first. The Next button shows it on click, and a small badge on the
      // run output flags that the chapter is done.
      setChapterReady(true);
    }
  }, [
    allPassed,
    isLastLessonOfChapter,
    data.currentChapter,
    data.currentLesson,
    markLessonComplete,
  ]);

  const check = useCallback(() => {
    // A second click while one's already loading orphaned the first entry.
    if (latestCheck?.ai === 'loading') return;
    const structural = runTests(userCode, data.tests).map((r) => ({
      id: r.id,
      description: r.description,
      passed: r.passed,
    }));
    const entryId = crypto.randomUUID();
    setEntries((prev) => [...prev, { kind: 'check', id: entryId, structural, ai: 'idle' }]);

    // Only worth a semantic review once the cheap structural checks already
    // pass. That's the case that can currently go green while being wrong.
    if (!structural.every((r) => r.passed)) return;

    // A formatting-only match is real; skip the AI call entirely for it.
    const hasAnswer = typeof data.answer === 'string' && data.answer.length > 0;
    if (hasAnswer && normalizeLessonCode(userCode) === normalizeLessonCode(data.answer)) {
      setEntries((prev) =>
        prev.map((e) => (e.id === entryId && e.kind === 'check' ? { ...e, ai: 'done', aiVerdict: 'match', aiReason: '' } : e)),
      );
      return;
    }

    // A leftover numbered TODO is a free, reliable "unfinished" signal even
    // when the structural checks above only cover an earlier TODO.
    if (/^\s*\/\/\s*\d+:/m.test(userCode)) {
      setEntries((prev) =>
        prev.map((e) =>
          e.id === entryId && e.kind === 'check'
            ? {
                ...e,
                ai: 'done',
                aiVerdict: 'unfinished',
                aiReason: "There's still a numbered TODO comment in the code.",
              }
            : e,
        ),
      );
      return;
    }

    const canVerify = isDesktop && typeof window !== 'undefined' && !!window.academy?.chat;
    if (!canVerify) {
      setEntries((prev) =>
        prev.map((e) => (e.id === entryId && e.kind === 'check' ? { ...e, ai: 'unavailable' } : e)),
      );
      return;
    }
    setEntries((prev) => prev.map((e) => (e.id === entryId && e.kind === 'check' ? { ...e, ai: 'loading' } : e)));

    // Cancel any review still running from a previous Check Answer click.
    if (pendingVerifyRef.current) {
      void window.academy?.chat?.stop?.(pendingVerifyRef.current.requestId).catch(() => undefined);
      pendingVerifyRef.current = null;
    }

    void (async () => {
      try {
        const { requestId } = await window.academy!.chat!.verify({
          code: userCode,
          tests: data.tests.map((t) => ({ id: t.id, description: t.description })),
          lessonKey:
            data.currentChapter && data.currentLesson
              ? { chapter: data.currentChapter.slug, lesson: data.currentLesson.slug }
              : null,
          lessonReference: data.lessonReference,
          answer: data.answer || undefined,
        });
        pendingVerifyRef.current = { requestId, entryId };
      } catch (err) {
        const message = err instanceof Error ? err.message : 'Could not reach the local model.';
        setEntries((prev) =>
          prev.map((e) => (e.id === entryId && e.kind === 'check' ? { ...e, ai: 'error', aiError: message } : e)),
        );
      }
    })();
  }, [
    userCode,
    data.tests,
    data.currentChapter,
    data.currentLesson,
    data.lessonReference,
    data.answer,
    isDesktop,
    latestCheck,
  ]);

  const stopCheck = useCallback((entryId: string) => {
    const pending = pendingVerifyRef.current;
    if (!pending || pending.entryId !== entryId) return;
    void window.academy?.chat?.stop?.(pending.requestId).catch(() => undefined);
    pendingVerifyRef.current = null;
    setEntries((prev) =>
      prev.map((e) => (e.id === entryId && e.kind === 'check' ? { ...e, ai: 'error', aiError: 'Stopped.' } : e)),
    );
  }, []);

  // Advisory only; null (unavailable/timeout/error) is treated as 'clean'.
  // The receiving device's own scan is the actual gate.
  const awaitSecurityScan = useCallback(
    async (code: string): Promise<ChatSecurityResult | null> => {
      if (typeof window === 'undefined' || !window.academy?.chat?.securityScan || !window.academy.chat.onSecurityResult) {
        return null;
      }
      const chatApi = window.academy.chat;
      return new Promise<ChatSecurityResult | null>((resolve) => {
        let settled = false;
        // Subscribed before the call, not inside its .then: a review that
        // answers without loading a model emits its result before the
        // requestId crosses the bridge, and a later listener misses it and
        // waits out the timeout below with the run held up behind it.
        let requestId: string | null = null;
        let early: { requestId: string; error: string | null; result: ChatSecurityResult | null } | null = null;
        const timer = setTimeout(() => settle(null), 20_000);
        const off = chatApi.onSecurityResult((payload) => {
          if (requestId === null) {
            early = payload;
            return;
          }
          if (payload.requestId !== requestId) return;
          settle(payload.error ? null : payload.result);
        });
        function settle(value: ChatSecurityResult | null) {
          if (settled) return;
          settled = true;
          clearTimeout(timer);
          off?.();
          resolve(value);
        }
        chatApi
          .securityScan({
            code,
            lessonKey:
              data.currentChapter && data.currentLesson
                ? { chapter: data.currentChapter.slug, lesson: data.currentLesson.slug }
                : null,
            lessonReference: data.lessonReference,
          })
          .then(({ requestId: id }) => {
            requestId = id;
            if (early && early.requestId === id) settle(early.error ? null : early.result);
          })
          .catch(() => settle(null));
      });
    },
    [data.currentChapter, data.currentLesson, data.lessonReference],
  );

  const run = useCallback(async () => {
    const runEntryId = crypto.randomUUID();
    // Null when this isn't a resolved remote run (this-device, or remote
    // with no device picked yet). RunCard reads that as "this device".
    const targetPeer =
      runMode === 'remote' && selectedPeerId
        ? realRemotePeers.find((p) => p.discoveryKey === selectedPeerId)
        : undefined;
    const deviceLabel = targetPeer ? peerDisplayName(targetPeer) : null;
    setEntries((prev) => [
      ...prev,
      { kind: 'run', id: runEntryId, lines: [], status: 'running', deviceLabel },
    ]);
    const finalizeRunEntry = (lines: OutputLine[], status: 'ok' | 'err' | 'stopped') => {
      setEntries((prev) =>
        prev.map((e) => (e.id === runEntryId && e.kind === 'run' ? { ...e, lines, status } : e)),
      );
    };

    // Whitespace-normalized, not a leftover-TODO heuristic: finishing TODO 1
    // but not 2 is a real change even with boilerplate still present.
    const unchangedFromStarter = normalizeLessonCode(userCode) === normalizeLessonCode(data.startingCode);
    if (unchangedFromStarter) {
      finalizeRunEntry(
        [
          { stream: 'stdout', line: 'Looks like you haven\u2019t made any changes yet.' },
          {
            stream: 'stdout',
            line: 'The starting code has numbered TODOs. Follow the lesson to write the code for each one, then click Run again.',
          },
        ],
        'ok',
      );
      return;
    }

    if (runMode === 'remote') {
      if (data.pairedMode === false) {
        finalizeRunEntry(
          [
            {
              stream: 'stdout',
              line: '[paired] This lesson serves a port on the machine it runs on, which a paired device cannot reach. Switch the picker to This device.',
            },
          ],
          'ok',
        );
        return;
      }
      if (realRemotePeers.length === 0) {
        const lines: OutputLine[] = localIsOnlyHost
          ? [
              {
                stream: 'stdout',
                line: "[paired] This device is the host in every pair. Hosts accept runs from guests; they don't forward them.",
              },
              {
                stream: 'stdout',
                line: 'Pair a second device and have it accept the invite (or `pnpm dev:host` in another terminal), then come back.',
              },
            ]
          : selfPairCount > 0
            ? [
                {
                  stream: 'stdout',
                  line: "[paired] The only paired device is this device. Two app instances sharing a userData directory end up paired as the same identity, but the exec channel can't route between matching keys.",
                },
                {
                  stream: 'stdout',
                  line: 'Run `pnpm --filter @tether-academy/desktop dev:host` in a second terminal to launch an isolated host, then pair it from Settings > Devices.',
                },
              ]
            : [
                {
                  stream: 'stdout',
                  line: '[paired] No paired devices. Open Settings to pair one, then come back.',
                },
              ];
        finalizeRunEntry(lines, 'ok');
        return;
      }
      if (!selectedPeerId) {
        finalizeRunEntry(
          [
            {
              stream: 'stdout',
              line: '[paired] Pick a paired device from the picker next to Run, then click Run again.',
            },
          ],
          'ok',
        );
        return;
      }
      // Remote run: same downstream path as this-device, with peerId set below.
    }

    const canRunForReal =
      (runMode === 'this-device' || (runMode === 'remote' && !!selectedPeerId)) &&
      typeof window !== 'undefined' &&
      window.academy?.run;

    const resolvedArgv = await resolveArgv();

    // The "no output produced" fallback below reads this, not a stale state read.
    let producedOutput: OutputLine[] = [];
    let runStatus: 'ok' | 'err' | 'stopped' = 'ok';

    if (canRunForReal) {
      setIsAnimating(true);
      setStopRequested(false);
      const runStartedAt = Date.now();
      const isRemoteRun = runMode === 'remote' && !!selectedPeerId;
      if (isRemoteRun && selectedPeerId) {
        setLastRemoteRun({ kind: 'running', peerId: selectedPeerId, startedAt: runStartedAt });
      }
      // Streamed as chunks arrive so 30-60s finetune runs don't look frozen.
      const streamBuffer: OutputLine[] = [];

      // Fed through the same path a real chunk takes, so the review reads as a
      // stage on the rail. Trailing newline included: without it the next real
      // chunk merges into this line instead of starting its own.
      const noteStage = (line: string) => {
        const chunk = { stream: 'stderr' as const, data: `${line}\n` };
        streamBuffer.splice(0, streamBuffer.length, ...appendChunkLines(streamBuffer, chunk));
        setEntries((prev) =>
          prev.map((e) =>
            e.id === runEntryId && e.kind === 'run' ? { ...e, lines: appendChunkLines(e.lines, chunk) } : e,
          ),
        );
      };

      // Advisory only; the paired device runs its own authoritative scan.
      if (isRemoteRun) {
        // Nothing reaches the peer until this answers, so without a row of its
        // own the panel sat empty and then filled all at once.
        noteStage('→ Reviewing the code on this device...');
        const reviewStartedAt = Date.now();
        const scan = await awaitSecurityScan(userCode);
        const reviewSecs = (Date.now() - reviewStartedAt) / 1000;
        noteStage(`  ✓ Reviewed on this device${reviewSecs >= 1 ? ` (${reviewSecs.toFixed(1)}s)` : ''}`);
        if (scan?.verdict === 'malicious') {
          const lines: OutputLine[] = [
            ...streamBuffer,
            { stream: 'stderr', line: '[security] This code was not sent to the paired device.' },
            ...scan.concerns.map((c) => ({ stream: 'stderr' as const, line: `  - ${c.summary}` })),
            { stream: 'stdout', line: 'Edit the code to remove the flagged content, then click Run again.' },
          ];
          finalizeRunEntry(lines, 'err');
          if (selectedPeerId) {
            setLastRemoteRun({
              kind: 'err',
              peerId: selectedPeerId,
              startedAt: runStartedAt,
              endedAt: Date.now(),
              code: null,
              signal: null,
              message: 'blocked by security review',
            });
          }
          setIsAnimating(false);
          return;
        }
        // 'suspicious' doesn't warn here either; only 'malicious' above is reliable.
      }

      const captured = new Set<string>();
      const scanForCaptures = (text: string) => {
        if (!isDesktop || !text) return;
        for (const { pattern, target } of CAPTURE_MARKERS) {
          if (captured.has(target)) continue;
          const m = text.match(pattern);
          if (m && m[1]) {
            captured.add(target);
            const value = m[1];
            void window.academy?.state?.set(capturedKey(target), value);
            setArgvCaptured((prev) => ({ ...prev, [target]: value }));
            void window.academy?.stop?.();
          }
        }
      };
      const unsubscribe = window.academy?.onRunChunk?.((chunk) => {
        streamBuffer.splice(0, streamBuffer.length, ...appendChunkLines(streamBuffer, chunk));
        setEntries((prev) =>
          prev.map((e) => (e.id === runEntryId && e.kind === 'run' ? { ...e, lines: appendChunkLines(e.lines, chunk) } : e)),
        );
        if (chunk.stream === 'stdout') scanForCaptures(chunk.data);
      });
      try {
        const result = await window.academy?.run({
          source: userCode,
          language: 'typescript',
          argv: resolvedArgv,
          fileName: runFileName(data),
          label: runLabel(data),
          ...(isRemoteRun && selectedPeerId ? { peerId: selectedPeerId } : {}),
        });
        if (!result) {
          producedOutput = [
            ...streamBuffer,
            { stream: 'stdout', line: '[error] no run result returned' },
          ];
          runStatus = 'err';
          if (isRemoteRun && selectedPeerId) {
            setLastRemoteRun({
              kind: 'err',
              peerId: selectedPeerId,
              startedAt: runStartedAt,
              endedAt: Date.now(),
              code: null,
              signal: null,
              message: 'no result returned from peer',
            });
          }
        } else if (result.ok) {
          producedOutput = streamBuffer;
          if (isRemoteRun && selectedPeerId) {
            setLastRemoteRun({
              kind: 'ok',
              peerId: selectedPeerId,
              startedAt: runStartedAt,
              endedAt: Date.now(),
            });
          }
        } else {
          // A native abort kills the child without printing anything, so the signal is all the student has to go on.
          // A user-initiated Stop should not look like a crash; the host flags `stopRequested` on the result when
          // the abort came from `academy:stop` rather than an actual non-zero exit.
          const note = result.stopRequested
            ? '[stopped]'
            : result.remoteExit?.signal
              ? `[stopped by ${result.remoteExit.signal}]`
              : '[exit non-zero]';
          const tail = unstreamed(result.output ?? '', streamBuffer) || note;
          producedOutput = [...streamBuffer, { stream: 'stdout', line: tail }];
          runStatus = result.stopRequested ? 'stopped' : 'err';
          if (isRemoteRun && selectedPeerId) {
            setLastRemoteRun({
              kind: 'err',
              peerId: selectedPeerId,
              startedAt: runStartedAt,
              endedAt: Date.now(),
              code: result.remoteExit?.code ?? null,
              signal: result.remoteExit?.signal ?? null,
              message: note.split('\n').pop() ?? null,
            });
          }
        }
        // In case a marker was split across chunk boundaries.
        scanForCaptures(result?.output ?? '');
      } catch (err) {
        producedOutput = [
          ...streamBuffer,
          {
            stream: 'stdout',
            line: `[error] ${err instanceof Error ? err.message : String(err)}`,
          },
        ];
        runStatus = 'err';
        if (isRemoteRun && selectedPeerId) {
          setLastRemoteRun({
            kind: 'err',
            peerId: selectedPeerId,
            startedAt: runStartedAt,
            endedAt: Date.now(),
            code: null,
            signal: null,
            message: err instanceof Error ? err.message : String(err),
          });
        }
      } finally {
        unsubscribe?.();
        setIsAnimating(false);
        setStopRequested(false);
      }
    } else {
      // Simulated mode, or this-device on the web where the academy bridge isn't available.
      setIsAnimating(true);
      await delay(900);
      producedOutput = data.expectedOutput.map((line) => ({ stream: 'stdout', line }));
      if (
        (runMode === 'this-device' || runMode === 'remote') &&
        typeof window !== 'undefined' &&
        !window.academy?.run
      ) {
        producedOutput = [
          ...producedOutput,
          { stream: 'stdout', line: '' },
          { stream: 'stdout', line: '[hint] Open in the desktop app to run this code for real.' },
        ];
      }
      setIsAnimating(false);
    }

    // Fall back to test results so the panel isn't blank when the run produces nothing.
    if (producedOutput.length === 0 && data.tests.length > 0) {
      const results = runTests(userCode, data.tests);
      const allPassed = results.every((r) => r.passed);
      const summary = results.map((r) =>
        r.passed ? `  \u2713 ${r.description}` : `  \u2717 ${r.description}`,
      );
      producedOutput = [
        {
          stream: 'stdout',
          line: allPassed
            ? "No output produced by the run, even though the checks below matched. These checks only cover part of the lesson. The code that would actually produce output is probably still missing or unreachable."
            : 'No output produced by the run. The checks below tell you which part is missing:',
        },
        // A blank line between items keeps OutputView's paragraph mode from space-joining them.
        ...summary.flatMap((line) => [{ stream: 'stdout' as const, line: '' }, { stream: 'stdout' as const, line }]),
      ];
    }

    finalizeRunEntry(producedOutput, runStatus);
  }, [
    runMode,
    userCode,
    data.expectedOutput,
    data.tests,
    data.readOnly,
    data.pairedMode,
    resolveArgv,
    isDesktop,
    check,
    realRemotePeers,
    selfPairCount,
    localIsOnlyHost,
    selectedPeerId,
    awaitSecurityScan,
  ]);

  const reset = useCallback(() => {
    setUserCode(data.startingCode);
    setEntries([]);
  }, [data.startingCode]);

  const stopRun = useCallback(() => {
    if (!isAnimating) return;
    setStopRequested(true);
    void window.academy?.stop?.();
  }, [isAnimating]);

  // The chevrons' shortcut. Anywhere a key means something else (the editor,
  // the chat box, the completion modal) the arrow belongs to that, not here.
  const router = useRouter();
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.metaKey || e.ctrlKey || e.altKey || e.shiftKey) return;
      if (e.key !== 'ArrowLeft' && e.key !== 'ArrowRight') return;
      if (showCompleteModal) return;
      const el = e.target as HTMLElement | null;
      if (el?.closest('input, textarea, select, [contenteditable="true"], .monaco-editor')) return;
      const href = e.key === 'ArrowLeft' ? data.prevUrl : allPassed ? data.nextUrl : undefined;
      if (!href) return;
      e.preventDefault();
      router.push(href);
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [router, data.prevUrl, data.nextUrl, allPassed, showCompleteModal]);

  // A lesson is exactly one viewport, the editor and console its only scroll
  // regions. Narrow layouts still scroll as a page, so the rule is a media
  // query in global.css rather than a style set from here.
  const isLessonPage = !!data.currentLesson;
  useEffect(() => {
    if (!isLessonPage) return;
    document.documentElement.classList.add('lesson-viewport');
    return () => document.documentElement.classList.remove('lesson-viewport');
  }, [isLessonPage]);

  return (
    <div className="workspace-root flex w-full flex-col lg:h-[calc(100vh-3.5rem)]">
      <div
        className={`workspace-row flex min-h-0 flex-col gap-4 overflow-x-auto px-4 pt-4 sm:px-6 sm:pt-6 lg:flex-1 lg:flex-row lg:gap-6 lg:overflow-hidden lg:pb-0 lg:overflow-x-hidden ${
          data.currentLesson ? 'pb-4' : 'pb-24'
        }`}
      >
        <section className="workspace-sidebar min-w-0 lg:max-w-[42%] lg:min-w-[360px] lg:flex-shrink-0 lg:h-full lg:overflow-y-auto lg:pb-[9px] lg:pr-2">
          <CurriculumStrip
            chapter={data.currentChapter}
            currentLesson={data.currentLesson}
            prevUrl={data.prevUrl}
            nextUrl={data.nextUrl}
            nextBlockedReason={allPassed ? undefined : blockedReason}
            onFinish={chapterReady ? () => setShowCompleteModal(true) : undefined}
            finishLabel={data.nextUrl ? 'Finish chapter' : 'Course complete'}
          />

          <header className="mb-5">
            <h1 className="mb-3 text-3xl font-bold leading-tight tracking-tight text-canvas-foreground sm:text-4xl">
              {data.title}
            </h1>
            {data.description ? (
              <p className="text-base leading-relaxed text-canvas-muted-foreground sm:text-lg">
                {data.description}
              </p>
            ) : null}
            {data.sourceExample ? (
              <a
                href={`https://github.com/tetherto/qvac/blob/main/${data.sourceExample}`}
                target="_blank"
                rel="noopener noreferrer"
                className="mt-2 inline-flex items-center gap-1 text-xs font-mono text-emerald-400 hover:text-emerald-300"
              >
                <span>Example on GitHub</span>
                <span aria-hidden>↗</span>
                <span className="text-canvas-muted-foreground">({data.sourceExample})</span>
              </a>
            ) : null}
          </header>

          <div className="prose-md">{children}</div>

          {data.questions && data.questions.length > 0 ? (
            <QuestionCheck questions={data.questions} onAllCorrectChange={setQuestionsCorrect} />
          ) : null}
        </section>

        <section className="workspace-runner-section flex min-h-[560px] flex-col pb-[9px] lg:h-full lg:min-h-0 lg:flex-1 lg:min-w-[640px]">
          <Runner
            userCode={userCode}
            setUserCode={setUserCode}
            platform={platform}
            setPlatform={setPlatform}
            runMode={runMode}
            setRunMode={setRunMode}
            isDesktop={isDesktop}
            entries={entries}
            onStopCheck={stopCheck}
            isAnimating={isAnimating}
            onRun={run}
            onStop={stopRun}
            stopRequested={stopRequested}
            onCheck={check}
            checkDisabled={data.tests.length === 0 || latestCheck?.ai === 'loading'}
            onReset={reset}
            platforms={data.platforms}
            pairedMode={data.pairedMode}
            readOnly={data.readOnly}
            hints={data.hints}
            answer={data.answer}
            argv={data.argv}
            argvOverrides={argvOverrides}
            argvCaptured={argvCaptured}
            onArgvOverrideValue={setArgvOverrideValue}
            onArgvOverrideStart={startArgvOverride}
            onArgvOverrideClear={clearArgvOverride}
            remotePeers={realRemotePeers}
            selectedPeerId={selectedPeerId}
            setSelectedPeerId={setSelectedPeerId}
            selfPairCount={selfPairCount}
            localIsOnlyHost={localIsOnlyHost}
            lastRemoteRun={lastRemoteRun}
            clearLastRemoteRun={() => setLastRemoteRun(null)}
            footer={
              data.currentLesson ? (
                data.readOnly ? (
                  <p className="py-1 text-center text-sm text-canvas-muted-foreground">
                    No code in this section
                  </p>
                ) : (
                  <ChatInputBar
                    entries={entries}
                    setEntries={setEntries}
                    lessonContext={
                      data.currentChapter
                        ? {
                            chapter: data.currentChapter.slug,
                            lesson: data.currentLesson.slug,
                            title: data.currentLesson.title,
                            reference: data.lessonReference,
                          }
                        : null
                    }
                    readOnly={data.readOnly}
                  />
                )
              ) : undefined
            }
          />
        </section>
      </div>

      {/* Only a chapter landing page still needs a row of its own: on a lesson
          the chat is docked in the runner column and navigation is on the
          stepper, so the page ends at the workspace. */}
      {data.currentChapter && !data.currentLesson ? (
        <nav className="sticky bottom-0 z-10 shrink-0 border-t border-canvas-border bg-canvas/95 backdrop-blur supports-[backdrop-filter]:bg-canvas/85 lg:static">
          <div className="flex items-center justify-between gap-2 px-4 py-3 sm:gap-3 sm:px-6 sm:py-3.5">
            {data.firstLessonHref ? (
              <Link
                href={data.firstLessonHref}
                className="mx-auto inline-flex items-center gap-1.5 rounded-md bg-emerald-500 px-4 py-2 text-sm font-semibold text-canvas transition-colors hover:bg-emerald-400"
              >
                <span>Start Lesson 1</span>
                <ArrowRight className="size-4" />
              </Link>
            ) : (
              <span className="mx-auto inline-flex items-center gap-1.5 rounded-md bg-canvas-muted px-4 py-2 text-sm font-medium text-canvas-muted-foreground">
                No lessons shipped yet
              </span>
            )}
          </div>
        </nav>
      ) : null}

      <LessonCompleteModal
        open={showCompleteModal}
        lessonTitle={data.title}
        chapterLabel={data.currentChapter?.label}
        chapterNum={data.currentChapter?.num}
        chapterLessonCount={data.currentChapter?.lessons.length}
        nextUrl={data.nextUrl}
        courseUrl={`/courses`}
        onClose={() => setShowCompleteModal(false)}
      />
    </div>
  );
}

function Runner({
  userCode,
  setUserCode,
  platform,
  setPlatform,
  runMode,
  setRunMode,
  isDesktop = false,
  entries,
  onStopCheck,
  isAnimating,
  onRun,
  onStop,
  stopRequested = false,
  onCheck,
  checkDisabled,
  onReset,
  platforms,
  pairedMode = true,
  readOnly = false,
  hints,
  answer,
  argv,
  argvOverrides,
  argvCaptured,
  onArgvOverrideValue,
  onArgvOverrideStart,
  onArgvOverrideClear,
  remotePeers,
  selectedPeerId,
  setSelectedPeerId,
  selfPairCount,
  localIsOnlyHost,
  lastRemoteRun,
  clearLastRemoteRun,
  footer,
}: {
  userCode: string;
  setUserCode: (s: string) => void;
  platform: LessonData['platforms'][number];
  setPlatform: (p: LessonData['platforms'][number]) => void;
  runMode: RunMode;
  setRunMode: (m: RunMode) => void;
  isDesktop?: boolean;
  entries: ConsoleEntry[];
  onStopCheck: (entryId: string) => void;
  isAnimating: boolean;
  onRun: () => void;
  onStop?: () => void;
  stopRequested?: boolean;
  onCheck: () => void;
  checkDisabled: boolean;
  onReset: () => void;
  platforms: LessonData['platforms'];
  pairedMode?: boolean;
  readOnly?: boolean;
  hints: string[];
  answer: string;
  argv?: LessonArgvSlot[];
  argvOverrides: Record<string, string>;
  argvCaptured: Record<string, string>;
  onArgvOverrideValue: (name: string, value: string) => void;
  onArgvOverrideStart: (name: string) => void;
  onArgvOverrideClear: (name: string) => void;
  remotePeers: Array<{ discoveryKey: string; userData: unknown; role: string; pairedAt: number }>;
  selectedPeerId: string;
  setSelectedPeerId: (id: string) => void;
  selfPairCount: number;
  localIsOnlyHost: boolean;
  lastRemoteRun:
    | { kind: 'running'; peerId: string; startedAt: number }
    | { kind: 'ok'; peerId: string; startedAt: number; endedAt: number }
    | {
        kind: 'err';
        peerId: string;
        startedAt: number;
        endedAt: number;
        code: number | null;
        signal: string | null;
        message: string | null;
      }
    | null;
  clearLastRemoteRun: () => void;
  /** Docked under the console, so the column reads code, output, input. */
  footer?: ReactNode;
}) {
  const [copied, setCopied] = useState(false);
  const [capturedCopiedKey, setCapturedCopiedKey] = useState<string | null>(null);
  const [tick, setTick] = useState(0);
  useEffect(() => {
    if (!lastRemoteRun) return;
    const id = setInterval(() => setTick((n) => n + 1), 1000);
    return () => clearInterval(id);
  }, [lastRemoteRun]);
  // Reference `tick` so lint sees it being read; the interval is the effect.
  void tick;

  const selectedPeer = remotePeers.find((p) => p.discoveryKey === selectedPeerId) ?? null;
  const peerName = selectedPeer
    ? peerLabel(selectedPeer)
    : selectedPeerId
      ? selectedPeerId.slice(0, 12)
      : 'paired device';
  const handleCopy = useCallback(async () => {
    try {
      if (navigator.clipboard?.writeText) {
        await navigator.clipboard.writeText(userCode);
      } else {
        // Older browsers and non-secure contexts don't expose the Clipboard API.
        const ta = document.createElement('textarea');
        ta.value = userCode;
        ta.style.position = 'fixed';
        ta.style.opacity = '0';
        document.body.appendChild(ta);
        ta.select();
        document.execCommand('copy');
        document.body.removeChild(ta);
      }
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
    }
  }, [userCode]);

  const handleCopyCaptured = useCallback(async (slotName: string, value: string) => {
    try {
      if (navigator.clipboard?.writeText) {
        await navigator.clipboard.writeText(value);
      } else {
        const ta = document.createElement('textarea');
        ta.value = value;
        ta.style.position = 'fixed';
        ta.style.opacity = '0';
        document.body.appendChild(ta);
        ta.select();
        document.execCommand('copy');
        document.body.removeChild(ta);
      }
      setCapturedCopiedKey(slotName);
      setTimeout(() => {
        setCapturedCopiedKey((current) => (current === slotName ? null : current));
      }, 1500);
    } catch {
    }
  }, []);

  return (
    <div className="flex min-h-0 flex-1 flex-col overflow-hidden rounded-lg border border-canvas-border bg-canvas-muted">
      <div className="flex items-center justify-between gap-2 border-b border-canvas-border bg-canvas px-3 py-2 sm:px-4">
        <div className="flex min-w-0 items-center gap-2 text-sm">
          <span
            className={`size-2 shrink-0 rounded-full ${
              readOnly ? 'bg-canvas-muted-foreground/60' : 'bg-emerald-500'
            }`}
          />
          <span className="truncate font-mono text-canvas-foreground">
            {readOnly ? 'overview' : 'index.ts'}
          </span>
          {readOnly ? (
            <span className="rounded bg-canvas-muted px-1.5 py-0.5 text-[10px] font-medium uppercase tracking-wider text-canvas-muted-foreground">
              read-only
            </span>
          ) : null}
        </div>
        <div className="flex min-w-0 items-center gap-1 text-canvas-muted-foreground sm:gap-2">
          <button
            type="button"
            onClick={isAnimating ? onStop : onRun}
            disabled={readOnly || (isAnimating ? stopRequested || !onStop : false)}
            className={
              isAnimating
                ? stopRequested
                  ? 'inline-flex shrink-0 items-center gap-1.5 rounded-md bg-canvas-muted px-2.5 py-1 text-xs font-semibold text-canvas-muted-foreground disabled:cursor-not-allowed disabled:opacity-60'
                  : 'inline-flex shrink-0 items-center justify-center rounded p-1.5 text-red-400 transition-colors hover:bg-red-500/10 hover:text-red-300 disabled:cursor-not-allowed disabled:opacity-40'
                : 'inline-flex shrink-0 items-center justify-center rounded p-1.5 text-canvas-muted-foreground transition-colors hover:bg-canvas-muted hover:text-canvas-foreground disabled:cursor-not-allowed disabled:opacity-40'
            }
            title={stopRequested ? 'Stopping…' : isAnimating ? 'Stop run' : 'Run code (R)'}
            aria-label={stopRequested ? 'Stopping' : isAnimating ? 'Stop run' : 'Run code'}
          >
            {isAnimating ? (
              stopRequested ? (
                <>
                  <Loader2 className="size-3.5 animate-spin" />
                  <span>Stopping…</span>
                </>
              ) : (
                <Square className="size-4 fill-current" />
              )
            ) : (
              <Play className="size-4 fill-current" />
            )}
          </button>
          <button
            type="button"
            onClick={onCheck}
            disabled={readOnly || checkDisabled}
            className="shrink-0 rounded p-1.5 text-canvas-muted-foreground transition-colors hover:bg-canvas-muted hover:text-canvas-foreground disabled:cursor-not-allowed disabled:opacity-40"
            title="Check answer"
            aria-label="Check answer"
          >
            <Check className="size-4" />
          </button>
          <select
            id="run-mode-select-desktop"
            value={runMode}
            onChange={(e) => setRunMode(e.target.value as RunMode)}
            disabled={readOnly}
            suppressHydrationWarning
            className="run-mode-select-desktop ml-1 min-w-0 max-w-[6.5rem] shrink truncate rounded border border-canvas-border bg-canvas px-1.5 py-1 text-[10px] font-medium uppercase tracking-wider text-canvas-muted-foreground sm:max-w-none transition-colors hover:text-canvas-foreground focus:border-emerald-500/60 focus:outline-none focus:ring-1 focus:ring-emerald-500/30 disabled:cursor-not-allowed disabled:opacity-40"
            title="Run mode"
            aria-label="Run mode"
          >
            <option value="this-device">This device</option>
            <option value="simulated">Simulated</option>
            <option
              value="remote"
              disabled={pairedMode === false || remotePeers.length === 0}
              title={
                pairedMode === false
                  ? 'This lesson serves a port on the machine it runs on, which a paired device cannot reach. Run it here.'
                  : localIsOnlyHost
                    ? 'This device is the host in every pair. Hosts accept runs from guests, not the other way around.'
                    : selfPairCount > 0
                      ? 'Only paired device is this device. Launch an isolated host with `pnpm dev:host` to enable this mode.'
                      : 'No paired devices. Pair one in Settings > Devices.'
              }
            >
              Paired device
            </option>
          </select>
          {runMode === 'remote' ? (
            <select
              aria-label="Pick a paired device"
              value={selectedPeerId}
              onChange={(e) => setSelectedPeerId(e.target.value)}
              disabled={readOnly}
              suppressHydrationWarning
              className="ml-1 min-w-0 max-w-[5.5rem] shrink truncate rounded border border-canvas-border bg-canvas px-1.5 py-1 sm:max-w-[10rem] text-[10px] font-medium uppercase tracking-wider text-canvas-muted-foreground transition-colors hover:text-canvas-foreground focus:border-emerald-500/60 focus:outline-none focus:ring-1 focus:ring-emerald-500/30 disabled:cursor-not-allowed disabled:opacity-40"
              title={
                remotePeers.length === 0
                  ? 'No paired devices. Pair one in Settings.'
                  : 'Pick a paired device'
              }
            >
              {remotePeers.length === 0 ? <option value="">No paired devices</option> : null}
              {remotePeers.map((p) => (
                <option key={p.discoveryKey} value={p.discoveryKey}>
                  {peerDisplayName(p)}
                </option>
              ))}
            </select>
          ) : null}
          {/* biome-ignore lint/security/noDangerouslySetInnerHtml: static string, no user input */}
          <script
            suppressHydrationWarning
            dangerouslySetInnerHTML={{
              __html:
                "try{if(window.academy&&window.academy.run){var s=document.getElementById('run-mode-select-desktop');if(s)s.value='this-device';}}catch(e){}",
            }}
          />
          <select
            aria-hidden={isDesktop}
            tabIndex={isDesktop ? -1 : undefined}
            disabled={isDesktop || readOnly}
            suppressHydrationWarning
            className="run-mode-select-web ml-1 shrink-0 rounded border border-canvas-border bg-canvas px-1.5 py-1 text-[10px] font-medium uppercase tracking-wider text-canvas-muted-foreground"
            title={isDesktop ? undefined : 'Run mode'}
            aria-label={isDesktop ? undefined : 'Run mode'}
          >
            <option value="simulated">Simulated</option>
          </select>
          <HelpPanel
            hints={hints}
            answer={answer}
            onReveal={() => setUserCode(answer)}
            disabled={readOnly || !answer}
          />
          <button
            type="button"
            aria-label="Reset code"
            onClick={onReset}
            disabled={readOnly}
            className="shrink-0 rounded p-1.5 transition-colors hover:bg-canvas-muted hover:text-canvas-foreground disabled:cursor-not-allowed disabled:opacity-40"
            title="Reset to starting code"
          >
            <RotateCcw className="size-4" />
          </button>
          <button
            type="button"
            aria-label={copied ? 'Copied' : 'Copy code'}
            onClick={handleCopy}
            className={`relative rounded p-1.5 transition-colors ${
              copied ? 'text-emerald-400' : 'hover:bg-canvas-muted hover:text-canvas-foreground'
            }`}
            title={copied ? 'Copied!' : 'Copy code'}
          >
            {copied ? <Check className="size-4" /> : <Copy className="size-4" />}
          </button>
        </div>
      </div>

      {argv && argv.length > 0 && isDesktop && runMode === 'this-device' && !readOnly ? (
        <div className="flex flex-col gap-1.5 border-b border-canvas-border bg-canvas/60 px-3 py-2 sm:px-4">
          {argv.map((slot) => {
            const source = sourceFromArgvFrom(slot.from);
            const capturedValue = source ? (argvCaptured[source] ?? '') : '';
            const isOverriding = slot.name in argvOverrides;
            const displayValue = isOverriding ? argvOverrides[slot.name] : capturedValue;
            const wasJustCopied = capturedCopiedKey === slot.name;
            return (
              <div key={slot.name} className="flex items-center gap-2 text-xs">
                <label
                  htmlFor={`argv-${slot.name}`}
                  className="shrink-0 font-medium text-canvas-muted-foreground"
                >
                  {slot.label ?? slot.name}
                </label>
                <input
                  id={`argv-${slot.name}`}
                  type="text"
                  value={displayValue}
                  readOnly={!isOverriding}
                  spellCheck={false}
                  autoComplete="off"
                  onFocus={(e) => {
                    if (!isOverriding) e.currentTarget.select();
                  }}
                  onChange={(e) => onArgvOverrideValue(slot.name, e.target.value)}
                  placeholder={isOverriding ? '' : argInputPlaceholder(slot, argvCaptured)}
                  className={
                    isOverriding
                      ? 'min-w-0 flex-1 rounded border border-canvas-border bg-canvas px-2 py-1 font-mono text-xs text-canvas-foreground placeholder:text-canvas-muted-foreground/50 focus:border-emerald-500/60 focus:outline-none focus:ring-1 focus:ring-emerald-500/30'
                      : 'min-w-0 flex-1 cursor-default select-all rounded border border-canvas-border bg-canvas-muted/50 px-2 py-1 font-mono text-xs text-canvas-foreground focus:border-emerald-500/40 focus:outline-none focus:ring-1 focus:ring-emerald-500/20'
                  }
                />
                {isOverriding ? (
                  <button
                    type="button"
                    onClick={() => onArgvOverrideClear(slot.name)}
                    className="shrink-0 rounded p-1 text-canvas-muted-foreground transition-colors hover:bg-canvas-muted hover:text-canvas-foreground"
                    title="Clear override (use captured value)"
                  >
                    <X className="size-3" />
                  </button>
                ) : (
                  <>
                    {capturedValue ? (
                      <button
                        type="button"
                        onClick={() => handleCopyCaptured(slot.name, capturedValue)}
                        className={`shrink-0 rounded p-1 transition-colors hover:bg-canvas-muted ${
                          wasJustCopied
                            ? 'text-emerald-400'
                            : 'text-canvas-muted-foreground hover:text-canvas-foreground'
                        }`}
                        title="Copy captured key"
                      >
                        {wasJustCopied ? <Check className="size-3" /> : <Copy className="size-3" />}
                      </button>
                    ) : null}
                    <button
                      type="button"
                      onClick={() => onArgvOverrideStart(slot.name)}
                      className="shrink-0 rounded p-1 text-canvas-muted-foreground transition-colors hover:bg-canvas-muted hover:text-canvas-foreground"
                      title="Use a different key"
                    >
                      <Pencil className="size-3" />
                    </button>
                  </>
                )}
              </div>
            );
          })}
        </div>
      ) : null}

      {/* One platform is not a choice, and the row costs as much height as six
          lines of code. Only lessons that actually offer an alternative get it. */}
      {platforms.length > 1 ? (
      <div className="flex flex-wrap items-center gap-1 border-b border-canvas-border bg-canvas px-3 py-2 sm:px-4">
        {platforms.map((p) => (
          <button
            key={p}
            type="button"
            onClick={() => setPlatform(p)}
            disabled={readOnly}
            className={`rounded-md px-2.5 py-1 text-xs font-medium capitalize transition-colors disabled:cursor-not-allowed ${
              platform === p
                ? 'bg-emerald-500/15 text-emerald-400 ring-1 ring-emerald-500/40'
                : 'text-canvas-muted-foreground hover:bg-canvas-muted hover:text-canvas-foreground'
            }`}
          >
            {p}
          </button>
        ))}
        {platform !== 'node' ? (
          <span className="ml-2 text-xs text-canvas-muted-foreground">
            ({platform} version isn't supported yet)
          </span>
        ) : null}
      </div>
      ) : null}

      {/* lg split: code 70% / output 30% of the runner card's height. */}
      {/* Monaco sits out of flow so its height comes from this box; in the stacked layout
          its own height:100% wrapper would otherwise resolve to auto and collapse. */}
      <div
        className="relative min-h-[420px] flex-1 overflow-hidden lg:min-h-0 lg:flex lg:basis-[70%]"
        style={{ backgroundColor: QVAC_EDITOR_BACKGROUND }}
      >
        <div className="absolute inset-0">
          <MonacoLessonEditor
            value={userCode}
            readOnly={readOnly}
            onChange={(value) => setUserCode(value)}
          />
        </div>
      </div>

      {runMode === 'remote' && remotePeers.length === 0 ? (
        <div className="flex h-[280px] shrink-0 items-center justify-center border-t border-canvas-border bg-canvas-muted font-sans text-sm text-canvas-muted-foreground lg:h-auto lg:min-h-0 lg:flex lg:basis-[30%]">
          <div className="flex max-w-sm flex-col items-center gap-2 text-center">
            {localIsOnlyHost ? (
              <>
                <div className="text-canvas-foreground">
                  This device is the host in every pair.
                </div>
                <div>
                  Hosts accept runs from guests; they don&apos;t forward them. Pair a second
                  device (or run{' '}
                  <code className="rounded bg-canvas-muted px-1.5 py-0.5 text-[11px]">
                    pnpm dev:host
                  </code>{' '}
                  in another terminal) and have it accept the invite, then come back.
                </div>
              </>
            ) : selfPairCount > 0 ? (
              <>
                <div className="text-canvas-foreground">
                  The only paired device is this device.
                </div>
                <div>
                  Two app instances sharing a userData directory pair as the same identity, but
                  the exec channel can&apos;t route between matching keys. Run{' '}
                  <code className="rounded bg-canvas-muted px-1.5 py-0.5 text-[11px]">
                    pnpm dev:host
                  </code>{' '}
                  in a second terminal to launch an isolated host, then pair it from{' '}
                  <Link
                    href="/settings"
                    className="text-emerald-400 underline-offset-2 hover:underline"
                  >
                    Settings
                  </Link>
                  .
                </div>
              </>
            ) : (
              <>
                <div className="text-canvas-foreground">No paired devices yet.</div>
                <div>
                  Pair another device in{' '}
                  <Link
                    href="/settings"
                    className="text-emerald-400 underline-offset-2 hover:underline"
                  >
                    Settings
                  </Link>{' '}
                  to run this lesson there.
                </div>
              </>
            )}
          </div>
        </div>
      ) : (
        <div className="flex min-h-0 lg:flex lg:basis-[30%]">
          <LessonConsole entries={entries} onStopCheck={onStopCheck} />
        </div>
      )}
      {/* No padding and no border of its own: the inset was the panel's own
          fill showing through around the chat bar, and the bar draws the only
          two rules this needs. */}
      {footer ? (
        <div className="shrink-0" style={{ backgroundColor: QVAC_EDITOR_BACKGROUND }}>
          {footer}
        </div>
      ) : null}
    </div>
  );
}

type RemoteRunState =
  | { kind: 'running'; peerId: string; startedAt: number }
  | { kind: 'ok'; peerId: string; startedAt: number; endedAt: number }
  | {
      kind: 'err';
      peerId: string;
      startedAt: number;
      endedAt: number;
      code: number | null;
      signal: string | null;
      message: string | null;
    };

function formatDuration(ms: number): string {
  if (ms < 0) ms = 0;
  const totalSec = Math.floor(ms / 1000);
  if (totalSec < 60) return `${totalSec}s`;
  const min = Math.floor(totalSec / 60);
  const sec = totalSec % 60;
  if (min < 60) return `${min}m ${sec}s`;
  const hr = Math.floor(min / 60);
  const m2 = min % 60;
  return `${hr}h ${m2}m`;
}

// Pattern flags must match the runner's logic so a passing test here also passes the browser's Check Answer.
function runTests(code: string, tests: LessonTest[]) {
  return tests.map((t) => {
    let passed = false;
    if (t.pattern) {
      try {
        passed = new RegExp(t.pattern, 'm').test(code);
      } catch {
        passed = false;
      }
    }
    if (!passed && t.contains) {
      passed = code.includes(t.contains);
    }
    return { id: t.id, description: t.description, passed };
  });
}

function delay(ms: number) {
  return new Promise((r) => setTimeout(r, ms));
}
