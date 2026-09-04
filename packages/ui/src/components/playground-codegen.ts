import { parsePickedFiles } from './playground-files.js';
import { parseCsv, parseSpreadsheetFile, SAMPLE_EXPENSES_CSV } from './playground-table.js';
import type { SavedWorkflow, SavedWorkflowNode } from './playground-workflow.js';

// Only when a read-file node was exported before any file was ever picked on
// it: same placeholder the node itself used to show, kept for one edge case.
const parseCsvFallback = () => parseCsv(SAMPLE_EXPENSES_CSV);

// A default, not a requirement: the SDK's own model picker in the desktop app
// looks at what's installed; a standalone script has no such registry to ask,
// so this names one real, small, commonly-cached chat preset and says so.
const DEFAULT_CHAT_MODEL_CONST = 'QWEN3_4B_INST_Q4_K_M';

function topoOrder(workflow: SavedWorkflow): SavedWorkflowNode[] {
  const byId = new Map(workflow.nodes.map((n) => [n.id, n]));
  const indeg = new Map(workflow.nodes.map((n) => [n.id, 0]));
  for (const e of workflow.edges) indeg.set(e.target, (indeg.get(e.target) ?? 0) + 1);
  const ready = workflow.nodes.filter((n) => indeg.get(n.id) === 0).map((n) => n.id);
  const remaining = new Map(indeg);
  const order: SavedWorkflowNode[] = [];
  while (ready.length > 0) {
    const id = ready.shift();
    if (id === undefined) break;
    const node = byId.get(id);
    if (node) order.push(node);
    for (const e of workflow.edges.filter((e2) => e2.source === id)) {
      const left = (remaining.get(e.target) ?? 1) - 1;
      remaining.set(e.target, left);
      if (left === 0) ready.push(e.target);
    }
  }
  return order;
}

function edgeInto(workflow: SavedWorkflow, targetId: string, handle?: string | null) {
  return workflow.edges.find((e) => e.target === targetId && (handle === undefined || e.sourceHandle === handle));
}

/** The `out[...]` key an edge's source actually wrote to: `id::handle` for a
 *  branch (If's Yes/No), plain `id` otherwise. Matches how the `if` case below
 *  writes both branches, so a read on the wrong side can't silently see `undefined`. */
function outKeyExpr(edge: { source: string; sourceHandle: string | null } | undefined): string {
  if (!edge) return 'undefined';
  const key = edge.sourceHandle ? `${edge.source}::${edge.sourceHandle}` : edge.source;
  return `out[${jsString(key)}]`;
}

/** JS string literal, not JSON.stringify: this lands inside a template file the
 *  user reads and edits, so plain single-quoted strings read like hand-written code. */
function jsString(value: string): string {
  return `'${value.replace(/\\/g, '\\\\').replace(/'/g, "\\'").replace(/\n/g, '\\n')}'`;
}

