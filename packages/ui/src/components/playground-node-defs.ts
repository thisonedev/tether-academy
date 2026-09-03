import {
  filterTable,
  IF_OPERATORS,
  IF_UNARY_OPERATORS,
  parseCsv,
  rowToMarkdown,
  SAMPLE_EXPENSES_CSV,
  splitLines,
  splitTable,
  tableToMarkdown,
} from './playground-table.js';
import type { PlaygroundCategory, PlaygroundDataType, PlaygroundNodeKindDef } from './playground-types.js';

// Bounds real per-row model calls until there's hardware-aware concurrency in the engine.
const MAX_ITERATE_ROWS = 5;

// Shared with the wire color a port's edges render in (see playground.tsx), so a
// port and everything plugged into it read as the same color, not just the endpoint.
export const PORT_COLOR: Record<PlaygroundDataType, string> = {
  table: '#6ea8fe',
  value: '#5eead4',
  bool: '#ff8fa3',
  flow: '#9aa4af',
  any: '#c9a5f8',
};

// A branch's color says "which path," not "what data type" (see branchPortStyle).
export const BRANCH_COLOR = { true: '#34d399', false: '#fb7185' } as const;

// One color per chakra, root to crown: trigger/data/logic ground and shape the
// run, ai-text/ai-voice/ai-media map to heart/throat/third-eye by what they
// actually do (understand, speak, see), interface is the crown's outward reach.
export const CATEGORY_CLASSES: Record<PlaygroundCategory, string> = {
  // red-300, not red-400: full-intensity red reads as an alarm/error color
  // elsewhere in the app, too harsh for a category that's just "this starts things."
  trigger: 'text-red-300 bg-red-300/15 border-red-300/40',
  data: 'text-orange-400 bg-orange-400/15 border-orange-400/40',
  logic: 'text-amber-400 bg-amber-400/15 border-amber-400/40',
  'ai-text': 'text-green-400 bg-green-400/15 border-green-400/40',
  'ai-voice': 'text-blue-400 bg-blue-400/15 border-blue-400/40',
  'ai-media': 'text-indigo-400 bg-indigo-400/15 border-indigo-400/40',
  interface: 'text-violet-400 bg-violet-400/15 border-violet-400/40',
};

function defaultsFrom(fields: PlaygroundNodeKindDef['fields']) {
  return () =>
    Object.fromEntries(
      fields.map((f) => [f.key, f.type === 'select' ? (f.options?.[0] ?? '') : '']),
    );
}

const readFileFields: PlaygroundNodeKindDef['fields'] = [
  { key: 'sheet', label: 'Sheet name', type: 'text' },
];
const filterFields: PlaygroundNodeKindDef['fields'] = [
  {
    key: 'column',
    label: 'Column',
    type: 'select',
    options: ['Date', 'Category', 'Description', 'Amount'],
  },
  { key: 'value', label: 'Equals', type: 'text' },
];
const agentFields: PlaygroundNodeKindDef['fields'] = [
  { key: 'task', label: 'Instructions: what should it do?', type: 'textarea' },
];
const ifFields: PlaygroundNodeKindDef['fields'] = [
  {
    key: 'column',
    label: 'Column',
    type: 'select',
    options: ['Date', 'Category', 'Description', 'Amount'],
    // Only meaningful when a real table is actually wired in; hidden otherwise
    // (including nothing connected yet) rather than shown-but-ignored.
    hiddenWhen: (_fields, inputKind) => inputKind !== 'table',
  },
  {
    key: 'operator',
    label: 'Condition',
    type: 'select',
    options: [...IF_OPERATORS],
  },
  {
    key: 'value',
    label: 'Value',
    type: 'text',
    hiddenWhen: (fields) => IF_UNARY_OPERATORS.includes(fields.operator),
  },
];
const iterateFields: PlaygroundNodeKindDef['fields'] = [
  { key: 'task', label: 'Ask the AI about each row', type: 'textarea' },
];
// Every target the SDK's Bergamot models actually support (the BERGAMOT_EN_<code>
// registry entries in @qvac/sdk), not a placeholder shortlist.
const BERGAMOT_EN_TARGETS = [
  'Arabic', 'Azerbaijani', 'Bulgarian', 'Bengali', 'Bosnian', 'Catalan', 'Czech', 'Danish',
  'German', 'Greek', 'Spanish', 'Estonian', 'Persian', 'Finnish', 'French', 'Gujarati',
  'Hebrew', 'Hindi', 'Croatian', 'Hungarian', 'Indonesian', 'Icelandic', 'Italian', 'Japanese',
  'Kannada', 'Korean', 'Lithuanian', 'Latvian', 'Malayalam', 'Malay', 'Norwegian Bokmål', 'Dutch',
  'Norwegian', 'Polish', 'Portuguese', 'Romanian', 'Russian', 'Slovak', 'Slovenian', 'Albanian',
  'Serbian', 'Swedish', 'Tamil', 'Telugu', 'Thai', 'Turkish', 'Ukrainian', 'Vietnamese', 'Chinese',
];
// Shared by every node with a "content" field a wire could also feed: the user
// picks explicitly rather than a connection silently overriding what they typed.
const INPUT_SOURCE_OPTIONS = ['Custom text', 'Previous result'];
const usesCustomText = (fields: Record<string, string>) => fields.source !== 'Previous result';

