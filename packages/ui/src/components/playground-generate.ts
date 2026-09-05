import { optionValue, PLAYGROUND_NODE_DEFS } from './playground-node-defs.js';
import {
  parseWorkflowShape,
  type SavedWorkflow,
  type SavedWorkflowEdge,
  type SavedWorkflowNode,
} from './playground-workflow.js';

/** Strips a workflow down to what a follow-up "change this" prompt actually
 *  needs: node/edge structure and fields, not coordinates or a file's own
 *  bytes (those would be megabytes of base64 for no benefit to the model). */
export function summarizeCurrentWorkflow(workflow: SavedWorkflow): string {
  const nodes = workflow.nodes.map((n) => {
    const def = PLAYGROUND_NODE_DEFS[n.kind];
    const fields: Record<string, string> = {};
    for (const [key, value] of Object.entries(n.fields)) {
      const fieldDef = def?.fields.find((f) => f.key === key);
      fields[key] = fieldDef?.type === 'file' ? (value ? '<file selected>' : '') : value;
    }
    return { id: n.id, kind: n.kind, fields };
  });
  return JSON.stringify({ name: workflow.name, nodes, edges: workflow.edges });
}

// Node cards are 208px wide (`w-52` in playground-flow-node.tsx); 260/170
// leaves a real gap between siblings and matches hand-placed presets' vertical rhythm.
const HORIZONTAL_STEP = 260;
const VERTICAL_STEP = 170;

/** Lays nodes out by BFS depth from `start`, fanning siblings at the same
 *  depth out horizontally and centered, instead of one long vertical line:
 *  a branch reads as a branch, and the whole graph tends to fit on screen. */
function layoutByDepth(nodes: SavedWorkflowNode[], edges: SavedWorkflowEdge[]): void {
  const childrenOf = new Map<string, string[]>();
  for (const e of edges) {
    if (!childrenOf.has(e.source)) childrenOf.set(e.source, []);
    childrenOf.get(e.source)?.push(e.target);
  }

  const depth = new Map<string, number>();
  const root = nodes.find((n) => n.kind === 'start')?.id ?? nodes[0]?.id;
  if (root) {
    depth.set(root, 0);
    const queue = [root];
    while (queue.length > 0) {
      const id = queue.shift() as string;
      const d = depth.get(id) as number;
      for (const child of childrenOf.get(id) ?? []) {
        if (depth.has(child)) continue;
        depth.set(child, d + 1);
        queue.push(child);
      }
    }
  }
  // A node no edge ever reaches (shouldn't happen, but not fatal) still gets a slot.
  let strayDepth = Math.max(0, ...depth.values()) + 1;
  for (const n of nodes) if (!depth.has(n.id)) depth.set(n.id, strayDepth++);

  const levels = new Map<number, string[]>();
  for (const n of nodes) {
    const d = depth.get(n.id) as number;
    if (!levels.has(d)) levels.set(d, []);
    levels.get(d)?.push(n.id);
  }

  const byId = new Map(nodes.map((n) => [n.id, n]));
  for (const [d, ids] of levels) {
    ids.forEach((id, i) => {
      const node = byId.get(id);
      if (!node) return;
      node.x = (i - (ids.length - 1) / 2) * HORIZONTAL_STEP;
      node.y = d * VERTICAL_STEP;
    });
  }
}

// The field actually holding a kind's static content, for kinds with a real
// vs. wired content-source toggle (search-documents is deliberately excluded:
// its toggle is files-vs-wire, and "query" is neither, so it needs no fix here).
const STATIC_CONTENT_FIELD: Partial<Record<string, string>> = {
  'ai-agent': 'content',
  translate: 'text',
  'ask-doc': 'document',
  'text-to-speech': 'text',
  'generate-image': 'prompt',
  'generate-video': 'prompt',
  'generate-music': 'caption',
};

// resolveContent (playground.tsx) always trusts the toggle over the wire, so a
// model that wires real content in but leaves the static field blank meant
// "read the wire" and just forgot to say so.
function fixContentSource(nodes: SavedWorkflowNode[], edges: SavedWorkflowEdge[]): void {
  const kindOf = new Map(nodes.map((n) => [n.id, n.kind]));
  const hasRealDataInput = new Set<string>();
  for (const e of edges) {
    const sourceKind = kindOf.get(e.source);
    const sourceOutput = sourceKind ? PLAYGROUND_NODE_DEFS[sourceKind]?.output : undefined;
    if (sourceOutput && sourceOutput !== 'flow') hasRealDataInput.add(e.target);
  }
  for (const node of nodes) {
    const staticKey = STATIC_CONTENT_FIELD[node.kind];
    if (!staticKey || !hasRealDataInput.has(node.id)) continue;
    if ((node.fields[staticKey] ?? '').trim().length > 0) continue;
    node.fields.source = 'Upstream input';
  }
}

