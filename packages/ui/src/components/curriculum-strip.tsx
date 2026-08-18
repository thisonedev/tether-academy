'use client';

import { Check, ChevronLeft, ChevronRight, Sparkles } from 'lucide-react';
import Link from 'next/link';
import {
  type CurriculumChapter,
  type CurriculumLesson,
  type CurriculumLessonState,
  stateOf,
} from '@academy/courses';
import { useUserStore } from '@academy/core';

const PULSE_STYLES = `
  @keyframes curriculumPulse {
    0%, 100% { box-shadow: 0 0 0 0 rgba(52, 211, 153, 0.55); }
    50%      { box-shadow: 0 0 0 6px rgba(52, 211, 153, 0); }
  }
  .current-pill { animation: curriculumPulse 2.4s ease-in-out infinite; }
`;

interface CurriculumStripProps {
  chapter?: CurriculumChapter;
  currentLesson?: CurriculumLesson;
  prevUrl?: string;
  nextUrl?: string;
  /** Why the forward chevron does not navigate yet; undefined means it does. */
  nextBlockedReason?: string;
  /** Takes over the forward chevron on the last lesson of a chapter. */
  onFinish?: () => void;
  finishLabel?: string;
}

const CHEVRON =
  'inline-flex size-7 shrink-0 items-center justify-center rounded-full border-[1.5px] border-canvas-border text-canvas-foreground transition-colors hover:border-emerald-500/40 hover:text-emerald-400';

export function CurriculumStrip({
  chapter,
  currentLesson,
  prevUrl,
  nextUrl,
  nextBlockedReason,
  onFinish,
  finishLabel,
}: CurriculumStripProps) {
  const completedChapters = useUserStore((s) => s.completedChapters);
  const completedLessons = useUserStore((s) => s.completedLessons);
  const chapterDone = !!chapter && completedChapters.includes(chapter.slug);

  if (!chapter) {
    return (
      <div className="mb-6 text-xs text-canvas-muted-foreground">
        No chapter context for this page.
      </div>
    );
  }

  const total = chapter.lessons.length;
  const currentIdx = currentLesson
    ? chapter.lessons.findIndex((l) => l.num === currentLesson.num)
    : -1;
  const position = currentIdx >= 0 ? currentIdx + 1 : 0;
  const topLabel = currentLesson
    ? `${chapter.label} · ${currentLesson.shortTitle ?? currentLesson.title}`
    : chapter.label;

  return (
    <div className="mb-6">
      <style>{PULSE_STYLES}</style>
      <div className="mb-3 flex items-center justify-between gap-3 text-xs">
        <span className="truncate font-semibold uppercase tracking-widest text-canvas-muted-foreground">
          {topLabel}
        </span>
        <span className="flex shrink-0 items-center gap-3">
          {chapterDone && !currentLesson ? (
            <span
              className="inline-flex items-center gap-1.5 rounded-full border border-emerald-500/35 bg-emerald-500/10 px-2 py-0.5 text-[10px] font-semibold tracking-wide text-emerald-400"
              title="All shipped lessons in this chapter are complete"
            >
              <Check className="size-3" strokeWidth={3} />
              Chapter completed
            </span>
          ) : null}
          <span className="font-mono text-canvas-muted-foreground">
            {position > 0 ? `${position} / ${total}` : `${total}`}
          </span>
        </span>
      </div>

      {/* Navigation sits on the control that already shows position, which
          costs no vertical space of its own. */}
      <div className="flex items-center gap-x-1.5">
        {prevUrl ? (
          <Link href={prevUrl} aria-label="Previous lesson" title="Previous lesson (left arrow key)" className={CHEVRON}>
            <ChevronLeft className="size-4" />
          </Link>
        ) : null}

        <ol
          className="m-0 flex list-none flex-wrap items-center gap-x-1.5 gap-y-2 p-0"
          aria-label={`${chapter.label} lessons`}
        >
          {chapter.lessons.map((lesson) => (
            <LessonPill
              key={lesson.num}
              lesson={lesson}
              state={stateOf(lesson, chapter, currentLesson)}
              chapterDone={chapterDone}
              isCompleted={completedLessons.includes(`${chapter.slug}-${lesson.slug}`)}
            />
          ))}
        </ol>

        {onFinish ? (
          <button
            type="button"
            onClick={onFinish}
            aria-label={finishLabel ?? 'Finish chapter'}
            title={finishLabel ?? 'Finish chapter'}
            className={`${CHEVRON} border-emerald-500/40 bg-emerald-500/10 text-emerald-300`}
          >
            <Sparkles className="size-3.5" />
          </button>
        ) : nextUrl && !nextBlockedReason ? (
          <Link href={nextUrl} aria-label="Next lesson" title="Next lesson (right arrow key)" className={CHEVRON}>
            <ChevronRight className="size-4" />
          </Link>
        ) : nextUrl ? (
          <span
            aria-label={nextBlockedReason}
            title={nextBlockedReason}
            className={`${CHEVRON} cursor-not-allowed text-canvas-muted-foreground opacity-50 hover:border-canvas-border hover:text-canvas-muted-foreground`}
          >
            <ChevronRight className="size-4" />
          </span>
        ) : null}
      </div>
    </div>
  );
}

function LessonPill({
  lesson,
  state,
  chapterDone,
  isCompleted,
}: {
  lesson: CurriculumLesson;
  state: CurriculumLessonState;
  chapterDone: boolean;
  isCompleted: boolean;
}) {
  const ariaLabel = `${lesson.num} · ${lesson.shortTitle ?? lesson.title}`;

  if (state === 'upcoming' && !lesson.href) {
    return (
      <li
        aria-label={`${ariaLabel} · planned`}
        title={`${lesson.title} (planned)`}
        className="inline-flex size-7 shrink-0 list-none items-center justify-center rounded-full border-[1.5px] border-canvas-border font-mono text-[11px] font-semibold text-canvas-muted-foreground/70"
      >
        {lesson.num}
      </li>
    );
  }

  if (!lesson.href) return null;

  // Filled pill and pulse for "you are here". The number stays visible: an
  // arrow sits next to two chevrons that navigate, and would read as a third.
  if (state === 'current') {
    return (
      <li>
        <Link
          href={lesson.href}
          aria-label={`${ariaLabel} · current`}
          title={`${lesson.title} (current lesson)`}
          className="current-pill inline-flex size-7 shrink-0 list-none items-center justify-center rounded-full bg-emerald-400 font-mono text-[11px] font-bold text-canvas ring-2 ring-emerald-400/40"
        >
          {lesson.num}
        </Link>
      </li>
    );
  }

  if (isCompleted || chapterDone) {
    return (
      <li>
        <Link
          href={lesson.href}
          aria-label={`${ariaLabel} · done`}
          title={`${lesson.title} (completed)`}
          className="inline-flex size-7 shrink-0 list-none items-center justify-center rounded-full bg-emerald-500/85 text-canvas transition-colors hover:bg-emerald-500"
        >
          <Check className="size-3.5" strokeWidth={3} />
        </Link>
      </li>
    );
  }

  return (
    <li>
      <Link
        href={lesson.href}
        aria-label={`${ariaLabel}`}
        title={lesson.title}
        className="inline-flex size-7 shrink-0 list-none items-center justify-center rounded-full border-[1.5px] border-canvas-border font-mono text-[11px] font-semibold text-canvas-muted-foreground transition-colors hover:border-emerald-500/40 hover:text-canvas-foreground"
      >
        {lesson.num}
      </Link>
    </li>
  );
}
