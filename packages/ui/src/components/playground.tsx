'use client';

import '@xyflow/react/dist/style.css';
import type { AcademyAPI } from '@academy/validation';
import {
  addEdge,
  Background,
  type Connection,
  type Edge,
  type Node,
  type OnConnect,
  ReactFlow,
  ReactFlowProvider,
  useEdgesState,
  useNodesState,
  useReactFlow,
} from '@xyflow/react';
import { Download, Eraser, FolderOpen, History, Loader2, Pencil, Play, RotateCcw, Save, Square } from 'lucide-react';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { ConsoleEntry } from './lesson-console.js';
import { PlaygroundConfigPopup } from './playground-config-popup.js';
import { PlaygroundConsole } from './playground-console.js';
import { buildConversationMarkdown, type ExportFormat } from './playground-export.js';
import { PlaygroundExportPopup } from './playground-export-popup.js';
import { PlaygroundFlowNode } from './playground-flow-node.js';
import { BRANCH_COLOR, PLAYGROUND_NODE_DEFS, PORT_COLOR } from './playground-node-defs.js';
import { PLAYGROUND_DRAG_MIME, PlaygroundPalette } from './playground-palette.js';
import type { PlaygroundTable } from './playground-table.js';
import type { PlaygroundNodeData } from './playground-types.js';
import {
  canPickFiles,
  downloadWorkflow,
  listRecentWorkflows,
  parseWorkflowFile,
  pickOpenHandle,
  pickSaveHandle,
  recordRecentWorkflow,
  type RecentWorkflowEntry,
  type SavedWorkflow,
  writeWorkflowToHandle,
} from './playground-workflow.js';

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
    data: { kind, fields: def.defaultFields() },
  };
}

/** Kahn's algorithm over the current edges; both the step numbers on cards and the
 *  Run order are derived from this one list, so they can never disagree. */
