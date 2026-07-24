'use client';

import { ArrowRight, Check } from 'lucide-react';
import Link from 'next/link';
import {
  type CurriculumChapter,
  type CurriculumLesson,
  type CurriculumLessonState,
  stateOf,
} from '@/lib/curriculum';
import { useUserStore } from '@/lib/store/user-store';

/** Pulse keyframes for the active pill. Inlined via <style> below. */
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
}

export function CurriculumStrip({ chapter, currentLesson }: CurriculumStripProps) {
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

  // Upcoming lesson without an href: render as a static outlined pill.
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

  // The current lesson: emerald arrow + ring. The arrow is the strong
  // "you are here" affordance, the ring reads as the focused state.
  if (state === 'current') {
    return (
      <li>
        <Link
          href={lesson.href}
          aria-label={`${ariaLabel} · current`}
          title={`${lesson.title} (current lesson)`}
          className="current-pill inline-flex size-7 shrink-0 list-none items-center justify-center rounded-full bg-emerald-400 text-canvas ring-2 ring-emerald-400/40"
        >
          <ArrowRight className="size-3.5" strokeWidth={3} />
        </Link>
      </li>
    );
  }

  // Completed lesson (signed in + lesson is in the user's completed set,
  // or the chapter is fully done so every pill shows done).
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

  // Upcoming, not yet attempted: outlined circle with the lesson number.
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