const RUNTIME_HELPERS = `
// ---- Runtime helpers (ported from playground-table.ts) ----
function findColumnIndex(headers, column) {
  const needle = column.trim().toLowerCase();
  return headers.findIndex((h) => h.trim().toLowerCase() === needle);
}
function filterTable(table, column, value) {
  const colIndex = findColumnIndex(table.headers, column);
  if (colIndex === -1) return { headers: table.headers, rows: [] };
  const needle = value.trim().toLowerCase();
  const rows = needle ? table.rows.filter((r) => (r[colIndex] ?? '').trim().toLowerCase() === needle) : table.rows;
  return { headers: table.headers, rows };
}
function matchesCondition(cell, operator, value) {
  const c = cell.trim(); const v = value.trim();
  switch (operator) {
    case 'equals': return c.toLowerCase() === v.toLowerCase();
    case 'does not equal': return c.toLowerCase() !== v.toLowerCase();
    case 'contains': return c.toLowerCase().includes(v.toLowerCase());
    case 'does not contain': return !c.toLowerCase().includes(v.toLowerCase());
    case 'greater than': case 'less than': case 'greater than or equal': case 'less than or equal': {
      const cellNum = Number(c); const valNum = Number(v);
      if (c === '' || Number.isNaN(cellNum) || Number.isNaN(valNum)) return false;
      if (operator === 'greater than') return cellNum > valNum;
      if (operator === 'less than') return cellNum < valNum;
      if (operator === 'greater than or equal') return cellNum >= valNum;
      return cellNum <= valNum;
    }
    case 'is a number': return c !== '' && !Number.isNaN(Number(c));
    case 'is a date': return c !== '' && Number.isNaN(Number(c)) && !Number.isNaN(Date.parse(c));
    case 'is text': return c !== '' && Number.isNaN(Number(c)) && Number.isNaN(Date.parse(c));
    default: return false;
  }
}
function splitTable(table, column, operator, value) {
  const colIndex = findColumnIndex(table.headers, column);
  const matches = (r) => colIndex !== -1 && matchesCondition(r[colIndex] ?? '', operator, value);
  return { yes: { headers: table.headers, rows: table.rows.filter(matches) }, no: { headers: table.headers, rows: table.rows.filter((r) => !matches(r)) } };
}
function splitLines(text, operator, value) {
  const lines = text.split('\\n').map((l) => l.trim()).filter((l) => l.length > 0);
  return { yes: lines.filter((l) => matchesCondition(l, operator, value)), no: lines.filter((l) => !matchesCondition(l, operator, value)) };
}
function rowToMarkdown(headers, row) {
  return headers.map((h, i) => \`**\${h}**: \${row[i] ?? ''}\`).join(', ');
}
function tableToMarkdown(t) {
  if (t.rows.length === 0) return '_No rows._';
  const head = \`| \${t.headers.join(' | ')} |\`;
  const sep = \`| \${t.headers.map(() => '---').join(' | ')} |\`;
  const body = t.rows.map((r) => \`| \${r.join(' | ')} |\`).join('\\n');
  return [head, sep, body].join('\\n');
}

// ---- SDK helpers ----
let currentChatModelId = null;
async function ensureChatModel(modelConst) {
  if (currentChatModelId) return currentChatModelId;
  const modelSrc = sdk[modelConst];
  if (!modelSrc) throw new Error(\`@qvac/sdk does not export \${modelConst} in this build\`);
  currentChatModelId = await sdk.loadModel({ modelSrc, modelConfig: { ctx_size: 4096 } });
  return currentChatModelId;
}
async function askAgent(task) {
  const modelId = await ensureChatModel(${jsString(DEFAULT_CHAT_MODEL_CONST)});
  const result = sdk.completion({ modelId, history: [{ role: 'user', content: task }], stream: false, generationParams: { predict: 512 } });
  let text = '';
  for await (const event of result.events) {
    if (event && (event.type === 'contentDelta' || event.type === 'rawDelta') && typeof event.text === 'string') text += event.text;
  }
  return text;
}
`.trim();

/** Generates one self-contained CommonJS script: real \`@qvac/sdk\` calls in
 *  topological order, no dependency on the playground app to run it. */
