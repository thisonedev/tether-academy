'use client';

import { Check, X } from 'lucide-react';
import { Fragment, useState } from 'react';
import type { LessonQuestion } from './lesson-workspace.js';

interface QuestionCheckProps {
  questions: LessonQuestion[];
  onAllCorrectChange: (allCorrect: boolean) => void;
}

interface Pick {
  index: number;
  correct: boolean;
}

// Splits on backtick-delimited spans and renders each as a pill instead of a bare backtick string.
function withCodePills(text: string) {
  const parts = text.split(/(`[^`]+`)/g);
  return parts.map((part, i) => {
    if (part.startsWith('`') && part.endsWith('`') && part.length > 1) {
      return (
        <code
          key={i}
          className="rounded-[0.25rem] bg-canvas-muted px-[0.35em] py-[0.1em] font-mono text-[0.9em]"
          style={{ color: 'oklch(0.85 0.15 162)' }}
        >
          {part.slice(1, -1)}
        </code>
      );
    }
    return <Fragment key={i}>{part}</Fragment>;
  });
}

export function QuestionCheck({ questions, onAllCorrectChange }: QuestionCheckProps) {
  const [picks, setPicks] = useState<Record<string, Pick>>({});

  if (questions.length === 0) return null;

  function pick(question: LessonQuestion, index: number) {
    // Once a question is answered correctly, further clicks on other options are ignored.
    if (picks[question.id]?.correct) return;
    const correct = question.answers[index]?.correct ?? false;
    const next = { ...picks, [question.id]: { index, correct } };
    setPicks(next);
    onAllCorrectChange(questions.every((q) => next[q.id]?.correct));
  }

  return (
    <div className="mt-8">
      <h2 className="mb-3 text-xl font-bold text-canvas-foreground">Questions</h2>
      <div className="space-y-3">
        {questions.map((question, qi) => {
          const state = picks[question.id];
          const wrongFeedback =
            state && !state.correct ? question.answers[state.index]?.feedback : undefined;
          return (
            <div
              key={question.id}
              className="rounded-lg border border-canvas-border bg-[#0d1117] p-4"
            >
              <p className="mb-1 font-mono text-[11px] uppercase tracking-wider text-emerald-400">
                Question {qi + 1} of {questions.length}
              </p>
              <p className="mb-3 text-sm font-semibold text-canvas-foreground">
                {withCodePills(question.text)}
              </p>
              <div className="space-y-2">
                {question.answers.map((answer, ai) => {
                  const isPicked = state?.index === ai;
                  const showCorrect = isPicked && answer.correct;
                  const showWrong = isPicked && !answer.correct;
                  return (
                    <button
                      key={`${question.id}-${ai}`}
                      type="button"
                      onClick={() => pick(question, ai)}
                      disabled={state?.correct}
                      className={`flex w-full items-center gap-2.5 rounded-md border px-3 py-2.5 text-left text-sm text-canvas-foreground transition-colors disabled:cursor-default ${
                        showCorrect
                          ? 'border-emerald-500 bg-emerald-500/10'
                          : showWrong
                            ? 'border-red-400/70 bg-red-400/10'
                            : 'border-canvas-border hover:border-emerald-500/40'
                      }`}
                    >
                      <span
                        className={`flex size-4 shrink-0 items-center justify-center rounded-full border ${
                          showCorrect
                            ? 'border-emerald-500 bg-emerald-500 text-canvas'
                            : showWrong
                              ? 'border-red-400 bg-red-400 text-canvas'
                              : 'border-canvas-muted-foreground'
                        }`}
                      >
                        {showCorrect ? (
                          <Check className="size-3" />
                        ) : showWrong ? (
                          <X className="size-3" />
                        ) : null}
                      </span>
                      <span>{withCodePills(answer.text)}</span>
                    </button>
                  );
                })}
              </div>
              {wrongFeedback ? (
                <p className="mt-2 rounded-md bg-red-400/10 px-3 py-2 text-xs leading-relaxed text-red-300">
                  {withCodePills(wrongFeedback)}
                </p>
              ) : null}
              {state?.correct ? (
                <p className="mt-2 text-xs font-medium text-emerald-400">Correct.</p>
              ) : null}
            </div>
          );
        })}
      </div>
    </div>
  );
}
