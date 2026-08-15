export type CurriculumLessonState = 'done' | 'current' | 'upcoming';

export interface CurriculumLesson {
  num: string;
  title: string;
  shortTitle?: string;
  slug: string;
  href?: string;
  /** Reserved for the future per-chapter graded quiz; unset means a regular lesson. */
  kind?: 'lesson' | 'quiz';
}

export interface CurriculumChapter {
  num: string;
  label: string;
  slug: string;
  href?: string;
  lessons: CurriculumLesson[];
}

export interface Course {
  slug: string;
  name: string;
  description: string;
  href: string;
  planned?: boolean;
}