/** A model asked for "the same task over N inputs" reliably wires N repeats
 *  of the same 1-2 node pattern one after another instead of N branches off
 *  start, even when told not to (chat-context.cjs asks for branches
 *  explicitly). Detected here instead: an unbranched chain whose kinds are
 *  a short pattern repeated 2+ times gets each repeat's first node rewired
 *  to hang off start directly, so layoutByDepth fans them out like the
 *  independent jobs they are. Left alone if the model already branched. */
function branchOutRepeatedChain(nodes: SavedWorkflowNode[], edges: SavedWorkflowEdge[]): void {
  const start = nodes.find((n) => n.kind === 'start');
  if (!start) return;

  const childrenOf = new Map<string, string[]>();
  const parentCount = new Map<string, number>();
  for (const e of edges) {
    if (!childrenOf.has(e.source)) childrenOf.set(e.source, []);
    childrenOf.get(e.source)?.push(e.target);
    parentCount.set(e.target, (parentCount.get(e.target) ?? 0) + 1);
  }
  // Only a real unbranched chain qualifies: the model already branching
  // correctly, or wiring something more complex, is left untouched.
  for (const n of nodes) {
    if ((childrenOf.get(n.id)?.length ?? 0) > 1 || (parentCount.get(n.id) ?? 0) > 1) return;
  }

  const chain: string[] = [];
  let current = childrenOf.get(start.id)?.[0];
  while (current) {
    chain.push(current);
    current = childrenOf.get(current)?.[0];
  }
  if (chain.length < 4) return;

  const kindOf = new Map(nodes.map((n) => [n.id, n.kind]));
  const kinds = chain.map((id) => kindOf.get(id));

  for (let period = 1; period <= chain.length / 2; period++) {
    if (chain.length % period !== 0) continue;
    const repeats = chain.length / period;
    if (repeats < 2) continue;
    const pattern = kinds.slice(0, period);
    const matches = kinds.every((kind, i) => kind === pattern[i % period]);
    if (!matches) continue;

    for (let r = 1; r < repeats; r++) {
      const unitFirstId = chain[r * period];
      const edge = edges.find((e) => e.target === unitFirstId);
      if (edge) edge.source = start.id;
    }
    return;
  }
}

// A small model reading a bare label list once picked "Read spreadsheet" for
// a plain-text document because its file field also accepts .txt; these hints
// exist only for kinds whose label alone invites that kind of mix-up.
const KIND_HINTS: Partial<Record<string, string>> = {
  'read-file': 'tabular rows to filter/iterate by column only, not prose',
  'text-input': 'any document or typed text to feed into another node, e.g. before translate/ask an agent',
  'iterate-ai': 'runs one action (ask an agent, or translate) per item, for a repeated task over several files, a list, or table rows; use its own file field for multiple files, not several chained nodes',
};

/** One line per real node kind, built live from `PLAYGROUND_NODE_DEFS` so it
 *  can't list a kind, field, or option that doesn't actually exist. */
export function buildNodeCatalogue(): string {
  return Object.values(PLAYGROUND_NODE_DEFS)
    .map((def) => {
      const fields = def.fields
        .map((f) =>
          f.type === 'select' && f.options ? `${f.key}(one of: ${f.options.map(optionValue).join('|')})` : `${f.key}:${f.type}`,
        )
        .join(', ');
      const hint = KIND_HINTS[def.kind];
      return `- ${def.kind} [${def.input ?? 'none'} -> ${def.output ?? 'none'}]${hint ? ` (${hint})` : ''}${fields ? `: ${fields}` : ''}`;
    })
    .join('\n');
}

/** Walks from the first `{` tracking brace depth (skipping braces inside
 *  string literals) to find its real matching close, rather than trusting
 *  `lastIndexOf('}')` (wrong the moment there's trailing prose, or the JSON
 *  itself got cut off mid-object). Returns null when the object never closes,
 *  the signal a truncated/over-budget response left behind. */
