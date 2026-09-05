/** A `type: 'file'` field's value is always this JSON-encoded, whether the
 *  field picks one file (a single object) or several (an array of these). */
export interface PickedFile {
  name: string;
  dataUrl: string;
}

export function readFileAsDataUrl(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result));
    reader.onerror = () => reject(reader.error);
    reader.readAsDataURL(file);
  });
}

// Past this, upscaling only bloats the payload past the OCR bridge's 25MB cap.
const MAX_UPSCALE_DIMENSION = 2200;

/** Redraws an image through a canvas, scaled by up to `factor`x and capped at
 *  `MAX_UPSCALE_DIMENSION` either way. Always re-encoding as JPEG (even at
 *  1x) is what matters for a `.jpeg`-named WebP: the SDK's vision models only
 *  decode JPEG/PNG/BMP, and this normalizes any browser-decodable format. */
export function normalizeImageForModel(dataUrl: string, factor = 2): Promise<string> {
  return new Promise((resolve, reject) => {
    const img = new window.Image();
    img.onload = () => {
      const longSide = Math.max(img.naturalWidth, img.naturalHeight);
      const scale = Math.min(factor, MAX_UPSCALE_DIMENSION / longSide);
      const canvas = document.createElement('canvas');
      canvas.width = Math.max(1, Math.round(img.naturalWidth * scale));
      canvas.height = Math.max(1, Math.round(img.naturalHeight * scale));
      const ctx = canvas.getContext('2d');
      if (!ctx) {
        reject(new Error('Could not prepare the image.'));
        return;
      }
      ctx.imageSmoothingEnabled = true;
      ctx.imageSmoothingQuality = 'high';
      ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
      resolve(canvas.toDataURL('image/jpeg', 0.92));
    };
    img.onerror = () => reject(new Error('Could not load the image.'));
    img.src = dataUrl;
  });
}

/** Parses a `type: 'file'` field's stored value back into one or more picked
 *  files, regardless of whether it was a single- or multiple-file field. */
export function parsePickedFiles(raw: string | undefined): PickedFile[] {
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed : [parsed];
  } catch {
    return [];
  }
}

