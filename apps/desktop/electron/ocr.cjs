'use strict';

// Real text-from-image via the SDK's ggml-ocr addon (doctr-based detector +
// recognizer, OCR_LATIN). image arrives from the renderer as a data URL;
// the SDK itself accepts a Buffer directly, no temp file needed.

const { createLazyModel } = require('./media-models.cjs');

const lazy = createLazyModel({
  label: 'ocr',
  registryKeys: ['OCR_LATIN'],
  buildLoadArgs: (sdk) => ({
    modelSrc: sdk.OCR_LATIN,
    // 1.5 is the addon's own default, so it changed nothing; 2.0 (top of the
    // documented range) and contrastRetry actually help small text like a
    // narrow quantity column.
    modelConfig: { langList: ['en'], magRatio: 2.0, contrastRetry: true },
  }),
});

function bufferFromDataUrl(dataUrl) {
  const comma = dataUrl.indexOf(',');
  const base64 = comma >= 0 ? dataUrl.slice(comma + 1) : dataUrl;
  return Buffer.from(base64, 'base64');
}

function median(nums) {
  if (nums.length === 0) return 0;
  const sorted = [...nums].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0 ? (sorted[mid - 1] + sorted[mid]) / 2 : sorted[mid];
}

// A total/tax/balance label starting a column. Checked against one column at
// a time (not the whole row) so the word showing up mid-sentence in ordinary
// prose ("...the total amount due...") never matches.
const FINANCIAL_LABEL_START_RE = /^(Subtotal|Sales Tax\s*\([^)]*\)|Sales Tax|Total|Balance Due|Grand Total|Amount Due)\b/;
const FINANCIAL_LABEL_RE = /\b(Subtotal|Sales Tax\s*\([^)]*\)|Sales Tax|Total|Balance Due|Grand Total|Amount Due)\b/;

const columnText = (group) => group.map((b) => b.text).join(' ');
const columnCenter = (group) => {
  const x0 = Math.min(...group.map((b) => b.bbox[0]));
  const x1 = Math.max(...group.map((b) => b.bbox[2]));
  return (x0 + x1) / 2;
};

/** Splits a column's blocks at a character index (matching `columnText`'s
 *  `join(' ')`). A match landing inside one block splits that block's own
 *  bbox by the same fraction as the character split. */
function splitColumnAtChar(group, charIndex) {
  let pos = 0;
  for (let i = 0; i < group.length; i++) {
    const block = group[i];
    const start = pos;
    const end = pos + block.text.length;
    if (charIndex === start) return [group.slice(0, i), group.slice(i)];
    if (charIndex > start && charIndex < end) {
      const within = charIndex - start;
      const splitX = block.bbox[0] + (block.bbox[2] - block.bbox[0]) * (within / block.text.length);
      const before = { ...block, text: block.text.slice(0, within).trim(), bbox: [block.bbox[0], block.bbox[1], splitX, block.bbox[3]] };
      const after = { ...block, text: block.text.slice(within).trim(), bbox: [splitX, block.bbox[1], block.bbox[2], block.bbox[3]] };
      return [
        [...group.slice(0, i), before],
        [after, ...group.slice(i + 1)],
      ];
    }
    pos = end + 1; // +1 for the space `columnText` joins with
  }
  return [group, []];
}

/** A totals box beside unrelated prose at the same height can land a label
 *  right after that prose with too small a gap to read as its own column;
 *  splits it off wherever the label itself starts. */
function explodeLabelWithinColumns(columns) {
  const exploded = [];
  for (const col of columns) {
    const match = FINANCIAL_LABEL_RE.exec(columnText(col));
    if (match && match.index > 0) {
      const [before, after] = splitColumnAtChar(col, match.index);
      if (before.length > 0) exploded.push(before);
      exploded.push(after.length > 0 ? after : col);
    } else {
      exploded.push(col);
    }
  }
  return exploded;
}

/** Splits a row wherever a total/tax/balance label starts a column, since a
 *  two-column layout can land it beside unrelated prose with no position-based
 *  way to tell them apart. The label piece is marked `isolated`. */
function splitFinancialLabelColumns(columns) {
  const exploded = explodeLabelWithinColumns(columns);
  const idx = exploded.findIndex((c) => FINANCIAL_LABEL_START_RE.test(columnText(c).trim()));
  if (idx === -1) return [{ columns: exploded, isolated: false }];
  const pieces = [];
  if (idx > 0) pieces.push({ columns: exploded.slice(0, idx), isolated: false });
  pieces.push({ columns: exploded.slice(idx), isolated: true });
  return pieces;
}

// A quantity glued to its item name ("2 Custom product/service A") is one
// OCR block with no gap to split on; a digit run before a capital letter is
// the only signal left. Capped at 2 digits so a street number never splits.
const LEADING_QUANTITY_RE = /^\d{1,2}\s+(?=[A-Z])/;

// A numbered list marker looks just like a glued quantity once OCR drops
// the period. Length tells them apart: a real item name runs a few words,
// a list item's own first line alone runs a whole sentence.
const LIST_MARKER_RE = /^[A-Za-z0-9]{1,2}[.):]?\s+(?=[A-Z])/;
const LIST_MARKER_TEXT_WORDS = 8;

