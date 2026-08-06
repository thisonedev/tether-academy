'use client';

import { Check, Copy } from 'lucide-react';
import { useEffect, useState } from 'react';

/** How long a copied command should sit on the clipboard. */
const CLIPBOARD_SCRUB_MS = 90_000;

interface CopyButtonProps {
  command: string;
  className?: string;
}

/**
 * Small icon-only copy button with "Copied" feedback. Copies to the system
 * clipboard and scrubs after a delay so the command does not linger in the
 * paste buffer after the user has run it.
 */
export function CopyButton({ command, className }: CopyButtonProps) {
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    if (!copied) return;
    const id = setTimeout(() => setCopied(false), 2_000);
    return () => clearTimeout(id);
  }, [copied]);

  const onCopy = async () => {
    try {
      if (navigator.clipboard?.writeText) {
        await navigator.clipboard.writeText(command);
        setCopied(true);
        setTimeout(() => {
          navigator.clipboard
            .readText()
            .then((current) => {
              if (current === command) navigator.clipboard.writeText('');
            })
            .catch(() => {});
        }, CLIPBOARD_SCRUB_MS);
      } else {
        const ta = document.createElement('textarea');
        ta.value = command;
        ta.style.position = 'fixed';
        ta.style.opacity = '0';
        document.body.appendChild(ta);
        ta.select();
        document.execCommand('copy');
        document.body.removeChild(ta);
        setCopied(true);
      }
    } catch {
      setCopied(false);
    }
  };

  return (
    <button
      type="button"
      onClick={onCopy}
      aria-label={copied ? 'Copied' : 'Copy install command'}
      title={copied ? 'Copied' : 'Copy'}
      className={`inline-flex shrink-0 items-center justify-center rounded border border-canvas-border bg-canvas-muted p-1.5 text-canvas-foreground transition-colors hover:border-emerald-500/40 hover:text-emerald-400 ${className ?? ''}`}
    >
      {copied ? <Check className="size-3.5" strokeWidth={2.5} /> : <Copy className="size-3.5" />}
    </button>
  );
}

interface InstallCommandProps {
  command: string;
  className?: string;
}

/**
 * One-line install command with a copy button. Self-contained rounded panel;
 * use CopyButton directly if you want to render the chrome yourself.
 */
export function InstallCommand({ command, className }: InstallCommandProps) {
  return (
    <div
      className={`flex items-center gap-2 rounded-md border border-canvas-border bg-canvas px-3 py-2 font-mono text-sm text-canvas-foreground ${className ?? ''}`}
    >
      <code className="min-w-0 flex-1 truncate">{command}</code>
      <CopyButton command={command} />
    </div>
  );
}
