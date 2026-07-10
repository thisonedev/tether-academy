'use client'

import { ArrowRight, Check } from 'lucide-react'
import Link from 'next/link'

import { COURSES, type Course, CURRICULUM } from '@/lib/curriculum'
import { useUserStore } from '@/lib/store/user-store'

export default function CoursesIndex() {
  return (
    <div className="mx-auto w-full max-w-5xl px-4 py-10 sm:px-6 sm:py-14">
      <header className="mb-8">
        <p className="mb-2 text-xs font-semibold uppercase tracking-widest text-emerald-400">
          Courses
        </p>
        <h1 className="mb-3 text-3xl font-bold tracking-tight text-canvas-foreground sm:text-4xl">
          Pick a track
        </h1>
        <p className="max-w-2xl text-base text-canvas-muted-foreground sm:text-lg">
          Pick an open-source stack to learn. Each course is a series of short lessons with code to
          read and run.
        </p>
      </header>

      <div className="grid grid-cols-1 gap-4 md:grid-cols-2 xl:grid-cols-3">
        {COURSES.map((course) =>
          course.planned ? (
            <PlannedCourseCard key={course.slug} course={course} />
          ) : (
            <LiveCourseCard key={course.slug} course={course} />
          ),
        )}
      </div>
    </div>
  )
}

/** Live course card: links into the course home, reads progress from the store. */
function LiveCourseCard({ course }: { course: Course }) {
  const counts = countsFor(course.slug)
  const completedChapters = useUserStore((s) => s.completedChapters)
  const completedLessons = useUserStore((s) => s.completedLessons)
  const points = useUserStore((s) => s.points)

  // CURRICULUM === qvac's chapters today; an explicit courseSlug on chapters will replace this when wdk/pears ship.
  const isQvac = course.slug === 'qvac'

  const completedChapterCount = isQvac
    ? CURRICULUM.filter((c) => completedChapters.includes(c.slug)).length
    : 0
  const completedLessonCount = isQvac
    ? CURRICULUM.reduce(
        (sum, c) =>
          sum +
          c.lessons.filter(
            (l) => l.href && completedLessons.includes(`${c.slug}-${l.slug}`),
          ).length,
        0,
      )
    : 0

  const isDone = counts.chapters > 0 && completedChapterCount === counts.chapters
  const hasProgress = completedLessonCount > 0
  const pct =
    counts.lessons > 0 ? Math.round((completedLessonCount / counts.lessons) * 100) : 0

  return (
    <Link
      href={course.href}
      className={`group flex h-full flex-col rounded-xl border bg-canvas-muted p-4 transition-colors sm:p-5 ${
        isDone
          ? 'border-emerald-500/35 hover:border-emerald-500/60'
          : 'border-canvas-border hover:border-emerald-500/50 hover:bg-canvas'
      }`}
    >
      <div className="flex items-start justify-between gap-3">
        <CourseGlyph slug={course.slug} />
        {isDone ? (
          <span className="inline-flex items-center gap-1.5 rounded-full border border-emerald-500/35 bg-emerald-500/10 px-2.5 py-1 text-[11px] font-semibold tracking-wide text-emerald-400">
            <Check className="size-3" strokeWidth={3} />
            Completed
          </span>
        ) : (
          <ArrowRight className="size-4 shrink-0 text-canvas-muted-foreground transition-colors group-hover:text-emerald-400" />
        )}
      </div>
      <h2 className="mt-4 text-lg font-semibold text-canvas-foreground sm:text-xl">
        {course.name}
      </h2>
      <p className="mt-1 text-sm leading-relaxed text-canvas-muted-foreground sm:text-base">
        {course.description}
      </p>
      <div className="mt-auto pt-4">
        <div className="flex items-center gap-3 text-xs text-canvas-muted-foreground">
          <span className="font-mono">
            {hasProgress ? `${completedChapterCount} / ${counts.chapters}` : counts.chapters}{' '}
            {counts.chapters === 1 ? 'chapter' : 'chapters'}
          </span>
          <span aria-hidden className="text-canvas-border">
            ·
          </span>
          <span className="font-mono">
            {hasProgress ? `${completedLessonCount} / ${counts.lessons}` : counts.lessons}{' '}
            {counts.lessons === 1 ? 'lesson' : 'lessons'}
          </span>
        </div>
        {hasProgress ? (
          <div className="mt-3 flex flex-col gap-1.5">
            <div className="flex justify-between text-[11px] font-mono text-canvas-muted-foreground">
              <span>{isDone ? '100% complete' : `${pct}% complete`}</span>
              <span className="font-semibold text-emerald-400">{points} XP</span>
            </div>
            <div className="h-1.5 overflow-hidden rounded-full bg-canvas">
              <div
                className={`h-full rounded-full ${
                  isDone
                    ? 'bg-gradient-to-r from-emerald-400 to-emerald-300'
                    : 'bg-emerald-500'
                }`}
                style={{ width: `${isDone ? 100 : pct}%` }}
              />
            </div>
          </div>
        ) : null}
      </div>
    </Link>
  )
}

/** Planned course card: dashed border, dimmed, "Coming soon" pill, no link. */
function PlannedCourseCard({ course }: { course: Course }) {
  return (
    <div
      aria-disabled
      className="flex h-full flex-col rounded-xl border border-dashed border-canvas-border bg-canvas-muted/40 p-4 opacity-70 sm:p-5"
    >
      <div className="flex items-start justify-between gap-3">
        <CourseGlyph slug={course.slug} />
        <span className="inline-flex items-center rounded-full border border-canvas-border bg-canvas px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wider text-canvas-muted-foreground">
          Coming soon
        </span>
      </div>
      <h2 className="mt-4 text-lg font-semibold text-canvas-foreground sm:text-xl">
        {course.name}
      </h2>
      <p className="mt-1 text-sm leading-relaxed text-canvas-muted-foreground sm:text-base">
        {course.description}
      </p>
    </div>
  )
}

/** Square logo block with a per-course accent gradient. */
function CourseGlyph({ slug }: { slug: string }) {
  const { bg, fg } = glyphPalette(slug)
  return (
    <span
      className="flex size-12 items-center justify-center rounded-lg border text-sm font-bold sm:size-14 sm:text-base"
      style={{ background: bg, color: fg, borderColor: 'transparent' }}
      aria-hidden
    >
      {slug.slice(0, 3).toUpperCase()}
    </span>
  )
}

/** Counts chapters + lessons for a course. Only QVAC ships chapters today. */
function countsFor(slug: string): { chapters: number; lessons: number } {
  if (slug !== 'qvac') return { chapters: 0, lessons: 0 }
  return {
    chapters: CURRICULUM.length,
    lessons: CURRICULUM.reduce((sum, c) => sum + c.lessons.length, 0),
  }
}

/** Per-course accent palette, used until real logos exist. */
function glyphPalette(slug: string): { bg: string; fg: string } {
  switch (slug) {
    case 'qvac':
      return { bg: 'linear-gradient(135deg, #0d2620 0%, #1a5e4a 100%)', fg: '#34d399' }
    case 'wdk':
      return { bg: 'linear-gradient(135deg, #1a1d2e 0%, #2d3050 100%)', fg: '#a5a8d4' }
    case 'pears':
      return { bg: 'linear-gradient(135deg, #2e1a1d 0%, #5a2d30 100%)', fg: '#f5a5a5' }
    default:
      return { bg: 'var(--color-canvas)', fg: 'var(--color-canvas-foreground)' }
  }
}