'use client';

import { useCallback, useRef, useState, type HTMLAttributes } from 'react';
import { Check, Copy } from 'lucide-react';

type RehypePreProps = HTMLAttributes<HTMLPreElement> & {
  // rehype-pretty-code attaches a stringified SVG for the language icon.
  icon?: string;
};

/** Custom MDX `pre` override: wraps the shiki-highlighted code in a figure
 *  with a visible copy button, matching the right-side editor's UX. */
export function MdxPre({
  className,
  style,
  tabIndex,
  icon: _icon,
  children,
  ...rest
}: RehypePreProps) {
  const [copied, setCopied] = useState(false);
  const preRef = useRef<HTMLPreElement>(null);

  const handleCopy = useCallback(async () => {
    const node = preRef.current;
    if (!node) return;
    const code = node.textContent ?? '';
    try {
      if (navigator.clipboard?.writeText) {
        await navigator.clipboard.writeText(code);
      } else {
        const ta = document.createElement('textarea');
        ta.value = code;
        ta.style.position = 'fixed';
        ta.style.opacity = '0';
        document.body.appendChild(ta);
        ta.select();
        document.execCommand('copy');
        document.body.removeChild(ta);
      }
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1500);
    } catch {
      // No-op: visual feedback just won't fire.
    }
  }, []);

  return (
    <figure className="mdx-code-figure relative my-5 overflow-hidden rounded-lg border border-canvas-border bg-[#0d1117] not-prose">
      <button
        type="button"
        onClick={handleCopy}
        aria-label={copied ? 'Copied' : 'Copy code'}
        title={copied ? 'Copied!' : 'Copy code'}
        className={`absolute right-2 top-2 z-10 inline-flex items-center gap-1 rounded-md border border-canvas-border bg-canvas/80 px-2 py-1 text-xs font-medium backdrop-blur transition-colors ${
          copied
            ? 'border-emerald-500/60 text-emerald-400'
            : 'text-canvas-muted-foreground hover:bg-canvas-muted hover:text-canvas-foreground'
        }`}
      >
        {copied ? <Check className="size-3.5" /> : <Copy className="size-3.5" />}
      </button>
      <pre
        ref={preRef}
        className={`mdx-code-pre overflow-x-auto text-sm leading-relaxed ${className ?? ''}`}
        style={style}
        tabIndex={tabIndex}
        {...rest}
      >
        {children}
      </pre>
    </figure>
  );
}