/** A bare marker paired with a long run of prose is a list item, not a
 *  table row; rejoins it into one column so it wraps like real prose. */
function isListMarkerRow(columns) {
  // A wide enough gap splits marker from text into 2 real columns; too
  // narrow a gap (still under the same regex, still a real list item) leaves
  // them glued in column 0 alone. Either way it's the joined text that matters.
  if (columns.length > 2) return false;
  const text = columns.map(columnText).join(' ');
  const match = LIST_MARKER_RE.exec(text);
  if (!match) return false;
  return text.slice(match[0].length).trim().split(/\s+/).length > LIST_MARKER_TEXT_WORDS;
}

/** Splits a leading quantity off an item name, same reason as
 *  `explodeLabelWithinColumns`: no gap marks the boundary, only the text does. */
function explodeLeadingQuantity(columns) {
  const exploded = [];
  for (const col of columns) {
    const match = LEADING_QUANTITY_RE.exec(columnText(col));
    if (match) {
      const [before, after] = splitColumnAtChar(col, match[0].length);
      if (before.length > 0) exploded.push(before);
      exploded.push(after.length > 0 ? after : col);
    } else {
      exploded.push(col);
    }
  }
  return exploded;
}

/** An under-split row (fewer columns than its neighbors) is realigned onto
 *  the block's real column count: an isolated label spans first column to
 *  last, anything else re-buckets by nearest reference column center. */
function realignTableBlock(blockPieces, tabularGap) {
  const maxColumns = Math.max(...blockPieces.map((p) => p.columns.length));
  const reference =
    blockPieces.find((p) => !p.isolated && p.columns.length === maxColumns) ??
    blockPieces.find((p) => p.columns.length === maxColumns);
  if (!reference || maxColumns < 2) return;
  const refCenters = reference.columns.map(columnCenter);
  const refFirstX0 = Math.min(...reference.columns[0].map((b) => b.bbox[0]));
  for (const piece of blockPieces) {
    if (piece.columns.length >= maxColumns) continue;
    // Two unrelated small tables can stack with no prose between them. A row
    // that doesn't start near the reference's own first column is a
    // different table, not a short row of this one: leave it alone.
    if (!piece.isolated) {
      const pieceFirstX0 = Math.min(...piece.columns[0].map((b) => b.bbox[0]));
      if (Math.abs(pieceFirstX0 - refFirstX0) > tabularGap * 2) continue;
    }
    const buckets = Array.from({ length: maxColumns }, () => []);
    if (piece.isolated) {
      // Names a total, not this row's own field: label to first, value to last.
      buckets[0] = piece.columns[0];
      buckets[maxColumns - 1] = piece.columns[piece.columns.length - 1];
    } else {
      for (const block of piece.columns.flat()) {
        const center = (block.bbox[0] + block.bbox[2]) / 2;
        let best = 0;
        let bestDist = Number.POSITIVE_INFINITY;
        for (let i = 0; i < refCenters.length; i++) {
          const dist = Math.abs(center - refCenters[i]);
          if (dist < bestDist) {
            bestDist = dist;
            best = i;
          }
        }
        buckets[best].push(block);
      }
    }
    piece.columns = buckets;
  }
}

// Only . ! ? reliably end a sentence; ; and : both show up mid-sentence in
// real OCR text (a misread comma, a clause before "and"), so treating them
// as hard paragraph breaks split sentences that should stay joined.
const endsASentence = (text) => /[.!?]\s*$/.test(text);

// A real word or a mid-sentence reference ("1&4.", "#4?") continuing the
// previous line; a new field starts with a capital letter instead, but only
// when the row isn't already ruled a table row.
const startsLikeContinuation = (text) => /^[a-z0-9]/.test(text);

// A table row's fields sit far apart; a wrapped sentence's words sit close.
// A fixed pixel gap can't tell them apart since each image rescales
// differently before OCR; measured against the page's own median height instead.
const TABULAR_GAP_RATIO = 2;

/** Groups a line's blocks into columns: a new one starts wherever the gap
 *  clears `tabularGap`, so real table fields split apart while a wrapped
 *  sentence's tightly-packed words stay one column. */
function splitIntoColumns(lineBlocks, tabularGap) {
  const columns = [[lineBlocks[0]]];
  for (let i = 1; i < lineBlocks.length; i++) {
    const gap = lineBlocks[i].bbox[0] - lineBlocks[i - 1].bbox[2];
    if (gap > tabularGap) columns.push([]);
    columns[columns.length - 1].push(lineBlocks[i]);
  }
  return columns;
}

const escapeTableCell = (text) => text.replace(/\|/g, '\\|').trim();

/** A table row (2+ columns) renders as its own visual block, set off from
 *  surrounding prose, instead of blending into it as one more line of text. */
const tableRowLine = (columns) => `| ${columns.map((group) => escapeTableCell(columnText(group))).join(' | ')} |`;

/** Groups blocks into lines (detection order isn't reading order), joins a
 *  wrapped sentence with spaces, breaks paragraphs at a real sentence end or
 *  wide gap, and renders a real table row (2+ far-apart fields) as a table. */
