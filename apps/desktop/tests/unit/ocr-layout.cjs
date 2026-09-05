'use strict';

const test = require('brittle');
const { layoutOcrBlocks } = require('../../electron/ocr.cjs');

function block(text, x0, y0, x1, y1) {
  return { text, bbox: [x0, y0, x1, y1] };
}

test('ocr-layout - blocks on one visual line join left to right', (t) => {
  const text = layoutOcrBlocks([
    block('World', 200, 100, 300, 140),
    block('Hello', 50, 100, 150, 140),
  ]);
  t.is(text, 'Hello World');
});

test('ocr-layout - out-of-order detection is put back into reading order', (t) => {
  const text = layoutOcrBlocks([
    block('Second line', 50, 200, 300, 240),
    block('First line', 50, 100, 300, 140),
  ]);
  t.is(text, 'First line\nSecond line');
});

test('ocr-layout - a wide gap becomes a blank line, a normal one does not', (t) => {
  // Several ordinary line-to-line gaps (10px) establish what "normal" is on
  // this page, so the one 400px gap reads as an actual section break.
  const text = layoutOcrBlocks([
    block('Line one', 50, 100, 200, 140),
    block('Line two', 50, 150, 200, 190),
    block('Line three', 50, 200, 200, 240),
    block('After a big gap', 50, 640, 300, 680),
  ]);
  t.is(text, 'Line one\nLine two\nLine three\n\nAfter a big gap');
});

test('ocr-layout - a real receipt row: item, mid-sentence noise, price columns render as a table row', (t) => {
  // From an actual OCR pass over a service invoice: the label, a duplicate
  // detection, the description's first wrapped line, and the rate/amount
  // share one visual row but sit far enough apart to be four real columns.
  const text = layoutOcrBlocks([
    block('labor/', 400, 1905, 510, 1949),
    block('laborl', 1140, 1899, 1247, 1943),
    block('diag', 1241, 1892, 1333, 1954),
    block('misfire clutch noise. motor was not', 1329, 1896, 1902, 1940),
    block('running on', 1898, 1892, 2086, 1941),
    block('100.00', 2331, 1886, 2447, 1927),
    block('600.00', 2665, 1880, 2781, 1924),
  ]);
  t.is(text, '| labor/ | laborl diag misfire clutch noise. motor was not running on | 100.00 | 600.00 |');
});

test('ocr-layout - falls back to detection order when no block has a bbox', (t) => {
  const text = layoutOcrBlocks([{ text: 'first' }, { text: 'second' }]);
  t.is(text, 'first\nsecond');
});

test('ocr-layout - a wrapped sentence spanning several lines reads as one paragraph', (t) => {
  // Three consecutive lines of the same wrapped sentence, none ending in
  // sentence-final punctuation, should join with spaces, not stay as lines.
  const text = layoutOcrBlocks([
    block('cylinder #1 failed computer test on injector #4? removed', 1140, 1942, 1714, 2000),
    block('air box to inspect injectors and spark plug on cylnder', 1142, 1989, 1651, 2044),
    block('customer did not want repairs done at this time and', 1143, 2135, 1514, 2179),
    block('requested to reassemble all parts and body panels.', 1140, 2176, 1683, 2238),
  ]);
  t.is(
    text,
    'cylinder #1 failed computer test on injector #4? removed air box to inspect injectors and spark plug on cylnder customer did not want repairs done at this time and requested to reassemble all parts and body panels.',
  );
});

