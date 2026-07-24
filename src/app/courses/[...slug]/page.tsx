import { promises as fs } from 'node:fs';
import path from 'node:path';
import type { MDXComponents } from 'mdx/types';
import { notFound } from 'next/navigation';
import type { ReactElement } from 'react';
import { ChapterLandingBody } from '@/components/chapter-landing-body';
import { type LessonData, type LessonTest, LessonWorkspace } from '@/components/lesson-workspace';
import { MdxPre } from '@/components/mdx-pre';
import {
  CURRICULUM,
  type CurriculumChapter,
  getCurriculumChapterBySlug,
  getCurriculumLessonBySlug,
} from '@/lib/curriculum';
import { getPage, source } from '@/lib/source';

type MdxBody = (props: { components?: MDXComponents }) => ReactElement;

/** Frontmatter fields we read off every lesson MDX. */
interface FrontMatter {
  sourceExample?: string;
  tests?: LessonTest[];
  hints?: string[];
  expectedOutput?: string[];
  platforms?: LessonData['platforms'];
}

async function readExampleFile(relPath: string | undefined): Promise<string> {
  if (!relPath) return '';
  try {
    const absolute = path.resolve(process.cwd(), relPath);
    return (await fs.readFile(absolute, 'utf-8')).trim();
  } catch {
    return '';
  }
}

function examplePathsForSlug(slug: string[]) {
  const chapter = slug[slug.length - 2] ?? '';
  const basename = slug[slug.length - 1] ?? '';
  return {
    answer: `examples/qvac/${chapter}/${basename}.answer.ts`,
    starting: `examples/qvac/${chapter}/${basename}.starting.ts`,
  };
}

/** Lesson route: resolves the MDX and reads example files; falls back to a synthesized chapter landing when no MDX exists. */
export default async function Page(props: { params: Promise<{ slug?: string[] }> }) {
  const params = await props.params;
  const slug = params.slug ?? [];

  // Pack-level landings use the first chapter so the bottom Start button has a target.
  const packLanding = slug.length <= 2;
  const resolvedChapter =
    getCurriculumChapterBySlug(slug[slug.length - 1] ?? '') ??
    getCurriculumChapterBySlug(slug[slug.length - 2] ?? '');
  const currentChapter = resolvedChapter ?? (packLanding ? CURRICULUM[0] : undefined);
  const currentLesson =
    currentChapter && slug.length >= 4 && resolvedChapter
      ? getCurriculumLessonBySlug(currentChapter, slug[slug.length - 1] ?? '')
      : undefined;
  // Landings span chapter boundaries; lessons span the curriculum in order.
  const { prevUrl, nextUrl, position } = currentLesson
    ? findNeighbours(slug)
    : currentChapter
      ? findChapterLandingNeighbours(currentChapter)
      : { prevUrl: undefined, nextUrl: undefined, position: undefined };

  const page = getPage(params);
  const isCodeLesson = currentLesson ? isCodeLessonForSlug(params.slug ?? []) : false;

  if (page) {
    const MDX = page.data.body as unknown as MdxBody;
    const fm = (page.data as unknown as FrontMatter) ?? {};
    const { answer: answerPath, starting: startingPath } = examplePathsForSlug(slug);
    const answerCode = await readExampleFile(answerPath);
    const startingCode = await readExampleFile(startingPath);

    const data: LessonData = {
      title: page.data.title as string,
      description: page.data.description as string | undefined,
      startingCode:
        isCodeLesson && startingCode
          ? startingCode
          : '// This page is informational.\n// Use the section on the left to navigate.',
      answer: answerCode,
      tests: fm.tests ?? [],
      hints: fm.hints ?? [],
      expectedOutput: fm.expectedOutput ?? [],
      platforms: fm.platforms ?? ['node'],
      sourceExample: fm.sourceExample,
      prevUrl,
      nextUrl,
      position,
      firstLessonHref: currentChapter?.lessons.find((l) => l.href)?.href,
      currentChapter,
      currentLesson,
      readOnly: !isCodeLesson,
    };

    return (
      <LessonWorkspace data={data}>
        <MDX components={{ pre: MdxPre }} />
      </LessonWorkspace>
    );
  }

  if (currentChapter && !currentLesson) {
    return (
      <LessonWorkspace data={chapterLandingData(currentChapter, prevUrl, nextUrl, position)}>
        <ChapterLandingBody chapter={currentChapter} />
      </LessonWorkspace>
    );
  }

  notFound();
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

/** With output: 'export', every URL must be enumerated up front, including chapter landings without an index.mdx. */
export function generateStaticParams() {
  const mdxParams = source.generateParams();
  const chapterLandingParams = CURRICULUM.flatMap((chapter) => [
    { slug: ['qvac', 'en', chapter.slug] },
  ]);
  return [...mdxParams, ...chapterLandingParams];
}

export const dynamic = 'force-static';

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

  // Walk back through current chapter, then previous chapters; return the first shipped href.
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

  // Walk forward through current + next chapters; first shipped href.
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