export async function generateStandaloneScript(workflow: SavedWorkflow): Promise<string> {
  const order = topoOrder(workflow);
  const lines: string[] = [];
  lines.push(`// Generated by Tether Academy Playground from "${workflow.name}". Edit freely; this`);
  lines.push('// is your code now, not a synced copy. Run with: npm install @qvac/sdk && node run.cjs');
  lines.push('//');
  lines.push('// PLAYGROUND_WORKFLOW (round-trip source; safe to delete, kept for re-import):');
  lines.push('// ' + JSON.stringify(workflow).replace(/\*\//g, '*\\/'));
  lines.push("'use strict';");
  lines.push('');
  lines.push("const sdk = require('@qvac/sdk');");
  lines.push('');
  lines.push(RUNTIME_HELPERS);
  lines.push('');
  lines.push('async function main() {');
  lines.push('  const out = {}; // node id -> table | string, this run\'s outputs');

  for (const node of order) {
    if (node.kind === 'start') continue;
    const f = (key: string) => jsString(node.fields[key] ?? '');
    const varName = `n_${node.id}`;
    lines.push(`  // --- ${node.kind}: ${node.id} ---`);
    switch (node.kind) {
      case 'read-file': {
        const picked = parsePickedFiles(node.fields.file)[0];
        const table = picked ? await parseSpreadsheetFile(picked.name, picked.dataUrl) : parseCsvFallback();
        const label = picked?.name ?? 'sample-expenses.csv (no file was ever picked on this node)';
        lines.push(`  const ${varName} = ${JSON.stringify(table)};`);
        lines.push(`  out[${jsString(node.id)}] = ${varName};`);
        lines.push(`  console.log(${jsString(label)} + ':', ${varName}.rows.length, 'rows');`);
        break;
      }
      case 'filter': {
        const inEdge = edgeInto(workflow, node.id);
        const src = outKeyExpr(inEdge);
        lines.push(`  if (findColumnIndex(${src}.headers, ${f('column')}) === -1) {`);
        lines.push(`    console.error('Column ' + ${f('column')} + ' not found. This table has: ' + ${src}.headers.join(', '));`);
        lines.push(`  }`);
        lines.push(`  const ${varName} = filterTable(${src}, ${f('column')}, ${f('value')});`);
        lines.push(`  out[${jsString(node.id)}] = ${varName};`);
        lines.push(`  console.log(${varName}.rows.length, 'of', (${src} && ${src}.rows.length) || 0, 'rows match');`);
        break;
      }
      case 'if': {
        const inEdge = edgeInto(workflow, node.id);
        const src = outKeyExpr(inEdge);
        lines.push(`  {`);
        lines.push(`    const input = ${src};`);
        lines.push(`    if (typeof input === 'string') {`);
        lines.push(`      const { yes, no } = splitLines(input, ${f('operator')}, ${f('value')});`);
        lines.push(`      out[${jsString(node.id)} + '::true'] = yes.join('\\n');`);
        lines.push(`      out[${jsString(node.id)} + '::false'] = no.join('\\n');`);
        lines.push(`    } else {`);
        lines.push(`      if (findColumnIndex(input.headers, ${f('column')}) === -1) {`);
        lines.push(`        console.error('Column ' + ${f('column')} + ' not found. This table has: ' + input.headers.join(', '));`);
        lines.push(`      }`);
        lines.push(`      const { yes, no } = splitTable(input, ${f('column')}, ${f('operator')}, ${f('value')});`);
        lines.push(`      out[${jsString(node.id)} + '::true'] = yes;`);
        lines.push(`      out[${jsString(node.id)} + '::false'] = no;`);
        lines.push(`    }`);
        lines.push(`  }`);
        break;
      }
      case 'iterate-ai': {
        const inEdge = edgeInto(workflow, node.id);
        const src = outKeyExpr(inEdge);
        lines.push(`  {`);
        lines.push(`    const input = ${src};`);
        lines.push(`    const rows = (input && input.rows || []).slice(0, 5);`);
        lines.push(`    for (const row of rows) {`);
        lines.push(`      const reply = await askAgent(${f('task')} + '\\n\\nRow: ' + rowToMarkdown(input.headers, row));`);
        lines.push(`      console.log(reply);`);
        lines.push(`    }`);
        lines.push(`  }`);
        break;
      }
      case 'ai-agent': {
        const inEdge = edgeInto(workflow, node.id);
        const src = outKeyExpr(inEdge);
        lines.push(`  {`);
        lines.push(`    const upstream = ${src};`);
        lines.push(
          `    const prompt = typeof upstream === 'string' ? (${f('task')} + '\\n\\nInput: ' + upstream) : upstream ? (${f('task')} + '\\n\\nData:\\n' + tableToMarkdown(upstream)) : ${f('task')};`,
        );
        lines.push(`    const ${varName} = await askAgent(prompt);`);
        lines.push(`    out[${jsString(node.id)}] = ${varName};`);
        lines.push(`    console.log(${varName});`);
        lines.push(`  }`);
        break;
      }
      case 'translate': {
        const isCustom = node.fields.source !== 'Previous result';
        const inEdge = edgeInto(workflow, node.id);
        const src = isCustom ? f('text') : outKeyExpr(inEdge);
        lines.push(`  {`);
        lines.push(`    const text = ${src};`);
        lines.push(
          `    const ${varName} = await askAgent('Translate the following text to ' + ${f('language') || jsString('Spanish')} + '. Reply with only the translation, nothing else.\\n\\n' + text);`,
        );
        lines.push(`    out[${jsString(node.id)}] = ${varName};`);
        lines.push(`    console.log(${varName});`);
        lines.push(`  }`);
        break;
      }
      case 'ask-doc': {
        const isCustom = node.fields.source !== 'Previous result';
        const inEdge = edgeInto(workflow, node.id);
        const src = isCustom ? f('document') : outKeyExpr(inEdge);
        lines.push(`  {`);
        lines.push(`    const document = ${src};`);
        lines.push(
          `    const ${varName} = await askAgent('Answer the question using only the text below. If the answer isn\\'t in the text, say so.\\n\\nText:\\n' + document + '\\n\\nQuestion: ' + ${f('question')});`,
        );
        lines.push(`    out[${jsString(node.id)}] = ${varName};`);
        lines.push(`    console.log(${varName});`);
        lines.push(`  }`);
        break;
      }
      case 'ask-confirmation': {
        lines.push(`  {`);
        lines.push(`    const rl = require('node:readline/promises').createInterface({ input: process.stdin, output: process.stdout });`);
        lines.push(`    const answer = (await rl.question(${f('message') || jsString('Continue?')} + ' [y/n] ')).trim().toLowerCase();`);
        lines.push(`    rl.close();`);
        lines.push(`    out[${jsString(node.id)}] = answer.startsWith('y') ? 'yes' : 'no';`);
        lines.push(`  }`);
        break;
      }
      default: {
        lines.push(`  console.log(${jsString(`[${node.kind}] not supported by this export yet]`)});`);
      }
    }
    lines.push('');
  }

  lines.push('}');
  lines.push('');
  lines.push('main().catch((err) => { console.error(err); process.exitCode = 1; });');
  return lines.join('\n');
}
