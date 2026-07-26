export type CurriculumLessonState = 'done' | 'current' | 'upcoming';

export interface CurriculumLesson {
  num: string;
  title: string;
  shortTitle?: string;
  slug: string;
  href?: string;
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
