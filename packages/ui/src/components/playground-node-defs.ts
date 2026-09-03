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
  return () => Object.fromEntries(fields.map((f) => [f.key, f.type === 'select' ? (f.options?.[0] ?? '') : '']));
}

const readFileFields: PlaygroundNodeKindDef['fields'] = [{ key: 'sheet', label: 'Sheet name', type: 'text' }];
const filterFields: PlaygroundNodeKindDef['fields'] = [
  { key: 'column', label: 'Column', type: 'select', options: ['Date', 'Category', 'Description', 'Amount'] },
  { key: 'value', label: 'Equals', type: 'text' },
];
const agentFields: PlaygroundNodeKindDef['fields'] = [
  { key: 'task', label: 'Instructions: what should it do?', type: 'textarea' },
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
    output: 'table',
    fields: agentFields,
    defaultFields: defaultsFrom(agentFields),
  },
};
