'use client';

import { COURSES, type Course, CURRICULUM } from '@academy/courses';
import type { AcademyAPI } from '@academy/validation';
import {
  ArrowRight,
  BookOpen,
  Check,
  Code2,
  Cpu,
  Lock,
  type LucideIcon,
  Network,
  Sparkles,
} from 'lucide-react';
import Link from 'next/link';
import { useEffect, useState } from 'react';
import { InstallCommandTabs } from '../../../../../packages/ui/src/components/install-command';

declare global {
  interface Window {
    academy?: AcademyAPI;
  }
}

const INSTALL_TABS = [
  { label: 'macOS / Linux', command: 'curl -fsSL https://tetheracademy.cc/install.sh | sh' },
  { label: 'Windows', command: 'irm https://tetheracademy.cc/install.ps1 | iex' },
];
const THISONEDEV_URL = 'https://github.com/thisonedev';

interface FeatureItem {
  icon: LucideIcon;
  title: string;
  body: string;
}

const FEATURES: FeatureItem[] = [
  {
    icon: BookOpen,
    title: 'Learn by doing',
    body: 'Every lesson = a short explanation, a small coding task, and instant feedback. No passive reading.',
  },
  {
    icon: Code2,
    title: 'Real SDK examples',
    body: "We wrap the SDK's own examples. Never fork them. One source of truth, kept in sync automatically",
  },
  {
    icon: Sparkles,
    title: 'AI-native by design',
    body: 'Every lesson doubles as high-quality training data. Agents can fetch the full curriculum via llms.txt.',
  },
];

const TOOLS = [
  'Pear Runtime',
  'QVAC SDK',
  'Hyperswarm',
  'HyperDHT',
  'Autobase',
  'Bare',
  'Keet Identity Key',
  'Fumadocs',
];

export default function HomePage() {
  return (
    <main className="mx-auto w-full max-w-5xl px-4 py-10 sm:px-6 sm:py-16">
      <div className="space-y-14 sm:space-y-20">
        <HeroWithInstall />
        <ToolStrip />
        <FeatureCards />
        <CoursesSection />
        <FeatureBlocks />
        <Copyright />
      </div>
    </main>
  );
}

function HeroWithInstall() {
  return (
    <div className="flex min-h-[calc(100vh-16rem)] flex-col justify-between gap-4 sm:gap-5">
      <Hero />
      <InstallRow />
    </div>
  );
}

function Hero() {
  return (
    <div className="flex flex-1 flex-col justify-center space-y-6 sm:space-y-8">
      <p className="inline-flex w-fit items-center gap-2 rounded-full border border-emerald-500/40 bg-emerald-500/15 px-3 py-1 text-xs font-semibold uppercase tracking-widest text-emerald-400">
        <Sparkles className="size-3" strokeWidth={2.5} />
        The first P2P code academy
      </p>
      <h1 className="max-w-4xl text-5xl font-bold leading-[1.05] tracking-tight sm:text-6xl lg:text-7xl">
        Learn to build on
        <br />
        Tether&apos;s open-source <br className="hidden sm:inline" />
        stack
      </h1>
      <p className="max-w-2xl text-lg leading-relaxed text-canvas-muted-foreground sm:text-xl">
        Fully local and private interactive code school for the Tether ecosystem. Short lessons,
        industry standard editor, models and code that run on your machine.
      </p>
    </div>
  );
}

function InstallRow() {
  return (
    <section id="install" className="max-w-lg space-y-3 scroll-mt-24">
      <p className="text-xs font-semibold uppercase tracking-widest text-emerald-400">
        Install via Terminal
      </p>
      <InstallCommandTabs tabs={INSTALL_TABS} />
    </section>
  );
}

function ToolStrip() {
  return (
    <div className="-mt-10 flex flex-wrap gap-2">
      {TOOLS.map((tool) => (
        <span
          key={tool}
          className="font-mono text-xs px-3 py-1.5 rounded-full border border-canvas-border bg-canvas-muted text-canvas-muted-foreground"
        >
          {tool}
        </span>
      ))}
    </div>
  );
}

function SectionDivider() {
  return (
    <div aria-hidden className="flex items-center gap-3">
      <span className="h-0.5 w-10 rounded-full bg-emerald-500" />
      <span className="h-px flex-1 bg-canvas-border" />
    </div>
  );
}

function FeatureCards() {
  return (
    <section className="space-y-6">
      <div className="grid grid-cols-1 gap-5 md:grid-cols-3">
        {FEATURES.map((feature) => (
          <FeatureCard key={feature.title} {...feature} />
        ))}
      </div>
    </section>
  );
}

