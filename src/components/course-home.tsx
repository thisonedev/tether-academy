'use client'

import { ArrowRight, Check, Lock } from 'lucide-react'
import Link from 'next/link'
import { CURRICULUM, type CurriculumChapter, type CurriculumLesson } from '@/lib/curriculum'
import { useUserHydrated, useUserStore } from '@/lib/store/user-store'

interface CourseHomeProps {
  courseName: string
  courseSlug: string
  courseDescription: string
  accent: 'emerald' | 'violet' | 'rose'
}

const ACCENT_BG: Record<CourseHomeProps['accent'], string> = {
  emerald: 'linear-gradient(135deg, #0d2620 0%, #1a5e4a 100%)',
  violet: 'linear-gradient(135deg, #1a1d2e 0%, #2d3050 100%)',
  rose: 'linear-gradient(135deg, #2e1a1d 0%, #5a2d30 100%)',
}

const ACCENT_FG: Record<CourseHomeProps['accent'], string> = {
  emerald: '#34d399',
  violet: '#a5a8d4',
  rose: '#f5a5a5',
}

/** Course home: hero + chapter list, every lesson visible. Mirrors Codecademy/Scrimba.
 *  Each chapter is its own section with a clickable list of lessons. */
export function CourseHome({ courseName, courseSlug, courseDescription, accent }: CourseHomeProps) {
  const hydrated = useUserHydrated()
  const username = useUserStore((s) => s.username)
  const completedChapters = useUserStore((s) => s.completedChapters)
  const completedLessons = useUserStore((s) => s.completedLessons)
  const signedIn = hydrated && !!username

  const totalChapters = CURRICULUM.length
  const totalLessons = CURRICULUM.reduce((sum, c) => sum + c.lessons.length, 0)
  const firstLessonHref =
    CURRICULUM.flatMap((c) => c.lessons).find((l) => l.href)?.href ?? CURRICULUM[0]?.href

  return (
    <div className="mx-auto w-full max-w-4xl px-4 py-10 sm:px-6 sm:py-14">
      <Link
        href="/courses"
        className="mb-6 inline-flex items-center gap-1 text-xs text-canvas-muted-foreground hover:text-canvas-foreground"
      >
        <span>←</span>
        <span>All courses</span>
      </Link>

      <header className="mb-8 sm:mb-10">
        <div className="flex items-start gap-4 sm:gap-5">
          <span
            className="flex size-14 shrink-0 items-center justify-center rounded-xl text-base font-bold sm:size-20 sm:text-xl"
            style={{ background: ACCENT_BG[accent], color: ACCENT_FG[accent] }}
            aria-hidden
          >
            {courseSlug.slice(0, 3).toUpperCase()}
          </span>
          <div className="min-w-0 flex-1">
            <p className="mb-1 text-xs font-semibold uppercase tracking-widest text-emerald-400">
              Course
            </p>
            <h1 className="mb-2 text-3xl font-bold tracking-tight text-canvas-foreground sm:text-4xl">
              {courseName}
            </h1>
            <p className="text-base text-canvas-muted-foreground sm:text-lg">{courseDescription}</p>
          </div>
        </div>

        <div className="mt-6 flex flex-wrap items-center gap-3 text-sm text-canvas-muted-foreground">
          <span className="font-mono">
            {totalChapters} {totalChapters === 1 ? 'chapter' : 'chapters'}
          </span>
          <span aria-hidden className="text-canvas-border">
            ·
          </span>
          <span className="font-mono">
            {totalLessons} {totalLessons === 1 ? 'lesson' : 'lessons'}
          </span>
          {firstLessonHref ? (
            <>
              <span aria-hidden className="text-canvas-border">
                ·
              </span>
              <Link
                href={firstLessonHref}
                className="ml-auto inline-flex items-center gap-1.5 rounded-md bg-emerald-500 px-4 py-2 text-sm font-semibold text-canvas transition-colors hover:bg-emerald-400"
              >
                <span>Start lesson 1</span>
                <ArrowRight className="size-4" />
              </Link>
            </>
          ) : null}
        </div>
      </header>

      <section aria-label="Chapters" className="space-y-4">
        {CURRICULUM.map((chapter) => (
          <ChapterSection
            key={chapter.slug}
            chapter={chapter}
            signedIn={signedIn}
            isChapterDone={signedIn && completedChapters.includes(chapter.slug)}
            completedLessons={completedLessons}
          />
        ))}
      </section>
    </div>
  )
}

