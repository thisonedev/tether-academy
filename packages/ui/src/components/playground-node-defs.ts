import { extractDocumentText, normalizeImageForModel, parsePickedFiles } from './playground-files.js';
import {
  filterTable,
  findColumnIndex,
  IF_OPERATORS,
  IF_UNARY_OPERATORS,
  parseSpreadsheetFile,
  rowToMarkdown,
  splitLines,
  splitTable,
  tableToMarkdown,
} from './playground-table.js';
import type { PlaygroundCategory, PlaygroundDataType, PlaygroundFieldDef, PlaygroundNodeKindDef } from './playground-types.js';

// Bounds real per-row model calls until there's hardware-aware concurrency in the engine.
const MAX_ITERATE_ROWS = 5;

// Same convention as the Randomize node's own list field: one per line, or
// comma-separated on a single line.
function splitIntoItems(text: string): string[] {
  return text
    .split(/\r?\n|,/)
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
}

// Must stay at or under academyTranslateSchema/chatMessageSchema's own caps
// in packages/validation/src/ipc.ts, or the IPC call rejects outright
// instead of running on a truncated document.
const TRANSLATE_TEXT_MAX = 20_000;
const AGENT_MESSAGE_MAX = 32_000;

function truncateForLimit(text: string, maxChars: number): { text: string; truncated: boolean } {
  if (text.length <= maxChars) return { text, truncated: false };
  return { text: text.slice(0, Math.max(0, maxChars)), truncated: true };
}

/** OCR's own `| cell | cell |` table rows are a display-only convention for
 *  the console (see ocr.cjs's `layoutOcrBlocks`); a downstream node (an AI
 *  agent, translate, ask-about-a-document) should see plain OCR text, not
 *  markdown table syntax it never asked for. */
function stripOcrTableMarkup(text: string): string {
  return text
    .split('\n')
    .map((line) => {
      const trimmed = line.trim();
      if (!trimmed.startsWith('|') || !trimmed.endsWith('|')) return line;
      return trimmed
        .slice(1, -1)
        .split(/(?<!\\)\|/)
        .map((cell) => cell.trim().replace(/\\\|/g, '|'))
        .join(' ');
    })
    .join('\n');
}

/** Truncates `body` (not `task`) to fit the two joined under `maxChars`, since
 *  the instructions are what makes the reply useful; the document is what's
 *  long enough to blow the cap. */
function buildAgentPrompt(task: string, body: string, maxChars: number): { text: string; truncated: boolean } {
  const separator = '\n\n';
  const { text: safeBody, truncated } = truncateForLimit(body, maxChars - task.length - separator.length);
  return { text: `${task}${separator}${safeBody}`, truncated };
}

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

// Shared by isValidConnection (a dragged wire) and the inline "+" on a wire
// (a node inserted into an existing one), so the two never disagree about
// what's allowed to plug into what.
export function typesCompatible(
  outType: PlaygroundDataType | null | undefined,
  inType: PlaygroundDataType | null | undefined,
): boolean {
  // 'flow' carries no data, so it fits any socket: a trigger just means "run this
  // next." 'any' accepts or forwards whichever type actually shows up.
  return outType != null && (outType === inType || outType === 'flow' || inType === 'any' || outType === 'any');
}

// One color per chakra, root to crown: trigger/data/logic ground and shape the
// run, ai-text/ai-voice/ai-media map to heart/throat/third-eye by what they
// actually do (understand, speak, see), interface is the crown's outward reach.
// All at the -300 step: full-intensity -400 icons read brighter than the
// trigger's deliberately muted red, which stood out as inconsistent.
export const CATEGORY_CLASSES: Record<PlaygroundCategory, string> = {
  trigger: 'text-red-300 bg-red-300/15 border-red-300/40',
  data: 'text-orange-300 bg-orange-300/15 border-orange-300/40',
  logic: 'text-amber-300 bg-amber-300/15 border-amber-300/40',
  'ai-text': 'text-green-300 bg-green-300/15 border-green-300/40',
  'ai-voice': 'text-blue-300 bg-blue-300/15 border-blue-300/40',
  'ai-media': 'text-indigo-300 bg-indigo-300/15 border-indigo-300/40',
  interface: 'text-violet-300 bg-violet-300/15 border-violet-300/40',
};

