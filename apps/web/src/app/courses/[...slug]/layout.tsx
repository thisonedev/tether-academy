import { promises as fs } from 'node:fs';
import path from 'node:path';
import {
  CURRICULUM,
  type CurriculumChapter,
  getCurriculumChapterBySlug,
  getCurriculumLessonBySlug,
} from '@academy/courses';
import {
  type LessonArgvSlot,
  type LessonData,
  type LessonQuestion,
  type LessonTest,
  LessonWorkspace,
} from '@academy/ui';
import { notFound } from 'next/navigation';
import type { ReactNode } from 'react';
import { getPage, source } from '@/lib/source';

interface FrontMatter {
  sourceExample?: string;
  tests?: LessonTest[];
  hints?: string[];
  expectedOutput?: string[];
  platforms?: LessonData['platforms'];
  pairedMode?: boolean;
  argv?: LessonArgvSlot[];
  questions?: LessonQuestion[];
}

function lessonReference(title: string, fm: FrontMatter, source: string): string {
  const result = [
    `Lesson: ${title}`,
    fm.sourceExample ? `Example: ${fm.sourceExample}` : '',
    source,
    ...(fm.hints ?? []).map((hint) => `Hint: ${hint}`),
    ...(fm.expectedOutput ?? []).map((line) => `Expected output: ${line}`),
  ].filter(Boolean);
  return result.join('\n').slice(0, 8_000);
}

// Vendored example code lives one repo level up, under packages/courses.
const COURSES_ROOT = path.resolve(process.cwd(), '..', '..', 'packages', 'courses');

async function readExampleFile(relPath: string | undefined): Promise<string> {
  if (!relPath) return '';
  try {
    const absolute = path.resolve(COURSES_ROOT, relPath);
    return (await fs.readFile(absolute, 'utf-8')).trim();
  } catch {
    return '';
  }
}

async function readLessonSource(slug: string[]): Promise<string> {
  const chapter = slug[slug.length - 2] ?? '';
  const lesson = slug[slug.length - 1] ?? '';
  return readExampleFile(`courses/qvac/en/${chapter}/${lesson}.mdx`);
}

function examplePathsForSlug(slug: string[]) {
  const chapter = slug[slug.length - 2] ?? '';
  const basename = slug[slug.length - 1] ?? '';
  return {
    answer: `examples/qvac/${chapter}/${basename}.answer.ts`,
    starting: `examples/qvac/${chapter}/${basename}.starting.ts`,
  };
}

async function isCodeLessonForSlug(slug: string[]): Promise<boolean> {
  const { starting: startingPath } = examplePathsForSlug(slug);
  const startingCode = await readExampleFile(startingPath);
  return typeof startingCode === 'string' && startingCode.length > 0;
}

function chapterLandingData(
  chapter: CurriculumChapter,
  prevUrl: string | undefined,
  nextUrl: string | undefined,
  position: { current: number; total: number } | undefined,
): LessonData {
  return {
    title: chapter.label,
    description: undefined,
    startingCode: '// This page is informational.\n// Use the section on the left to navigate.',
    answer: '',
    tests: [],
    hints: [],
    expectedOutput: [],
    platforms: ['node'],
    prevUrl,
    nextUrl,
    position,
    firstLessonHref: chapter.lessons.find((l) => l.href)?.href,
    currentChapter: chapter,
    currentLesson: undefined,
    readOnly: true,
  };
}

/** Finds prev/next for a chapter landing: previous chapter's last shipped lesson, this chapter's first. */
function findChapterLandingNeighbours(chapter: CurriculumChapter): {
  prevUrl: string | undefined;
  nextUrl: string | undefined;
  position: undefined;
} {
  const idx = CURRICULUM.findIndex((c) => c.slug === chapter.slug);
  const prevChapter = idx > 0 ? CURRICULUM[idx - 1] : undefined;
  const prevUrl = prevChapter?.lessons.findLast((l) => l.href)?.href;
  const nextUrl = chapter.lessons.find((l) => l.href)?.href;
  return { prevUrl, nextUrl, position: undefined };
}

