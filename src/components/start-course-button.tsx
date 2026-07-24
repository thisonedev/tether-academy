'use client';

import { ArrowRight } from 'lucide-react';
import Link from 'next/link';
import { useSignInGate } from '@/lib/hooks/use-sign-in-gate';

interface StartCourseButtonProps {
  href?: string;
  label?: string;
}

/** Marked `'use client'` so the sign-in gate can read the user store while the home page stays a server component. */
export function StartCourseButton({
  href = '/courses/qvac',
  label = 'Start QVAC course',
}: StartCourseButtonProps) {
  const handleClick = useSignInGate();
  return (
    <Link
      href={href}
      onClick={handleClick}
      className="inline-flex items-center gap-2 rounded-md bg-emerald-500 px-5 py-2.5 text-sm font-semibold text-canvas transition-colors hover:bg-emerald-400"
    >
      {label}
      <ArrowRight className="size-4" />
    </Link>
  );
}
