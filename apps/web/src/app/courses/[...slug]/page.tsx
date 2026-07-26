import { getCurriculumChapterBySlug } from '@academy/courses';
import { ChapterLandingBody, MdxPre } from '@academy/ui';
import type { MDXComponents } from 'mdx/types';
import type { ReactElement } from 'react';
import { getPage } from '@/lib/source';

type MdxBody = (props: { components?: MDXComponents }) => ReactElement;

/** Renders the inner content that swaps between lessons: MDX body or chapter landing.
 *  The persistent shell (workspace, runner, header) lives in the matching layout. */
export default async function Page({ params }: { params: Promise<{ slug?: string[] }> }) {
  const resolved = await params;
  const slug = resolved.slug ?? [];

  const page = getPage(resolved);
  if (page) {
    const MDX = page.data.body as unknown as MdxBody;
    return <MDX components={{ pre: MdxPre }} />;
  }

  const chapter =
    getCurriculumChapterBySlug(slug[slug.length - 1] ?? '') ??
    getCurriculumChapterBySlug(slug[slug.length - 2] ?? '');
  if (chapter) {
    return <ChapterLandingBody chapter={chapter} />;
  }

  return null;
}
