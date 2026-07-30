'use client';

import type { AcademyAPI, AcademyRunChunk } from '@academy/academy-bridge';
import { useUserStore } from '@academy/core';
import type { CurriculumChapter, CurriculumLesson } from '@academy/courses';
import { ArrowLeft, ArrowRight, Check, Copy, Loader2, Pencil, Play, RotateCcw, Square, X } from 'lucide-react';
import Link from 'next/link';
import { type ReactNode, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { CurriculumStrip } from './curriculum-strip.js';
import { HelpPanel } from './help-panel.js';
import { LessonCompleteModal } from './lesson-complete-modal.js';
import { MonacoLessonEditor } from './monaco-lesson-editor.js';

export interface LessonTest {
  id: string;
  description: string;
  pattern?: string;
  contains?: string;
}

export interface LessonArgvSlot {
  name: string;
  from: 'state:lastProviderPublicKey' | 'literal';
  default?: string;
  label?: string;
}

export type OutputLine = {
  stream: "stdout" | "stderr";
  line: string;
};

export interface LessonData {
  title: string;
  description?: string;
  startingCode: string;
  answer: string;
  tests: LessonTest[];
  hints: string[];
  expectedOutput: string[];
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
}

const TABS = ['output', 'tests', 'preview'] as const;
type Tab = (typeof TABS)[number];

const RUN_MODES = ['simulated', 'this-device', 'remote'] as const;
type RunMode = (typeof RUN_MODES)[number];

const ARGV_OVERRIDE_PREFIX = 'argv.override.';
const ARGV_CAPTURED_PREFIX = 'argv.captured.';

const CAPTURE_MARKERS: Array<{ pattern: RegExp; target: string }> = [
  { pattern: /▸\s+Provider Public Key:\s+([a-f0-9]{64})/i, target: 'lastProviderPublicKey' },
];

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
  if (data && typeof data === 'object' && 'name' in data && typeof (data as { name: unknown }).name === 'string') {
    return (data as { name: string }).name;
  }
  if (data && typeof data === 'object' && 'hostname' in data && typeof (data as { hostname: unknown }).hostname === 'string') {
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

// Per-run temp file label shown in the paired-devices audit log; uses the lesson title.
function runFileName(data: LessonData): string {
  const slug = data.title
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
  return `${slug || 'lesson'}.mts`;
}

declare global {
  interface Window {
    academy?: AcademyAPI;
  }
}

export function LessonWorkspace({ data, children }: { data: LessonData; children: ReactNode }) {
  const [userCode, setUserCode] = useState(data.startingCode);
  const [platform, setPlatform] = useState<LessonData['platforms'][number]>('node');
  const [tab, setTab] = useState<Tab>('output');
  // typeof window differs between SSR and client; defer to useEffect
  // so the first client render matches the SSR'd HTML.
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
  // Poll identity on a short interval: peer.init runs after app.whenReady, so
  // a workspace mounted earlier in the boot may see null for a beat.
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
  // Two app instances sharing a userData dir pair as the same identity; the
  // exec channel can't route between matching keys, so runs hang silently.
  // Filter self-pairs, then keep only guest-role peers (the side that runs
  // the code) so a host never tries to forward runs to itself-as-host.
  const realRemotePeers = useMemo(() => {
    const notSelf = localPublicKey
      ? remotePeers.filter((p) => p.hostIdentity !== localPublicKey)
      : remotePeers;
    return notSelf.filter((p) => p.role === 'guest');
  }, [remotePeers, localPublicKey]);
  const selfPairCount = remotePeers.length - realRemotePeers.length;
  const localIsOnlyHost =
    remotePeers.length > 0 && remotePeers.every((p) => p.role === 'host');
  const [selectedPeerId, setSelectedPeerId] = useState<string>('');
  // Auto-pick the most recently paired device when entering Paired-device mode
  // with no current selection (initial entry, peer dropped, mode flip-back).
  useEffect(() => {
    if (runMode !== 'remote') return;
    if (realRemotePeers.length === 0) return;
    if (realRemotePeers.some((p) => p.discoveryKey === selectedPeerId)) return;
    const latest = realRemotePeers.reduce((a, b) => (a.pairedAt >= b.pairedAt ? a : b));
    setSelectedPeerId(latest.discoveryKey);
  }, [runMode, realRemotePeers, selectedPeerId]);
  const [testResults, setTestResults] = useState<null | ReturnType<typeof runTests>>(null);
  const [outputLines, setOutputLines] = useState<OutputLine[]>([]);
  const [isAnimating, setIsAnimating] = useState(false);
  const [stopRequested, setStopRequested] = useState(false);
  const [showCompleteModal, setShowCompleteModal] = useState(false);
  const [hasShownModal, setHasShownModal] = useState(false);
  const [outputKey, setOutputKey] = useState(0);
  const [argvOverrides, setArgvOverrides] = useState<Record<string, string>>({});
  const [argvCaptured, setArgvCaptured] = useState<Record<string, string>>({});
  const [lastRemoteRun, setLastRemoteRun] = useState<
    | { kind: 'running'; peerId: string; startedAt: number }
    | { kind: 'ok'; peerId: string; startedAt: number; endedAt: number }
    | { kind: 'err'; peerId: string; startedAt: number; endedAt: number; code: number | null; signal: string | null; message: string | null }
    | null
  >(null);

  useEffect(() => {
    if (data.readOnly) {
      setUserCode(data.startingCode || '// This section is informational. No code to run here.\n');
    } else {
      setUserCode(data.startingCode);
    }
    setTestResults(null);
    setOutputLines([]);
    setTab('output');
    setRunMode(isDesktop ? 'this-device' : 'simulated');
    setShowCompleteModal(false);
    setHasShownModal(false);
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

  // Empty value still represents an active override session; only non-empty values persist.
  const setArgvOverrideValue = useCallback((name: string, value: string) => {
    setArgvOverrides((prev) => {
      if (!(name in prev) && value.length === 0) return prev;
      return { ...prev, [name]: value };
    });
    if (isDesktop && value.length > 0) {
      void window.academy?.state?.set(overrideKey(name), value);
    }
  }, [isDesktop]);

  const startArgvOverride = useCallback((name: string) => {
    setArgvOverrides((prev) => {
      if (name in prev) return prev;
      return { ...prev, [name]: '' };
    });
  }, []);

  const clearArgvOverride = useCallback((name: string) => {
    setArgvOverrides((prev) => {
      if (!(name in prev)) return prev;
      const next = { ...prev };
      delete next[name];
      return next;
    });
    if (isDesktop) {
      void window.academy?.state?.remove(overrideKey(name));
    }
  }, [isDesktop]);

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

  const allPassed = testResults?.every((r) => r.passed) ?? false;

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
    if (isLastLessonOfChapter && !hasShownModal) {
      setShowCompleteModal(true);
      setHasShownModal(true);
    }
  }, [
    allPassed,
    isLastLessonOfChapter,
    data.currentChapter,
    data.currentLesson,
    hasShownModal,
    markLessonComplete,
  ]);

  const check = useCallback(() => {
    setTab('tests');
    setTestResults(runTests(userCode, data.tests));
  }, [userCode, data.tests]);

  const run = useCallback(async () => {
    setTab('output');
    setOutputLines([]);
    setOutputKey((prev) => prev + 1);

    // Skip the run when TODOs are still empty, so the panel doesn't go blank and the button doesn't look broken.
    const unchangedFromStarter =
      userCode === data.startingCode ||
      (/^\s*\/\/\s*\d+:/m.test(userCode) && /^\s*await\s+unloadModel\s*\(/m.test(userCode));
    if (unchangedFromStarter) {
      setOutputLines([
        { stream: 'stdout', line: 'Looks like you haven\u2019t started yet.' },
        {
          stream: 'stdout',
          line: 'The starting code has numbered TODOs (// 1:, // 2:, \u2026). Fill those in, then click Run again.',
        },
      ]);
      return;
    }

    if (runMode === 'remote') {
      if (realRemotePeers.length === 0) {
        const lines: OutputLine[] = localIsOnlyHost
          ? [
              {
                stream: 'stdout',
                line:
                  '[paired] This device is the host in every pair. Hosts accept runs from guests; they don\'t forward them.',
              },
              {
                stream: 'stdout',
                line:
                  'Pair a second device and have it accept the invite (or `pnpm dev:host` in another terminal), then come back.',
              },
            ]
          : selfPairCount > 0
            ? [
                {
                  stream: 'stdout',
                  line:
                    '[paired] The only paired device is this device. Two app instances sharing a userData directory end up paired as the same identity, but the exec channel can\'t route between matching keys.',
                },
                {
                  stream: 'stdout',
                  line:
                    'Run `pnpm --filter @tether-academy/desktop dev:host` in a second terminal to launch an isolated host, then pair it from Settings > Devices.',
                },
              ]
            : [
                {
                  stream: 'stdout',
                  line: '[paired] No paired devices. Open Settings to pair one, then come back.',
                },
              ];
        setOutputLines(lines);
        if (isLastLessonOfChapter && !data.readOnly) {
          setTab('tests');
          setTestResults(runTests(userCode, data.tests));
        }
        return;
      }
      if (!selectedPeerId) {
        setOutputLines([
          { stream: 'stdout', line: '[paired] Pick a paired device from the picker next to Run, then click Run again.' },
        ]);
        if (isLastLessonOfChapter && !data.readOnly) {
          setTab('tests');
          setTestResults(runTests(userCode, data.tests));
        }
        return;
      }
      // Falls through to the same this-device path, but with peerId in the payload.
    }

    const canRunForReal =
      (runMode === 'this-device' || (runMode === 'remote' && !!selectedPeerId)) &&
      typeof window !== 'undefined' &&
      window.academy?.run;

    const resolvedArgv = await resolveArgv();

    // The "no output produced" fallback below reads this, not a stale state read.
    let producedOutput: OutputLine[] = [];

    if (canRunForReal) {
      setIsAnimating(true);
      setStopRequested(false);
      const runStartedAt = Date.now();
      const isRemoteRun = runMode === 'remote' && !!selectedPeerId;
      if (isRemoteRun && selectedPeerId) {
        setLastRemoteRun({ kind: 'running', peerId: selectedPeerId, startedAt: runStartedAt });
      }
      // Stream chunks as they arrive so 30-60s finetune runs don't look frozen.
      // Local buffer keeps stream type so the panel can distinguish reasoning from answer text.
      const streamBuffer: OutputLine[] = [];
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
        const newLines = chunk.data.split('\n').map((line) => ({
          stream: chunk.stream,
          line,
        }));
        streamBuffer.push(...newLines);
        setOutputLines((prev) => [...prev, ...newLines]);
        if (chunk.stream === 'stdout') scanForCaptures(chunk.data);
      });
      try {
        const result = await window.academy?.run({
          source: userCode,
          language: 'typescript',
          argv: resolvedArgv,
          fileName: runFileName(data),
          ...(isRemoteRun && selectedPeerId ? { peerId: selectedPeerId } : {}),
        });
        if (!result) {
          producedOutput = [
            ...streamBuffer,
            { stream: 'stdout', line: '[error] no run result returned' },
          ];
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
        } else if (result.output && result.output.trim().length > 0) {
          producedOutput = [
            ...streamBuffer,
            { stream: 'stdout', line: result.output.trim() },
          ];
          if (isRemoteRun && selectedPeerId) {
            setLastRemoteRun({
              kind: 'err',
              peerId: selectedPeerId,
              startedAt: runStartedAt,
              endedAt: Date.now(),
              code: result.remoteExit?.code ?? null,
              signal: result.remoteExit?.signal ?? null,
              message: result.output.trim().split('\n').pop() ?? null,
            });
          }
        } else {
          producedOutput = [
            ...streamBuffer,
            { stream: 'stdout', line: '[exit non-zero]' },
          ];
          if (isRemoteRun && selectedPeerId) {
            setLastRemoteRun({
              kind: 'err',
              peerId: selectedPeerId,
              startedAt: runStartedAt,
              endedAt: Date.now(),
              code: result.remoteExit?.code ?? null,
              signal: result.remoteExit?.signal ?? null,
              message: '[exit non-zero]',
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
      if ((runMode === 'this-device' || runMode === 'remote') && typeof window !== 'undefined' && !window.academy?.run) {
        producedOutput = [
          ...producedOutput,
          { stream: 'stdout', line: '' },
          { stream: 'stdout', line: '[hint] Open in the desktop app to run this code for real.' },
        ];
      }
      setIsAnimating(false);
    }

    // If the run produced nothing, fall back to the test results so the
    // panel isn't blank and the student can see which check failed.
    if (producedOutput.length === 0 && data.tests.length > 0) {
      const results = runTests(userCode, data.tests);
      const summary = results.map((r) =>
        r.passed ? `  \u2713 ${r.description}` : `  \u2717 ${r.description}`,
      );
      producedOutput = [
        { stream: 'stdout', line: 'No output produced by the run. The checks below tell you which part is missing:' },
        { stream: 'stdout', line: '' },
        ...summary.map((line) => ({ stream: 'stdout' as const, line })),
      ];
    }

    setOutputLines(producedOutput);

    if (isLastLessonOfChapter && !data.readOnly) {
      setTab('tests');
      setTestResults(runTests(userCode, data.tests));
    }
  }, [
    runMode,
    userCode,
    data.expectedOutput,
    data.tests,
    data.readOnly,
    isLastLessonOfChapter,
    resolveArgv,
    isDesktop,
    realRemotePeers,
    selfPairCount,
    localIsOnlyHost,
    selectedPeerId,
  ]);

  const reset = useCallback(() => {
    setUserCode(data.startingCode);
    setTestResults(null);
    setOutputLines([]);
  }, [data.startingCode]);

  const stopRun = useCallback(() => {
    if (!isAnimating) return;
    setStopRequested(true);
    void window.academy?.stop?.();
  }, [isAnimating]);

  return (
    <div className="flex w-full flex-col lg:h-[calc(100vh-3.5rem)]">
      <div className="flex min-h-0 flex-col gap-4 px-4 pb-24 pt-4 sm:px-6 sm:pt-6 lg:flex-1 lg:flex-row lg:gap-6 lg:overflow-hidden lg:pb-0">
        <section className="min-w-0 lg:max-w-[42%] lg:min-w-[360px] lg:flex-shrink-0 lg:h-full lg:overflow-y-auto lg:pr-2">
          <CurriculumStrip chapter={data.currentChapter} currentLesson={data.currentLesson} />

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
        </section>

        <section className="flex min-w-0 flex-col pb-[9px] lg:h-full lg:min-h-0 lg:flex-1">
          <Runner
            userCode={userCode}
            setUserCode={setUserCode}
            platform={platform}
            setPlatform={setPlatform}
            tab={tab}
            setTab={setTab}
            runMode={runMode}
            setRunMode={setRunMode}
            isDesktop={isDesktop}
            testResults={testResults}
            outputLines={outputLines}
            isAnimating={isAnimating}
            onRun={run}
            onStop={stopRun}
            onReset={reset}
            platforms={data.platforms}
            readOnly={data.readOnly}
            hints={data.hints}
            answer={data.answer}
            outputKey={outputKey}
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
            stopRequested={stopRequested}
          />
        </section>
      </div>

      {data.currentChapter ? (
        <nav className="sticky bottom-0 z-10 shrink-0 border-t border-canvas-border bg-canvas/95 backdrop-blur supports-[backdrop-filter]:bg-canvas/85 lg:static">
          <div className="flex items-center gap-2 px-4 py-3 sm:gap-3 sm:px-6 sm:py-3.5">
            {data.prevUrl ? (
              <Link
                href={data.prevUrl}
                className="inline-flex items-center gap-1.5 rounded-md border border-canvas-border bg-canvas px-3 py-2 text-sm text-canvas-foreground transition-colors hover:bg-canvas-muted"
              >
                <ArrowLeft className="size-4" />
                <span className="hidden sm:inline">Previous</span>
              </Link>
            ) : null}
            {data.currentLesson ? (
              data.readOnly ? (
                <span className="mx-auto inline-flex items-center gap-1.5 rounded-md bg-canvas-muted px-4 py-2 text-sm font-medium text-canvas-muted-foreground">
                  No code in this section
                </span>
              ) : (
                <button
                  type="button"
                  onClick={check}
                  disabled={data.tests.length === 0}
                  className="mx-auto inline-flex items-center gap-1.5 rounded-md bg-emerald-500 px-4 py-2 text-sm font-semibold text-canvas transition-colors hover:bg-emerald-400 disabled:opacity-50"
                >
                  <Check className="size-4" />
                  <span>Check Answer</span>
                </button>
              )
            ) : data.firstLessonHref ? (
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
            {data.nextUrl ? (
              <Link
                href={data.nextUrl}
                className="inline-flex items-center gap-1.5 rounded-md border border-canvas-border bg-canvas px-3 py-2 text-sm text-canvas-foreground transition-colors hover:bg-canvas-muted"
              >
                <span className="hidden sm:inline">Next</span>
                <ArrowRight className="size-4" />
              </Link>
            ) : null}
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
  tab,
  setTab,
  runMode,
  setRunMode,
  isDesktop = false,
  testResults,
  outputLines,
  isAnimating,
  onRun,
  onStop,
  onReset,
  platforms,
  readOnly = false,
  hints,
  answer,
  outputKey,
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
  stopRequested = false,
}: {
  userCode: string;
  setUserCode: (s: string) => void;
  platform: LessonData['platforms'][number];
  setPlatform: (p: LessonData['platforms'][number]) => void;
  tab: Tab;
  setTab: (t: Tab) => void;
  runMode: RunMode;
  setRunMode: (m: RunMode) => void;
  isDesktop?: boolean;
  testResults: null | ReturnType<typeof runTests>;
  outputLines: OutputLine[];
  isAnimating: boolean;
  onRun: () => void;
  onStop?: () => void;
  onReset: () => void;
  platforms: LessonData['platforms'];
  readOnly?: boolean;
  hints: string[];
  answer: string;
  outputKey: number;
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
    | { kind: 'err'; peerId: string; startedAt: number; endedAt: number; code: number | null; signal: string | null; message: string | null }
    | null;
  clearLastRemoteRun: () => void;
  stopRequested?: boolean;
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
  const showRemoteBanner =
    runMode === 'remote' && (isAnimating || lastRemoteRun !== null);

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
      // No-op: visual feedback just won't fire.
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
      // No-op
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
        <div className="flex shrink-0 items-center gap-1 text-canvas-muted-foreground sm:gap-2">
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
            className="rounded p-1.5 transition-colors hover:bg-canvas-muted hover:text-canvas-foreground disabled:cursor-not-allowed disabled:opacity-40"
            title="Reset to starting code"
          >
            <RotateCcw className="size-4" />
          </button>
          <select
            id="run-mode-select-desktop"
            value={runMode}
            onChange={(e) => setRunMode(e.target.value as RunMode)}
            disabled={readOnly}
            suppressHydrationWarning
            className="run-mode-select-desktop ml-1 rounded border border-canvas-border bg-canvas px-1.5 py-1 text-[10px] font-medium uppercase tracking-wider text-canvas-muted-foreground transition-colors hover:text-canvas-foreground focus:border-emerald-500/60 focus:outline-none focus:ring-1 focus:ring-emerald-500/30 disabled:cursor-not-allowed disabled:opacity-40"
            title="Run mode"
            aria-label="Run mode"
          >
            <option value="this-device">This device</option>
            <option value="simulated">Simulated</option>
            <option
              value="remote"
              disabled={remotePeers.length === 0}
              title={
                localIsOnlyHost
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
              className="ml-1 max-w-[10rem] truncate rounded border border-canvas-border bg-canvas px-1.5 py-1 text-[10px] font-medium uppercase tracking-wider text-canvas-muted-foreground transition-colors hover:text-canvas-foreground focus:border-emerald-500/60 focus:outline-none focus:ring-1 focus:ring-emerald-500/30 disabled:cursor-not-allowed disabled:opacity-40"
              title={remotePeers.length === 0 ? 'No paired devices. Pair one in Settings.' : 'Pick a paired device'}
            >
              {remotePeers.length === 0 ? (
                <option value="">No paired devices</option>
              ) : null}
              {remotePeers.map((p) => {
                const name = p.userData && typeof p.userData === 'object' && 'name' in p.userData
                  ? String((p.userData as { name: unknown }).name)
                  : p.discoveryKey.slice(0, 8);
                return (
                  <option key={p.discoveryKey} value={p.discoveryKey}>
                    {name}
                  </option>
                );
              })}
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
            className="run-mode-select-web ml-1 rounded border border-canvas-border bg-canvas px-1.5 py-1 text-[10px] font-medium uppercase tracking-wider text-canvas-muted-foreground"
            title={isDesktop ? undefined : 'Run mode'}
            aria-label={isDesktop ? undefined : 'Run mode'}
          >
            <option value="simulated">Simulated</option>
          </select>
          <button
            type="button"
            onClick={isAnimating ? onStop : onRun}
            disabled={readOnly || (isAnimating ? stopRequested || !onStop : false)}
            className={
              isAnimating
                ? stopRequested
                  ? 'inline-flex items-center gap-1.5 rounded-md bg-canvas-muted px-2.5 py-1 text-xs font-semibold text-canvas-muted-foreground disabled:cursor-not-allowed disabled:opacity-60'
                  : runMode === 'remote'
                    ? 'inline-flex items-center gap-1.5 rounded-md bg-red-500 px-2.5 py-1 text-xs font-semibold text-canvas transition-colors hover:bg-red-400 disabled:cursor-not-allowed disabled:opacity-40'
                    : 'inline-flex items-center justify-center rounded p-1.5 text-red-400 transition-colors hover:bg-red-500/10 hover:text-red-300 disabled:cursor-not-allowed disabled:opacity-40'
                : 'inline-flex items-center justify-center rounded p-1.5 text-canvas-muted-foreground transition-colors hover:bg-canvas-muted hover:text-canvas-foreground disabled:cursor-not-allowed disabled:opacity-40'
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
              ) : runMode === 'remote' ? (
                <>
                  <Square className="size-3.5 fill-current" />
                  <span>Stop</span>
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
            const capturedValue = source ? argvCaptured[source] ?? '' : '';
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

      <div className="min-h-0 flex-1 overflow-hidden">
        <MonacoLessonEditor
          value={userCode}
          readOnly={readOnly}
          onChange={(value) => setUserCode(value)}
        />
      </div>

      <div className="flex items-center gap-1 border-t border-canvas-border bg-canvas px-2">
        {TABS.map((t) => (
          <button
            key={t}
            type="button"
            onClick={() => setTab(t)}
            className={`relative px-3 py-2 text-xs font-semibold uppercase tracking-wider transition-colors ${
              tab === t
                ? 'text-emerald-400'
                : 'text-canvas-muted-foreground hover:text-canvas-foreground'
            }`}
          >
            {t}
            {tab === t ? (
              <span className="absolute inset-x-0 bottom-0 mx-auto h-0.5 w-8 bg-emerald-400" />
            ) : null}
          </button>
        ))}
      </div>

      {showRemoteBanner ? (
        <RunStatusBanner
          lastRun={lastRemoteRun}
          peerName={peerName}
          isAnimating={isAnimating}
          stopRequested={stopRequested}
          onDismiss={clearLastRemoteRun}
        />
      ) : null}

      <div className="h-[200px] shrink-0 overflow-auto border-t border-canvas-border bg-canvas-muted p-4 font-mono text-sm text-canvas-foreground">
        {tab === 'output' ? (
          runMode === 'remote' && remotePeers.length === 0 ? (
            <div className="flex h-full items-center justify-center font-sans text-sm text-canvas-muted-foreground">
              <div className="flex max-w-sm flex-col items-center gap-2 text-center">
                {localIsOnlyHost ? (
                  <>
                    <div className="text-canvas-foreground">
                      This device is the host in every pair.
                    </div>
                    <div>
                      Hosts accept runs from guests; they don&apos;t forward them. Pair a
                      second device (or run{' '}
                      <code className="rounded bg-canvas-muted px-1.5 py-0.5 text-[11px]">
                        pnpm dev:host
                      </code>{' '}
                      in another terminal) and have it accept the invite, then come
                      back.
                    </div>
                  </>
                ) : selfPairCount > 0 ? (
                  <>
                    <div className="text-canvas-foreground">
                      The only paired device is this device.
                    </div>
                    <div>
                      Two app instances sharing a userData directory pair as the same
                      identity, but the exec channel can&apos;t route between matching
                      keys. Run{' '}
                      <code className="rounded bg-canvas-muted px-1.5 py-0.5 text-[11px]">
                        pnpm dev:host
                      </code>{' '}
                      in a second terminal to launch an isolated host, then pair it
                      from{' '}
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
            <OutputView key={outputKey} lines={outputLines} isAnimating={isAnimating} />
          )
        ) : null}
        {tab === 'tests' ? <TestsView results={testResults} tests={null as never} /> : null}
        {tab === 'preview' ? <PreviewView /> : null}
      </div>
    </div>
  );
}

type RemoteRunState =
  | { kind: 'running'; peerId: string; startedAt: number }
  | { kind: 'ok'; peerId: string; startedAt: number; endedAt: number }
  | { kind: 'err'; peerId: string; startedAt: number; endedAt: number; code: number | null; signal: string | null; message: string | null };

function RunStatusBanner({
  lastRun,
  peerName,
  isAnimating,
  stopRequested,
  onDismiss,
}: {
  lastRun: RemoteRunState | null;
  peerName: string;
  isAnimating: boolean;
  stopRequested: boolean;
  onDismiss: () => void;
}) {
  const now = Date.now();
  const live = isAnimating && lastRun?.kind === 'running' ? lastRun : null;
  const final = !isAnimating && lastRun && lastRun.kind !== 'running' ? lastRun : null;
  const elapsedMs = live
    ? now - live.startedAt
    : final
      ? final.endedAt - final.startedAt
      : 0;
  const elapsedStr = formatDuration(elapsedMs);

  let tone: 'running' | 'ok' | 'err' | 'stopping' = 'running';
  let headline = '';
  let detail = '';
  let spinning = false;
  if (live) {
    if (stopRequested) {
      tone = 'stopping';
      headline = `Stopping on ${peerName}`;
      detail = `dropping paired device · ${elapsedStr} elapsed`;
      spinning = true;
    } else {
      tone = 'running';
      headline = `Running on ${peerName}`;
      detail = `streaming output · ${elapsedStr} elapsed`;
      spinning = true;
    }
  } else if (final?.kind === 'ok') {
    tone = 'ok';
    headline = `Finished on ${peerName}`;
    detail = `exit 0 · took ${elapsedStr}`;
  } else if (final?.kind === 'err') {
    tone = 'err';
    const code = final.code;
    const signal = final.signal;
    if (signal) {
      headline = `Stopped on ${peerName}`;
      detail = `${signal} · ${elapsedStr}`;
    } else if (code != null) {
      headline = `Failed on ${peerName}`;
      detail = `exit ${code} · ${elapsedStr}`;
    } else {
      headline = `Failed on ${peerName}`;
      detail = final.message ? `${final.message} · ${elapsedStr}` : elapsedStr;
    }
  }

  const toneClasses =
    tone === 'running'
      ? 'border-sky-500/40 bg-sky-500/10 text-sky-300'
      : tone === 'stopping'
        ? 'border-amber-500/40 bg-amber-500/10 text-amber-300'
        : tone === 'ok'
          ? 'border-emerald-500/40 bg-emerald-500/10 text-emerald-300'
          : 'border-red-500/40 bg-red-500/10 text-red-300';

  const Icon =
    tone === 'ok' ? Check : tone === 'err' ? X : Loader2;

  return (
    <div
      role="status"
      aria-live="polite"
      className={`flex items-center gap-2 border-b border-canvas-border px-3 py-1.5 text-xs ${toneClasses}`}
    >
      <Icon className={`size-3.5 shrink-0 ${spinning ? 'animate-spin' : ''}`} />
      <span className="font-semibold">{headline}</span>
      <span className="text-canvas-muted-foreground">·</span>
      <span className="text-canvas-muted-foreground">{detail}</span>
      {!live ? (
        <button
          type="button"
          onClick={onDismiss}
          aria-label="Dismiss run status"
          className="ml-auto rounded p-1 text-canvas-muted-foreground transition-colors hover:bg-canvas-muted hover:text-canvas-foreground"
        >
          <X className="size-3" />
        </button>
      ) : null}
    </div>
  );
}

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

function OutputView({ lines, isAnimating }: { lines: OutputLine[]; isAnimating: boolean }) {
  // Find the latest finetune tick. Format: `▸ epoch=1 step=1 batch=1/16 ...`.
  const tickPattern = /epoch=(\d+)\s+step=(\d+)\s+batch=(\d+)\/(\d+)/;
  // Match the trainer's final message or a user-side `console.log('... status: COMPLETED')`.
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
    const percent = completed
      ? 100
      : Math.min(100, Math.round((latestStep / totalSteps) * 100));
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
    <div className="space-y-1 text-canvas-muted-foreground">
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
        // Smart rendering: collapse single newlines to spaces, keep double as paragraph breaks.
        // Falls back to line-by-line when finetune progress lines are present.
        const hasFinetuneProgress = lines.some(
          (e) => e.stream === 'stdout' && /^▸\s+epoch=/.test(e.line),
        );

        if (hasFinetuneProgress) {
          const firstBlank = lines.findIndex(
            (e) => e.stream === 'stdout' && e.line === '',
          );
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

        // Group stdout into paragraphs on double newlines, collapse single newlines to spaces.
        // stderr lines render line-by-line, dimmed.
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
              className={
                isPrefix
                  ? 'whitespace-pre-wrap text-canvas-muted-foreground/60 italic'
                  : 'whitespace-pre-wrap'
              }
            >
              {para}
            </p>
          );
        });

        const renderStderr = stderrLines.map((entry, i) => (
          <p
            key={`err-${i}`}
            className="whitespace-pre-wrap text-canvas-muted-foreground/60 italic"
          >
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
    </div>
  );
}

function TestsView({ results }: { results: null | ReturnType<typeof runTests>; tests: never }) {
  if (!results) {
    return (
      <p className="text-canvas-muted-foreground">
        Click <span className="text-emerald-400">Check Answer</span> in the tutorial to run the
        tests.
      </p>
    );
  }
  return (
    <ul className="space-y-1.5 text-canvas-foreground">
      {results.map((r) => (
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
    </ul>
  );
}

function PreviewView() {
  return (
    <p className="text-canvas-muted-foreground">
      The simulated live preview animates token streams, progress, and UI state changes keyed to
      your code passing the checks. Ships in a later pass. The per-lesson preview animation hooks
      into the same
      <span className="px-1 font-mono text-emerald-400">expectedOutput</span>
      array already declared in the lesson frontmatter.
    </p>
  );
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
