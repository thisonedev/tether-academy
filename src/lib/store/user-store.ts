'use client';

import { useEffect, useState } from 'react';
import { create } from 'zustand';
import { persist, createJSONStorage } from 'zustand/middleware';
import { getCurriculumChapterBySlug } from '@/lib/curriculum';

export const POINTS_PER_LESSON = 10;
export const POINTS_PER_CHAPTER = 50;
const XP_PER_LEVEL = 100;

export function getLevel(points: number): number {
  return Math.floor(points / XP_PER_LEVEL) + 1;
}

/** localStorage key. Rename only when changing the persistence schema; old keys hold old data. */
const STORAGE_KEY = 'tether-academy-user';

/** Lesson key in the form `<chapterSlug>-<lessonSlug>`, e.g. "getting-started-load-model". */
function lessonKey(chapterSlug: string, lessonSlug: string): string {
  return `${chapterSlug}-${lessonSlug}`;
}

/** The Supabase migration is one named line: replace `storage`
 *  in `useUserStore` with a Supabase-backed adapter. */
export interface UserState {
  username: string | null;
  points: number;
  completedChapters: string[];
  completedLessons: string[];
  signInPromptOpen: boolean;
  setUsername: (name: string) => void;
  markLessonComplete: (chapterSlug: string, lessonSlug: string) => void;
  reset: () => void;
  openSignInPrompt: () => void;
  closeSignInPrompt: () => void;
}

export const useUserStore = create<UserState>()(
  persist(
    (set, get) => ({
      username: null,
      points: 0,
      completedChapters: [],
      completedLessons: [],
      signInPromptOpen: false,
      setUsername: (name) =>
        set({ username: name, signInPromptOpen: false }),
      markLessonComplete: (chapterSlug, lessonSlug) => {
        // Guest completions are silently dropped: progress requires an identity.
        if (!get().username) return;
        const key = lessonKey(chapterSlug, lessonSlug);
        // Per-lesson XP, deduped: re-runs on the same lesson are no-ops.
        if (get().completedLessons.includes(key)) return;
        const newLessons = [...get().completedLessons, key];
        let nextPoints = get().points + POINTS_PER_LESSON;
        // Chapter bonus fires when this lesson completes the chapter.
        const chapter = getCurriculumChapterBySlug(chapterSlug);
        const allDone =
          !!chapter &&
          chapter.lessons.every((l) => newLessons.includes(lessonKey(chapterSlug, l.slug)));
        const newCompletedChapters = allDone
          ? get().completedChapters.includes(chapterSlug)
            ? get().completedChapters
            : [...get().completedChapters, chapterSlug]
          : get().completedChapters;
        if (allDone && !get().completedChapters.includes(chapterSlug)) {
          nextPoints += POINTS_PER_CHAPTER;
        }
        set({
          completedLessons: newLessons,
          completedChapters: newCompletedChapters,
          points: nextPoints,
        });
      },
      reset: () =>
        set({
          username: null,
          points: 0,
          completedChapters: [],
          completedLessons: [],
          signInPromptOpen: false,
        }),
      openSignInPrompt: () => set({ signInPromptOpen: true }),
      closeSignInPrompt: () => set({ signInPromptOpen: false }),
    }),
    {
      name: STORAGE_KEY,
      // Single point of change for the Supabase migration.
      storage: createJSONStorage(() => localStorage),
      partialize: (state) => ({
        username: state.username,
        points: state.points,
        completedChapters: state.completedChapters,
        completedLessons: state.completedLessons,
      }),
    },
  ),
);

/** Returns true once the persisted state has rehydrated from storage. */
export function useUserHydrated(): boolean {
  const [hydrated, setHydrated] = useState(false);
  useEffect(() => {
    if (useUserStore.persist.hasHydrated()) {
      setHydrated(true);
      return;
    }
    return useUserStore.persist.onFinishHydration(() => setHydrated(true));
  }, []);
  return hydrated;
}