const translateFields: PlaygroundNodeKindDef['fields'] = [
  { key: 'source', label: 'Text source', type: 'select', options: INPUT_SOURCE_OPTIONS },
  {
    key: 'text',
    label: 'Text to translate',
    type: 'textarea',
    hiddenWhen: (fields) => !usesCustomText(fields),
  },
  {
    key: 'language',
    label: 'Target language',
    type: 'select',
    options: BERGAMOT_EN_TARGETS,
  },
];
const askDocFields: PlaygroundNodeKindDef['fields'] = [
  { key: 'source', label: 'Document source', type: 'select', options: INPUT_SOURCE_OPTIONS },
  {
    key: 'document',
    label: 'Source text',
    type: 'textarea',
    hiddenWhen: (fields) => !usesCustomText(fields),
  },
  { key: 'question', label: 'Question', type: 'text' },
];

/** One deterministic source, one deterministic transform, one AI-backed node. Every other
 *  node kind follows this exact shape, so adding one never touches the canvas or engine. */
export const PLAYGROUND_NODE_DEFS: Record<string, PlaygroundNodeKindDef> = {
  start: {
    kind: 'start',
    label: 'Start a workflow',
    category: 'trigger',
    input: null,
    output: 'flow',
    fields: [],
    defaultFields: () => ({}),
  },
  'read-file': {
    kind: 'read-file',
    label: 'Read spreadsheet',
    category: 'data',
    input: 'flow',
    output: 'table',
    fields: readFileFields,
    defaultFields: defaultsFrom(readFileFields),
    async run(ctx) {
      const table = parseCsv(SAMPLE_EXPENSES_CSV);
      ctx.setOutput(table);
      const sheet = ctx.fields.sheet || 'Expenses';
      ctx.pushResult(`**${sheet}** — ${table.rows.length} rows\n\n${tableToMarkdown(table)}`);
    },
  },
  filter: {
    kind: 'filter',
    label: 'Filter rows',
    category: 'logic',
    input: 'table',
    output: 'table',
    fields: filterFields,
    defaultFields: defaultsFrom(filterFields),
    async run(ctx) {
      const input = ctx.readInput();
      if (!input || typeof input === 'string') {
        ctx.pushRunLine('err', 'No table connected in.');
        return;
      }
      const filtered = filterTable(input, ctx.fields.column ?? '', ctx.fields.value ?? '');
      ctx.setOutput(filtered);
      ctx.pushResult(`${filtered.rows.length} of ${input.rows.length} rows match\n\n${tableToMarkdown(filtered)}`);
    },
  },
  'ai-agent': {
    kind: 'ai-agent',
    label: 'Ask an AI agent',
    category: 'ai-text',
    input: 'table',
    // Always a reply string at runtime, table input or not: declaring 'table' here
    // let this connect into Filter/Iterate even though it can never feed them real rows.
    output: 'value',
    fields: agentFields,
    defaultFields: defaultsFrom(agentFields),
    async run(ctx) {
      const upstream = ctx.readInput();
      const task = ctx.fields.task ?? '';
      const prompt =
        typeof upstream === 'string'
          ? `${task}\n\nInput: ${upstream}`
          : upstream
            ? `${task}\n\nData:\n${tableToMarkdown(upstream)}`
            : task;
      ctx.setOutput(await ctx.runAgent(prompt));
    },
  },
  if: {
    kind: 'if',
    label: 'If',
    category: 'logic',
    // Accepts a table (splits rows by column) or plain text (tests the whole
    // string), whichever is actually wired in; see `run` for the branch.
    input: 'any',
    output: 'any',
    dualOutput: true,
    fields: ifFields,
    defaultFields: defaultsFrom(ifFields),
    async run(ctx) {
      const input = ctx.readInput();
      if (input === undefined) {
        ctx.pushRunLine('err', 'Nothing connected in.');
        return;
      }
      const operator = ctx.fields.operator ?? 'equals';
      const value = ctx.fields.value ?? '';
      if (typeof input === 'string') {
        const { yes, no } = splitLines(input, operator, value);
        ctx.setOutput(yes.join('\n'), 'true');
        ctx.setOutput(no.join('\n'), 'false');
        ctx.pushResult(`${yes.length} of ${yes.length + no.length} item(s) matched the condition.`);
        return;
      }
      const { yes, no } = splitTable(input, ctx.fields.column ?? '', operator, value);
      ctx.setOutput(yes, 'true');
      ctx.setOutput(no, 'false');
      ctx.pushResult(`${yes.rows.length} row(s) yes, ${no.rows.length} row(s) no`);
    },
  },
  'iterate-ai': {
    kind: 'iterate-ai',
    label: 'Iterate',
    category: 'logic',
    input: 'table',
    output: 'table',
    fields: iterateFields,
    defaultFields: defaultsFrom(iterateFields),
    async run(ctx) {
      const input = ctx.readInput();
      if (!input || typeof input === 'string') {
        ctx.pushRunLine('err', 'No table connected in.');
        return;
      }
      const task = ctx.fields.task ?? '';
      const rows = input.rows.slice(0, MAX_ITERATE_ROWS);
      if (input.rows.length > MAX_ITERATE_ROWS) {
        ctx.pushRunLine('ok', `Capped to the first ${MAX_ITERATE_ROWS} of ${input.rows.length} rows.`);
      }
      for (const row of rows) {
        if (ctx.stopRequested()) break;
        await ctx.runAgent(`${task}\n\nRow: ${rowToMarkdown(input.headers, row)}`);
      }
    },
  },
  translate: {
    kind: 'translate',
    label: 'Translate',
    category: 'ai-text',
    // 'any': a flow trigger to just sequence it after Start, or real text from an
    // AI agent/If/etc. when "Previous result" is picked as the text source.
    input: 'any',
    output: 'value',
    fields: translateFields,
    defaultFields: defaultsFrom(translateFields),
    async run(ctx) {
      const text = ctx.resolveContent('text');
      if (text === undefined) {
        ctx.pushRunLine(
          'err',
          "Nothing to work with: the previous step produced no text, or nothing is connected.",
        );
        return;
      }
      const language = ctx.fields.language || 'Spanish';
      ctx.setOutput(await ctx.translate(text, language));
    },
  },
  'ask-doc': {
    kind: 'ask-doc',
    label: 'Ask about a document',
    category: 'ai-text',
    input: 'any', // same reasoning as Translate above
    output: 'value',
    fields: askDocFields,
    defaultFields: defaultsFrom(askDocFields),
    async run(ctx) {
      const document = ctx.resolveContent('document');
      if (document === undefined) {
        ctx.pushRunLine(
          'err',
          "Nothing to work with: the previous step produced no text, or nothing is connected.",
        );
        return;
      }
      const question = ctx.fields.question ?? '';
      ctx.setOutput(
        await ctx.runAgent(
          `Answer the question using only the text below. If the answer isn't in the text, say so.\n\nText:\n${document}\n\nQuestion: ${question}`,
        ),
      );
    },
  },
  // Inactive: placeholders so every chakra color actually shows up in the palette,
  // not real node kinds yet. No handler in the run loop, can't be dragged onto
  // the canvas (see PlaygroundPalette), and never claim otherwise.
  'text-to-speech': {
    kind: 'text-to-speech',
    label: 'Text to speech',
    category: 'ai-voice',
    input: 'any',
    output: 'value',
    fields: [],
    defaultFields: () => ({}),
    inactive: true,
  },
  'speech-to-text': {
    kind: 'speech-to-text',
    label: 'Speech to text',
    category: 'ai-voice',
    input: 'any',
    output: 'value',
    fields: [],
    defaultFields: () => ({}),
    inactive: true,
  },
  'generate-image': {
    kind: 'generate-image',
    label: 'Generate image',
    category: 'ai-media',
    input: 'any',
    output: 'value',
    fields: [],
    defaultFields: () => ({}),
    inactive: true,
  },
  'generate-video': {
    kind: 'generate-video',
    label: 'Generate video',
    category: 'ai-media',
    input: 'any',
    output: 'value',
    fields: [],
    defaultFields: () => ({}),
    inactive: true,
  },
  'generate-music': {
    kind: 'generate-music',
    label: 'Generate music',
    category: 'ai-media',
    input: 'any',
    output: 'value',
    fields: [],
    defaultFields: () => ({}),
    inactive: true,
  },
  ocr: {
    kind: 'ocr',
    label: 'Read text from image',
    category: 'ai-media',
    input: 'any',
    output: 'value',
    fields: [],
    defaultFields: () => ({}),
    inactive: true,
  },
  'classify-image': {
    kind: 'classify-image',
    label: 'Classify image',
    category: 'ai-media',
    input: 'any',
    output: 'value',
    fields: [],
    defaultFields: () => ({}),
    inactive: true,
  },
  'search-documents': {
    kind: 'search-documents',
    label: 'Search documents',
    category: 'ai-text',
    input: 'any',
    output: 'value',
    fields: [],
    defaultFields: () => ({}),
    inactive: true,
  },
  'ask-confirmation': {
    kind: 'ask-confirmation',
    label: 'Ask for confirmation',
    category: 'interface',
    input: 'any',
    output: 'bool',
    fields: [],
    defaultFields: () => ({}),
    inactive: true,
  },
};