function dataUrlToBytes(dataUrl: string): Uint8Array {
  const comma = dataUrl.indexOf(',');
  const base64 = comma >= 0 ? dataUrl.slice(comma + 1) : dataUrl;
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

/** Decodes a data: URL's payload as UTF-8 text (not `atob` alone, which
 *  returns Latin1 and mangles anything outside ASCII). */
export function dataUrlToText(dataUrl: string): string {
  return new TextDecoder('utf-8').decode(dataUrlToBytes(dataUrl));
}

/** pdf.js's positioned runs carry no inherent spacing, so joining them on
 *  every boundary leaves a space before punctuation ("It ' s ."). Some PDFs
 *  encode an apostrophe as U+2019 or U+02BC rather than the ASCII "'". */
function tightenPunctuationSpacing(text: string): string {
  return text
    .replace(/[ \t]+([,.!?;:)\]])/g, '$1')
    .replace(/([(\[])[ \t]+/g, '$1')
    .replace(/[ \t]*(['’ʼ])[ \t]*/g, '$1');
}

function median(nums: number[]): number {
  if (nums.length === 0) return 0;
  const sorted = [...nums].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0 ? (sorted[mid - 1] + sorted[mid]) / 2 : sorted[mid];
}

interface PdfRun {
  str: string;
  transform: number[];
  width: number;
  height: number;
}

/** Joins a line's runs by their real horizontal gap: pdf.js splits
 *  "soundcloud.com" into adjacent runs the same way it splits "quantum
 *  field" apart, so a blanket space between every run mangled every URL. */
function joinRunsByGap(items: PdfRun[]): string {
  let text = '';
  let prevRight: number | null = null;
  let prevHeight = 0;
  for (const item of items) {
    if (prevRight !== null && item.transform[4] - prevRight > Math.max(1, prevHeight * 0.2)) text += ' ';
    text += item.str;
    prevRight = item.transform[4] + item.width;
    prevHeight = item.height || prevHeight;
  }
  return text;
}

async function extractPdfText(dataUrl: string): Promise<string> {
  const pdfjs = await import('pdfjs-dist');
  pdfjs.GlobalWorkerOptions.workerSrc = new URL(
    'pdfjs-dist/build/pdf.worker.min.mjs',
    import.meta.url,
  ).toString();
  const doc = await pdfjs.getDocument({ data: dataUrlToBytes(dataUrl) }).promise;
  const pages: string[] = [];
  for (let i = 1; i <= doc.numPages; i++) {
    const page = await doc.getPage(i);
    const content = await page.getTextContent();
    const pageHeight = page.view[3] - page.view[1];

    // Group runs into visual lines. `hasEOL` marks a line's last run, but
    // some generators (seen on a real footer: a title run at the left margin
    // and a page number run at the right, both `hasEOL: false`) never set it
    // at all, which would otherwise fuse a whole page's body text and its
    // footer into one "line" the margin filter below never gets a chance to
    // see. A real jump in baseline Y is the more reliable signal.
    const lines: { runs: PdfRun[]; y: number; rightEdge: number }[] = [];
    let current: PdfRun[] = [];
    let currentY: number | null = null;
    const flushLine = () => {
      if (current.length === 0) return;
      const last = current[current.length - 1];
      lines.push({ runs: current, y: current[0].transform[5], rightEdge: last.transform[4] + last.width });
      current = [];
    };
    for (const item of content.items) {
      // A real line's own `hasEOL` sometimes lands on a separate, empty-text
      // marker item instead of the line's last real run (seen right at the
      // start of the next line, same Y as its real content, zero width).
      // Included as real content it reads as a one-word line of its own and
      // forces a paragraph break after almost every line. It carries no text
      // either way, so it's dropped outright rather than specially handled.
      if (!('str' in item) || item.str.length === 0) continue;
      const y = item.transform[5];
      if (currentY !== null && Math.abs(y - currentY) > 2) flushLine();
      current.push({ str: item.str, transform: item.transform, width: item.width, height: item.height });
      currentY = y;
      if (item.hasEOL) {
        flushLine();
        currentY = null;
      }
    }
    flushLine();

    // A running header/footer lives in the page's outer margin and is short;
    // real body text is never both at once.
    const bodyLines = lines.filter((line) => {
      const inMargin = line.y < pageHeight * 0.08 || line.y > pageHeight * 0.92;
      return !(inMargin && line.runs.length <= 8);
    });

    // `hasEOL` fires at every wrapped line, not just a paragraph's end; a
    // line ending well short of the page's typical (median) width is the
    // real paragraph boundary.
    const fullLineWidth = median(bodyLines.map((l) => l.rightEdge));
    let text = '';
    for (const line of bodyLines) {
      const isParagraphEnd = fullLineWidth > 0 && line.rightEdge < fullLineWidth * 0.8;
      text += `${joinRunsByGap(line.runs)}${isParagraphEnd ? '\n\n' : ' '}`;
    }
    pages.push(tightenPunctuationSpacing(text.replace(/[ \t]{2,}/g, ' ')));
  }
  return pages.join('\n\n');
}

async function extractDocxText(dataUrl: string): Promise<string> {
  const mammoth = await import('mammoth');
  const { value } = await mammoth.extractRawText({ arrayBuffer: dataUrlToBytes(dataUrl).buffer as ArrayBuffer });
  return value;
}

async function extractSpreadsheetAsText(fileName: string, dataUrl: string): Promise<string> {
  const { parseSpreadsheetFile, tableToMarkdown } = await import('./playground-table.js');
  return tableToMarkdown(await parseSpreadsheetFile(fileName, dataUrl));
}

/** Reads a picked document as plain text: real extraction for PDF/Word, a
 *  markdown table for a spreadsheet, a straight decode for anything already text. */
export async function extractDocumentText(fileName: string, dataUrl: string): Promise<string> {
  if (/\.pdf$/i.test(fileName)) return extractPdfText(dataUrl);
  if (/\.docx$/i.test(fileName)) return extractDocxText(dataUrl);
  if (/\.xlsx?$/i.test(fileName)) return extractSpreadsheetAsText(fileName, dataUrl);
  return dataUrlToText(dataUrl);
}
