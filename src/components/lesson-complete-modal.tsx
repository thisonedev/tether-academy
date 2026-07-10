'use client';

import { useEffect } from 'react';
import Link from 'next/link';
import { Check, ArrowRight, ArrowLeft, X, Sparkles } from 'lucide-react';
import { useUserStore, POINTS_PER_CHAPTER } from '@/lib/store/user-store';

interface LessonCompleteModalProps {
  open: boolean;
  lessonTitle: string;
  chapterLabel?: string;
  chapterNum?: string;
  chapterLessonCount?: number;
  nextUrl?: string;
  courseUrl?: string;
  onClose: () => void;
}

/** Celebration modal on the last lesson of a chapter. Confetti only when `nextUrl` is undefined. */
export function LessonCompleteModal({
  open,
  lessonTitle,
  chapterLabel,
  chapterNum,
  chapterLessonCount,
  nextUrl,
  courseUrl = '/courses',
  onClose,
}: LessonCompleteModalProps) {
  const points = useUserStore((s) => s.points);

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    document.addEventListener('keydown', onKey);
    document.body.style.overflow = 'hidden';
    return () => {
      document.removeEventListener('keydown', onKey);
      document.body.style.overflow = '';
    };
  }, [open, onClose]);

  if (!open) return null;

  const isLastChapter = !nextUrl;
  const eyebrow = isLastChapter ? 'Course complete' : 'Chapter complete';
  const heading = chapterLabel ?? lessonTitle;
  const subtitle = isLastChapter
    ? 'All chapters complete. Nice work.'
    : `All ${chapterLessonCount ?? ''} lessons in this chapter pass. Nice work.`;

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-labelledby="lesson-complete-title"
      className="fixed inset-0 z-50 flex items-center justify-center px-4 py-8"
    >
      <button
        type="button"
        aria-label="Dismiss"
        onClick={onClose}
        className="absolute inset-0 bg-canvas/70 backdrop-blur-md"
      />

      {isLastChapter ? (
        <div className="pointer-events-none absolute inset-0 overflow-hidden">
          {Array.from({ length: 36 }).map((_, i) => {
            const left = (i * 13 + 7) % 100;
            const delay = (i * 0.13) % 2.4;
            const duration = 2.6 + ((i * 0.31) % 1.8);
            const size = 6 + (i % 3) * 2;
            const tone = i % 4;
            return (
              <span
                key={`confetti-${left}-${tone}-${size}`}
                className="absolute top-[-12px] block rounded-full animate-[fall_var(--dur)_var(--delay)_ease-in_forwards]"
                style={
                  {
                    left: `${left}%`,
                    width: `${size}px`,
                    height: `${size}px`,
                    backgroundColor:
                      tone === 0
                        ? 'oklch(0.696 0.17 162)'
                        : tone === 1
                          ? 'oklch(0.85 0.15 162)'
                          : tone === 2
                            ? 'oklch(0.96 0.005 162)'
                            : 'oklch(0.72 0.012 162)',
                    '--delay': `-${delay}s`,
                    '--dur': `${duration}s`,
                  } as React.CSSProperties
                }
              />
            );
          })}
        </div>
      ) : null}

      <div className="relative z-10 w-full max-w-md rounded-2xl border border-canvas-border bg-canvas p-8 text-center shadow-2xl shadow-black/50">
        <button
          type="button"
          onClick={onClose}
          aria-label="Close"
          className="absolute right-3 top-3 rounded p-1.5 text-canvas-muted-foreground transition-colors hover:bg-canvas-muted hover:text-canvas-foreground"
        >
          <X className="size-4" />
        </button>

        <div className="mx-auto mb-5 flex h-16 w-16 items-center justify-center rounded-full bg-emerald-500/15 ring-4 ring-emerald-500/20">
          <Check className="size-9 text-emerald-400" strokeWidth={2.5} />
        </div>

        <p className="mb-1 text-xs font-semibold uppercase tracking-widest text-emerald-400">
          {eyebrow}
        </p>
        <h2
          id="lesson-complete-title"
          className="mb-2 text-2xl font-bold tracking-tight text-canvas-foreground sm:text-3xl"
        >
          {chapterNum ? `Chapter ${chapterNum} · ${heading}` : heading}
        </h2>
        <p className="mb-5 text-sm text-canvas-muted-foreground">{subtitle}</p>

        <div className="points-pulse mx-auto mb-7 inline-flex items-center gap-2 rounded-full border border-emerald-500/40 bg-emerald-500/10 px-4 py-1.5 font-mono text-sm text-emerald-300">
          <Sparkles className="size-4 text-emerald-400" />
          <span>+{POINTS_PER_CHAPTER}</span>
          <span className="text-emerald-400/60">·</span>
          <span>{points} total</span>
        </div>

        <div className="flex flex-col gap-2 sm:flex-row sm:justify-center">
          {nextUrl ? (
            <Link
              href={nextUrl}
              className="inline-flex items-center justify-center gap-1.5 rounded-md bg-emerald-500 px-5 py-2.5 text-sm font-semibold text-canvas transition-colors hover:bg-emerald-400"
            >
              Next chapter
              <ArrowRight className="size-4" />
            </Link>
          ) : (
            <Link
              href={courseUrl}
              className="inline-flex items-center justify-center gap-1.5 rounded-md bg-emerald-500 px-5 py-2.5 text-sm font-semibold text-canvas transition-colors hover:bg-emerald-400"
            >
              <ArrowLeft className="size-4" />
              Back to courses
            </Link>
          )}
          <button
            type="button"
            onClick={onClose}
            className="rounded-md border border-canvas-border bg-canvas px-5 py-2.5 text-sm font-semibold text-canvas-foreground transition-colors hover:bg-canvas-muted"
          >
            Review code
          </button>
        </div>
      </div>

      <style jsx>{`
        @keyframes fall {
          0% {
            transform: translateY(-10vh) rotate(0deg);
            opacity: 1;
          }
          85% {
            opacity: 1;
          }
          100% {
            transform: translateY(110vh) rotate(540deg);
            opacity: 0;
          }
        }
      `}</style>
    </div>
  );
}