export interface PlaygroundTable {
  headers: string[];
  rows: string[][];
}

/** Sample data the Read-spreadsheet node parses for real; stands in for a file
 *  picker, which doesn't exist yet (no fs-access bridge to the renderer). */
export const SAMPLE_EXPENSES_CSV = `Date,Category,Description,Amount
2024-01-03,Travel,Flight to Chicago,412.50
2024-01-09,Travel,Taxi,34.00
2024-01-14,Travel,Hotel - 2 nights,310.00
2024-01-18,Meals,Team lunch,58.20
2024-01-22,Office,Notebook + pens,14.75
2024-01-27,Meals,Client dinner,96.40
2024-02-02,Travel,Parking,22.00
2024-02-05,Office,Monitor stand,39.99`;

/** RFC 4180 parse: quoted fields, escaped quotes, commas/newlines inside quotes. */
export function parseCsv(text: string): PlaygroundTable {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = '';
  let inQuotes = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (inQuotes) {
      if (c === '"') {
        if (text[i + 1] === '"') {
          field += '"';
          i++;
        } else inQuotes = false;
      } else field += c;
    } else if (c === '"') {
      inQuotes = true;
    } else if (c === ',') {
      row.push(field);
      field = '';
    } else if (c === '\n' || c === '\r') {
      if (c === '\r' && text[i + 1] === '\n') i++;
      row.push(field);
      rows.push(row);
      row = [];
      field = '';
    } else field += c;
  }
  if (field.length > 0 || row.length > 0) {
    row.push(field);
    rows.push(row);
  }
  const [headers, ...body] = rows;
  return { headers: headers ?? [], rows: body };
}

/** Real file, not the sample: .csv/.txt parse directly, .xlsx/.xls go through
 *  the `xlsx` package (already a dependency, used for export), first sheet only. */
export async function parseSpreadsheetFile(fileName: string, dataUrl: string): Promise<PlaygroundTable> {
  if (/\.xlsx?$/i.test(fileName)) {
    const XLSX = await import('xlsx');
    const base64 = dataUrl.slice(dataUrl.indexOf(',') + 1);
    const workbook = XLSX.read(base64, { type: 'base64' });
    const sheet = workbook.Sheets[workbook.SheetNames[0] ?? ''];
    const rows: string[][] = sheet
      ? XLSX.utils.sheet_to_json(sheet, { header: 1, blankrows: false, raw: false })
      : [];
    const [headers, ...body] = rows;
    return { headers: headers ?? [], rows: body };
  }
  const comma = dataUrl.indexOf(',');
  const base64 = comma >= 0 ? dataUrl.slice(comma + 1) : dataUrl;
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return parseCsv(new TextDecoder('utf-8').decode(bytes));
}

/** Case-insensitive: a user typing the column name shouldn't have to match
 *  the source file's exact capitalization. */
export function findColumnIndex(headers: string[], column: string): number {
  const needle = column.trim().toLowerCase();
  return headers.findIndex((h) => h.trim().toLowerCase() === needle);
}

export function filterTable(
  table: PlaygroundTable,
  column: string,
  value: string,
): PlaygroundTable {
  const colIndex = findColumnIndex(table.headers, column);
  if (colIndex === -1) return { headers: table.headers, rows: [] };
  const needle = value.trim().toLowerCase();
  const rows = needle
    ? table.rows.filter((r) => (r[colIndex] ?? '').trim().toLowerCase() === needle)
    : table.rows;
  return { headers: table.headers, rows };
}

// Mirrors the condition operators n8n/IFTTT expose for a single field: equality,
// substring, numeric comparison, and a type check for messy real-world columns.
export const IF_OPERATORS = [
  'equals',
  'does not equal',
  'contains',
  'does not contain',
  'greater than',
  'less than',
  'greater than or equal',
  'less than or equal',
  'is a number',
  'is a date',
  'is text',
] as const;
export type IfOperator = (typeof IF_OPERATORS)[number];
// Unary operators test the cell alone; the rest compare it against a value,
// so the If node's config popup hides the value field for these.
export const IF_UNARY_OPERATORS: readonly string[] = ['is a number', 'is a date', 'is text'];

/** Also used directly on a plain string by the If node, when what's connected
 *  in isn't a table at all (e.g. an AI agent's reply text). */
export function matchesCondition(cell: string, operator: string, value: string): boolean {
  const c = cell.trim();
  const v = value.trim();
  switch (operator as IfOperator) {
    case 'equals':
      return c.toLowerCase() === v.toLowerCase();
    case 'does not equal':
      return c.toLowerCase() !== v.toLowerCase();
    case 'contains':
      return c.toLowerCase().includes(v.toLowerCase());
    case 'does not contain':
      return !c.toLowerCase().includes(v.toLowerCase());
    case 'greater than':
    case 'less than':
    case 'greater than or equal':
    case 'less than or equal': {
      const cellNum = Number(c);
      const valNum = Number(v);
      if (c === '' || Number.isNaN(cellNum) || Number.isNaN(valNum)) return false;
      if (operator === 'greater than') return cellNum > valNum;
      if (operator === 'less than') return cellNum < valNum;
      if (operator === 'greater than or equal') return cellNum >= valNum;
      return cellNum <= valNum;
    }
    case 'is a number':
      return c !== '' && !Number.isNaN(Number(c));
    case 'is a date':
      return c !== '' && Number.isNaN(Number(c)) && !Number.isNaN(Date.parse(c));
    case 'is text':
      return c !== '' && Number.isNaN(Number(c)) && Number.isNaN(Date.parse(c));
    default:
      return false;
  }
}

/** Splits into both branches for the If node, by whichever operator the user picked. */
export function splitTable(
  table: PlaygroundTable,
  column: string,
  operator: string,
  value: string,
): { yes: PlaygroundTable; no: PlaygroundTable } {
  const colIndex = findColumnIndex(table.headers, column);
  const matches = (r: string[]) => colIndex !== -1 && matchesCondition(r[colIndex] ?? '', operator, value);
  return {
    yes: { headers: table.headers, rows: table.rows.filter(matches) },
    no: { headers: table.headers, rows: table.rows.filter((r) => !matches(r)) },
  };
}

/** Same operators as splitTable, per line of plain text instead of per table row:
 *  an AI reply is usually a list, and "contains X" should filter to the matching
 *  items, not pass the whole reply through because X appears somewhere in it. */
export function splitLines(text: string, operator: string, value: string): { yes: string[]; no: string[] } {
  const lines = text
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => l.length > 0);
  return {
    yes: lines.filter((l) => matchesCondition(l, operator, value)),
    no: lines.filter((l) => !matchesCondition(l, operator, value)),
  };
}

export function rowToMarkdown(headers: string[], row: string[]): string {
  return headers.map((h, i) => `**${h}**: ${row[i] ?? ''}`).join(', ');
}

export function tableToMarkdown({ headers, rows }: PlaygroundTable): string {
  if (rows.length === 0) return '_No rows._';
  const head = `| ${headers.join(' | ')} |`;
  const sep = `| ${headers.map(() => '---').join(' | ')} |`;
  const body = rows.map((r) => `| ${r.join(' | ')} |`).join('\n');
  return [head, sep, body].join('\n');
}
