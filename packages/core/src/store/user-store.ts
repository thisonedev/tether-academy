'use client';

import { useSyncExternalStore } from 'react';
import { create } from 'zustand';
import { createJSONStorage, persist } from 'zustand/middleware';
import { CURRICULUM, getCurriculumChapterBySlug } from '@academy/courses';
import { academyStorage } from './academy-storage.js';

export const POINTS_PER_LESSON = 10;
export const POINTS_PER_CHAPTER = 50;
const XP_PER_LEVEL = 100;

export function getLevel(points: number): number {
  return Math.floor(points / XP_PER_LEVEL) + 1;
}

// Rename only when changing the persistence schema; old keys hold old data.
const STORAGE_KEY = 'tether-academy-user';

function lessonKey(chapterSlug: string, lessonSlug: string): string {
  return `${chapterSlug}-${lessonSlug}`;
}

export interface UserState {
  username: string | null;
  points: number;
  completedChapters: string[];
  completedLessons: string[];
  signInPromptOpen: boolean;
  setUsername: (name: string) => void;
  markLessonComplete: (chapterSlug: string, lessonSlug: string) => void;
  /** Replaces local progress with the host's signed record (sign-in / recovery on the same device). */
  restoreProgress: (completedLessonKeys: string[]) => void;
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
      setUsername: (name) => set({ username: name, signInPromptOpen: false }),
      markLessonComplete: (chapterSlug, lessonSlug) => {
        // Guest completions are dropped: progress requires an identity.
        if (!get().username) return;
        const key = lessonKey(chapterSlug, lessonSlug);
        if (get().completedLessons.includes(key)) return;
        const newLessons = [...get().completedLessons, key];
        let nextPoints = get().points + POINTS_PER_LESSON;
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
      restoreProgress: (completedLessonKeys) => {
        const completed = new Set(completedLessonKeys);
        const completedChapters = CURRICULUM.filter(
          (chapter) =>
            chapter.lessons.length > 0 &&
            chapter.lessons.every((l) => completed.has(lessonKey(chapter.slug, l.slug))),
        ).map((c) => c.slug);
        const points =
          completedLessonKeys.length * POINTS_PER_LESSON + completedChapters.length * POINTS_PER_CHAPTER;
        set({ completedLessons: [...completedLessonKeys], completedChapters, points });
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
      storage: createJSONStorage(() => academyStorage),
      partialize: (state) => ({
        username: state.username,
        points: state.points,
        completedChapters: state.completedChapters,
        completedLessons: state.completedLessons,
      }),
    },
  ),
);

export function useUserHydrated(): boolean {
  return useSyncExternalStore(
    (onChange) => useUserStore.persist.onFinishHydration(onChange),
    () => useUserStore.persist.hasHydrated(),
    () => false,
  );
}
