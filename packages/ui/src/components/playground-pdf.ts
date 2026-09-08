/** PDF page operations, kept separate from playground-files.ts: that module
 *  reads documents down to text, these rewrite the pages and hand back a PDF. */
import type { PickedFile } from './playground-files.js';

const PDF_MIME = 'application/pdf';

function dataUrlToBytes(dataUrl: string): Uint8Array {
  const comma = dataUrl.indexOf(',');
  const binary = atob(comma >= 0 ? dataUrl.slice(comma + 1) : dataUrl);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

function bytesToDataUrl(bytes: Uint8Array): string {
  let binary = '';
  // String.fromCharCode(...bytes) overflows the call stack on a real PDF.
  for (let i = 0; i < bytes.length; i += 0x8000) {
    binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  }
  return `data:${PDF_MIME};base64,${btoa(binary)}`;
}

export function isPdf(file: { name: string; dataUrl: string }): boolean {
  return /\.pdf$/i.test(file.name) || file.dataUrl.startsWith(`data:${PDF_MIME}`);
}

function isImage(file: { name: string }): boolean {
  return /\.(png|jpe?g)$/i.test(file.name);
}

/** Every entry point loads pdf-lib this way: it is large and only reachable
 *  through a PDF node, so it stays out of the main bundle. */
async function pdfLib() {
  return import('pdf-lib');
}

/** Appends `file` to `target` as pages: a PDF contributes its own, a scan
 *  saved as PNG/JPEG becomes one page sized to the image. */
async function appendFile(target: import('pdf-lib').PDFDocument, file: PickedFile): Promise<number> {
  const bytes = dataUrlToBytes(file.dataUrl);
  if (isPdf(file)) {
    const { PDFDocument } = await pdfLib();
    const source = await PDFDocument.load(bytes, { ignoreEncryption: true });
    const copied = await target.copyPages(source, source.getPageIndices());
    for (const page of copied) target.addPage(page);
    return copied.length;
  }
  if (!isImage(file)) throw new Error(`${file.name} is not a PDF or a PNG/JPEG scan.`);
  const image = /\.png$/i.test(file.name) ? await target.embedPng(bytes) : await target.embedJpg(bytes);
  target.addPage([image.width, image.height]).drawImage(image, {
    x: 0,
    y: 0,
    width: image.width,
    height: image.height,
  });
  return 1;
}

export interface MergeResult {
  dataUrl: string;
  pageCount: number;
}

/** Merges PDFs and image scans, in the order given, into one document. */
export async function mergeToPdf(files: PickedFile[]): Promise<MergeResult> {
  const { PDFDocument } = await pdfLib();
  const merged = await PDFDocument.create();
  let pageCount = 0;
  for (const file of files) pageCount += await appendFile(merged, file);
  if (pageCount === 0) throw new Error('Nothing to merge: no pages were found in the selected files.');
  return { dataUrl: bytesToDataUrl(await merged.save()), pageCount };
}

export async function pdfPageCount(dataUrl: string): Promise<number> {
  const { PDFDocument } = await pdfLib();
  const doc = await PDFDocument.load(dataUrlToBytes(dataUrl), { ignoreEncryption: true });
  return doc.getPageCount();
}

/** Builds a new PDF from `indices` (0-based) of the source, in the order given,
 *  so a caller can reorder as well as select. */
async function pdfFromPages(sourceDataUrl: string, indices: number[]): Promise<string> {
  const { PDFDocument } = await pdfLib();
  const source = await PDFDocument.load(dataUrlToBytes(sourceDataUrl), { ignoreEncryption: true });
  const out = await PDFDocument.create();
  const copied = await out.copyPages(source, indices);
  for (const page of copied) out.addPage(page);
  return bytesToDataUrl(await out.save());
}

/** Parses "1-3, 7, 9-" into 0-based page indices. Duplicates are kept, so
 *  "1,1" repeats page 1 twice; an open end ("9-") runs to the last page. */
export function parsePageRanges(spec: string, pageCount: number): number[] {
  const indices: number[] = [];
  for (const part of spec.split(',')) {
    const piece = part.trim();
    if (!piece) continue;
    const range = /^(\d+)?\s*-\s*(\d+)?$/.exec(piece);
    if (range) {
      const from = range[1] ? Number(range[1]) : 1;
      const to = range[2] ? Number(range[2]) : pageCount;
      if (from < 1 || to > pageCount || from > to) throw new Error(`Page range "${piece}" is outside 1-${pageCount}.`);
      for (let page = from; page <= to; page++) indices.push(page - 1);
      continue;
    }
    if (!/^\d+$/.test(piece)) throw new Error(`"${piece}" is not a page number.`);
    const single = Number(piece);
    if (single < 1 || single > pageCount) throw new Error(`Page ${single} is outside 1-${pageCount}.`);
    indices.push(single - 1);
  }
  if (indices.length === 0) throw new Error('No pages selected: enter something like 1-3, 7.');
  return indices;
}

/** Turns selected 0-based indices back into "1-3, 7, 9-10", so a visual
 *  selection round-trips through the same field a person can type into. */
export function formatPageSpec(indices: number[]): string {
  const sorted = Array.from(new Set(indices)).sort((a, b) => a - b);
  const parts: string[] = [];
  for (let i = 0; i < sorted.length; ) {
    let end = i;
    while (end + 1 < sorted.length && sorted[end + 1] === sorted[end] + 1) end++;
    parts.push(i === end ? `${sorted[i] + 1}` : `${sorted[i] + 1}-${sorted[end] + 1}`);
    i = end + 1;
  }
  return parts.join(', ');
}

export async function extractPages(sourceDataUrl: string, spec: string): Promise<{ dataUrl: string; pages: number[] }> {
  const indices = parsePageRanges(spec, await pdfPageCount(sourceDataUrl));
  return { dataUrl: await pdfFromPages(sourceDataUrl, indices), pages: indices.map((i) => i + 1) };
}

export interface PdfPart {
  dataUrl: string;
  /** 1-based, inclusive, for naming the part and reporting it. */
  firstPage: number;
  lastPage: number;
}

/** One file per page named in "1, 3, 7", for picking pages off the strip.
 *  Where Extract collects those pages into one document, "3-4" here makes two. */
export async function splitPdfByPages(sourceDataUrl: string, spec: string): Promise<PdfPart[]> {
  const indices = parsePageRanges(spec, await pdfPageCount(sourceDataUrl));
  const parts: PdfPart[] = [];
  for (const index of indices) {
    parts.push({ dataUrl: await pdfFromPages(sourceDataUrl, [index]), firstPage: index + 1, lastPage: index + 1 });
  }
  return parts;
}

/** Cuts a document into consecutive chunks of `pagesPerFile` pages; the last
 *  chunk holds the remainder. */
export async function splitPdf(sourceDataUrl: string, pagesPerFile: number): Promise<PdfPart[]> {
  if (!Number.isInteger(pagesPerFile) || pagesPerFile < 1) throw new Error('Pages per file must be 1 or more.');
  const pageCount = await pdfPageCount(sourceDataUrl);
  const parts: PdfPart[] = [];
  for (let start = 0; start < pageCount; start += pagesPerFile) {
    const end = Math.min(start + pagesPerFile, pageCount);
    const indices = Array.from({ length: end - start }, (_, i) => start + i);
    parts.push({ dataUrl: await pdfFromPages(sourceDataUrl, indices), firstPage: start + 1, lastPage: end });
  }
  return parts;
}

/** Renders each page to a small PNG, one at a time, calling `onPage` as each
 *  finishes, so a long document fills in progressively. */
export async function renderPdfThumbnails(
  dataUrl: string,
  onPage: (index: number, pngDataUrl: string) => void,
  opts: { width?: number; maxPages?: number; signal?: { aborted: boolean } } = {},
): Promise<void> {
  const width = opts.width ?? 132;
  const pdfjs = await import('pdfjs-dist');
  pdfjs.GlobalWorkerOptions.workerSrc = new URL('pdfjs-dist/build/pdf.worker.min.mjs', import.meta.url).toString();
  const doc = await pdfjs.getDocument({ data: dataUrlToBytes(dataUrl) }).promise;
  const last = Math.min(doc.numPages, opts.maxPages ?? doc.numPages);
  for (let i = 1; i <= last; i++) {
    if (opts.signal?.aborted) return;
    const page = await doc.getPage(i);
    const base = page.getViewport({ scale: 1 });
    const viewport = page.getViewport({ scale: width / base.width });
    const canvas = document.createElement('canvas');
    canvas.width = Math.max(1, Math.round(viewport.width));
    canvas.height = Math.max(1, Math.round(viewport.height));
    const ctx = canvas.getContext('2d');
    if (!ctx) return;
    // A PDF page with no background of its own paints nothing, which reads as
    // a broken thumbnail against a dark panel.
    ctx.fillStyle = '#ffffff';
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    await page.render({ canvasContext: ctx, viewport }).promise;
    onPage(i - 1, canvas.toDataURL('image/png'));
  }
}

/** Bundles the parts into one zip, so you can save a split without clicking
 *  through every file. PDFs are already compressed, so entries go in stored. */
export async function zipPdfParts(files: { name: string; dataUrl: string }[]): Promise<string> {
  const { zipSync } = await import('fflate');
  const entries: Record<string, [Uint8Array, { level: 0 }]> = {};
  const used = new Set<string>();
  for (const file of files) {
    // Two ranges can produce the same name (a repeated page); a zip with
    // duplicate entries silently loses all but one.
    let name = file.name;
    for (let n = 2; used.has(name); n++) name = file.name.replace(/(\.pdf)?$/i, ` (${n})$1`);
    used.add(name);
    entries[name] = [dataUrlToBytes(file.dataUrl), { level: 0 }];
  }
  const zipped = zipSync(entries);
  let binary = '';
  for (let i = 0; i < zipped.length; i += 0x8000) binary += String.fromCharCode(...zipped.subarray(i, i + 0x8000));
  return `data:application/zip;base64,${btoa(binary)}`;
}