function layoutOcrBlocks(blocks) {
  const withBbox = blocks.filter((b) => Array.isArray(b.bbox) && b.bbox.length === 4);
  if (withBbox.length === 0) return blocks.map((b) => b.text).join('\n');

  const medianHeight = median(withBbox.map((b) => b.bbox[3] - b.bbox[1]));
  const tolerance = medianHeight * 0.5;
  const tabularGap = medianHeight * TABULAR_GAP_RATIO;
  // Sorted first: matching against the nearest line by running-average
  // center is order-sensitive, and the raw detection order isn't top-to-bottom.
  const sorted = [...withBbox].sort((a, b) => a.bbox[1] + a.bbox[3] - (b.bbox[1] + b.bbox[3]));
  const lines = [];
  for (const block of sorted) {
    const yCenter = (block.bbox[1] + block.bbox[3]) / 2;
    let line = lines.find((l) => Math.abs(l.yCenter - yCenter) < tolerance);
    if (!line) {
      line = { yCenter, blocks: [] };
      lines.push(line);
    }
    line.blocks.push(block);
    line.yCenter = line.blocks.reduce((sum, b) => sum + (b.bbox[1] + b.bbox[3]) / 2, 0) / line.blocks.length;
  }

  const rows = lines
    .map((line) => {
      const lineBlocks = line.blocks.slice().sort((a, b) => a.bbox[0] - b.bbox[0]);
      return {
        columns: splitIntoColumns(lineBlocks, tabularGap),
        top: Math.min(...lineBlocks.map((b) => b.bbox[1])),
        bottom: Math.max(...lineBlocks.map((b) => b.bbox[3])),
      };
    })
    .sort((a, b) => a.top - b.top);

  const pieces = [];
  for (const row of rows) {
    // Only within an already-tabular row: a plain paragraph that happens to
    // open with a number ("2 Reasons this works...") is not a quantity column.
    const columns = row.columns.length > 1 ? explodeLeadingQuantity(row.columns) : row.columns;
    for (const piece of splitFinancialLabelColumns(columns)) {
      if (!piece.isolated && isListMarkerRow(piece.columns)) {
        // Starts with a digit, so it reads like a mid-sentence continuation
        // of whatever came before; it's a new item, not a continuation.
        pieces.push({
          columns: [piece.columns.flat()],
          isolated: false,
          blockIncomingJoin: true,
          top: row.top,
          bottom: row.bottom,
          tabular: false,
        });
        continue;
      }
      pieces.push({ ...piece, top: row.top, bottom: row.bottom, tabular: piece.columns.length > 1 });
    }
  }

  // A run of consecutive table rows is one visual table; realigning it as a
  // whole (not row by row) lets an under-split row borrow real column
  // positions from its neighbors instead of only its own.
  for (let i = 0; i < pieces.length; ) {
    if (!pieces[i].tabular) {
      i++;
      continue;
    }
    let j = i;
    while (j < pieces.length && pieces[j].tabular) j++;
    realignTableBlock(pieces.slice(i, j), tabularGap);
    i = j;
  }

  const gaps = pieces.slice(1).map((p, i) => p.top - pieces[i].bottom);
  const typicalGap = median(gaps.filter((g) => g > 0));
  const lineOf = (piece) => (piece.tabular ? tableRowLine(piece.columns) : columnText(piece.columns[0]));
  let text = lineOf(pieces[0]);
  for (let i = 1; i < pieces.length; i++) {
    const prev = pieces[i - 1];
    const curr = pieces[i];
    let separator;
    if (prev.tabular && curr.tabular) {
      // Adjacent table rows stay one visual block, no blank line between them.
      separator = '\n';
    } else if (prev.tabular || curr.tabular) {
      // Entering or leaving a table always breaks the paragraph around it,
      // so it reads as its own block instead of one more line of text.
      separator = '\n\n';
    } else {
      const prevText = columnText(prev.columns[0]);
      const currText = columnText(curr.columns[0]);
      const gap = curr.top - prev.bottom;
      const wideGap = typicalGap > 0 && gap > typicalGap * 2.5;
      const sentenceEnd = endsASentence(prevText) && currText.length > 3;
      if (wideGap || sentenceEnd) separator = '\n\n';
      else if (!prev.isolated && !curr.blockIncomingJoin && startsLikeContinuation(currText)) separator = ' ';
      else separator = '\n';
    }
    text += separator;
    text += lineOf(curr);
  }
  return text;
}

async function readTextFromImage(imageDataUrl) {
  const sdk = require('@qvac/sdk');
  const modelId = await lazy.ensureLoaded();
  // paragraph: false keeps each detected block separate instead of merging
  // nearby text, so a table's cells (like a lone quantity digit) don't get
  // absorbed into a neighboring block or dropped.
  const { blocks } = sdk.ocr({
    modelId,
    image: bufferFromDataUrl(imageDataUrl),
    options: { paragraph: false },
  });
  const result = await blocks;
  return layoutOcrBlocks(result);
}

module.exports = { readTextFromImage, layoutOcrBlocks, unload: lazy.unload };
