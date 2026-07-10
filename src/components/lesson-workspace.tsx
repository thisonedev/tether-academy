'use client'

import { javascript } from '@codemirror/lang-javascript'
import { oneDark } from '@codemirror/theme-one-dark'
import CodeMirror from '@uiw/react-codemirror'
import {
  ArrowLeft,
  ArrowRight,
  Check,
  Copy,
  Play,
  RotateCcw,
  X,
} from 'lucide-react'
import Link from 'next/link'
import { type ReactNode, useCallback, useEffect, useState } from 'react'
import { CurriculumStrip } from '@/components/curriculum-strip'
import { HelpPanel } from '@/components/help-panel'
import { LessonCompleteModal } from '@/components/lesson-complete-modal'
import { SignInBanner } from '@/components/sign-in-banner'
import type { CurriculumChapter, CurriculumLesson } from '@/lib/curriculum'
import { useUserStore } from '@/lib/store/user-store'

/** A single lesson test declaration. Matches the lesson MDX `tests:` array shape. */
export interface LessonTest {
  id: string
  description: string
  pattern?: string
  contains?: string
}

/** Per-page data passed into `LessonWorkspace` from the route handler. */
export interface LessonData {
  title: string
  description?: string
  startingCode: string
  answer: string
  tests: LessonTest[]
  hints: string[]
  expectedOutput: string[]
  platforms: Array<'node' | 'web' | 'mobile' | 'desktop'>
  sourceExample?: string
  prevUrl?: string
  nextUrl?: string
  position?: { current: number; total: number }
  firstLessonHref?: string
  currentChapter?: CurriculumChapter
  currentLesson?: CurriculumLesson
  readOnly?: boolean
}

const TABS = ['output', 'tests', 'preview'] as const
type Tab = (typeof TABS)[number]

/** Two-pane lesson UI: tutorial on the left, code runner on the right, sticky prev/check/next bar at the bottom. */
export function LessonWorkspace({ data, children }: { data: LessonData; children: ReactNode }) {
  const [userCode, setUserCode] = useState(data.startingCode)
  const [platform, setPlatform] = useState<LessonData['platforms'][number]>('node')
  const [tab, setTab] = useState<Tab>('output')
  const [testResults, setTestResults] = useState<null | ReturnType<typeof runTests>>(null)
  const [outputLines, setOutputLines] = useState<string[]>([])
  const [isAnimating, setIsAnimating] = useState(false)
  const [showCompleteModal, setShowCompleteModal] = useState(false)
  const [hasShownModal, setHasShownModal] = useState(false)

  // Reset transient state when the lesson changes.
  useEffect(() => {
    if (data.readOnly) {
      setUserCode(data.startingCode || '// This section is informational. No code to run here.\n')
    } else {
      setUserCode(data.startingCode)
    }
    setTestResults(null)
    setOutputLines([])
    setTab('output')
    setShowCompleteModal(false)
    setHasShownModal(false)
  }, [data.startingCode, data.readOnly])

  const allPassed = testResults?.every((r) => r.passed) ?? false

  // Modal fires only on the LAST lesson of the chapter (section is the unit).
  const isLastLessonOfChapter =
    !!data.currentChapter &&
    !!data.currentLesson &&
    data.currentChapter.lessons.at(-1)?.num === data.currentLesson.num

  const markLessonComplete = useUserStore((s) => s.markLessonComplete)

  useEffect(() => {
    if (!allPassed || !data.currentChapter || !data.currentLesson) return
    // Awards per-lesson XP (+ chapter bonus if this completes the chapter).
    // Deduped inside the store: re-runs on the same lesson are no-ops.
    markLessonComplete(data.currentChapter.slug, data.currentLesson.slug)
    if (isLastLessonOfChapter && !hasShownModal) {
      setShowCompleteModal(true)
      setHasShownModal(true)
    }
  }, [
    allPassed,
    isLastLessonOfChapter,
    data.currentChapter,
    data.currentLesson,
    hasShownModal,
    markLessonComplete,
  ])

  const check = useCallback(() => {
    setTab('tests')
    setTestResults(runTests(userCode, data.tests))
  }, [userCode, data.tests])

  const run = useCallback(async () => {
    setTab('output')
    setOutputLines([])
    setIsAnimating(true)
    for (const line of data.expectedOutput) {
      await delay(220)
      setOutputLines((prev) => [...prev, line])
    }
    setIsAnimating(false)

    if (isLastLessonOfChapter && !data.readOnly) {
      setTab('tests')
      setTestResults(runTests(userCode, data.tests))
    }
  }, [data.expectedOutput, data.tests, data.readOnly, isLastLessonOfChapter, userCode])

  const reset = useCallback(() => {
    setUserCode(data.startingCode)
    setTestResults(null)
    setOutputLines([])
  }, [data.startingCode])

  return (
    <div className="flex w-full flex-col lg:h-[calc(100vh-3.5rem)]">
      <div className="flex min-h-0 flex-col gap-4 px-4 pb-24 pt-4 sm:px-6 sm:pt-6 lg:flex-1 lg:flex-row lg:gap-6 lg:overflow-hidden lg:pb-0">
        <section className="min-w-0 lg:max-w-[42%] lg:min-w-[360px] lg:flex-shrink-0 lg:h-full lg:overflow-y-auto lg:pr-2">
          <SignInBanner />
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
            testResults={testResults}
            outputLines={outputLines}
            isAnimating={isAnimating}
            onRun={run}
            onReset={reset}
            platforms={data.platforms}
            readOnly={data.readOnly}
            hints={data.hints}
            answer={data.answer}
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
  )
}

