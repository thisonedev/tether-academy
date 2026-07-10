'use client'

import { ArrowRight, Check } from 'lucide-react'
import Link from 'next/link'

import type { CurriculumChapter } from '@/lib/curriculum'
import { useUserStore } from '@/lib/store/user-store'

/** Chapter landing fallback: lesson list with per-lesson checks + a "Chapter completed" badge. */
export function ChapterLandingBody({ chapter }: { chapter: CurriculumChapter }) {
  const completedLessons = useUserStore((s) => s.completedLessons)

  const shipped = chapter.lessons.filter((l) => l.href)
  const doneKeys = new Set(completedLessons)
  const isChapterDone = shipped.length > 0 && shipped.every((l) => doneKeys.has(`${chapter.slug}-${l.slug}`))

  return (
    <div className="prose-md">
      <div className="mb-3 flex flex-wrap items-center gap-3">
        <h1 className="m-0">{chapter.label}</h1>
        {isChapterDone ? (
          <span className="inline-flex items-center gap-1.5 rounded-full border border-emerald-500/35 bg-emerald-500/10 px-2.5 py-1 text-[11px] font-semibold tracking-wide text-emerald-400">
            <Check className="size-3" strokeWidth={3} />
            Chapter completed
          </span>
        ) : null}
      </div>
      <p className="text-canvas-muted-foreground">
        {chapter.lessons.length} {chapter.lessons.length === 1 ? 'lesson' : 'lessons'} in this chapter.
        {isChapterDone ? ' All shipped lessons done — +50 XP earned.' : ' Pick one below or jump to the first shipped lesson.'}
      </p>
      <ul className="m-0 list-none divide-y divide-canvas-border border-y border-canvas-border p-0">
        {chapter.lessons.map((lesson) => {
          const isDone = !!lesson.href && doneKeys.has(`${chapter.slug}-${lesson.slug}`)
          return (
            <li key={lesson.slug} className="py-2">
              <Link
                href={lesson.href ?? '#'}
                className="flex items-center justify-between gap-2 text-sm hover:text-emerald-400"
              >
                <span className="flex items-center gap-2">
                  <span className="font-mono text-canvas-muted-foreground">{lesson.num}</span>
                  <span>{lesson.shortTitle ?? lesson.title}</span>
                  {isDone ? (
                    <Check
                      className="size-3.5 text-emerald-400"
                      strokeWidth={3}
                      aria-label="completed"
                    />
                  ) : null}
                </span>
                {lesson.href ? (
                  <ArrowRight className="size-4 text-canvas-muted-foreground" />
                ) : (
                  <span className="text-xs uppercase text-canvas-muted-foreground/60">planned</span>
                )}
              </Link>
            </li>
          )
        })}
      </ul>
    </div>
  )
}