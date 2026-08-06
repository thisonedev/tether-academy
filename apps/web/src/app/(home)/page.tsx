'use client';

import {
  AppWindow,
  ArrowRight,
  BookOpen,
  Check,
  Code2,
  Cpu,
  Globe,
  HardDrive,
  type LucideIcon,
  Network,
  ShieldCheck,
  Sparkles,
} from 'lucide-react';
import { CopyButton } from '../../../../../packages/ui/src/components/install-command';

const INSTALL_COMMAND =
  'curl -fsSL https://raw.githubusercontent.com/thisonedev/tether-academy/master/apps/cli/install.sh | sh';
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
    body: "Every lesson = a short explanation, a small coding task, and instant feedback. No passive reading.",
  },
  {
    icon: Code2,
    title: 'Real SDK examples',
    body: "We wrap the SDK's own examples. Never fork them. One source of truth, kept in sync automatically",
  },
  {
    icon: Sparkles,
    title: 'AI-native by design',
    body: "Every lesson doubles as high-quality training data. Agents can fetch the full curriculum via llms.txt.",
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
        <FeatureBlocks />
        <Architecture />
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
      <p className="inline-flex w-fit items-center gap-2 rounded-full border border-emerald-500/30 bg-emerald-500/10 px-3 py-1 text-xs font-semibold uppercase tracking-widest text-emerald-400">
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
    <section className="max-w-md space-y-3">
      <p className="text-xs font-semibold uppercase tracking-widest text-emerald-400">
        Install via Terminal (macOS / Linux)
      </p>
      <div className="overflow-hidden rounded-md border border-canvas-border bg-canvas">
        <div className="flex items-center gap-2 px-3 py-2 font-mono text-sm text-canvas-foreground">
          <code className="min-w-0 flex-1 truncate">{INSTALL_COMMAND}</code>
          <CopyButton command={INSTALL_COMMAND} />
        </div>
      </div>
    </section>
  );
}

function ToolStrip() {
  return (
    <div className="-mt-12 flex flex-wrap gap-2 sm:-mt-10">
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
      <div className="grid grid-cols-1 gap-4 md:grid-cols-3">
        {FEATURES.map((feature) => (
          <FeatureCard key={feature.title} {...feature} />
        ))}
      </div>
    </section>
  );
}

function FeatureCard({ icon: Icon, title, body }: FeatureItem) {
  return (
    <div className="flex h-full flex-col rounded-xl border border-canvas-border bg-canvas-muted p-5">
      <Icon className="mb-4 size-5 text-emerald-400" />
      <h3 className="mb-3 text-lg font-semibold leading-snug tracking-tight text-canvas-foreground sm:text-xl">
        {title}
      </h3>
      <p className="text-sm leading-relaxed text-canvas-muted-foreground">{body}</p>
    </div>
  );
}

interface FeatureShot {
  key: string;
  icon: LucideIcon;
  category: string;
  label: string;
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
    src: '/this-device.png',
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
    src: '/monaco-editor.png',
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
    src: '/device-pairing.png',
    alt: 'Device pairing panel in Tether Academy, showing a local DHT pairing flow with another device.',
    checkboxes: [
      'Connects to other devices over a public DHT by their keypair.',
      'Multiple layers of security. Every connection is end-to-end encrypted.',
      'Rate-limited to one in-flight run per peer.',
    ],
  },
  {
    key: 'models',
    icon: HardDrive,
    category: 'LLMs',
    label: 'Model management',
    src: '/model-management.png',
    alt: 'Model management view in Tether Academy, showing a list of downloaded models with sizes and integrity hashes.',
    checkboxes: [
      'Models are files on your disk, with a sha256 hash recorded in a manifest.',
      'A tampered model is rejected on load.',
      'Manage the list from Settings → Models.',
    ],
  },
];

function FeatureBlocks() {
  return (
    <div className="space-y-14 sm:space-y-20">
      <SectionDivider />
      <section className="space-y-14 sm:space-y-20">
      {FEATURE_SHOTS.map((feature, index) => (
        <FeatureBlock key={feature.key} feature={feature} index={index} />
      ))}
    </section>
    </div>
    
  );
}

function FeatureBlock({ feature, index }: { feature: FeatureShot; index: number }) {
  const Icon = feature.icon;
  const hasImage = Boolean(feature.src);
  const reverse = index % 2 === 1;
  const textOrder = hasImage ? (reverse ? 'md:order-1' : 'md:order-2') : 'md:col-span-2';
  const imageOrder = hasImage ? (reverse ? 'md:order-2' : 'md:order-1') : '';
  const number = String(index + 1).padStart(2, '0');
  const text = (
    <div
      className={`relative flex flex-col justify-center gap-4 overflow-hidden rounded-2xl border border-canvas-border bg-canvas-muted p-6 sm:p-8 ${textOrder}`}
    >
      <p className="inline-flex w-fit items-center gap-2 rounded-full border border-emerald-500/30 bg-emerald-500/10 px-2.5 py-1 font-mono text-[10px] font-semibold uppercase tracking-widest text-emerald-400">
        <Icon className="size-3" strokeWidth={2.5} aria-hidden />
        {feature.category}
      </p>
      <h3 className="text-2xl font-bold leading-tight tracking-tight text-canvas-foreground sm:text-2xl">
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
                className="mt-0.5 inline-flex size-4 shrink-0 items-center justify-center rounded border border-emerald-500/40 bg-emerald-500/10 text-emerald-400"
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
      className={`overflow-hidden rounded-2xl border border-canvas-border bg-canvas-muted ${imageOrder}`}
    >
      <div className="overflow-hidden rounded-xl">
        {/* biome-ignore lint/performance/noImgElement: the home page is short, the screenshots are static, and next/image is not used anywhere else in apps/web/src/ */}
        <img src={feature.src} alt={feature.alt ?? ''} loading="lazy" className="block w-full" />
      </div>
    </div>
  ) : null;

  return (
    <div className="grid grid-cols-1 items-center gap-6 md:grid-cols-2 md:gap-10">
      {text}
      {image}
    </div>
  );
}