function ChapterSection({
  chapter,
  signedIn,
  isChapterDone,
  completedLessons,
}: {
  chapter: CurriculumChapter
  signedIn: boolean
  isChapterDone: boolean
  completedLessons: string[]
}) {
  const doneCount = signedIn
    ? chapter.lessons.filter((l) => completedLessons.includes(`${chapter.slug}-${l.slug}`)).length
    : 0
  const complete = signedIn && doneCount === chapter.lessons.length && doneCount > 0

  return (
    <article className="rounded-xl border border-canvas-border bg-canvas-muted p-4 sm:p-5">
      <header className="mb-3 flex items-center justify-between gap-3">
        <div className="flex min-w-0 items-center gap-3">
          <span className="flex size-9 shrink-0 items-center justify-center rounded-lg border border-canvas-border bg-canvas font-mono text-sm font-bold text-emerald-400">
            {chapter.num}
          </span>
          <div className="min-w-0">
            <h2 className="truncate text-base font-semibold text-canvas-foreground sm:text-lg">
              {chapter.label}
            </h2>
            <p className="text-xs text-canvas-muted-foreground">
              {chapter.lessons.length} {chapter.lessons.length === 1 ? 'lesson' : 'lessons'}
              {signedIn && doneCount > 0 ? (
                <>
                  {' · '}
                  <span className="font-mono">
                    {doneCount}/{chapter.lessons.length} done
                  </span>
                </>
              ) : null}
            </p>
          </div>
        </div>
        {complete ? (
          <span className="inline-flex items-center gap-1 rounded-full bg-emerald-500/15 px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wider text-emerald-400">
            <Check className="size-3" strokeWidth={3} />
            Complete
          </span>
        ) : null}
      </header>

      <ol className="m-0 flex list-none flex-col gap-0 divide-y divide-canvas-border rounded-lg border border-canvas-border bg-canvas p-0">
        {chapter.lessons.map((lesson) => {
          const isCompleted =
            signedIn && completedLessons.includes(`${chapter.slug}-${lesson.slug}`)
          const hasHref = !!lesson.href
          return (
            <li key={lesson.slug} className="px-1">
              <LessonRow
                chapterSlug={chapter.slug}
                lesson={lesson}
                hasHref={hasHref}
                isCompleted={isCompleted}
                isChapterDone={isChapterDone}
              />
            </li>
          )
        })}
      </ol>
    </article>
  )
}

function LessonRow({
  lesson,
  hasHref,
  isCompleted,
  isChapterDone,
}: {
  chapterSlug: string
  lesson: CurriculumLesson
  hasHref: boolean
  isCompleted: boolean
  isChapterDone: boolean
}) {
  const status: 'done' | 'planned' | 'available' = !hasHref
    ? 'planned'
    : isCompleted || isChapterDone
      ? 'done'
      : 'available'

  const inner = (
    <>
      <span className="flex size-7 shrink-0 items-center justify-center rounded-full border-[1.5px] border-canvas-border bg-canvas-muted font-mono text-[11px] font-semibold text-canvas-muted-foreground">
        {status === 'done' ? (
          <Check className="size-3.5 text-emerald-500" strokeWidth={3} />
        ) : status === 'planned' ? (
          <Lock className="size-3" />
        ) : (
          lesson.num
        )}
      </span>
      <span
        className={
          status === 'done'
            ? 'truncate text-sm text-canvas-foreground line-through decoration-canvas-muted-foreground/50 sm:text-base'
            : status === 'planned'
              ? 'truncate text-sm text-canvas-muted-foreground sm:text-base'
              : 'truncate text-sm text-canvas-foreground sm:text-base'
        }
      >
        {lesson.shortTitle ?? lesson.title}
      </span>
      <span className="ml-auto font-mono text-[11px] uppercase tracking-wider text-canvas-muted-foreground">
        {status === 'done' ? 'Done' : status === 'planned' ? 'Planned' : 'Open'}
      </span>
    </>
  )

  const baseClass =
    'flex w-full items-center gap-3 rounded-md px-2 py-2 text-left transition-colors'

  if (!hasHref || !lesson.href) {
    return (
      <div aria-disabled className={`${baseClass} cursor-not-allowed opacity-70`}>
        {inner}
      </div>
    )
  }

  return (
    <Link
      href={lesson.href}
      className={`${baseClass} hover:bg-canvas-muted focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-emerald-400/40`}
    >
      {inner}
    </Link>
  )
}