export function optionValue(o: string | { value: string; label: string }): string {
  return typeof o === 'string' ? o : o.value;
}

function labelFor(options: PlaygroundFieldDef['options'], value: string): string {
  const match = options?.find((o) => optionValue(o) === value);
  return match ? (typeof match === 'string' ? match : match.label) : value;
}

function defaultsFrom(fields: PlaygroundNodeKindDef['fields']) {
  return () =>
    Object.fromEntries(
      fields.map((f) => [f.key, f.default ?? (f.type === 'select' && f.options?.[0] ? optionValue(f.options[0]) : '')]),
    );
}

const readFileFields: PlaygroundNodeKindDef['fields'] = [
  { key: 'file', label: 'Spreadsheet file', type: 'file', accept: '.csv,.xlsx,.xls' },
];
// Shared by every node that reads a whole document as plain text, not rows to
// filter: PDF and Word go through real text extraction, xls(x) through the
// same spreadsheet parser Read-spreadsheet uses, the rest is a plain decode.
const DOCUMENT_ACCEPT = '.txt,.md,.csv,.pdf,.docx,.xls,.xlsx';
// 'column' is free text, not a picker: no list here would reflect the real
// table's actual headers anyway, so the node's own run() validates it against
// the real headers at run time and errors clearly if it doesn't match.
const filterFields: PlaygroundNodeKindDef['fields'] = [
  { key: 'column', label: 'Column', type: 'text' },
  { key: 'value', label: 'Equals', type: 'text' },
];
const ifFields: PlaygroundNodeKindDef['fields'] = [
  {
    key: 'column',
    label: 'Column',
    type: 'text',
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
const ITERATE_SOURCE_OPTIONS = ['Table rows (upstream)', 'List (upstream text)', 'Files (pick here)'];
const ITERATE_ACTION_OPTIONS = ['Ask an AI agent', 'Translate'];
const iterateFields: PlaygroundNodeKindDef['fields'] = [
  { key: 'source', label: 'Iterate over', type: 'select', options: ITERATE_SOURCE_OPTIONS },
  {
    key: 'files',
    label: 'Files',
    type: 'file',
    multiple: true,
    accept: '.pdf,.docx,.txt,.csv,.xlsx,.xls',
    hiddenWhen: (fields) => fields.source !== 'Files (pick here)',
  },
  { key: 'action', label: 'Action per item', type: 'select', options: ITERATE_ACTION_OPTIONS },
  {
    key: 'task',
    label: 'Ask the AI about each item',
    type: 'textarea',
    hiddenWhen: (fields) => (fields.action || ITERATE_ACTION_OPTIONS[0]) !== 'Ask an AI agent',
  },
  {
    key: 'languages',
    label: 'Languages (one per item, in order)',
    type: 'textarea',
    hiddenWhen: (fields) => fields.action !== 'Translate',
  },
];
const randomizeFields: PlaygroundNodeKindDef['fields'] = [
  { key: 'options', label: 'Options (one per line)', type: 'textarea' },
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
const INPUT_SOURCE_OPTIONS = ['My input', 'Upstream input'];
const usesStaticSource = (fields: Record<string, string>) => fields.source !== 'Upstream input';
// null (nothing connected) and 'flow' (a trigger like Start) both carry no
// data, so "Upstream input" isn't a real choice yet and shouldn't show.
const hasWiredInput = (inputKind: PlaygroundDataType | null) => inputKind !== null && inputKind !== 'flow';

// `content` is its own field, separate from instructions: same source toggle
// as translate/ask-doc below, so a Provide text or document node wired in has to be
// picked explicitly via "Upstream input" rather than silently overriding it.
const OUTPUT_FORMAT_OPTIONS = ['Markdown', 'Plain text', 'CSV'];
const OUTPUT_FORMAT_INSTRUCTION: Partial<Record<string, string>> = {
  Markdown: 'Format the reply in markdown (tables, lists, or headings as appropriate).',
  CSV: 'Reply with only CSV rows: comma-separated values, no headers unless asked for, no markdown, no commentary.',
};
const agentFields: PlaygroundNodeKindDef['fields'] = [
  {
    key: 'source',
    label: 'Content source',
    type: 'select',
    options: INPUT_SOURCE_OPTIONS,
    hiddenWhen: (_fields, inputKind) => !hasWiredInput(inputKind),
  },
  {
    key: 'content',
    label: 'Content',
    type: 'textarea',
    hiddenWhen: (fields, inputKind) => hasWiredInput(inputKind) && !usesStaticSource(fields),
  },
  { key: 'task', label: 'Instructions', type: 'textarea' },
  { key: 'outputFormat', label: 'Output format', type: 'select', options: OUTPUT_FORMAT_OPTIONS },
];

const TEXT_SOURCE_OPTIONS = ['My input', 'Choose document'];
const textInputFields: PlaygroundNodeKindDef['fields'] = [
  { key: 'source', label: 'Source', type: 'select', options: TEXT_SOURCE_OPTIONS },
  { key: 'text', label: 'Text', type: 'textarea', hiddenWhen: (fields) => fields.source === 'Choose document' },
  {
    key: 'file',
    label: 'Document',
    type: 'file',
    accept: DOCUMENT_ACCEPT,
    hiddenWhen: (fields) => fields.source !== 'Choose document',
  },
];

const translateFields: PlaygroundNodeKindDef['fields'] = [
  {
    key: 'source',
    label: 'Text source',
    type: 'select',
    options: INPUT_SOURCE_OPTIONS,
    hiddenWhen: (_fields, inputKind) => !hasWiredInput(inputKind),
  },
  {
    key: 'text',
    label: 'Text to translate',
    type: 'textarea',
    hiddenWhen: (fields, inputKind) => hasWiredInput(inputKind) && !usesStaticSource(fields),
  },
  {
    key: 'language',
    label: 'Target language',
    type: 'select',
    options: BERGAMOT_EN_TARGETS,
  },
];
// Unlike translate/ai-agent above, a document is more often a file than
// pasted text, so this always offers "Choose document" too rather than
// only appearing once something happens to be wired in.
const ASK_DOC_SOURCE_OPTIONS = ['My input', 'Choose document', 'Upstream input'];
const askDocFields: PlaygroundNodeKindDef['fields'] = [
  { key: 'source', label: 'Document source', type: 'select', options: ASK_DOC_SOURCE_OPTIONS },
  {
    key: 'document',
    label: 'Source text',
    type: 'textarea',
    hiddenWhen: (fields) => fields.source !== 'My input',
  },
  {
    key: 'file',
    label: 'Document',
    type: 'file',
    accept: DOCUMENT_ACCEPT,
    hiddenWhen: (fields) => fields.source !== 'Choose document',
  },
  { key: 'question', label: 'Question', type: 'text' },
];
const confirmFields: PlaygroundNodeKindDef['fields'] = [
  { key: 'message', label: 'Message to show', type: 'text' },
];
// One entry per model this build knows how to load, matching diffusion.cjs's
// IMAGE_MODELS/VIDEO_MODELS keys exactly. Add a model in both places, not just here.
const IMAGE_MODEL_OPTIONS = [
  { value: 'sd2.1', label: 'Fast (Stable Diffusion 2.1)' },
  { value: 'flux2-klein', label: 'High Quality (FLUX.2 Klein)' },
];
const VIDEO_MODEL_OPTIONS = ['wan2.1-1.3b'];
const ttsFields: PlaygroundNodeKindDef['fields'] = [
  {
    key: 'source',
    label: 'Text source',
    type: 'select',
    options: INPUT_SOURCE_OPTIONS,
    hiddenWhen: (_fields, inputKind) => !hasWiredInput(inputKind),
  },
  {
    key: 'text',
    label: 'Text to speak',
    type: 'textarea',
    hiddenWhen: (fields, inputKind) => hasWiredInput(inputKind) && !usesStaticSource(fields),
  },
];
const sttFields: PlaygroundNodeKindDef['fields'] = [
  { key: 'file', label: 'Audio file (.wav)', type: 'file', accept: '.wav' },
];
const imageGenFields: PlaygroundNodeKindDef['fields'] = [
  {
    key: 'source',
    label: 'Prompt source',
    type: 'select',
    options: INPUT_SOURCE_OPTIONS,
    hiddenWhen: (_fields, inputKind) => !hasWiredInput(inputKind),
  },
  {
    key: 'prompt',
    label: 'Prompt',
    type: 'textarea',
    hiddenWhen: (fields, inputKind) => hasWiredInput(inputKind) && !usesStaticSource(fields),
  },
  { key: 'model', label: 'Model', type: 'select', options: IMAGE_MODEL_OPTIONS },
];
const videoGenFields: PlaygroundNodeKindDef['fields'] = [
  {
    key: 'source',
    label: 'Prompt source',
    type: 'select',
    options: INPUT_SOURCE_OPTIONS,
    hiddenWhen: (_fields, inputKind) => !hasWiredInput(inputKind),
  },
  {
    key: 'prompt',
    label: 'Prompt',
    type: 'textarea',
    hiddenWhen: (fields, inputKind) => hasWiredInput(inputKind) && !usesStaticSource(fields),
  },
  { key: 'model', label: 'Model', type: 'select', options: VIDEO_MODEL_OPTIONS },
  { key: 'length', label: 'Length (seconds)', type: 'text', default: '3' },
  { key: 'quality', label: 'Quality (steps, higher is slower)', type: 'text', default: '30' },
];
const musicGenFields: PlaygroundNodeKindDef['fields'] = [
  {
    key: 'source',
    label: 'Description source',
    type: 'select',
    options: INPUT_SOURCE_OPTIONS,
    hiddenWhen: (_fields, inputKind) => !hasWiredInput(inputKind),
  },
  {
    key: 'caption',
    label: 'Describe the music',
    type: 'textarea',
    hiddenWhen: (fields, inputKind) => hasWiredInput(inputKind) && !usesStaticSource(fields),
  },
  { key: 'duration', label: 'Duration (seconds, max 60)', type: 'text' },
];
const ocrFields: PlaygroundNodeKindDef['fields'] = [
  { key: 'file', label: 'Image file', type: 'file', accept: 'image/*' },
];
const classifyFields: PlaygroundNodeKindDef['fields'] = [
  { key: 'file', label: 'Image file', type: 'file', accept: 'image/*' },
];
// Real files, not typed-in text: a search index over documents the user
// never actually has to paste is the whole point of the node.
const SEARCH_SOURCE_OPTIONS = ['Choose files', 'Upstream input'];
const searchDocsFields: PlaygroundNodeKindDef['fields'] = [
  {
    key: 'source',
    label: 'Document source',
    type: 'select',
    options: SEARCH_SOURCE_OPTIONS,
    hiddenWhen: (_fields, inputKind) => !hasWiredInput(inputKind),
  },
  {
    key: 'files',
    label: 'Documents',
    type: 'file',
    accept: DOCUMENT_ACCEPT,
    multiple: true,
    hiddenWhen: (fields, inputKind) => hasWiredInput(inputKind) && !usesStaticSource(fields),
  },
  { key: 'query', label: 'Search query', type: 'text' },
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
      const picked = parsePickedFiles(ctx.fields.file)[0];
      if (!picked) {
        ctx.pushRunLine('err', 'No file selected: open this node and choose a spreadsheet.');
        return;
      }
      const table = await parseSpreadsheetFile(picked.name, picked.dataUrl);
      ctx.setOutput(table);
      ctx.pushResult(`**${picked.name}**, ${table.rows.length} rows\n\n${tableToMarkdown(table)}`);
    },
  },
  'text-input': {
    kind: 'text-input',
    label: 'Provide text or document',
    category: 'data',
    input: 'flow',
    output: 'value',
    fields: textInputFields,
    defaultFields: defaultsFrom(textInputFields),
    async run(ctx) {
      if (ctx.fields.source === 'Choose document') {
        const picked = parsePickedFiles(ctx.fields.file)[0];
        if (!picked) {
          ctx.pushRunLine('err', 'No document selected: open this node and choose a file.');
          return;
        }
        const text = await extractDocumentText(picked.name, picked.dataUrl);
        ctx.setOutput(text);
        ctx.pushResult(`**${picked.name}**\n\n${text}`);
        return;
      }
      const text = ctx.fields.text ?? '';
      ctx.setOutput(text);
      ctx.pushResult(text || '[empty]');
    },
  },
  filter: {
    kind: 'filter',
    label: 'Filter table',
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
      const column = ctx.fields.column ?? '';
      if (findColumnIndex(input.headers, column) === -1) {
        ctx.pushRunLine('err', `Column "${column}" not found. This table has: ${input.headers.join(', ')}.`);
        return;
      }
      const filtered = filterTable(input, column, ctx.fields.value ?? '');
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
      const formatInstruction = OUTPUT_FORMAT_INSTRUCTION[ctx.fields.outputFormat ?? ''];
      const task = formatInstruction ? `${ctx.fields.task ?? ''}\n\n${formatInstruction}` : (ctx.fields.task ?? '');
      const upstream = ctx.readInput();
      if (upstream && typeof upstream !== 'string') {
        // A real table can only ever arrive over a wire, never as typed content.
        const { text, truncated } = buildAgentPrompt(task, `Data:\n${tableToMarkdown(upstream)}`, AGENT_MESSAGE_MAX);
        if (truncated) ctx.pushRunLine('ok', 'The table was long: only the part that fit was sent to the agent.');
        ctx.setOutput(await ctx.runAgent(text));
        return;
      }
      const content = ctx.resolveContent('content');
      if (!content || content.trim().length === 0) {
        ctx.setOutput(await ctx.runAgent(task));
        return;
      }
      const { text, truncated } = buildAgentPrompt(task, `Input: ${content}`, AGENT_MESSAGE_MAX);
      if (truncated) ctx.pushRunLine('ok', 'The input was long: only the part that fit was sent to the agent.');
      ctx.setOutput(await ctx.runAgent(text));
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
      const column = ctx.fields.column ?? '';
      if (findColumnIndex(input.headers, column) === -1) {
        ctx.pushRunLine('err', `Column "${column}" not found. This table has: ${input.headers.join(', ')}.`);
        return;
      }
      const { yes, no } = splitTable(input, column, operator, value);
      ctx.setOutput(yes, 'true');
      ctx.setOutput(no, 'false');
      ctx.pushResult(`${yes.rows.length} row(s) yes, ${no.rows.length} row(s) no`);
    },
  },
  'iterate-ai': {
    kind: 'iterate-ai',
    label: 'Iterate',
    category: 'logic',
    input: 'any',
    output: 'table',
    fields: iterateFields,
    defaultFields: defaultsFrom(iterateFields),
    async run(ctx) {
      const source = ctx.fields.source || ITERATE_SOURCE_OPTIONS[0];
      let items: string[];
      if (source === 'Files (pick here)') {
        const files = parsePickedFiles(ctx.fields.files);
        if (files.length === 0) {
          ctx.pushRunLine('err', 'No files selected: open this node and choose files.');
          return;
        }
        items = await Promise.all(files.map((f) => extractDocumentText(f.name, f.dataUrl)));
      } else if (source === 'List (upstream text)') {
        const input = ctx.readInput();
        if (typeof input !== 'string' || input.trim().length === 0) {
          ctx.pushRunLine('err', 'Nothing to iterate: connect a step that outputs text.');
          return;
        }
        items = splitIntoItems(input);
      } else {
        const input = ctx.readInput();
        if (!input || typeof input === 'string') {
          ctx.pushRunLine('err', 'No table connected in.');
          return;
        }
        items = input.rows.map((row) => rowToMarkdown(input.headers, row));
      }
      if (items.length > MAX_ITERATE_ROWS) {
        ctx.pushRunLine('ok', `Capped to the first ${MAX_ITERATE_ROWS} of ${items.length} items.`);
        items = items.slice(0, MAX_ITERATE_ROWS);
      }
      if (ctx.fields.action === 'Translate') {
        const languages = splitIntoItems(ctx.fields.languages ?? '');
        for (let i = 0; i < items.length; i++) {
          if (ctx.stopRequested()) break;
          const language = languages[i] || languages[languages.length - 1] || 'Spanish';
          const { text: safeItem, truncated } = truncateForLimit(items[i], TRANSLATE_TEXT_MAX);
          if (truncated) ctx.pushRunLine('ok', `Item ${i + 1} was long: only the first ${TRANSLATE_TEXT_MAX.toLocaleString()} characters were translated.`);
          ctx.pushResult(await ctx.translate(safeItem, language));
        }
        return;
      }
      const task = ctx.fields.task ?? '';
      for (const item of items) {
        if (ctx.stopRequested()) break;
        const { text, truncated } = buildAgentPrompt(task, `Item:\n${item}`, AGENT_MESSAGE_MAX);
        if (truncated) ctx.pushRunLine('ok', 'An item was long: only the part that fit was sent to the agent.');
        await ctx.runAgent(text);
      }
    },
  },
  randomize: {
    kind: 'randomize',
    label: 'Randomize',
    category: 'logic',
    input: 'flow',
    output: 'value',
    fields: randomizeFields,
    defaultFields: defaultsFrom(randomizeFields),
    async run(ctx) {
      const options = (ctx.fields.options ?? '')
        .split(/\r?\n|,/)
        .map((s) => s.trim())
        .filter((s) => s.length > 0);
      if (options.length === 0) {
        ctx.pushRunLine('err', 'No options to pick from: open this node and list at least one, one per line.');
        return;
      }
      const pick = options[Math.floor(Math.random() * options.length)];
      ctx.setOutput(pick);
      ctx.pushResult(`Picked "${pick}" from ${options.length} option(s).`);
    },
  },
  translate: {
    kind: 'translate',
    label: 'Translate',
    category: 'ai-text',
    // 'any': a flow trigger to just sequence it after Start, or real text from an
    // AI agent/If/etc. when "Upstream input" is picked as the text source.
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
      const { text: safeText, truncated } = truncateForLimit(text, TRANSLATE_TEXT_MAX);
      if (truncated) ctx.pushRunLine('ok', `Text was long: only the first ${TRANSLATE_TEXT_MAX.toLocaleString()} characters were translated.`);
      ctx.setOutput(await ctx.translate(safeText, language));
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
      let document: string;
      if (ctx.fields.source === 'Choose document') {
        const picked = parsePickedFiles(ctx.fields.file)[0];
        if (!picked) {
          ctx.pushRunLine('err', 'No document selected: open this node and choose a file.');
          return;
        }
        document = await extractDocumentText(picked.name, picked.dataUrl);
      } else {
        const resolved = ctx.resolveContent('document');
        if (resolved === undefined) {
          ctx.pushRunLine(
            'err',
            "Nothing to work with: the previous step produced no text, or nothing is connected.",
          );
          return;
        }
        document = resolved;
      }
      const question = ctx.fields.question ?? '';
      const wrap = (text: string) =>
        `Answer the question using only the text below. If the answer isn't in the text, say so.\n\nText:\n${text}\n\nQuestion: ${question}`;
      const { text: safeDocument, truncated } = truncateForLimit(document, AGENT_MESSAGE_MAX - wrap('').length);
      if (truncated) ctx.pushRunLine('ok', 'The document was long: only the part that fit was sent to the agent.');
      ctx.setOutput(await ctx.runAgent(wrap(safeDocument)));
    },
  },
  'text-to-speech': {
    kind: 'text-to-speech',
    label: 'Text to speech',
    category: 'ai-voice',
    input: 'any',
    output: 'value',
    fields: ttsFields,
    defaultFields: defaultsFrom(ttsFields),
    async run(ctx) {
      const text = ctx.resolveContent('text');
      if (text === undefined) {
        ctx.pushRunLine('err', 'Nothing to speak: the previous step produced no text, or nothing is connected.');
        return;
      }
      const dataUrl = await ctx.textToSpeech(text);
      ctx.setOutput(dataUrl);
      ctx.pushMedia('audio', dataUrl, text);
    },
  },
  'speech-to-text': {
    kind: 'speech-to-text',
    label: 'Speech to text',
    category: 'ai-voice',
    input: 'flow',
    output: 'value',
    fields: sttFields,
    defaultFields: defaultsFrom(sttFields),
    async run(ctx) {
      const picked = parsePickedFiles(ctx.fields.file)[0];
      if (!picked) {
        ctx.pushRunLine('err', 'No audio file selected: open this node and choose a .wav file.');
        return;
      }
      const text = await ctx.speechToText(picked.dataUrl);
      ctx.setOutput(text);
      ctx.pushResult(text || '[no speech detected]');
    },
  },
  'generate-image': {
    kind: 'generate-image',
    label: 'Generate image',
    category: 'ai-media',
    input: 'any',
    output: 'value',
    fields: imageGenFields,
    defaultFields: defaultsFrom(imageGenFields),
    async run(ctx) {
      const prompt = ctx.resolveContent('prompt');
      if (prompt === undefined) {
        ctx.pushRunLine('err', 'Nothing to generate from: the previous step produced no text, or nothing is connected.');
        return;
      }
      const modelKey = ctx.fields.model || optionValue(IMAGE_MODEL_OPTIONS[0]);
      ctx.pushRunLine('ok', `Generating image with ${labelFor(IMAGE_MODEL_OPTIONS, modelKey)}…`);
      const dataUrl = await ctx.generateImage(prompt, ctx.fields.model);
      ctx.setOutput(dataUrl);
      ctx.pushMedia('image', dataUrl, prompt);
    },
  },
  'generate-video': {
    kind: 'generate-video',
    label: 'Generate video',
    category: 'ai-media',
    input: 'any',
    output: 'value',
    fields: videoGenFields,
    defaultFields: defaultsFrom(videoGenFields),
    async run(ctx) {
      const prompt = ctx.resolveContent('prompt');
      if (prompt === undefined) {
        ctx.pushRunLine('err', 'Nothing to generate from: the previous step produced no text, or nothing is connected.');
        return;
      }
      const modelKey = ctx.fields.model || optionValue(VIDEO_MODEL_OPTIONS[0]);
      const seconds = Math.max(0.5, Number.parseFloat(ctx.fields.length) || 3);
      const steps = Math.min(150, Math.max(1, Number.parseInt(ctx.fields.quality, 10) || 30));
      // Wan's frame count must be an integer >=5 of the form 4k+1 (diffusion.cjs
      // runs it at 16fps); round the user's seconds to the nearest valid count.
      let frames = Math.round((Math.round(seconds * 16) - 1) / 4) * 4 + 1;
      frames = Math.min(197, Math.max(5, frames));
      ctx.pushRunLine(
        'ok',
        `Generating video with ${labelFor(VIDEO_MODEL_OPTIONS, modelKey)} (${seconds}s, ${steps} steps). This can take several minutes.`,
      );
      const dataUrl = await ctx.generateVideo(prompt, modelKey, frames, steps);
      ctx.setOutput(dataUrl);
      ctx.pushMedia('video', dataUrl, prompt);
    },
  },
  'generate-music': {
    kind: 'generate-music',
    label: 'Generate music',
    category: 'ai-media',
    input: 'any',
    output: 'value',
    fields: musicGenFields,
    defaultFields: defaultsFrom(musicGenFields),
    async run(ctx) {
      const caption = ctx.resolveContent('caption');
      if (caption === undefined) {
        ctx.pushRunLine('err', 'Nothing to generate from: the previous step produced no text, or nothing is connected.');
        return;
      }
      const duration = Math.min(60, Math.max(1, Number(ctx.fields.duration) || 10));
      ctx.pushRunLine('ok', `Generating ${duration}s of music…`);
      const dataUrl = await ctx.generateMusic(caption, duration);
      ctx.setOutput(dataUrl);
      ctx.pushMedia('audio', dataUrl, caption);
    },
  },
  ocr: {
    kind: 'ocr',
    label: 'Read text from image',
    category: 'ai-media',
    input: 'flow',
    output: 'value',
    fields: ocrFields,
    defaultFields: defaultsFrom(ocrFields),
    async run(ctx) {
      const picked = parsePickedFiles(ctx.fields.file)[0];
      if (!picked) {
        ctx.pushRunLine('err', 'No image selected: open this node and choose a file.');
        return;
      }
      // Also normalizes the format (a browser-decodable file with any other
      // extension, like a `.jpeg`-named WebP screenshot), which the OCR
      // engine itself would otherwise reject outright.
      let normalized: string;
      try {
        normalized = await normalizeImageForModel(picked.dataUrl);
      } catch (err) {
        ctx.pushRunLine('err', err instanceof Error ? err.message : 'Could not prepare that image for OCR.');
        return;
      }
      const text = await ctx.ocr(normalized);
      ctx.setOutput(stripOcrTableMarkup(text));
      ctx.pushResult(text || '[no text found]', { raw: true });
    },
  },
  'classify-image': {
    kind: 'classify-image',
    label: 'Classify image',
    category: 'ai-media',
    input: 'flow',
    output: 'value',
    fields: classifyFields,
    defaultFields: defaultsFrom(classifyFields),
    async run(ctx) {
      const picked = parsePickedFiles(ctx.fields.file)[0];
      if (!picked) {
        ctx.pushRunLine('err', 'No image selected: open this node and choose a file.');
        return;
      }
      // factor 1: no reason to enlarge for a fixed-size classifier, just
      // normalize the format (see the OCR node's own comment on this).
      let normalized: string;
      try {
        normalized = await normalizeImageForModel(picked.dataUrl, 1);
      } catch (err) {
        ctx.pushRunLine('err', err instanceof Error ? err.message : 'Could not prepare that image.');
        return;
      }
      const text = await ctx.classifyImage(normalized);
      ctx.setOutput(text);
      ctx.pushResult(text);
    },
  },
  'search-documents': {
    kind: 'search-documents',
    label: 'Search documents',
    category: 'ai-text',
    input: 'any',
    output: 'value',
    fields: searchDocsFields,
    defaultFields: defaultsFrom(searchDocsFields),
    async run(ctx) {
      let documents: string[];
      if (usesStaticSource(ctx.fields)) {
        const picked = parsePickedFiles(ctx.fields.files);
        if (picked.length === 0) {
          ctx.pushRunLine('err', 'No documents selected: open this node and choose files.');
          return;
        }
        const extracted = await Promise.all(picked.map((f) => extractDocumentText(f.name, f.dataUrl)));
        documents = extracted.filter((d) => d.trim().length > 0);
        if (documents.length === 0) {
          // A scanned/image-only PDF has no embedded text layer, so extraction
          // legitimately returns nothing; this isn't a bug in the node itself,
          // and it's worth saying so rather than a bare "no documents."
          ctx.pushRunLine(
            'err',
            `Could not find any text in ${picked.length === 1 ? 'that file' : 'those files'}. A scanned or image-only PDF has no text to search; try a text-based file instead.`,
          );
          return;
        }
      } else {
        const raw = ctx.readInput();
        if (!raw || typeof raw !== 'string') {
          ctx.pushRunLine('err', 'Nothing to work with: the previous step produced no text, or nothing is connected.');
          return;
        }
        documents = raw
          .split('\n')
          .map((l) => l.trim())
          .filter((l) => l.length > 0);
        if (documents.length === 0) {
          ctx.pushRunLine('err', 'No documents to search.');
          return;
        }
      }
      ctx.setOutput(await ctx.search(documents, ctx.fields.query ?? ''));
    },
  },
  'ask-confirmation': {
    kind: 'ask-confirmation',
    label: 'Ask for confirmation',
    category: 'interface',
    input: 'any',
    output: 'bool',
    fields: confirmFields,
    defaultFields: defaultsFrom(confirmFields),
    async run(ctx) {
      const message = ctx.fields.message || 'Continue?';
      const yes = await ctx.confirm(message);
      // 'yes'/'no': what a user actually types into a downstream If's Value
      // field, not the internal 'true'/'false' this used to emit.
      ctx.setOutput(yes ? 'yes' : 'no');
    },
  },
};
