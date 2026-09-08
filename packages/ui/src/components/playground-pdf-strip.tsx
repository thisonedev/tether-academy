'use client';

import { Check, Loader2 } from 'lucide-react';
import { useEffect, useState } from 'react';
import { formatPageSpec, parsePageRanges, renderPdfThumbnails } from './playground-pdf.js';

/** Past this the strip costs more memory than the preview is worth, so the
 *  tail stays unrendered and the typed field keeps covering those pages. */
const MAX_STRIP_PAGES = 200;

/** Thumbnails for one PDF, filling in as each page renders. */
export function usePdfThumbnails(dataUrl: string | null, maxPages = MAX_STRIP_PAGES): string[] {
  const [thumbs, setThumbs] = useState<string[]>([]);
  useEffect(() => {
    setThumbs([]);
    if (!dataUrl) return;
    const signal = { aborted: false };
    renderPdfThumbnails(
      dataUrl,
      (index, png) =>
        setThumbs((prev) => {
          const next = prev.slice();
          next[index] = png;
          return next;
        }),
      { width: 96, maxPages, signal },
    ).catch(() => {});
    return () => {
      signal.aborted = true;
    };
  }, [dataUrl, maxPages]);
  return thumbs;
}

const STRIP =
  'flex items-start gap-2 overflow-x-auto rounded-lg border border-canvas-border bg-canvas p-2';

function Thumb({ png, label }: { png: string; label: string }) {
  return (
    <>
      {/* biome-ignore lint/performance/noImgElement: a locally rendered data: URL, not a remote asset */}
      <img src={png} alt="" className="w-full rounded-sm" />
      <span className="mt-1 block text-center text-[10px] text-canvas-muted-foreground">{label}</span>
    </>
  );
}

function Rendering() {
  return (
    <span className="flex items-center gap-1.5 px-1 py-6 text-[11px] text-canvas-muted-foreground">
      <Loader2 className="size-3 animate-spin" />
      Rendering pages…
    </span>
  );
}

/** Extract's strip: every page is a toggle, and the selection is the same
 *  value as the typed spec, so either one can drive the other. */
export function PdfPageStrip({
  dataUrl,
  value,
  onChange,
}: {
  dataUrl: string;
  value: string;
  onChange: (spec: string) => void;
}) {
  const thumbs = usePdfThumbnails(dataUrl);
  const count = thumbs.length;
  // A spec being edited by hand may not parse yet, so a failure selects nothing.
  let selected: Set<number>;
  try {
    selected = new Set(count > 0 ? parsePageRanges(value, count) : []);
  } catch {
    selected = new Set();
  }
  const toggle = (index: number) => {
    const next = new Set(selected);
    if (next.has(index)) next.delete(index);
    else next.add(index);
    onChange(formatPageSpec(Array.from(next)));
  };
  const all = count > 0 && selected.size === count;
  const everyPage = () => formatPageSpec(Array.from({ length: count }, (_, i) => i));
  return (
    <>
      {count > 0 && (
        <div className="mb-1 flex items-center justify-between px-0.5 text-[10.5px] text-canvas-muted-foreground">
          <span>{`${selected.size} of ${count} selected`}</span>
          <button
            type="button"
            onClick={() => onChange(all ? '' : everyPage())}
            className="rounded border border-canvas-border px-1.5 py-0.5 hover:text-canvas-foreground"
          >
            {all ? 'Select none' : 'Select all'}
          </button>
        </div>
      )}
      <div className={STRIP}>
        {count === 0 && <Rendering />}
        {thumbs.map((png, index) => {
          const on = selected.has(index);
          return (
            <button
              key={`p${index}`}
              type="button"
              onClick={() => toggle(index)}
              aria-pressed={on}
              aria-label={`Page ${index + 1}`}
              className={`relative w-[68px] shrink-0 rounded-md border p-1 ${
                on ? 'border-emerald-500 bg-emerald-500/10' : 'border-canvas-border hover:bg-canvas-muted'
              }`}
            >
              <span
                className={`absolute top-2 left-2 flex size-3.5 items-center justify-center rounded-full border ${
                  on ? 'border-emerald-500 bg-emerald-500 text-black' : 'border-canvas-border bg-canvas'
                }`}
              >
                {on && <Check className="size-2.5" />}
              </span>
              <Thumb png={png} label={`${index + 1}`} />
            </button>
          );
        })}
      </div>
    </>
  );
}

/** A preview for the typed modes: a range or a page count is easier to write
 *  while looking at the document. The pages do nothing when clicked. */
export function PdfPreviewStrip({ dataUrl }: { dataUrl: string }) {
  const thumbs = usePdfThumbnails(dataUrl);
  return (
    <div className={STRIP}>
      {thumbs.length === 0 && <Rendering />}
      {thumbs.map((png, index) => (
        <div key={`p${index}`} className="w-[68px] shrink-0 rounded-md border border-canvas-border p-1">
          <Thumb png={png} label={`${index + 1}`} />
        </div>
      ))}
    </div>
  );
}

/** Merge's per-file preview: only the first page, which is enough to tell two
 *  scans apart in a stack. */
export function PdfFirstPage({ dataUrl }: { dataUrl: string }) {
  const [thumb] = usePdfThumbnails(dataUrl, 1);
  if (!thumb) return <div className="h-[46px] w-[34px] shrink-0 rounded-sm bg-canvas-muted" />;
  // biome-ignore lint/performance/noImgElement: a locally rendered data: URL, not a remote asset
  // draggable={false}: a native image drag would win over the row's own drag.
  return (
    <img src={thumb} alt="" draggable={false} className="h-[46px] w-[34px] shrink-0 rounded-sm object-cover" />
  );
}
