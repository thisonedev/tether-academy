'use client';

import '@xyflow/react/dist/style.css';
import {
  Background,
  type Connection,
  type Edge,
  type Node,
  type OnConnect,
  ReactFlow,
  ReactFlowProvider,
  addEdge,
  useEdgesState,
  useNodesState,
  useReactFlow,
} from '@xyflow/react';
import type { AcademyAPI } from '@academy/validation';
import { Download, Eraser, Loader2, Pencil, Play, RotateCcw, Square } from 'lucide-react';
import { useCallback, useEffect, useRef, useState } from 'react';
import { PlaygroundConfigPopup } from './playground-config-popup.js';
import { PlaygroundConsole } from './playground-console.js';
import { PlaygroundExportPopup } from './playground-export-popup.js';
import { buildConversationMarkdown, type ExportFormat } from './playground-export.js';
import { PLAYGROUND_NODE_DEFS } from './playground-node-defs.js';
import { PLAYGROUND_DRAG_MIME, PlaygroundPalette } from './playground-palette.js';
import { PlaygroundFlowNode } from './playground-flow-node.js';
import type { PlaygroundNodeData } from './playground-types.js';
import type { ConsoleEntry } from './lesson-console.js';

declare global {
  interface Window {
    academy?: AcademyAPI;
  }
}

const NODE_TYPES = { playgroundNode: PlaygroundFlowNode };
// The start node's flow position (see initialGraph) plus half its own size.
const START_NODE_CENTER = { x: 130 + 24, y: 20 + 24 };
const VIEWPORT_ZOOM = 0.85;
// setCenter puts this point in the exact middle of the pane; targeting a point
// below the node keeps it horizontally centered but pushes it up into the
// canvas's upper portion instead of dead center.
const VIEWPORT_FOCUS = { x: START_NODE_CENTER.x, y: START_NODE_CENTER.y + 220 };
const MIN_PANEL_WIDTH = 340;
const DEFAULT_PANEL_WIDTH = 410;
const MAX_PANEL_WIDTH = 720;
// A conversation mixes prose and tables, so CSV/Excel (row-shaped formats) only
// show up for a single table's own export, not the whole thing.
const CONVERSATION_FORMATS: ExportFormat[] = ['pdf', 'markdown', 'txt', 'docx'];
const TABLE_FORMATS: ExportFormat[] = ['pdf', 'markdown', 'txt', 'csv', 'docx', 'xlsx'];

let idSeq = 1;
const nextId = () => `n${idSeq++}`;
let entrySeq = 1;
const nextEntryId = () => `re${entrySeq++}`;

function makeNode(kind: string, x: number, y: number): Node<PlaygroundNodeData> {
  const def = PLAYGROUND_NODE_DEFS[kind];
  return {
    id: nextId(),
    type: 'playgroundNode',
    position: { x, y },
    data: { kind, fields: def.defaultFields(), stepNumber: null },
  };
}

/** Kahn's algorithm over the current edges; both the step numbers on cards and the
 *  Run order are derived from this one list, so they can never disagree. */
function topoOrderIds(nodes: Node<PlaygroundNodeData>[], edges: Edge[]): string[] {
  const indeg = new Map(nodes.map((n) => [n.id, 0]));
  for (const e of edges) indeg.set(e.target, (indeg.get(e.target) ?? 0) + 1);
  let ready = nodes.filter((n) => indeg.get(n.id) === 0).map((n) => n.id);
  const remaining = new Map(indeg);
  const order: string[] = [];
  while (ready.length > 0) {
    const id = ready.shift();
    if (id === undefined) break;
    order.push(id);
    for (const e of edges.filter((e2) => e2.source === id)) {
      const left = (remaining.get(e.target) ?? 1) - 1;
      remaining.set(e.target, left);
      if (left === 0) ready.push(e.target);
    }
  }
  return order;
}

function initialGraph(): { nodes: Node<PlaygroundNodeData>[]; edges: Edge[] } {
  const start = makeNode('start', 130, 20);
  return {
    nodes: [start],
    edges: [],
  };
}
const INITIAL_GRAPH = initialGraph();