test('ocr-layout - a total/tax/balance label bleeding into unrelated prose renders as its own table row', (t) => {
  // A totals box beside a legal paragraph can land a label and unrelated
  // prose on one detected line; the label must come out as its own table
  // row, set off from the prose on both sides.
  const text = layoutOcrBlocks([
    block('hereby authorize the repair work', 439, 3101, 987, 3161),
    block('herein set forth to be done along', 984, 3079, 1526, 3145),
    block('with the necessary', 1524, 3083, 1826, 3127),
    block('Sales Tax (7.75%)', 1995, 3085, 2468, 3151),
    block('82.41', 2683, 3102, 2778, 3146),
    block('materials and agree that you are', 421, 3155, 948, 3206),
  ]);
  t.is(
    text,
    'hereby authorize the repair work herein set forth to be done along with the necessary\n\n| Sales Tax (7.75%) | 82.41 |\n\nmaterials and agree that you are',
  );
});

test('ocr-layout - a label glued to prose with too small a gap to be its own column still splits off', (t) => {
  // Same idea as above, but the label's box is close enough to the prose
  // before it (under TABULAR_GAP) to land in the same column; the label
  // itself is still the more reliable signal, so it must still split off.
  const text = layoutOcrBlocks([
    block('with the necessary Total', 1524, 3083, 1900, 3127),
    block('638.46', 2200, 3085, 2300, 3127),
  ]);
  t.is(text, 'with the necessary\n\n| Total | 638.46 |');
});

test('ocr-layout - a period starts a new paragraph even without a wide gap', (t) => {
  const text = layoutOcrBlocks([
    block('requested to reassemble all parts and body panels.', 1140, 2176, 1683, 2238),
    block('environmental fee', 1145, 2226, 1446, 2278),
  ]);
  t.is(text, 'requested to reassemble all parts and body panels.\n\nenvironmental fee');
});

test('ocr-layout - a semicolon does not break a real sentence in two', (t) => {
  // A misread comma often becomes a semicolon; ";" still shows up mid-sentence
  // constantly in real OCR text, so it must not force a paragraph break.
  const text = layoutOcrBlocks([
    block('bent exhaust valve possibly from metal parts from airbox;', 1142, 2084, 2078, 2137),
    block('customer did not want repairs done at this time and', 1143, 2135, 1514, 2179),
  ]);
  t.is(
    text,
    'bent exhaust valve possibly from metal parts from airbox; customer did not want repairs done at this time and',
  );
});

test('ocr-layout - a continuation line starting with a digit still joins the sentence', (t) => {
  // "1&4." reads like a new field (starts with a digit) but is really mid-
  // sentence; only a table row's own wide internal gap should block a join,
  // which this single-block line doesn't have.
  const text = layoutOcrBlocks([
    block('air box to inspect injectors and spark plug on cylnder', 1142, 1989, 1651, 2044),
    block('1&4. discovered metel parts in air box, cylinder #1 has', 1146, 2041, 2039, 2090),
  ]);
  t.is(
    text,
    'air box to inspect injectors and spark plug on cylnder 1&4. discovered metel parts in air box, cylinder #1 has',
  );
});

test('ocr-layout - a shorter table row still lines up under the full row above it', (t) => {
  // Row two has no price fields at all (blank cells on the real form, not
  // a detection miss); it should still land under row one, id under id,
  // not read as a two-column row sharing a table with a four-column one.
  const text = layoutOcrBlocks([
    block('11427721779', 406, 2290, 645, 2334),
    block('oil filter', 1146, 2290, 1288, 2334),
    block('28.50', 2350, 2290, 2450, 2334),
    block('28.SOT', 2683, 2290, 2803, 2334),
    block('07119963252', 401, 2450, 647, 2494),
    block('crush washer', 1145, 2450, 1371, 2494),
  ]);
  t.is(text, '| 11427721779 | oil filter | 28.50 | 28.SOT |\n| 07119963252 | crush washer |  |  |');
});

