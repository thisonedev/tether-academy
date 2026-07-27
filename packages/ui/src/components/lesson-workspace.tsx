'use client';

import type { AcademyAPI, AcademyRunChunk } from '@academy/academy-bridge';
import { useUserStore } from '@academy/core';
import type { CurriculumChapter, CurriculumLesson } from '@academy/courses';
import { javascript } from '@codemirror/lang-javascript';
import { oneDark } from '@codemirror/theme-one-dark';
import CodeMirror from '@uiw/react-codemirror';
import { ArrowLeft, ArrowRight, Check, Copy, Play, RotateCcw, X } from 'lucide-react';
import Link from 'next/link';
import { type ReactNode, useCallback, useEffect, useState } from 'react';
import { CurriculumStrip } from './curriculum-strip.js';
import { HelpPanel } from './help-panel.js';
import { LessonCompleteModal } from './lesson-complete-modal.js';

export interface LessonTest {
  id: string;
  description: string;
  pattern?: string;
  contains?: string;
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
}

const TABS = ['output', 'tests', 'preview'] as const;
type Tab = (typeof TABS)[number];

const RUN_MODES = ['simulated', 'this-device', 'remote'] as const;
type RunMode = (typeof RUN_MODES)[number];

declare global {
  interface Window {
    academy?: AcademyAPI;
  }
}

export function LessonWorkspace({ data, children }: { data: LessonData; children: ReactNode }) {
  const [userCode, setUserCode] = useState(data.startingCode);
  const [platform, setPlatform] = useState<LessonData['platforms'][number]>('node');
  const [tab, setTab] = useState<Tab>('output');
  // Detect the bridge synchronously so the run-mode preselect lands on the first render.
  const isDesktop = typeof window !== 'undefined' && typeof window.academy?.run === 'function';
  const [runMode, setRunMode] = useState<RunMode>(isDesktop ? 'this-device' : 'simulated');
  const [testResults, setTestResults] = useState<null | ReturnType<typeof runTests>>(null);
  const [outputLines, setOutputLines] = useState<OutputLine[]>([]);
  const [isAnimating, setIsAnimating] = useState(false);
  const [showCompleteModal, setShowCompleteModal] = useState(false);
  const [hasShownModal, setHasShownModal] = useState(false);
  // Bumped on each run and used as the key on OutputView so a re-run
  // remounts it with the cleared state.
  const [outputKey, setOutputKey] = useState(0);

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
      setOutputLines([
        {
          stream: 'stdout',
          line: '[coming soon] Run on a remote device needs a paired device. Open on the desktop app to run for real, or use Simulated.',
        },
      ]);
      if (isLastLessonOfChapter && !data.readOnly) {
        setTab('tests');
        setTestResults(runTests(userCode, data.tests));
      }
      return;
    }

    const canRunForReal =
      runMode === 'this-device' && typeof window !== 'undefined' && window.academy?.run;

    // The "no output produced" fallback below reads this, not a stale state read.
    let producedOutput: OutputLine[] = [];

    if (canRunForReal) {
      setIsAnimating(true);
      // Stream chunks as they arrive so 30-60s finetune runs don't look frozen.
      // Local buffer keeps stream type so the panel can distinguish reasoning from answer text.
      const streamBuffer: OutputLine[] = [];
      const unsubscribe = window.academy?.onRunChunk?.((chunk) => {
        const newLines = chunk.data.split('\n').map((line) => ({
          stream: chunk.stream,
          line,
        }));
        streamBuffer.push(...newLines);
        setOutputLines((prev) => [...prev, ...newLines]);
      });
      try {
        const result = await window.academy?.run({ source: userCode, language: 'typescript' });
        if (!result) {
          producedOutput = [
            ...streamBuffer,
            { stream: 'stdout', line: '[error] no run result returned' },
          ];
        } else if (result.ok) {
          producedOutput = streamBuffer;
        } else {
          producedOutput = [
            ...streamBuffer,
            { stream: 'stdout', line: '[exit non-zero]' },
          ];
        }
      } catch (err) {
        producedOutput = [
          ...streamBuffer,
          {
            stream: 'stdout',
            line: `[error] ${err instanceof Error ? err.message : String(err)}`,
          },
        ];
      } finally {
        unsubscribe?.();
        setIsAnimating(false);
      }
    } else {
      // Simulated mode, or this-device on the web where the academy bridge isn't available.
      setIsAnimating(true);
      await delay(900);
      producedOutput = data.expectedOutput.map((line) => ({ stream: 'stdout', line }));
      if (runMode === 'this-device' && typeof window !== 'undefined' && !window.academy?.run) {
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
  }, [runMode, userCode, data.expectedOutput, data.tests, data.readOnly, isLastLessonOfChapter]);

  const reset = useCallback(() => {
    setUserCode(data.startingCode);
    setTestResults(null);
    setOutputLines([]);
  }, [data.startingCode]);

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
            onReset={reset}
            platforms={data.platforms}
            readOnly={data.readOnly}
            hints={data.hints}
            answer={data.answer}
            outputKey={outputKey}
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
  onReset,
  platforms,
  readOnly = false,
  hints,
  answer,
  outputKey,
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
  onReset: () => void;
  platforms: LessonData['platforms'];
  readOnly?: boolean;
  hints: string[];
  answer: string;
  outputKey: number;
}) {
  const [copied, setCopied] = useState(false);

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
          </select>
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
            onClick={onRun}
            disabled={isAnimating || readOnly}
            className="inline-flex items-center justify-center rounded p-1.5 text-canvas-muted-foreground transition-colors hover:bg-canvas-muted hover:text-canvas-foreground disabled:cursor-not-allowed disabled:opacity-40"
            title="Run code (R)"
          >
            <Play className="size-4 fill-current" />
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
        <CodeMirror
          value={userCode}
          height="100%"
          theme={oneDark}
          extensions={[javascript({ jsx: false, typescript: true })]}
          onChange={(value) => setUserCode(value)}
          editable={!readOnly}
          readOnly={readOnly}
          basicSetup={{
            lineNumbers: !readOnly,
            foldGutter: false,
            highlightActiveLine: !readOnly,
            highlightSelectionMatches: false,
            autocompletion: false,
            indentOnInput: !readOnly,
          }}
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

      <div className="h-[200px] shrink-0 overflow-auto border-t border-canvas-border bg-canvas-muted p-4 font-mono text-sm text-canvas-foreground">
        {tab === 'output' ? (
          <OutputView key={outputKey} lines={outputLines} isAnimating={isAnimating} />
        ) : null}
        {tab === 'tests' ? <TestsView results={testResults} tests={null as never} /> : null}
        {tab === 'preview' ? <PreviewView /> : null}
      </div>
    </div>
  );
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