function FeatureCard({ icon: Icon, title, body }: FeatureItem) {
  return (
    <div className="group flex h-full cursor-pointer flex-col rounded-2xl border border-canvas-border bg-canvas-muted p-6 transition-colors hover:border-emerald-500/60 sm:p-7">
      <div className="flex size-11 items-center justify-center rounded-xl border border-emerald-500/40 bg-emerald-500/15 transition-colors group-hover:border-emerald-500/60 group-hover:bg-emerald-500/15">
        <Icon className="size-5 text-emerald-400" strokeWidth={2} aria-hidden />
      </div>
      <h3 className="mt-5 text-lg font-semibold leading-snug tracking-tight text-canvas-foreground sm:text-xl">
        {title}
      </h3>
      <p className="mt-2.5 text-sm leading-relaxed text-canvas-muted-foreground">{body}</p>
    </div>
  );
}

interface FeatureShot {
  key: string;
  icon: LucideIcon;
  category: string;
  label: string;
  subtitle: string;
  checkboxes: string[];
  src?: string;
  alt?: string;
}

const FEATURE_SHOTS: FeatureShot[] = [
  {
    key: 'run-locally',
    icon: Cpu,
    category: 'CODE',
    label: 'Local execution',
    subtitle: 'kernel sandbox',
    src: `${process.env.NEXT_PUBLIC_BASE_PATH ?? ''}/this-device.png`,
    checkboxes: [
      'Lessons execute in a kernel sandbox, so that code can not reach the rest of your system.',
      'Models run on your CPU or GPU. No API keys and no rate limiting.',
      'Peer-exec is refused on Windows. macOS and Linux only.',
    ],
  },
  {
    key: 'editor',
    icon: Code2,
    category: 'EDITOR',
    label: 'Familiar coding experience',
    subtitle: 'monaco bundled',
    src: `${process.env.NEXT_PUBLIC_BASE_PATH ?? ''}/monaco-editor.png`,
    alt: 'Monaco editor inside a Tether Academy lesson, showing TypeScript code with IntelliSense and inline error underlines.',
    checkboxes: [
      'Monaco is bundled with the desktop app. No CDN.',
      'TypeScript, IntelliSense, and inline error messages are supported out of the box.',
      'Loads from the same local bundle as the lesson runtime. No remote scripts.',
    ],
  },
  {
    key: 'pairing',
    icon: Network,
    category: 'P2P',
    label: 'Device pairing',
    subtitle: 'end-to-end',
    src: `${process.env.NEXT_PUBLIC_BASE_PATH ?? ''}/device-pairing.png`,
    alt: 'Device pairing panel in Tether Academy, showing a local DHT pairing flow with another device.',
    checkboxes: [
      'Connects to other devices over a public DHT by their keypair.',
      'Multiple layers of security. Every connection is end-to-end encrypted.',
      'Rate-limited to one in-flight run per peer.',
    ],
  },
];

function FeatureBlocks() {
  return (
    <div className="space-y-14 sm:space-y-10">
      <SectionDivider />
      <div className="space-y-3">
        <h2 className="text-3xl font-bold leading-tight tracking-tight text-canvas-foreground sm:text-4xl">
          Explore new way of learning
        </h2>
        <h3 className="max-w-2xl text-sm leading-relaxed text-canvas-muted-foreground sm:text-base">
          The Academy is built on a local-first, peer-to-peer architecture. This allows a series of
          features that are impossible in a traditional online coding academies, including local
          execution, device pairing, private identity management, etc.
        </h3>
      </div>
      <section className="space-y-5">
        {FEATURE_SHOTS.map((feature, index) => (
          <FeatureBlock key={feature.key} feature={feature} index={index} />
        ))}
      </section>
      <ExploreCta />
    </div>
  );
}

function ExploreCta() {
  return (
    <div className="rounded-2xl border border-canvas-border bg-canvas-muted p-6 sm:p-8">
      <div className="grid grid-cols-1 gap-6 items-center md:grid-cols-[1fr_auto]">
        <div className="min-w-0">
          <p className="font-mono text-xs font-semibold uppercase tracking-widest text-emerald-400">
            Try it
          </p>
          <h3 className="mt-2 text-2xl font-bold leading-tight tracking-tight text-canvas-foreground">
            Ready to build on the p2p stack?
          </h3>
          <p className="mt-2 text-sm leading-relaxed text-canvas-muted-foreground sm:text-base max-w-xl">
            One install command. Runs offline. No accounts, no cloud.
          </p>
        </div>
        <div className="min-w-0 w-full md:w-auto">
          <InstallCommandTabs tabs={INSTALL_TABS} />
        </div>
      </div>
    </div>
  );
}

