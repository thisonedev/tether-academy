import { dataUrlToText, parsePickedFiles } from './playground-files.js';
import {
  filterTable,
  IF_OPERATORS,
  IF_UNARY_OPERATORS,
  parseSpreadsheetFile,
  rowToMarkdown,
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
  { key: 'file', label: 'Spreadsheet file', type: 'file', accept: '.csv,.txt,.xlsx,.xls' },
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

// `content` is its own field, separate from instructions: same source toggle
// as translate/ask-doc below, so a Text or document node wired in has to be
// picked explicitly via "Previous result" rather than silently overriding it.
const agentFields: PlaygroundNodeKindDef['fields'] = [
  { key: 'source', label: 'Content source', type: 'select', options: INPUT_SOURCE_OPTIONS },
  { key: 'content', label: 'Content', type: 'textarea', hiddenWhen: (fields) => !usesCustomText(fields) },
  { key: 'task', label: 'Instructions', type: 'textarea' },
];

const TEXT_SOURCE_OPTIONS = ['Type text', 'Choose document'];
const textInputFields: PlaygroundNodeKindDef['fields'] = [
  { key: 'source', label: 'Source', type: 'select', options: TEXT_SOURCE_OPTIONS },
  { key: 'text', label: 'Text', type: 'textarea', hiddenWhen: (fields) => fields.source === 'Choose document' },
  {
    key: 'file',
    label: 'Document',
    type: 'file',
    accept: '.txt,.md,.csv',
    hiddenWhen: (fields) => fields.source !== 'Choose document',
  },
];

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
const confirmFields: PlaygroundNodeKindDef['fields'] = [
  { key: 'message', label: 'Message to show', type: 'text' },
];
// One entry per model this build knows how to load, matching diffusion.cjs's
// IMAGE_MODELS/VIDEO_MODELS keys exactly. Add a model in both places, not just here.
const IMAGE_MODEL_OPTIONS = ['sd2.1'];
const VIDEO_MODEL_OPTIONS = ['wan2.1-1.3b'];
const ttsFields: PlaygroundNodeKindDef['fields'] = [
  { key: 'source', label: 'Text source', type: 'select', options: INPUT_SOURCE_OPTIONS },
  { key: 'text', label: 'Text to speak', type: 'textarea', hiddenWhen: (fields) => !usesCustomText(fields) },
];
const sttFields: PlaygroundNodeKindDef['fields'] = [
  { key: 'file', label: 'Audio file (.wav)', type: 'file', accept: '.wav' },
];
const imageGenFields: PlaygroundNodeKindDef['fields'] = [
  { key: 'source', label: 'Prompt source', type: 'select', options: INPUT_SOURCE_OPTIONS },
  { key: 'prompt', label: 'Prompt', type: 'textarea', hiddenWhen: (fields) => !usesCustomText(fields) },
  { key: 'model', label: 'Model', type: 'select', options: IMAGE_MODEL_OPTIONS },
];
// Wan's frame count must be 4*k + 1; these are the SDK's own documented
// checkpoints (17 through 81, the model's native training length).
const VIDEO_LENGTH_OPTIONS = [
  '17 frames (~1s, fast)',
  '33 frames (~2s)',
  '49 frames (~3s)',
  '65 frames (~4s)',
  '81 frames (~5s, best quality)',
];
const VIDEO_QUALITY_OPTIONS = ['15 steps (fast)', '30 steps (balanced)', '50 steps (high quality)'];
const videoGenFields: PlaygroundNodeKindDef['fields'] = [
  { key: 'source', label: 'Prompt source', type: 'select', options: INPUT_SOURCE_OPTIONS },
  { key: 'prompt', label: 'Prompt', type: 'textarea', hiddenWhen: (fields) => !usesCustomText(fields) },
  { key: 'model', label: 'Model', type: 'select', options: VIDEO_MODEL_OPTIONS },
  { key: 'length', label: 'Length', type: 'select', options: VIDEO_LENGTH_OPTIONS },
  { key: 'quality', label: 'Quality', type: 'select', options: VIDEO_QUALITY_OPTIONS },
];
const musicGenFields: PlaygroundNodeKindDef['fields'] = [
  { key: 'source', label: 'Description source', type: 'select', options: INPUT_SOURCE_OPTIONS },
  { key: 'caption', label: 'Describe the music', type: 'textarea', hiddenWhen: (fields) => !usesCustomText(fields) },
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
const SEARCH_SOURCE_OPTIONS = ['Choose files', 'Previous result'];
const searchDocsFields: PlaygroundNodeKindDef['fields'] = [
  { key: 'source', label: 'Document source', type: 'select', options: SEARCH_SOURCE_OPTIONS },
  {
    key: 'files',
    label: 'Documents',
    type: 'file',
    accept: '.txt,.md,.csv',
    multiple: true,
    hiddenWhen: (fields) => !usesCustomText(fields),
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
    label: 'Text or document',
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
        const text = dataUrlToText(picked.dataUrl);
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
      const task = ctx.fields.task ?? '';
      const upstream = ctx.readInput();
      if (upstream && typeof upstream !== 'string') {
        // A real table can only ever arrive over a wire, never as typed content.
        ctx.setOutput(await ctx.runAgent(`${task}\n\nData:\n${tableToMarkdown(upstream)}`));
        return;
      }
      const content = ctx.resolveContent('content');
      const prompt = content && content.trim().length > 0 ? `${task}\n\nInput: ${content}` : task;
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
      ctx.pushRunLine('ok', `Generating image with ${ctx.fields.model || IMAGE_MODEL_OPTIONS[0]}…`);
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
      const frames = Number.parseInt(ctx.fields.length, 10) || 17;
      const steps = Number.parseInt(ctx.fields.quality, 10) || 30;
      ctx.pushRunLine(
        'ok',
        `Generating video with ${ctx.fields.model || VIDEO_MODEL_OPTIONS[0]} (${frames} frames, ${steps} steps). This can take several minutes.`,
      );
      const dataUrl = await ctx.generateVideo(prompt, ctx.fields.model, frames, steps);
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
      const text = await ctx.ocr(picked.dataUrl);
      ctx.setOutput(text);
      ctx.pushResult(text || '[no text found]');
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
      const text = await ctx.classifyImage(picked.dataUrl);
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
      if (usesCustomText(ctx.fields)) {
        const picked = parsePickedFiles(ctx.fields.files);
        if (picked.length === 0) {
          ctx.pushRunLine('err', 'No documents selected: open this node and choose files.');
          return;
        }
        documents = picked.map((f) => dataUrlToText(f.dataUrl)).filter((d) => d.trim().length > 0);
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
      }
      if (documents.length === 0) {
        ctx.pushRunLine('err', 'No documents to search.');
        return;
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
