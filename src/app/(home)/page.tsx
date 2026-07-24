import { BookOpen, Code2, Sparkles } from 'lucide-react';
import { StartCourseButton } from '@/components/start-course-button';

export default function HomePage() {
  return (
    <main className="mx-auto w-full max-w-5xl px-4 py-12 sm:px-6 sm:py-20">
      <div className="space-y-12 sm:space-y-16">
        <div className="space-y-4 sm:space-y-6">
          <h1 className="text-4xl font-bold leading-[1.1] tracking-tight sm:text-6xl">
            Learn to build on
            <br />
            Tether&apos;s open-source stack.
          </h1>
          <p className="max-w-2xl text-lg leading-relaxed text-canvas-muted-foreground sm:text-xl">
            An interactive code school for the Tether ecosystem. Short lessons, in-browser code,
            instant feedback.
          </p>
          <div className="flex flex-wrap gap-3 pt-2">
            <StartCourseButton />
            <a
              href="https://github.com/thisonedev/tether-academy"
              target="_blank"
              rel="noreferrer"
              className="inline-flex items-center gap-2 rounded-md border border-canvas-border px-5 py-2.5 text-sm font-semibold text-canvas-foreground transition-colors hover:bg-canvas-muted"
            >
              View on GitHub
            </a>
          </div>
        </div>

        <section className="grid gap-4 sm:grid-cols-3 sm:gap-6">
          <FeatureCard
            icon={<BookOpen className="size-5" />}
            title="Learn by doing"
            body="Every lesson = a short explanation, a small coding task, and instant pass/fail feedback. No passive reading."
          />
          <FeatureCard
            icon={<Code2 className="size-5" />}
            title="Real SDK examples"
            body="We wrap the SDK's own examples. Never fork them. One source of truth, kept in sync automatically."
          />
          <FeatureCard
            icon={<Sparkles className="size-5" />}
            title="AI-native by design"
            body="Every lesson doubles as high-quality training data. Agents can fetch the full curriculum via llms.txt."
          />
        </section>

        <section className="rounded-lg border border-canvas-border bg-canvas-muted p-5 sm:p-6">
          <h2 className="mb-3 text-lg font-semibold text-canvas-foreground sm:text-xl">
            What's included
          </h2>
          <ul className="ml-5 list-disc space-y-1.5 text-sm text-canvas-muted-foreground sm:text-base">
            <li>QVAC course: getting started, completion, RAG, speech, P2P, etc.</li>
            <li>Interactive lesson runner with simulated live preview</li>
            <li>Sample-sync against the upstream QVAC SDK examples</li>
            <li>
              <a
                href="/tether-academy/courses/llms-full.txt"
                className="font-mono text-emerald-400"
              >
                llms.txt
              </a>{' '}
              export of the full curriculum
            </li>
          </ul>
        </section>
      </div>
    </main>
  );
}

function FeatureCard({
  icon,
  title,
  body,
}: {
  icon: React.ReactNode;
  title: string;
  body: string;
}) {
  return (
    <div className="rounded-lg border border-canvas-border bg-canvas-muted p-4 sm:p-5">
      <div className="mb-3 inline-flex size-9 items-center justify-center rounded-md bg-canvas text-emerald-400">
        {icon}
      </div>
      <h3 className="mb-1.5 text-base font-semibold text-canvas-foreground">{title}</h3>
      <p className="text-sm leading-relaxed text-canvas-muted-foreground">{body}</p>
    </div>
  );
}
