import { IF_OPERATORS, IF_UNARY_OPERATORS } from './playground-table.js';
import type { PlaygroundCategory, PlaygroundNodeKindDef } from './playground-types.js';

export const CATEGORY_CLASSES: Record<PlaygroundCategory, string> = {
  trigger: 'text-emerald-400 bg-emerald-400/15 border-emerald-400/40',
  conditions: 'text-amber-400 bg-amber-400/15 border-amber-400/40',
  agent: 'text-fuchsia-400 bg-fuchsia-400/15 border-fuchsia-400/40',
  'ai-text': 'text-orange-400 bg-orange-400/15 border-orange-400/40',
  'ai-media': 'text-pink-400 bg-pink-400/15 border-pink-400/40',
  'ai-voice': 'text-teal-400 bg-teal-400/15 border-teal-400/40',
  data: 'text-sky-400 bg-sky-400/15 border-sky-400/40',
  transform: 'text-violet-400 bg-violet-400/15 border-violet-400/40',
  interface: 'text-amber-400 bg-amber-400/15 border-amber-400/40',
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
    label: 'When you click Run',
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
  },
  filter: {
    kind: 'filter',
    label: 'Filter rows',
    category: 'transform',
    input: 'table',
    output: 'table',
    fields: filterFields,
    defaultFields: defaultsFrom(filterFields),
  },
  'ai-agent': {
    kind: 'ai-agent',
    label: 'Ask an AI agent',
    category: 'agent',
    input: 'table',
    // Always a reply string at runtime, table input or not: declaring 'table' here
    // let this connect into Filter/Iterate even though it can never feed them real rows.
    output: 'value',
    fields: agentFields,
    defaultFields: defaultsFrom(agentFields),
  },
  if: {
    kind: 'if',
    label: 'If',
    category: 'conditions',
    // Accepts a table (splits rows by column) or plain text (tests the whole
    // string), whichever is actually wired in; see the run loop for the branch.
    input: 'any',
    output: 'any',
    dualOutput: true,
    fields: ifFields,
    defaultFields: defaultsFrom(ifFields),
  },
  'iterate-ai': {
    kind: 'iterate-ai',
    label: 'Iterate',
    category: 'conditions',
    input: 'table',
    output: 'table',
    fields: iterateFields,
    defaultFields: defaultsFrom(iterateFields),
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
  },
  'ask-doc': {
    kind: 'ask-doc',
    label: 'Ask about a document',
    category: 'ai-text',
    input: 'any', // same reasoning as Translate above
    output: 'value',
    fields: askDocFields,
    defaultFields: defaultsFrom(askDocFields),
  },
};