function topoOrderIds(nodes: Node<PlaygroundNodeData>[], edges: Edge[]): string[] {
  const indeg = new Map(nodes.map((n) => [n.id, 0]));
  for (const e of edges) indeg.set(e.target, (indeg.get(e.target) ?? 0) + 1);
  const ready = nodes.filter((n) => indeg.get(n.id) === 0).map((n) => n.id);
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

/** The output type of whatever node feeds `id`, or null if nothing does. */
function inputKindFor(id: string, nodes: Node<PlaygroundNodeData>[], edges: Edge[]) {
  const edge = edges.find((e) => e.target === id);
  const source = edge ? nodes.find((n) => n.id === edge.source) : undefined;
  return source ? (PLAYGROUND_NODE_DEFS[source.data.kind]?.output ?? null) : null;
}

function initialGraph(): { nodes: Node<PlaygroundNodeData>[]; edges: Edge[] } {
  const start = makeNode('start', 130, 20);
  return {
    nodes: [start],
    edges: [],
  };
}
const INITIAL_GRAPH = initialGraph();

// Navigating to another route (Courses, etc.) unmounts PlaygroundCanvas entirely,
// so its own useState would reset on return. Held here instead, outside React, it
// survives that; it only clears on an actual page reload/app restart, or Reset.
let heldState: {
  nodes: Node<PlaygroundNodeData>[];
  edges: Edge[];
  entries: ConsoleEntry[];
  workflowName: string;
  fileHandle: FileSystemFileHandle | null;
} | null = null;

function PlaygroundCanvas() {
  const [nodes, setNodes, onNodesChange] = useNodesState<Node<PlaygroundNodeData>>(
    heldState?.nodes ?? INITIAL_GRAPH.nodes,
  );
  const [edges, setEdges, onEdgesChange] = useEdgesState<Edge>(heldState?.edges ?? INITIAL_GRAPH.edges);
  const [entries, setEntries] = useState<ConsoleEntry[]>(heldState?.entries ?? []);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [rejectMessage, setRejectMessage] = useState<string | null>(null);
  const [exportRequest, setExportRequest] = useState<{
    title: string;
    markdown: string;
    formats: ExportFormat[];
    defaultName: string;
  } | null>(null);
  const [workflowName, setWorkflowName] = useState(heldState?.workflowName ?? 'Untitled workflow');
  const [editingName, setEditingName] = useState(false);
  const commitWorkflowName = useCallback(() => {
    setWorkflowName((prev) => prev.trim() || 'Untitled workflow');
    setEditingName(false);
  }, []);
  // Loaded lazily (not on mount): reading localStorage during the initial render
  // would differ between server and client and trip a hydration mismatch.
  const [recentWorkflows, setRecentWorkflows] = useState<RecentWorkflowEntry[]>([]);
  const [showRecent, setShowRecent] = useState(false);
  const recentMenuRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!showRecent) return;
    function onPointerDown(e: MouseEvent) {
      if (e.target instanceof Node && recentMenuRef.current?.contains(e.target)) return;
      setShowRecent(false);
    }
    document.addEventListener('mousedown', onPointerDown);
    return () => document.removeEventListener('mousedown', onPointerDown);
  }, [showRecent]);
  const [panelWidth, setPanelWidth] = useState(DEFAULT_PANEL_WIDTH);
  const [isResizingPanel, setIsResizingPanel] = useState(false);
  const wrapperRef = useRef<HTMLDivElement>(null);
  const rowRef = useRef<HTMLDivElement>(null);
  const { screenToFlowPosition, setCenter } = useReactFlow();
  const centerOnStart = useCallback(
    (duration?: number) =>
      setCenter(VIEWPORT_FOCUS.x, VIEWPORT_FOCUS.y, { zoom: VIEWPORT_ZOOM, duration }),
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

  const isValidConnection = useCallback(
    (conn: Connection | Edge) => {
      const source = nodes.find((n) => n.id === conn.source);
      const target = nodes.find((n) => n.id === conn.target);
      if (!source || !target) return false;
      const outType = PLAYGROUND_NODE_DEFS[source.data.kind]?.output;
      const inType = PLAYGROUND_NODE_DEFS[target.data.kind]?.input;
      // 'flow' carries no data, so it fits any socket: a trigger just means "run this next."
      // 'any' (currently just If) accepts or forwards whichever type actually shows up.
      const ok =
        outType != null &&
        (outType === inType || outType === 'flow' || inType === 'any' || outType === 'any');
      if (!ok) {
        setRejectMessage(
          `Doesn't fit: "${PLAYGROUND_NODE_DEFS[source.data.kind]?.label}" doesn't plug into "${PLAYGROUND_NODE_DEFS[target.data.kind]?.label}".`,
        );
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
      if (!kind || !PLAYGROUND_NODE_DEFS[kind] || PLAYGROUND_NODE_DEFS[kind].inactive) return;
      const position = screenToFlowPosition({ x: e.clientX, y: e.clientY });
      const node = makeNode(kind, position.x - 100, position.y - 30);
      setNodes((nds) => [...nds, node]);
      setSelectedId(node.id);
    },
    [screenToFlowPosition, setNodes],
  );

  const setAssistantEntry = useCallback(
    (
      id: string,
      update: (
        e: Extract<ConsoleEntry, { kind: 'chat-assistant' }>,
      ) => Extract<ConsoleEntry, { kind: 'chat-assistant' }>,
    ) => {
      setEntries((prev) =>
        prev.map((e) => (e.id === id && e.kind === 'chat-assistant' ? update(e) : e)),
      );
    },
    [],
  );

  // Read inside the run loop's for-await, not React state: a state read would
  // only ever see the value from when the closure was created, not a Stop
  // click that happens mid-run.
  const stopRequestedRef = useRef(false);
  const pendingRequestIdRef = useRef<string | null>(null);
  const [stopRequested, setStopRequested] = useState(false);

  // An agent node's reply is a model completion, not a code run, so it goes through the
  // same `chat.send` bridge real lesson chat uses (already tuned: stripping, token budget,
  // no leftover markers) rather than a hand-rolled `academy.run` snippet with none of that.
  // Resolves with the final reply text (not just void) so a downstream node
  // (If, another agent) can actually read what this one produced.
  const runAgentNode = useCallback(
    (task: string) =>
      new Promise<string>((resolve) => {
        const entryId = nextEntryId();
        let content = '';
        setEntries((prev) => [
          ...prev,
          { kind: 'chat-assistant', id: entryId, content: '', streaming: true },
        ]);

        if (typeof window.academy?.chat?.send !== 'function') {
          content = 'Running a block is only available in the desktop app.';
          setAssistantEntry(entryId, (e) => ({ ...e, content, streaming: false }));
          resolve(content);
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
                content = chunk.error ?? 'Run failed.';
                setAssistantEntry(entryId, (e) => ({ ...e, content, streaming: false }));
              } else if (!chunk.done) {
                content = chunk.replace ? chunk.delta : content + chunk.delta;
                setAssistantEntry(entryId, (e) => ({ ...e, content }));
              }
              if (chunk.done) {
                setAssistantEntry(entryId, (e) => ({ ...e, streaming: false }));
                unsubscribe?.();
                pendingRequestIdRef.current = null;
                resolve(content);
              }
            });
          })
          .catch((err: unknown) => {
            content = err instanceof Error ? err.message : 'Run failed.';
            setAssistantEntry(entryId, (e) => ({ ...e, content, streaming: false }));
            pendingRequestIdRef.current = null;
            resolve(content);
          });
      }),
    [setAssistantEntry],
  );

  const [isRunning, setIsRunning] = useState(false);
  // Which nodes' `run` reported an error on the run currently shown in the
  // output feed; render-only, cleared at the start of every run and reset.
  const [nodeErrors, setNodeErrors] = useState<Set<string>>(new Set());
  // The loop never branches on `kind`: every node contract in PLAYGROUND_NODE_DEFS
  // owns its own `run`, so a new node kind never touches this function.
  const handleRun = useCallback(async () => {
    stopRequestedRef.current = false;
    setStopRequested(false);
    setIsRunning(true);
    setNodeErrors(new Set());
    // Keyed by `nodeId::sourceHandle` (handle is '' for single-output nodes), rebuilt fresh
    // each run. Holds a table or plain text, whichever the upstream node actually produced.
    const nodeOutputs = new Map<string, PlaygroundTable | string>();
    const outKey = (nodeId: string, handle?: string | null) => `${nodeId}::${handle ?? ''}`;
    const pushResult = (content: string) =>
      setEntries((prev) => [
        ...prev,
        { kind: 'chat-assistant', id: nextEntryId(), content, streaming: false },
      ]);
    try {
      for (const id of topoOrderIds(nodes, edges)) {
        if (stopRequestedRef.current) break;
        const node = nodes.find((n) => n.id === id);
        if (!node || node.data.kind === 'start') continue;
        // Closes over this node's id so a failing `run` marks the node that
        // actually failed, not whichever one happens to run next.
        const pushRunLine = (status: 'ok' | 'err', line: string) => {
          setEntries((prev) => [
            ...prev,
            { kind: 'run', id: nextEntryId(), lines: [{ stream: status === 'err' ? 'stderr' : 'stdout', line }], status },
          ]);
          if (status === 'err') setNodeErrors((prev) => new Set(prev).add(id));
        };
        const def = PLAYGROUND_NODE_DEFS[node.data.kind];
        if (!def?.run) {
          pushRunLine('ok', '[not wired up yet]');
          continue;
        }
        const readInput = () => {
          const edge = edges.find((e) => e.target === id);
          return edge ? nodeOutputs.get(outKey(edge.source, edge.sourceHandle)) : undefined;
        };
        // The explicit "Text source" choice, not a connection silently overriding what
        // was typed: undefined means "Previous result" was picked but nothing usable is wired in.
        const resolveContent = (manualKey: string) => {
          const fields = node.data.fields;
          if ((fields.source ?? 'Custom text') !== 'Previous result') return fields[manualKey] ?? '';
          const upstream = readInput();
          // An empty string counts as "nothing usable" too: an upstream If with zero
          // matching items still writes '', which otherwise sailed through as real
          // content and got sent to the model with nothing to actually act on.
          if (typeof upstream !== 'string' || upstream.trim().length === 0) return undefined;
          return upstream;
        };
        try {
          await def.run({
            fields: node.data.fields,
            readInput,
            resolveContent,
            pushResult,
            pushRunLine,
            runAgent: runAgentNode,
            setOutput: (value, handle) => nodeOutputs.set(outKey(id, handle), value),
            stopRequested: () => stopRequestedRef.current,
          });
        } catch (err) {
          // A handler that throws instead of reporting through pushRunLine (an
          // unexpected exception, not a modeled "nothing connected" case) still
          // has to mark its node and keep the run going for whatever's left.
          pushRunLine('err', err instanceof Error ? err.message : 'This step failed.');
        }
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

  // The file this workflow was last opened from or saved to, if the browser
  // supports keeping one: lets Save write back to it directly, no picker, the
  // same "Ctrl+S just saves" behavior every other app has.
  const fileHandleRef = useRef<FileSystemFileHandle | null>(heldState?.fileHandle ?? null);

  // Keeps heldState current every render so it's there to read from if this
  // component unmounts (navigating away) and remounts (navigating back).
  useEffect(() => {
    heldState = { nodes, edges, entries, workflowName, fileHandle: fileHandleRef.current };
  });

  const handleReset = useCallback(() => {
    const fresh = initialGraph();
    setNodes(fresh.nodes);
    setEdges(fresh.edges);
    setSelectedId(null);
    setEntries([]);
    setNodeErrors(new Set());
    setWorkflowName('Untitled workflow');
    fileHandleRef.current = null;
    centerOnStart(200);
  }, [setNodes, setEdges, centerOnStart]);

  const buildWorkflow = useCallback(
    (): SavedWorkflow => ({
      version: 1,
      name: workflowName,
      nodes: nodes.map((n) => ({ id: n.id, kind: n.data.kind, x: n.position.x, y: n.position.y, fields: n.data.fields })),
      edges: edges.map((e) => ({
        source: e.source,
        target: e.target,
        sourceHandle: e.sourceHandle ?? null,
        targetHandle: e.targetHandle ?? null,
      })),
    }),
    [nodes, edges, workflowName],
  );

  const handleSaveWorkflow = useCallback(async () => {
    const workflow = buildWorkflow();
    if (!canPickFiles()) {
      downloadWorkflow(workflow);
      recordRecentWorkflow(workflow);
      return;
    }
    if (!fileHandleRef.current) {
      const handle = await pickSaveHandle(`${workflow.name || 'workflow'}.json`);
      if (!handle) return; // user cancelled the picker
      fileHandleRef.current = handle;
    }
    await writeWorkflowToHandle(fileHandleRef.current, workflow);
    recordRecentWorkflow(workflow);
  }, [buildWorkflow]);

  // Loaded nodes get fresh ids through the same nextId() every other node uses,
  // never the saved ones directly: those came from a different session's counter
  // and could collide with whatever's minted next in this one.
  const applyLoadedWorkflow = useCallback(
    (workflow: ReturnType<typeof parseWorkflowFile>) => {
      const idMap = new Map(workflow.nodes.map((n) => [n.id, nextId()]));
      setNodes(
        workflow.nodes.map((n) => ({
          id: idMap.get(n.id) ?? n.id,
          type: 'playgroundNode',
          position: { x: n.x, y: n.y },
          data: { kind: n.kind, fields: n.fields },
        })),
      );
      setEdges(
        workflow.edges
          .filter((e) => idMap.has(e.source) && idMap.has(e.target))
          .map((e) => ({
            id: nextId(),
            source: idMap.get(e.source) ?? '',
            target: idMap.get(e.target) ?? '',
            sourceHandle: e.sourceHandle,
            targetHandle: e.targetHandle,
          })),
      );
      setWorkflowName(workflow.name);
      setSelectedId(null);
      setEntries([]);
      setNodeErrors(new Set());
      recordRecentWorkflow(workflow);
      centerOnStart(0);
    },
    [setNodes, setEdges, centerOnStart],
  );

  const handleLoadWorkflowFile = useCallback(
    async (file: File) => {
      try {
        // Cleared, not carried over: a stale handle from whatever was open before
        // would otherwise let Ctrl+S silently overwrite the wrong file.
        fileHandleRef.current = null;
        applyLoadedWorkflow(parseWorkflowFile(await file.text()));
      } catch (err) {
        setRejectMessage(err instanceof Error ? err.message : 'Could not read that file.');
        window.setTimeout(() => setRejectMessage(null), 2600);
      }
    },
    [applyLoadedWorkflow],
  );

  const fileInputRef = useRef<HTMLInputElement>(null);
  const handleOpenWorkflow = useCallback(async () => {
    if (!canPickFiles()) {
      fileInputRef.current?.click();
      return;
    }
    const handle = await pickOpenHandle();
    if (!handle) return; // user cancelled the picker
    await handleLoadWorkflowFile(await handle.getFile());
    fileHandleRef.current = handle;
  }, [handleLoadWorkflowFile]);

  // The Recent list holds JSON snapshots, not file handles (see recordRecentWorkflow),
  // so reopening one is a fresh in-memory copy: Ctrl/Cmd+S after this asks where to
  // save, same as any workflow that's never been saved to a file yet.
  const handleOpenRecent = useCallback(
    (entry: RecentWorkflowEntry) => {
      fileHandleRef.current = null;
      applyLoadedWorkflow(entry.workflow);
      setShowRecent(false);
    },
    [applyLoadedWorkflow],
  );

  useEffect(() => {
    function onKeyDown(e: KeyboardEvent) {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 's') {
        e.preventDefault();
        void handleSaveWorkflow();
      }
    }
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [handleSaveWorkflow]);

  const selectedNode = nodes.find((n) => n.id === selectedId) ?? null;
  const anchorEl = selectedId
    ? (wrapperRef.current?.querySelector<HTMLElement>(`[data-id="${selectedId}"]`) ?? null)
    : null;
  // What's actually feeding the selected node, so its popup can hide fields
  // (like If's "Column") that only make sense for a particular input shape.
  const selectedInputKind = selectedNode ? inputKindFor(selectedNode.id, nodes, edges) : null;

  const conversationMarkdown = buildConversationMarkdown(entries);
  // Gated on a reply or a run actually having something to show, not just a
  // sent question: entries.length alone goes up the instant a message is sent,
  // before the model has said anything back.
  const hasExportableOutput = entries.some(
    (e) =>
      (e.kind === 'chat-assistant' && e.content.trim().length > 0) ||
      (e.kind === 'run' && e.lines.some((l) => l.line.trim().length > 0)),
  );

  // `hasError` is render-only (never saved with the workflow); only the errored
  // nodes get a new object, so the rest of the canvas doesn't re-render.
  const nodesForRender = useMemo(
    () => (nodeErrors.size === 0 ? nodes : nodes.map((n) => (nodeErrors.has(n.id) ? { ...n, data: { ...n.data, hasError: true } } : n))),
    [nodes, nodeErrors],
  );

  // A wire is colored by what's actually flowing through it, the same way its
  // ports already are: the branch color for If's Yes/No, otherwise the source
  // node's declared output type. Derived at render, not stored on the edge, so
  // it stays correct even after the source node's kind changes underneath it.
  const edgesForRender = useMemo(
    () =>
      edges.map((e) => {
        const branch = e.sourceHandle === 'true' || e.sourceHandle === 'false' ? e.sourceHandle : null;
        const outputType = PLAYGROUND_NODE_DEFS[nodes.find((n) => n.id === e.source)?.data.kind ?? '']?.output;
        const color = branch ? BRANCH_COLOR[branch] : (outputType && PORT_COLOR[outputType]) || PORT_COLOR.flow;
        return { ...e, style: { stroke: color } };
      }),
    [edges, nodes],
  );

  return (
    <div className="flex h-full min-h-0 flex-1 flex-col">
      <div className="flex h-11 shrink-0 items-center justify-between gap-2 border-b border-canvas-border bg-canvas px-3 py-2 sm:px-4">
        <div className="flex min-w-0 items-center gap-2 text-sm">
          <span
            className={`size-2 shrink-0 rounded-full bg-emerald-500 ${isRunning ? 'animate-pulse' : ''}`}
          />
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
          <button
            type="button"
            onClick={() => void handleSaveWorkflow()}
            disabled={isRunning}
            className="shrink-0 rounded p-1.5 text-canvas-muted-foreground transition-colors hover:bg-canvas-muted hover:text-canvas-foreground disabled:cursor-not-allowed disabled:opacity-40"
            title="Save workflow (⌘S)"
            aria-label="Save workflow"
          >
            <Save className="size-4" />
          </button>
          <button
            type="button"
            onClick={() => void handleOpenWorkflow()}
            disabled={isRunning}
            className="shrink-0 rounded p-1.5 text-canvas-muted-foreground transition-colors hover:bg-canvas-muted hover:text-canvas-foreground disabled:cursor-not-allowed disabled:opacity-40"
            title="Open workflow"
            aria-label="Open workflow"
          >
            <FolderOpen className="size-4" />
          </button>
          <div className="relative shrink-0" ref={recentMenuRef}>
            <button
              type="button"
              onClick={() => {
                setRecentWorkflows(listRecentWorkflows());
                setShowRecent((prev) => !prev);
              }}
              disabled={isRunning}
              className="rounded p-1.5 text-canvas-muted-foreground transition-colors hover:bg-canvas-muted hover:text-canvas-foreground disabled:cursor-not-allowed disabled:opacity-40"
              title="Recent workflows"
              aria-label="Recent workflows"
            >
              <History className="size-4" />
            </button>
            {showRecent && (
              <div className="absolute right-0 top-full z-10 mt-1 w-64 rounded-md border border-canvas-border bg-canvas py-1 shadow-lg">
                {recentWorkflows.length === 0 ? (
                  <div className="px-3 py-2 text-xs text-canvas-muted-foreground">No recent workflows yet.</div>
                ) : (
                  recentWorkflows.map((entry) => (
                    <button
                      key={`${entry.name}-${entry.savedAt}`}
                      type="button"
                      onClick={() => handleOpenRecent(entry)}
                      className="flex w-full flex-col items-start px-3 py-1.5 text-left text-xs hover:bg-canvas-muted"
                    >
                      <span className="truncate font-mono text-canvas-foreground">{entry.name}</span>
                      <span className="text-canvas-muted-foreground">{new Date(entry.savedAt).toLocaleString()}</span>
                    </button>
                  ))
                )}
              </div>
            )}
          </div>
          {/* Fallback only: used when the File System Access API isn't available.
           *  Extension-based accept, not a MIME type, which some OS file dialogs
           *  don't reliably match against an actual .json file's reported type. */}
          <input
            ref={fileInputRef}
            type="file"
            accept=".json,application/json"
            className="hidden"
            onChange={(e) => {
              const file = e.target.files?.[0];
              e.target.value = '';
              if (file) void handleLoadWorkflowFile(file);
            }}
          />
        </div>
      </div>

      <div ref={rowRef} className="flex min-h-0 flex-1">
        <div ref={wrapperRef} className="relative h-full min-w-0 flex-1">
          <ReactFlow
            nodes={nodesForRender}
            edges={edgesForRender}
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
              inputKind={selectedInputKind}
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
                setEdges((eds) =>
                  eds.filter((e) => e.source !== selectedNode.id && e.target !== selectedNode.id),
                );
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
              setExportRequest({
                title: 'Export table',
                markdown,
                formats: TABLE_FORMATS,
                defaultName: workflowName,
              })
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