function FeatureBlock({ feature, index }: { feature: FeatureShot; index: number }) {
  const Icon = feature.icon;
  const hasImage = Boolean(feature.src);
  const reverse = index % 2 === 1;

  const text = (
    <div
      className={`flex flex-col justify-center gap-3 p-6 sm:p-8 ${
        hasImage ? (reverse ? 'md:order-1' : 'md:order-2') : ''
      }`}
    >
      <div className="flex items-center justify-between gap-3">
        <p className="inline-flex w-fit items-center gap-2 rounded-full border border-emerald-500/40 bg-emerald-500/15 px-2.5 py-1 font-mono text-[10px] font-semibold uppercase tracking-widest text-emerald-400">
          <Icon className="size-3" strokeWidth={2.5} aria-hidden />
          {feature.category} — {String(index + 1).padStart(2, '0')}
        </p>
        <span className="hidden font-mono text-[11px] text-canvas-muted-foreground sm:inline">
          {feature.subtitle}
        </span>
      </div>
      <h3 className="mt-1 text-2xl font-bold leading-tight tracking-tight text-canvas-foreground">
        {feature.label}
      </h3>
      {feature.checkboxes?.length ? (
        <ul className="mt-2 space-y-2">
          {feature.checkboxes.map((item) => (
            <li
              key={item}
              className="flex items-start gap-2 text-sm text-canvas-foreground sm:text-base"
            >
              <span
                aria-hidden
                className="mt-0.5 inline-flex size-4 shrink-0 items-center justify-center rounded border border-emerald-500/40 bg-emerald-500/15 text-emerald-400"
              >
                <Check className="size-3" strokeWidth={3} />
              </span>
              <span>{item}</span>
            </li>
          ))}
        </ul>
      ) : null}
    </div>
  );

  const image = feature.src ? (
    <div
      className={`relative overflow-hidden border-b border-canvas-border md:border-b-0 ${
        reverse ? 'md:order-2 md:border-l' : 'md:order-1 md:border-r'
      }`}
    >
      {/* biome-ignore lint/performance/noImgElement: the home page is short, the screenshots are static, and next/image is not used anywhere else in apps/web/src/ */}
      <img src={feature.src} alt={feature.alt ?? ''} loading="lazy" className="block w-full" />
    </div>
  ) : null;

  return (
    <article className="group overflow-hidden rounded-2xl border border-canvas-border bg-canvas-muted transition-colors hover:border-emerald-500/60">
      <div
        className={`grid grid-cols-1 items-center ${
          hasImage ? (reverse ? 'md:grid-cols-[1fr_1.4fr]' : 'md:grid-cols-[1.4fr_1fr]') : ''
        }`}
      >
        {text}
        {image}
      </div>
    </article>
  );
}

/** True once the desktop bridge (window.academy) is confirmed present. Starts
 *  false so SSR HTML matches the first client render, then flips after mount. */
function useIsDesktop(): boolean {
  const [isDesktop, setIsDesktop] = useState(false);
  useEffect(() => {
    setIsDesktop(typeof window !== 'undefined' && !!window.academy);
  }, []);
  return isDesktop;
}

/** Per-course accent palette, used until real logos exist. Mirrors
 *  apps/web/src/app/courses/page.tsx so the two listings stay visually in sync.
 *  Same construction as the playground's own node-category colors
 *  (CATEGORY_CLASSES): a flat color at 15% for the fill and 40% for the border. */
function glyphPalette(slug: string): { bg: string; fg: string; border: string } {
  switch (slug) {
    case 'qvac':
      return {
        bg: 'color-mix(in oklab, #4ade80 10%, var(--color-canvas))',
        fg: '#4ade80',
        border: 'color-mix(in oklab, #4ade80 30%, transparent)',
      };
    case 'wdk':
      return {
        bg: 'color-mix(in oklab, #818cf8 10%, var(--color-canvas))',
        fg: '#818cf8',
        border: 'color-mix(in oklab, #818cf8 30%, transparent)',
      };
    case 'pears':
      return {
        bg: 'color-mix(in oklab, #fca5a5 10%, var(--color-canvas))',
        fg: '#fca5a5',
        border: 'color-mix(in oklab, #fca5a5 30%, transparent)',
      };
    default:
      return {
        bg: 'var(--color-canvas)',
        fg: 'var(--color-canvas-foreground)',
        border: 'var(--color-canvas-border)',
      };
  }
}

function CourseGlyph({ slug }: { slug: string }) {
  const { bg, fg, border } = glyphPalette(slug);
  return (
    <span
      className="flex size-12 items-center justify-center rounded-lg border text-sm font-bold sm:size-14 sm:text-base"
      style={{ background: bg, color: fg, borderColor: border }}
      aria-hidden
    >
      {slug.slice(0, 3).toUpperCase()}
    </span>
  );
}