function findJsonObject(text: string): string | null {
  const start = text.indexOf('{');
  if (start === -1) return null;
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let i = start; i < text.length; i++) {
    const ch = text[i];
    if (inString) {
      if (escaped) escaped = false;
      else if (ch === '\\') escaped = true;
      else if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') inString = true;
    else if (ch === '{') depth++;
    else if (ch === '}') {
      depth--;
      if (depth === 0) return text.slice(start, i + 1);
    }
  }
  return null;
}

// Reproduced with unrelated prompts, two variants of the same slip right
// after a short/empty "fields": dropping the next object's opening brace
// entirely (`}},"id":"n2"`) or leaving a stray quote in front of a brace
// that IS there (`}},"{"id":"n2"`). Both edits are safe to apply
// unconditionally: valid JSON never has either shape, so each can only ever
// match a real mistake, never a correctly-formed transition.
function repairMissingBraces(text: string): string {
  return text
    .replace(/([}\]])(\s*,\s*)("(?:id|source)":)/g, '$1$2{$3')
    .replace(/,"\{/g, ',{');
}

/** Strips a code fence if the model wrapped its answer in one, repairs a known
 *  brace-dropping mistake, then finds the real JSON object inside and
 *  tolerates a trailing comma before `}`/`]`, another common small-model slip. */
function extractJson(raw: string): string {
  const fenced = raw.match(/```(?:json)?\s*([\s\S]*?)```/i);
  const body = repairMissingBraces(fenced ? fenced[1] : raw);
  const found = findJsonObject(body);
  if (!found) {
    throw new Error(
      raw.trim().length === 0
        ? 'The AI produced an empty reply. Try again, maybe with a shorter request.'
        : `The AI reply was cut off before a full workflow came through. Try a shorter or simpler request. It started with: "${raw.trim().slice(0, 120)}"`,
    );
  }
  return found.replace(/,(\s*[}\]])/g, '$1');
}

/** Repairs a generated workflow against the real node contracts before it
 *  reaches the canvas: drops an invented kind or field, coerces a `select`
 *  value to a real option, fixes a wired-but-unset content source, lays out
 *  branches by depth, and guarantees a `start` node exists. */
export function parseGeneratedWorkflow(raw: string): SavedWorkflow {
  const extracted = extractJson(raw);
  let data: unknown;
  try {
    data = JSON.parse(extracted);
  } catch {
    throw new Error(`The AI reply wasn't valid JSON. It started with: "${extracted.slice(0, 120)}"`);
  }
  const shaped = parseWorkflowShape(data);

  const idRename = new Map<string, string>();
  const usedIds = new Set<string>();
  const nodes: SavedWorkflowNode[] = [];
  let hasStart = false;

  shaped.nodes.forEach((node, index) => {
    const def = PLAYGROUND_NODE_DEFS[node.kind];
    if (!def) return;

    let id = node.id.trim().length > 0 ? node.id.trim() : `gen${index}`;
    if (usedIds.has(id)) id = `${id}-${index}`;
    usedIds.add(id);
    if (!idRename.has(node.id)) idRename.set(node.id, id);

    if (node.kind === 'start') hasStart = true;
    const fields: Record<string, string> = {};
    for (const fieldDef of def.fields) {
      // A generated workflow can never attach real file bytes, so a hallucinated
      // value here would just be a fake filename sitting in the UI; leave it
      // unset so the config popup prompts the user to pick a real file instead.
      if (fieldDef.type === 'file') continue;
      const value = node.fields[fieldDef.key];
      if (value === undefined) continue;
      fields[fieldDef.key] =
        fieldDef.type === 'select' && fieldDef.options && !fieldDef.options.some((o) => optionValue(o) === value)
          ? optionValue(fieldDef.options[0])
          : value;
    }
    nodes.push({ id, kind: node.kind, x: 0, y: 0, fields });
  });

  if (!hasStart) nodes.unshift({ id: 'start', kind: 'start', x: 0, y: 0, fields: {} });
  if (nodes.length <= 1) throw new Error("The AI reply didn't describe any real steps.");

  const nodeIds = new Set(nodes.map((n) => n.id));
  const edges = shaped.edges
    .map((e) => ({ ...e, source: idRename.get(e.source) ?? e.source, target: idRename.get(e.target) ?? e.target }))
    .filter((e) => nodeIds.has(e.source) && nodeIds.has(e.target));

  fixContentSource(nodes, edges);
  branchOutRepeatedChain(nodes, edges);
  layoutByDepth(nodes, edges);

  return { version: 1, name: shaped.name || 'Generated workflow', nodes, edges };
}
