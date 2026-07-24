import { notFound } from 'next/navigation';
import { CourseHome } from '@/components/course-home';
import { COURSES } from '@/lib/curriculum';

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