interface ArchitectureLayer {
  icon: LucideIcon;
  title: string;
  subtitle: string;
}

const ARCH_LAYERS: ArchitectureLayer[] = [
  {
    icon: Globe,
    title: 'Page',
    subtitle: 'Next.js + Fumadocs + Monaco',
  },
  {
    icon: AppWindow,
    title: 'Desktop shell',
    subtitle: 'Electron main + preload',
  },
  {
    icon: Cpu,
    title: 'Bare host',
    subtitle: 'Pear Runtime + peer transport',
  },
  {
    icon: ShieldCheck,
    title: 'Sandboxed peer-exec',
    subtitle: 'kernel sandbox + remote peers',
  },
];

const ARCH_LAYER_STYLES: { tint: string; icon: string; ring: string }[] = [
  {
    tint: 'from-emerald-500/15 to-emerald-500/0',
    icon: 'from-emerald-400 to-emerald-500',
    ring: 'ring-emerald-500/30',
  },
  {
    tint: 'from-cyan-500/10 to-cyan-500/0',
    icon: 'from-cyan-400 to-cyan-500',
    ring: 'ring-cyan-500/30',
  },
  {
    tint: 'from-violet-500/10 to-violet-500/0',
    icon: 'from-violet-400 to-violet-500',
    ring: 'ring-violet-500/30',
  },
  {
    tint: 'from-amber-500/10 to-amber-500/0',
    icon: 'from-amber-400 to-amber-500',
    ring: 'ring-amber-500/30',
  },
];

function Architecture() {
  return (
    <section className="space-y-10">
      <SectionDivider />
      <h2 className="text-3xl font-bold leading-tight tracking-tight text-canvas-foreground sm:text-4xl">
        Architecture
      </h2>
      <h3 className="max-w-2xl text-sm leading-relaxed text-canvas-muted-foreground sm:text-base">
        The Academy is built on a local-first, peer-to-peer architecture. The page runs in a browser, the
        desktop shell runs in Electron, and the lesson engine runs in a sandboxed process. Every
        action is mediated by a small, audited bridge.
      </h3>
      <div className="rounded-2xl border border-canvas-border bg-canvas-muted p-4 sm:p-6">
        <div className="grid grid-cols-1 items-stretch gap-4 md:grid-cols-[1fr_auto_1fr_auto_1fr_auto_1fr] md:gap-3">
          {ARCH_LAYERS.map((layer, index) => {
            const Icon = layer.icon;
            const isLast = index === ARCH_LAYERS.length - 1;
            const style = ARCH_LAYER_STYLES[index] ?? ARCH_LAYER_STYLES[0];
            return (
              <div key={layer.title} className="contents">
                <div
                  className={`relative flex flex-col items-center gap-3 overflow-hidden rounded-2xl border border-canvas-border bg-gradient-to-b ${style.tint} p-5 text-center`}
                >
                  <span
                    className={`inline-flex size-11 items-center justify-center rounded-xl border border-canvas-border bg-gradient-to-br ${style.icon} p-2 text-canvas shadow-sm`}
                  >
                    <Icon className="size-5 text-canvas" strokeWidth={2} aria-hidden />
                  </span>
                  <h3 className="text-lg font-semibold tracking-tight text-canvas-foreground">
                    {layer.title}
                  </h3>
                  <p className="text-sm text-canvas-muted-foreground">{layer.subtitle}</p>
                </div>
                {!isLast ? (
                  <div
                    aria-hidden
                    className="hidden flex-col items-center justify-center gap-2 self-center text-canvas-muted-foreground md:flex"
                  >
                    <span className="font-mono text-[10px] font-semibold uppercase tracking-widest text-emerald-400">
                      {index === 0 ? 'contextBridge' : index === 1 ? 'bare-rpc' : 'Hyperswarm'}
                    </span>
                    <div className="flex items-center gap-1">
                      <span className="h-px w-3 bg-emerald-500/40" />
                      <ArrowRight className="size-4 text-emerald-400" />
                      <span className="h-px w-3 bg-emerald-500/40" />
                    </div>
                  </div>
                ) : null}
              </div>
            );
          })}
        </div>
      </div>
    </section>
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