/** Finds prev/next across CURRICULUM in declaration order. Spans chapter boundaries; skips lessons without an href (planned). */
function findNeighbours(slug: string[]): {
  prevUrl: string | undefined;
  nextUrl: string | undefined;
  position: { current: number; total: number } | undefined;
} {
  const chapter = getCurriculumChapterBySlug(slug[slug.length - 2] ?? '');
  if (!chapter) return { prevUrl: undefined, nextUrl: undefined, position: undefined };

  const lessonIdx = chapter.lessons.findIndex((l) => l.slug === (slug[slug.length - 1] ?? ''));
  if (lessonIdx === -1) {
    return { prevUrl: undefined, nextUrl: undefined, position: undefined };
  }

  const position = { current: lessonIdx + 1, total: chapter.lessons.length };

  // Walk back through this chapter, then earlier chapters; first shipped href.
  const prevShipped = (() => {
    for (let i = lessonIdx - 1; i >= 0; i--) {
      const href = chapter.lessons[i]?.href;
      if (href) return href;
    }
    const chapterIdx = CURRICULUM.findIndex((c) => c.slug === chapter.slug);
    for (let c = chapterIdx - 1; c >= 0; c--) {
      const prevChapter = CURRICULUM[c];
      if (!prevChapter) continue;
      for (let i = prevChapter.lessons.length - 1; i >= 0; i--) {
        const href = prevChapter.lessons[i]?.href;
        if (href) return href;
      }
    }
    return undefined;
  })();

  // Walk forward through this + next chapters; first shipped href.
  const nextShipped = (() => {
    for (let i = lessonIdx + 1; i < chapter.lessons.length; i++) {
      const href = chapter.lessons[i]?.href;
      if (href) return href;
    }
    const chapterIdx = CURRICULUM.findIndex((c) => c.slug === chapter.slug);
    for (let c = chapterIdx + 1; c < CURRICULUM.length; c++) {
      const nextChapter = CURRICULUM[c];
      if (!nextChapter) continue;
      for (let i = 0; i < nextChapter.lessons.length; i++) {
        const href = nextChapter.lessons[i]?.href;
        if (href) return href;
      }
    }
    return undefined;
  })();

  return { prevUrl: prevShipped, nextUrl: nextShipped, position };
}

/** Stays mounted across sibling-lesson navigations so the editor, the runner,
 *  and the header do not reflash on every Next click. Only `children` swap. */
export default async function Layout({
  children,
  params,
}: {
  children: ReactNode;
  params: Promise<{ slug?: string[] }>;
}) {
  const resolved = await params;
  const slug = resolved.slug ?? [];

  const packLanding = slug.length <= 2;
  const resolvedChapter =
    getCurriculumChapterBySlug(slug[slug.length - 1] ?? '') ??
    getCurriculumChapterBySlug(slug[slug.length - 2] ?? '');
  const currentChapter = resolvedChapter ?? (packLanding ? CURRICULUM[0] : undefined);
  const currentLesson =
    currentChapter && slug.length >= 4 && resolvedChapter
      ? getCurriculumLessonBySlug(currentChapter, slug[slug.length - 1] ?? '')
      : undefined;
  const { prevUrl, nextUrl, position } = currentLesson
    ? findNeighbours(slug)
    : currentChapter
      ? findChapterLandingNeighbours(currentChapter)
      : { prevUrl: undefined, nextUrl: undefined, position: undefined };

  const page = getPage(resolved);
  const isCodeLesson = currentLesson ? await isCodeLessonForSlug(slug) : false;

  if (page) {
    const fm = (page.data as unknown as FrontMatter) ?? {};
    const { answer: answerPath, starting: startingPath } = examplePathsForSlug(slug);
    const [answerCode, startingCode, lessonSource] = await Promise.all([
      readExampleFile(answerPath),
      readExampleFile(startingPath),
      readLessonSource(slug),
    ]);

    const data: LessonData = {
      title: page.data.title as string,
      description: page.data.description as string | undefined,
      lessonReference: lessonReference(page.data.title as string, fm, lessonSource),
      startingCode:
        isCodeLesson && startingCode
          ? startingCode
          : '// This page is informational.\n// Use the section on the left to navigate.',
      answer: answerCode,
      tests: fm.tests ?? [],
      hints: fm.hints ?? [],
      expectedOutput: fm.expectedOutput ?? [],
      platforms: fm.platforms ?? ['node'],
      pairedMode: fm.pairedMode !== false,
      sourceExample: fm.sourceExample,
      prevUrl,
      nextUrl,
      position,
      firstLessonHref: currentChapter?.lessons.find((l) => l.href)?.href,
      currentChapter,
      currentLesson,
      readOnly: !isCodeLesson,
      argv: fm.argv,
      questions: fm.questions,
    };

    return <LessonWorkspace data={data}>{children}</LessonWorkspace>;
  }

  if (currentChapter && !currentLesson) {
    return (
      <LessonWorkspace data={chapterLandingData(currentChapter, prevUrl, nextUrl, position)}>
        {children}
      </LessonWorkspace>
    );
  }

  notFound();
}

/** With output: 'export', every URL must be enumerated up front, including chapter landings without an index.mdx. */
export function generateStaticParams() {
  const mdxParams = source.generateParams();
  const chapterLandingParams = CURRICULUM.flatMap((chapter) => [
    { slug: ['qvac', 'en', chapter.slug] },
  ]);
  return [...mdxParams, ...chapterLandingParams];
}
