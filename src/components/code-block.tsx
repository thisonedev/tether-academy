import { promises as fs } from 'node:fs';
import path from 'node:path';
import { codeToHtml } from 'shiki';

interface CodeBlockProps {
  file: string;
  mode?: 'starting' | 'answer';
  title?: string;
}

export async function CodeBlock({ file, mode = 'answer', title }: CodeBlockProps) {
  const filePath = path.resolve(process.cwd(), file);
  let content: string;
  try {
    content = await fs.readFile(filePath, 'utf-8');
  } catch {
    return (
      <div className="my-4 rounded-md border border-red-500/40 bg-red-500/10 p-3 text-sm text-red-300">
        Failed to read <code className="font-mono">{file}</code>. Make sure the file exists in the
        repo.
      </div>
    );
  }

  const displayTitle = title ?? (mode === 'starting' ? 'Starting template' : 'Answer');

  const html = await codeToHtml(content.trim(), {
    lang: 'typescript',
    theme: 'github-dark',
  });

  return (
    <figure className="my-5 overflow-hidden rounded-lg border border-fd-border bg-[#0d1117] not-prose">
      <figcaption className="flex items-center gap-2 border-b border-fd-border bg-fd-card px-4 py-2 text-xs font-semibold uppercase tracking-wider text-fd-muted-foreground">
        <span>{displayTitle}</span>
        {mode === 'starting' ? (
          <span className="rounded bg-fd-muted px-1.5 py-0.5 text-[10px] font-medium text-fd-foreground normal-case">
            fill in the TODOs
          </span>
        ) : null}
        <span className="ml-auto font-mono text-[10px] font-normal normal-case text-fd-muted-foreground/70">
          {path.basename(file)}
        </span>
      </figcaption>
      <div
        className="overflow-x-auto p-4 text-sm leading-relaxed [&_pre]:bg-transparent [&_pre]:p-0 [&_pre]:m-0"
        // biome-ignore lint/security/noDangerouslySetInnerHtml: html is built by shiki from the same source file we read into `content`; it never contains user input.
        dangerouslySetInnerHTML={{ __html: html }}
      />
    </figure>
  );
}