function PlaygroundCanvas() {
  const [nodes, setNodes, onNodesChange] = useNodesState<Node<PlaygroundNodeData>>(INITIAL_GRAPH.nodes);
  const [edges, setEdges, onEdgesChange] = useEdgesState<Edge>(INITIAL_GRAPH.edges);
  const [entries, setEntries] = useState<ConsoleEntry[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [rejectMessage, setRejectMessage] = useState<string | null>(null);
  const [exportRequest, setExportRequest] = useState<{
    title: string;
    markdown: string;
    formats: ExportFormat[];
    defaultName: string;
  } | null>(null);
  const [workflowName, setWorkflowName] = useState('Untitled workflow');
  const [editingName, setEditingName] = useState(false);
  const commitWorkflowName = useCallback(() => {
    setWorkflowName((prev) => prev.trim() || 'Untitled workflow');
    setEditingName(false);
  }, []);
  const [panelWidth, setPanelWidth] = useState(DEFAULT_PANEL_WIDTH);
  const [isResizingPanel, setIsResizingPanel] = useState(false);
  const wrapperRef = useRef<HTMLDivElement>(null);
  const rowRef = useRef<HTMLDivElement>(null);
  const { screenToFlowPosition, setCenter } = useReactFlow();
  const centerOnStart = useCallback(
    (duration?: number) => setCenter(VIEWPORT_FOCUS.x, VIEWPORT_FOCUS.y, { zoom: VIEWPORT_ZOOM, duration }),
    [setCenter],
  );

  // Current width is the floor: dragging left only ever grows it back to here.
  useEffect(() => {
    if (!isResizingPanel) return;
    const onMove = (e: PointerEvent) => {
      const rect = rowRef.current?.getBoundingClientRect();
      if (!rect) return;
      const next = rect.right - e.clientX;
      setPanelWidth(Math.min(MAX_PANEL_WIDTH, Math.max(MIN_PANEL_WIDTH, next)));
    };
    const onUp = () => setIsResizingPanel(false);
    window.addEventListener('pointermove', onMove);
    window.addEventListener('pointerup', onUp);
    return () => {
      window.removeEventListener('pointermove', onMove);
      window.removeEventListener('pointerup', onUp);
    };
  }, [isResizingPanel]);

  const order = topoOrderIds(nodes, edges);
  const stepNumbers = new Map(order.map((id, i) => [id, i + 1]));
  const renderedNodes = nodes.map((n) => ({
    ...n,
    data: { ...n.data, stepNumber: stepNumbers.get(n.id) ?? null },
  }));

  const isValidConnection = useCallback(
    (conn: Connection | Edge) => {
      const source = nodes.find((n) => n.id === conn.source);
      const target = nodes.find((n) => n.id === conn.target);
      if (!source || !target) return false;
      const outType = PLAYGROUND_NODE_DEFS[source.data.kind]?.output;
      const inType = PLAYGROUND_NODE_DEFS[target.data.kind]?.input;
      // 'flow' carries no data, so it fits any socket: a trigger just means "run this next."
      const ok = outType != null && (outType === inType || outType === 'flow');
      if (!ok) {
        setRejectMessage(`Doesn't fit: "${PLAYGROUND_NODE_DEFS[source.data.kind]?.label}" doesn't plug into "${PLAYGROUND_NODE_DEFS[target.data.kind]?.label}".`);
        window.setTimeout(() => setRejectMessage(null), 2600);
      }
      return ok;
    },
    [nodes],
  );

  const onConnect: OnConnect = useCallback(
    (connection) => setEdges((eds) => addEdge(connection, eds)),
    [setEdges],
  );

  const onDrop = useCallback(
    (e: React.DragEvent) => {
      e.preventDefault();
      const kind = e.dataTransfer.getData(PLAYGROUND_DRAG_MIME);
      if (!kind || !PLAYGROUND_NODE_DEFS[kind]) return;
      const position = screenToFlowPosition({ x: e.clientX, y: e.clientY });
      const node = makeNode(kind, position.x - 100, position.y - 30);
      setNodes((nds) => [...nds, node]);
      setSelectedId(node.id);
    },
    [screenToFlowPosition, setNodes],
  );

  const setAssistantEntry = useCallback((id: string, update: (e: Extract<ConsoleEntry, { kind: 'chat-assistant' }>) => Extract<ConsoleEntry, { kind: 'chat-assistant' }>) => {
    setEntries((prev) => prev.map((e) => (e.id === id && e.kind === 'chat-assistant' ? update(e) : e)));
  }, []);

  // Read inside the run loop's for-await, not React state: a state read would
  // only ever see the value from when the closure was created, not a Stop
  // click that happens mid-run.
  const stopRequestedRef = useRef(false);
  const pendingRequestIdRef = useRef<string | null>(null);
  const [stopRequested, setStopRequested] = useState(false);

  // An agent node's reply is a model completion, not a code run, so it goes through the
  // same `chat.send` bridge real lesson chat uses (already tuned: stripping, token budget,
  // no leftover markers) rather than a hand-rolled `academy.run` snippet with none of that.
  const runAgentNode = useCallback(
    (task: string) =>
      new Promise<void>((resolve) => {
        const entryId = nextEntryId();
        setEntries((prev) => [...prev, { kind: 'chat-assistant', id: entryId, content: '', streaming: true }]);

        if (typeof window.academy?.chat?.send !== 'function') {
          setAssistantEntry(entryId, (e) => ({
            ...e,
            content: 'Running a block is only available in the desktop app.',
            streaming: false,
          }));
          resolve();
          return;
        }

        let unsubscribe: (() => void) | undefined;
        window.academy.chat
          .send({ messages: [{ role: 'user', content: task }], lessonKey: null })
          .then(({ requestId }) => {
            pendingRequestIdRef.current = requestId;
            unsubscribe = window.academy?.chat?.onChunk?.((chunk) => {
              if (chunk.requestId !== requestId) return;
              if (chunk.error) {
                setAssistantEntry(entryId, (e) => ({ ...e, content: chunk.error ?? 'Run failed.', streaming: false }));
              } else if (!chunk.done) {
                setAssistantEntry(entryId, (e) => ({
                  ...e,
                  content: chunk.replace ? chunk.delta : e.content + chunk.delta,
                }));
              }
              if (chunk.done) {
                setAssistantEntry(entryId, (e) => ({ ...e, streaming: false }));
                unsubscribe?.();
                pendingRequestIdRef.current = null;
                resolve();
              }
            });
          })
          .catch((err: unknown) => {
            setAssistantEntry(entryId, (e) => ({
              ...e,
              content: err instanceof Error ? err.message : 'Run failed.',
              streaming: false,
            }));
            pendingRequestIdRef.current = null;
            resolve();
          });
      }),
    [setAssistantEntry],
  );

  const [isRunning, setIsRunning] = useState(false);
  const handleRun = useCallback(async () => {
    stopRequestedRef.current = false;
    setStopRequested(false);
    setIsRunning(true);
    try {
      for (const id of topoOrderIds(nodes, edges)) {
        if (stopRequestedRef.current) break;
        const node = nodes.find((n) => n.id === id);
        if (!node || node.data.kind === 'start') continue;

        if (node.data.kind !== 'ai-agent') {
          setEntries((prev) => [
            ...prev,
            { kind: 'run', id: nextEntryId(), lines: [{ stream: 'stdout', line: '[not wired up yet]' }], status: 'ok' },
          ]);
          continue;
        }

        await runAgentNode(node.data.fields.task ?? '');
      }
    } finally {
      setIsRunning(false);
      setStopRequested(false);
      stopRequestedRef.current = false;
    }
  }, [nodes, edges, runAgentNode]);

  // Stops the queue between nodes; the in-flight agent call itself only stops
  // early when the desktop bridge can actually abort it.
  const handleStop = useCallback(() => {
    if (!isRunning || stopRequestedRef.current) return;
    stopRequestedRef.current = true;
    setStopRequested(true);
    const requestId = pendingRequestIdRef.current;
    if (requestId) void window.academy?.chat?.stop?.(requestId).catch(() => undefined);
  }, [isRunning]);

  const handleReset = useCallback(() => {
    const fresh = initialGraph();
    setNodes(fresh.nodes);
    setEdges(fresh.edges);
    setSelectedId(null);
    setEntries([]);
    centerOnStart(200);
  }, [setNodes, setEdges, centerOnStart]);

  const selectedNode = nodes.find((n) => n.id === selectedId) ?? null;
  const anchorEl = selectedId
    ? (wrapperRef.current?.querySelector<HTMLElement>(`[data-id="${selectedId}"]`) ?? null)
    : null;

  const conversationMarkdown = buildConversationMarkdown(entries);
  // Gated on a reply or a run actually having something to show, not just a
  // sent question: entries.length alone goes up the instant a message is sent,
  // before the model has said anything back.
  const hasExportableOutput = entries.some(
    (e) =>
      (e.kind === 'chat-assistant' && e.content.trim().length > 0) ||
      (e.kind === 'run' && e.lines.some((l) => l.line.trim().length > 0)),
  );

  return (
    <div className="flex h-full min-h-0 flex-1 flex-col">
      <div className="flex h-11 shrink-0 items-center justify-between gap-2 border-b border-canvas-border bg-canvas px-3 py-2 sm:px-4">
        <div className="flex min-w-0 items-center gap-2 text-sm">
          <span className={`size-2 shrink-0 rounded-full bg-emerald-500 ${isRunning ? 'animate-pulse' : ''}`} />
          {editingName ? (
            <input
              // biome-ignore lint/a11y/noAutofocus: opened by the user's own click on the edit icon right next to it
              autoFocus
              value={workflowName}
              onChange={(e) => setWorkflowName(e.target.value)}
              onBlur={commitWorkflowName}
              onKeyDown={(e) => {
                if (e.key === 'Enter') {
                  e.preventDefault();
                  commitWorkflowName();
                } else if (e.key === 'Escape') {
                  e.preventDefault();
                  setEditingName(false);
                }
              }}
              className="min-w-0 flex-1 rounded border border-emerald-500/60 bg-canvas px-1.5 py-0.5 font-mono text-canvas-foreground focus:outline-none focus:ring-1 focus:ring-emerald-500/30"
            />
          ) : (
            <>
              <span className="truncate font-mono text-canvas-foreground">{workflowName}</span>
              <button
                type="button"
                onClick={() => setEditingName(true)}
                className="shrink-0 text-canvas-muted-foreground transition-colors hover:text-canvas-foreground"
                title="Rename workflow"
                aria-label="Rename workflow"
              >
                <Pencil className="size-3.5" />
              </button>
            </>
          )}
        </div>
        <div className="flex min-w-0 items-center gap-1 text-canvas-muted-foreground sm:gap-2">
          <button
            type="button"
            onClick={isRunning ? handleStop : handleRun}
            disabled={isRunning && stopRequested}
            className={
              isRunning
                ? stopRequested
                  ? 'inline-flex shrink-0 items-center gap-1.5 rounded-md bg-canvas-muted px-2.5 py-1 text-xs font-semibold text-canvas-muted-foreground disabled:cursor-not-allowed disabled:opacity-60'
                  : 'inline-flex shrink-0 items-center justify-center rounded p-1.5 text-red-400 transition-colors hover:bg-red-500/10 hover:text-red-300 disabled:cursor-not-allowed disabled:opacity-40'
                : 'inline-flex shrink-0 items-center justify-center rounded p-1.5 text-canvas-muted-foreground transition-colors hover:bg-canvas-muted hover:text-canvas-foreground disabled:cursor-not-allowed disabled:opacity-40'
            }
            title={stopRequested ? 'Stopping…' : isRunning ? 'Stop run' : 'Run'}
            aria-label={stopRequested ? 'Stopping' : isRunning ? 'Stop run' : 'Run'}
          >
            {isRunning ? (
              stopRequested ? (
                <>
                  <Loader2 className="size-3.5 animate-spin" />
                  <span>Stopping…</span>
                </>
              ) : (
                <Square className="size-4 fill-current" />
              )
            ) : (
              <Play className="size-4 fill-current" />
            )}
          </button>
          <button
            type="button"
            onClick={handleReset}
            disabled={isRunning}
            className="shrink-0 rounded p-1.5 text-canvas-muted-foreground transition-colors hover:bg-canvas-muted hover:text-canvas-foreground disabled:cursor-not-allowed disabled:opacity-40"
            title="Reset playground"
            aria-label="Reset playground"
          >
            <RotateCcw className="size-4" />
          </button>
          <button
            type="button"
            onClick={() => setEntries([])}
            disabled={entries.length === 0 || isRunning}
            className="shrink-0 rounded p-1.5 text-canvas-muted-foreground transition-colors hover:bg-canvas-muted hover:text-canvas-foreground disabled:cursor-not-allowed disabled:opacity-40"
            title="Clear output"
            aria-label="Clear output"
          >
            <Eraser className="size-4" />
          </button>
          <button
            type="button"
            onClick={() =>
              setExportRequest({
                title: 'Export conversation',
                markdown: conversationMarkdown,
                formats: CONVERSATION_FORMATS,
                defaultName: workflowName,
              })
            }
            disabled={!hasExportableOutput || isRunning}
            className="shrink-0 rounded p-1.5 text-canvas-muted-foreground transition-colors hover:bg-canvas-muted hover:text-canvas-foreground disabled:cursor-not-allowed disabled:opacity-40"
            title="Export conversation"
            aria-label="Export conversation"
          >
            <Download className="size-4" />
          </button>
        </div>
      </div>

      <div ref={rowRef} className="flex min-h-0 flex-1">
        <div ref={wrapperRef} className="relative h-full min-w-0 flex-1">
          <ReactFlow
            nodes={renderedNodes}
            edges={edges}
            onNodesChange={onNodesChange}
            onEdgesChange={onEdgesChange}
            onConnect={onConnect}
            isValidConnection={isValidConnection}
            nodeTypes={NODE_TYPES}
            onNodeClick={(_, node) => setSelectedId(node.id)}
            onPaneClick={() => setSelectedId(null)}
            onDrop={onDrop}
            onDragOver={(e) => e.preventDefault()}
            onInit={() => centerOnStart()}
          >
            <Background gap={22} color="#22262b" />
          </ReactFlow>

          {selectedNode && anchorEl && (
            <PlaygroundConfigPopup
              nodeId={selectedNode.id}
              kind={selectedNode.data.kind}
              fields={selectedNode.data.fields}
              anchorEl={anchorEl}
              onChange={(key, value) =>
                setNodes((nds) =>
                  nds.map((n) =>
                    n.id === selectedNode.id
                      ? { ...n, data: { ...n.data, fields: { ...n.data.fields, [key]: value } } }
                      : n,
                  ),
                )
              }
              onDelete={() => {
                setNodes((nds) => nds.filter((n) => n.id !== selectedNode.id));
                setEdges((eds) => eds.filter((e) => e.source !== selectedNode.id && e.target !== selectedNode.id));
                setSelectedId(null);
              }}
              onClose={() => setSelectedId(null)}
            />
          )}

          {rejectMessage && (
            <div className="fixed bottom-6 left-1/2 z-50 -translate-x-1/2 rounded-lg border border-red-400/40 bg-canvas-muted px-4 py-2 font-mono text-[12.5px] text-red-400 shadow-lg">
              {rejectMessage}
            </div>
          )}
        </div>

        <button
          type="button"
          onPointerDown={(e) => {
            e.preventDefault();
            setIsResizingPanel(true);
          }}
          aria-label="Resize output panel"
          title="Drag to resize"
          className="w-1 shrink-0 cursor-col-resize border-l border-canvas-border bg-transparent transition-colors hover:bg-emerald-500/50"
        />

        <div style={{ width: panelWidth }} className="h-full shrink-0 bg-canvas">
          <PlaygroundConsole
            entries={entries}
            setEntries={setEntries}
            onExportTable={(markdown) =>
              setExportRequest({ title: 'Export table', markdown, formats: TABLE_FORMATS, defaultName: workflowName })
            }
          />
        </div>
      </div>

      {exportRequest && (
        <PlaygroundExportPopup
          title={exportRequest.title}
          initialMarkdown={exportRequest.markdown}
          formats={exportRequest.formats}
          defaultName={exportRequest.defaultName}
          onClose={() => setExportRequest(null)}
        />
      )}
    </div>
  );
}

export function Playground() {
  return (
    <div className="flex h-[calc(100vh-56px)] w-full bg-canvas">
      <PlaygroundPalette />
      <ReactFlowProvider>
        <PlaygroundCanvas />
      </ReactFlowProvider>
    </div>
  );
}
