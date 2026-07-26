import { COURSES } from '@academy/courses';
import { CourseHome } from '@academy/ui';
import { notFound } from 'next/navigation';

interface PageProps {
  params: Promise<{ slug: string }>;
}

const COURSE_ACCENTS: Record<string, 'emerald' | 'violet' | 'rose'> = {
  qvac: 'emerald',
  wdk: 'violet',
  pears: 'rose',
};

export default async function Page({ params }: PageProps) {
  const { slug } = await params;
  const course = COURSES.find((c) => c.slug === slug);
  if (!course || course.planned) return notFound();
  return (
    <CourseHome
      courseName={course.name}
      courseSlug={course.slug}
      courseDescription={course.description}
      accent={COURSE_ACCENTS[course.slug] ?? 'emerald'}
    />
  );
}

export function generateStaticParams() {
  return COURSES.filter((c) => !c.planned).map((c) => ({ slug: c.slug }));
}

export const dynamic = 'force-static';