test('ocr-layout - a header row too tight to split on its own borrows the row below it', (t) => {
  // From a real receipt: "QTY"-"Description" is 8px and "Unit Price"-"Amount"
  // is 54px, both under this page's own threshold, while the row below
  // splits into three real columns. The header must match that.
  const text = layoutOcrBlocks([
    block('QTY', 90, 616, 135, 637),
    block('Description', 143, 616, 270, 641),
    block('Unit Price', 775, 616, 880, 637),
    block('Amount', 934, 617, 1020, 637),
    block('Custom product/service A', 143, 663, 391, 692),
    block('45.00', 823, 667, 880, 687),
    block('$90.00', 952, 664, 1026, 689),
  ]);
  t.is(text, '| QTY Description | Unit Price | Amount |\n| Custom product/service A | 45.00 | $90.00 |');
});

test('ocr-layout - a Subtotal/Total row always puts its value in the last column', (t) => {
  // A Subtotal label sits well left of where a real field row's rate column
  // starts, so matching it to the nearest column by position would land it
  // under Unit Price instead of Amount; a label row always spans first
  // column to last instead, regardless of where its own text happens to sit.
  const text = layoutOcrBlocks([
    block('Custom product/service A', 143, 663, 391, 692),
    block('45.00', 823, 667, 880, 687),
    block('$90.00', 952, 664, 1026, 689),
    block('Subtotal', 599, 867, 681, 887),
    block('$240.00', 941, 865, 1026, 889),
  ]);
  t.is(text, '| Custom product/service A | 45.00 | $90.00 |\n| Subtotal |  | $240.00 |');
});

test('ocr-layout - a quantity glued to the item name it counts splits off', (t) => {
  // OCR detects "2 Custom product/service A" as one block with no gap at
  // all between the digit and the name; only reading the text (a short
  // digit run right before a capital letter) finds that boundary.
  const text = layoutOcrBlocks([
    block('2 Custom product/service A', 143, 663, 391, 692),
    block('45.00', 823, 667, 880, 687),
    block('$90.00', 952, 664, 1026, 689),
  ]);
  t.is(text, '| 2 | Custom product/service A | 45.00 | $90.00 |');
});

test('ocr-layout - a street number never splits off as if it were a quantity', (t) => {
  // "1234 Company St," matches the same shape (digits, then a capital
  // letter) as a real quantity does; capped at two digits so an address or
  // a year is never mistaken for one, since a real quantity in this context
  // is realistically 1-2 digits.
  const text = layoutOcrBlocks([
    block('1234 Company St,', 72, 147, 255, 172),
    block('Upload Logo', 756, 141, 927, 164),
  ]);
  t.is(text, '| 1234 Company St, | Upload Logo |');
});

test('ocr-layout - a numbered list item never renders as a two-column table', (t) => {
  // From a real form: "1" (OCR drops the period) sits a real column-gap
  // away from the item text, same shape as a quantity glued to a short
  // name. Length tells them apart: this text runs a whole sentence.
  const text = layoutOcrBlocks([
    block('1', 136, 814, 155, 855),
    block('If you were in hospital at the time of', 245, 822, 793, 855),
    block('service; the Medicare AND private Health', 789, 824, 1359, 855),
    block('Insurance refund', 1356, 825, 1575, 855),
  ]);
  t.is(text, '1 If you were in hospital at the time of service; the Medicare AND private Health Insurance refund');
});

test('ocr-layout - a numbered list item never glues onto the heading above it', (t) => {
  // Real coordinates: "1" sits only 84px from the item text, under this
  // page's own ~86px column threshold, so it never splits into 2 columns at
  // all; it still must not read as a mid-sentence continuation of the
  // heading above it just because it starts with a digit.
  const text = layoutOcrBlocks([
    block('Health Care Card Holders Only :', 662, 740, 1213, 790),
    block('1', 136, 802, 155, 826),
    block('If you were in hospital at the time of', 239, 800, 737, 844),
    block('service; the Medicare AND private Health', 734, 802, 1308, 845),
    block('Insurance refund', 1308, 808, 1555, 841),
  ]);
  t.is(
    text,
    'Health Care Card Holders Only :\n1 If you were in hospital at the time of service; the Medicare AND private Health Insurance refund',
  );
});