/** Right-column code runner: editor, tabbed output/tests/preview, action bar. */
function Runner({
  userCode,
  setUserCode,
  platform,
  setPlatform,
  tab,
  setTab,
  testResults,
  outputLines,
  isAnimating,
  onRun,
  onReset,
  platforms,
  readOnly = false,
  hints,
  answer,
}: {
  userCode: string
  setUserCode: (s: string) => void
  platform: LessonData['platforms'][number]
  setPlatform: (p: LessonData['platforms'][number]) => void
  tab: Tab
  setTab: (t: Tab) => void
  testResults: null | ReturnType<typeof runTests>
  outputLines: string[]
  isAnimating: boolean
  onRun: () => void
  onReset: () => void
  platforms: LessonData['platforms']
  readOnly?: boolean
  hints: string[]
  answer: string
}) {
  const [copied, setCopied] = useState(false)

  const handleCopy = useCallback(async () => {
    try {
      if (navigator.clipboard?.writeText) {
        await navigator.clipboard.writeText(userCode)
      } else {
        // Fallback for older browsers / non-secure contexts.
        const ta = document.createElement('textarea')
        ta.value = userCode
        ta.style.position = 'fixed'
        ta.style.opacity = '0'
        document.body.appendChild(ta)
        ta.select()
        document.execCommand('copy')
        document.body.removeChild(ta)
      }
      setCopied(true)
      setTimeout(() => setCopied(false), 1500)
    } catch {
      // No-op: visual feedback just won't fire.
    }
  }, [userCode])

  return (
    <div
      className="flex min-h-0 flex-1 flex-col overflow-hidden rounded-lg border border-canvas-border bg-canvas-muted"
    >
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
          <button
            type="button"
            onClick={onRun}
            disabled={isAnimating || readOnly}
            className="ml-1 inline-flex items-center justify-center rounded p-1.5 text-canvas-muted-foreground transition-colors hover:bg-canvas-muted hover:text-canvas-foreground disabled:cursor-not-allowed disabled:opacity-40"
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
        {tab === 'output' ? <OutputView lines={outputLines} isAnimating={isAnimating} /> : null}
        {tab === 'tests' ? <TestsView results={testResults} tests={null as never} /> : null}
        {tab === 'preview' ? <PreviewView /> : null}
      </div>
    </div>
  )
}

/** Output tab: streams `expectedOutput` lines one at a time. */
function OutputView({ lines, isAnimating }: { lines: string[]; isAnimating: boolean }) {
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
      {lines.map((line) => (
        <p key={line} className="whitespace-pre-wrap">
          {line}
        </p>
      ))}
      {isAnimating ? (
        <p>
          <span className="ml-1 inline-block h-3 w-2 animate-pulse bg-emerald-400 align-middle" />
        </p>
      ) : null}
    </div>
  )
}

/** Tests tab: pass/fail list, or an empty-state pointing at Check Answer. */
function TestsView({ results }: { results: null | ReturnType<typeof runTests>; tests: never }) {
  if (!results) {
    return (
      <p className="text-canvas-muted-foreground">
        Click <span className="text-emerald-400">Check Answer</span> in the tutorial to run the
        tests.
      </p>
    )
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
  )
}

/** Preview tab: placeholder explaining the live-preview pipeline. */
function PreviewView() {
  return (
    <p className="text-canvas-muted-foreground">
      The simulated live preview animates token streams, progress, and UI state changes keyed to
      your code passing the checks. Ships in a later pass. The per-lesson preview animation hooks
      into the same
      <span className="px-1 font-mono text-emerald-400">expectedOutput</span>
      array already declared in the lesson frontmatter.
    </p>
  )
}

/** Mirror of the in-app runner's `runTests`. Pattern flags must match
 *  so a passing test here also passes the user's check in the browser. */
function runTests(code: string, tests: LessonTest[]) {
  return tests.map((t) => {
    let passed = false
    if (t.pattern) {
      try {
        passed = new RegExp(t.pattern, 'm').test(code)
      } catch {
        passed = false
      }
    }
    if (!passed && t.contains) {
      passed = code.includes(t.contains)
    }
    return { id: t.id, description: t.description, passed }
  })
}

function delay(ms: number) {
  return new Promise((r) => setTimeout(r, ms))
}