/** Counts chapters + lessons for a course. Only QVAC ships chapters today. */
function courseCounts(slug: string): { chapters: number; lessons: number } {
  if (slug !== 'qvac') return { chapters: 0, lessons: 0 };
  return {
    chapters: CURRICULUM.length,
    lessons: CURRICULUM.reduce((sum, c) => sum + c.lessons.length, 0),
  };
}

function CoursesSection() {
  const isDesktop = useIsDesktop();
  return (
    <section className="space-y-10">
      <SectionDivider />
      <div className="space-y-3">
        <p className="text-xs font-semibold uppercase tracking-widest text-emerald-400">Courses</p>
        <h2 className="text-3xl font-bold leading-tight tracking-tight text-canvas-foreground sm:text-4xl">
          Pick a track
        </h2>
        <p className="max-w-2xl text-sm leading-relaxed text-canvas-muted-foreground sm:text-base">
          Pick an open-source stack to learn. Each course is a series of short lessons with code to
          read and run.
        </p>
      </div>
      <div className="grid grid-cols-1 gap-4 md:grid-cols-2 xl:grid-cols-3">
        {COURSES.map((course) => (
          <CourseCard key={course.slug} course={course} isDesktop={isDesktop} />
        ))}
      </div>
      {isDesktop ? null : (
        <p className="text-sm text-canvas-muted-foreground">
          Courses run in the desktop app.{' '}
          <a href="#install" className="font-semibold text-emerald-400 hover:underline">
            Install it above
          </a>{' '}
          to start learning.
        </p>
      )}
    </section>
  );
}

function CourseCard({ course, isDesktop }: { course: Course; isDesktop: boolean }) {
  const counts = courseCounts(course.slug);
  // Web visitors never get a clickable course, live or not: the app is where
  // lessons actually run, so every card here should push toward installing it.
  const locked = !isDesktop && !course.planned;

  const body = (
    <>
      <div className="flex items-start justify-between gap-3">
        <CourseGlyph slug={course.slug} />
        {course.planned ? (
          <span className="inline-flex items-center rounded-full border border-canvas-border bg-canvas px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wider text-canvas-muted-foreground">
            Coming soon
          </span>
        ) : locked ? (
          <span className="inline-flex items-center gap-1.5 rounded-full border border-canvas-border bg-canvas px-2.5 py-1 text-[11px] font-semibold tracking-wide text-canvas-muted-foreground">
            <Lock className="size-3" strokeWidth={2.5} />
            Desktop only
          </span>
        ) : (
          <ArrowRight className="size-4 shrink-0 text-canvas-muted-foreground transition-colors group-hover:text-emerald-400" />
        )}
      </div>
      <h3 className="mt-4 text-lg font-semibold text-canvas-foreground sm:text-xl">
        {course.name}
      </h3>
      <p className="mt-1 text-sm leading-relaxed text-canvas-muted-foreground sm:text-base">
        {course.description}
      </p>
      {counts.chapters > 0 ? (
        <div className="mt-auto flex items-center gap-3 pt-4 text-xs text-canvas-muted-foreground">
          <span className="font-mono">
            {counts.chapters} {counts.chapters === 1 ? 'chapter' : 'chapters'}
          </span>
          <span aria-hidden className="text-canvas-border">
            ·
          </span>
          <span className="font-mono">
            {counts.lessons} {counts.lessons === 1 ? 'lesson' : 'lessons'}
          </span>
        </div>
      ) : null}
    </>
  );

  if (course.planned) {
    return (
      <div
        aria-disabled
        className="flex h-full flex-col rounded-2xl border border-dashed border-canvas-border bg-canvas-muted p-4 opacity-70 sm:p-5"
      >
        {body}
      </div>
    );
  }

  if (locked) {
    return (
      <div
        title="Install the desktop app to start this course"
        className="flex h-full flex-col rounded-2xl border border-canvas-border bg-canvas-muted p-4 opacity-80 sm:p-5"
      >
        {body}
      </div>
    );
  }

  return (
    <Link
      href={course.href}
      className="group flex h-full flex-col rounded-2xl border border-canvas-border bg-canvas-muted p-4 transition-colors hover:border-emerald-500/60 sm:p-5"
    >
      {body}
    </Link>
  );
}

function Copyright() {
  return (
    <footer className="flex flex-col items-center gap-2 pt-2 text-center text-xs text-canvas-muted-foreground sm:flex-row sm:justify-between sm:text-left">
      <p>
        © 2026{' '}
        <a
          href={THISONEDEV_URL}
          target="_blank"
          rel="noreferrer"
          className="inline-flex items-center gap-1.5 font-mono transition-colors hover:text-emerald-400"
        >
          thisonedev
        </a>
      </p>
    </footer>
  );
}
