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
import {
  ChevronDown,
  Download,
  Eraser,
  FileCode,
  FileText,
  FolderOpen,
  GripVertical,
  Loader2,
  Pencil,
  Play,
  RotateCcw,
  Save,
  Sparkles,
  Square,
} from 'lucide-react';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { ConsoleEntry } from './lesson-console.js';
import { PlaygroundConfigPopup } from './playground-config-popup.js';
import { PlaygroundConsole } from './playground-console.js';
import { generateStandaloneScript } from './playground-codegen.js';
import { buildConversationMarkdown, downloadBlob, type ExportFormat, slugFilename } from './playground-export.js';
import { PlaygroundExportPopup } from './playground-export-popup.js';
import { PlaygroundFlowEdge } from './playground-flow-edge.js';
import type { PresetEntry } from './playground-preset-data.js';
import { PlaygroundPresetsModal } from './playground-presets-modal.js';
import { PlaygroundFlowNode } from './playground-flow-node.js';
import { buildNodeCatalogue, parseGeneratedWorkflow, summarizeCurrentWorkflow } from './playground-generate.js';
import { BRANCH_COLOR, PLAYGROUND_NODE_DEFS, PORT_COLOR, typesCompatible } from './playground-node-defs.js';
import { PLAYGROUND_DRAG_MIME, PlaygroundPalette } from './playground-palette.js';
import type { PlaygroundTable } from './playground-table.js';
import type { PlaygroundNodeData } from './playground-types.js';
import {
  canPickFiles,
  downloadWorkflow,
  parseWorkflowFile,
  pickOpenHandle,
  pickSaveHandle,
  type SavedWorkflow,
  writeWorkflowToHandle,
} from './playground-workflow.js';

declare global {
  interface Window {
    academy?: AcademyAPI;
  }
}

const NODE_TYPES = { playgroundNode: PlaygroundFlowNode };
const EDGE_TYPES = { playgroundEdge: PlaygroundFlowEdge };
// The start node's flow position (see initialGraph) plus half its own size.
const START_NODE_CENTER = { x: 130 + 24, y: 20 + 24 };
const VIEWPORT_ZOOM = 0.85;
// setCenter puts this point in the exact middle of the pane; targeting a point
// below the node keeps it horizontally centered but pushes it up into the
// canvas's upper portion instead of dead center.
const VIEWPORT_FOCUS = { x: START_NODE_CENTER.x, y: START_NODE_CENTER.y + 220 };
// The SDK gives these calls no requestId/signal to cancel; once started, only
// letting the current step finish (never starting the next) is possible.
const UNCANCELABLE_KINDS = new Set(['ocr', 'classify-image', 'generate-image']);
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

function PlaygroundCanvas({
  workflowName,
  setWorkflowName,
  setEditingName,
}: {
  workflowName: string;
  setWorkflowName: (value: string | ((prev: string) => string)) => void;
  setEditingName: (value: boolean) => void;
}) {
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
  const [showFileMenu, setShowFileMenu] = useState(false);
  const fileMenuRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!showFileMenu) return;
    function onPointerDown(e: MouseEvent) {
      if (e.target instanceof Node && fileMenuRef.current?.contains(e.target)) return;
      setShowFileMenu(false);
    }
    // Capture phase: the React Flow canvas stops propagation on its own pane
    // clicks, so a bubble-phase listener never sees a click on the canvas.
    document.addEventListener('mousedown', onPointerDown, true);
    return () => document.removeEventListener('mousedown', onPointerDown, true);
  }, [showFileMenu]);
  const [panelWidth, setPanelWidth] = useState(DEFAULT_PANEL_WIDTH);
  const [isResizingPanel, setIsResizingPanel] = useState(false);
  const wrapperRef = useRef<HTMLDivElement>(null);
  const rowRef = useRef<HTMLDivElement>(null);
  const { screenToFlowPosition, setCenter, fitView } = useReactFlow();
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
      const ok = typesCompatible(outType, inType);
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
  // Which node kind is inside its own `run` right now, so Stop can tell the
  // user when a kind has no way to interrupt an already-started call (the
  // SDK gives ocr/classify-image/generate-image no requestId to cancel).
  const runningKindRef = useRef<string | null>(null);

  // Routes through the same `chat.send` bridge lesson chat uses (already
  // tuned: stripping, token budget), not a hand-rolled `academy.run` call.
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

  // Tries the SDK's dedicated per-language Bergamot NMT models first (real
  // translation, not a chat-model guess); silently falls back to runAgentNode
  // when the bridge is unavailable (web) or the language has no NMT model.
  const translateNode = useCallback(
    async (text: string, language: string): Promise<string> => {
      if (typeof window.academy?.translate === 'function') {
        const entryId = nextEntryId();
        setEntries((prev) => [...prev, { kind: 'chat-assistant', id: entryId, content: '', streaming: true }]);
        try {
          const result = await window.academy.translate(text, language);
          setAssistantEntry(entryId, (e) => ({ ...e, content: result, streaming: false }));
          return result;
        } catch {
          setEntries((prev) => prev.filter((e) => e.id !== entryId));
        }
      }
      return runAgentNode(
        `Translate the following text to ${language}. Reply with only the translation, nothing else.\n\n${text}`,
      );
    },
    [runAgentNode, setAssistantEntry],
  );

  // Keyed by confirm entry id; handleStop resolves every pending one as `false`
  // so a run stuck waiting on the user isn't the one thing Stop can't stop.
  const confirmResolversRef = useRef(new Map<string, (answer: boolean) => void>());
  const confirmNode = useCallback(
    (message: string): Promise<boolean> =>
      new Promise<boolean>((resolve) => {
        const entryId = nextEntryId();
        confirmResolversRef.current.set(entryId, resolve);
        setEntries((prev) => [...prev, { kind: 'confirm', id: entryId, message, answer: null }]);
      }),
    [],
  );
  const handleConfirmAnswer = useCallback((entryId: string, answer: 'yes' | 'no') => {
    setEntries((prev) => prev.map((e) => (e.id === entryId && e.kind === 'confirm' ? { ...e, answer } : e)));
    const resolve = confirmResolversRef.current.get(entryId);
    if (resolve) {
      resolve(answer === 'yes');
      confirmResolversRef.current.delete(entryId);
    }
  }, []);

  // Real vector search (chunk + embed + ragSearch), not ask-doc's whole-document
  // prompt stuffing. No chat-model fallback: a wrong answer dressed up as a
  // real search result would be worse than a plain "not available" here.
  const searchDocumentsNode = useCallback(
    async (documents: string[], query: string): Promise<string> => {
      const entryId = nextEntryId();
      setEntries((prev) => [...prev, { kind: 'chat-assistant', id: entryId, content: '', streaming: true }]);
      if (typeof window.academy?.ragSearch !== 'function') {
        const content = 'Search documents is only available in the desktop app.';
        setAssistantEntry(entryId, (e) => ({ ...e, content, streaming: false }));
        return content;
      }
      try {
        const results = await window.academy.ragSearch(documents, query);
        // A source document's own text can start a line with "- " or "1. ",
        // which markdown reads as a real list; escaping it keeps a quoted
        // passage as plain text instead of turning into a one-item bullet.
        const escapeMarkdownList = (text: string) => text.replace(/^([ \t]*)([-*+]|\d+[.)])(\s)/gm, '$1\\$2$3');
        // Bold "Result N" labels, not a markdown ordered list: multi-paragraph
        // result text breaks list continuation, which silently restarts the
        // rendered numbering at 1 for every item after the first.
        const content =
          results.length === 0
            ? `No matches for "${query}".`
            : `**${results.length} result(s) for "${query}"**\n\n` +
              results
                .map((r, i) => `**Result ${i + 1}** (score ${r.score.toFixed(3)})\n\n${escapeMarkdownList(r.content)}`)
                .join('\n\n---\n\n');
        setAssistantEntry(entryId, (e) => ({ ...e, content, streaming: false }));
        return content;
      } catch (err) {
        const content = err instanceof Error ? err.message : 'Search failed.';
        setAssistantEntry(entryId, (e) => ({ ...e, content, streaming: false }));
        return content;
      }
    },
    [setAssistantEntry],
  );

  // Reads window.academy fresh on every call, not captured at render time:
  // the preload bridge can attach after this component's first render.
  function bridgeCall<A extends unknown[], R>(pick: (api: AcademyAPI) => ((...args: A) => Promise<R>) | undefined, label: string) {
    return async (...args: A): Promise<R> => {
      const fn = window.academy && pick(window.academy);
      if (typeof fn !== 'function') throw new Error(`${label} is only available in the desktop app.`);
      return fn(...args);
    };
  }
  const ocrNode = useCallback(bridgeCall((a) => a.ocr, 'Read text from image'), []);
  const classifyImageNode = useCallback(bridgeCall((a) => a.classifyImage, 'Classify image'), []);
  const textToSpeechNode = useCallback(bridgeCall((a) => a.textToSpeech, 'Text to speech'), []);
  const speechToTextNode = useCallback(bridgeCall((a) => a.speechToText, 'Speech to text'), []);
  const generateImageNode = useCallback(bridgeCall((a) => a.generateImage, 'Generate image'), []);
  const generateVideoNode = useCallback(bridgeCall((a) => a.generateVideo, 'Generate video'), []);
  const generateMusicNode = useCallback(bridgeCall((a) => a.generateMusic, 'Generate music'), []);

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
    // Nodes wired to the branch of an If that didn't match: skipped outright,
    // not run with empty input, so "connect to No" actually means conditional.
    const skippedNodes = new Set<string>();
    const pushResult = (content: string, opts?: { raw?: boolean }) =>
      setEntries((prev) => [
        ...prev,
        { kind: 'chat-assistant', id: nextEntryId(), content, streaming: false, raw: opts?.raw },
      ]);
    const pushMedia = (mediaType: 'image' | 'audio' | 'video', dataUrl: string, caption?: string) =>
      setEntries((prev) => [...prev, { kind: 'media', id: nextEntryId(), mediaType, dataUrl, caption }]);
    try {
      for (const id of topoOrderIds(nodes, edges)) {
        if (stopRequestedRef.current) break;
        const node = nodes.find((n) => n.id === id);
        if (!node || node.data.kind === 'start') continue;
        const incomingEdge = edges.find((e) => e.target === id);
        if (incomingEdge) {
          if (skippedNodes.has(incomingEdge.source)) {
            skippedNodes.add(id);
            continue;
          }
          if (incomingEdge.sourceHandle === 'true' || incomingEdge.sourceHandle === 'false') {
            const branchValue = nodeOutputs.get(outKey(incomingEdge.source, incomingEdge.sourceHandle));
            const branchEmpty =
              branchValue === undefined ||
              (typeof branchValue === 'string' ? branchValue.length === 0 : branchValue.rows.length === 0);
            if (branchEmpty) {
              skippedNodes.add(id);
              continue;
            }
          }
        }
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
        // was typed: undefined means "Upstream input" was picked but nothing usable is wired in.
        const resolveContent = (manualKey: string) => {
          const fields = node.data.fields;
          if ((fields.source ?? 'My input') !== 'Upstream input') return fields[manualKey] ?? '';
          const upstream = readInput();
          // An empty string counts as "nothing usable" too: an upstream If with zero
          // matching items still writes '', which otherwise sailed through as real
          // content and got sent to the model with nothing to actually act on.
          if (typeof upstream !== 'string' || upstream.trim().length === 0) return undefined;
          return upstream;
        };
        runningKindRef.current = node.data.kind;
        try {
          await def.run({
            fields: node.data.fields,
            readInput,
            resolveContent,
            pushResult,
            pushRunLine,
            runAgent: runAgentNode,
            translate: translateNode,
            confirm: confirmNode,
            search: searchDocumentsNode,
            setOutput: (value, handle) => nodeOutputs.set(outKey(id, handle), value),
            pushMedia,
            ocr: ocrNode,
            classifyImage: classifyImageNode,
            textToSpeech: textToSpeechNode,
            speechToText: speechToTextNode,
            generateImage: generateImageNode,
            generateVideo: generateVideoNode,
            generateMusic: generateMusicNode,
            stopRequested: () => stopRequestedRef.current,
          });
        } catch (err) {
          // A handler that throws instead of reporting through pushRunLine (an
          // unexpected exception, not a modeled "nothing connected" case) still
          // has to mark its node and keep the run going for whatever's left.
          pushRunLine('err', err instanceof Error ? err.message : 'This step failed.');
        } finally {
          runningKindRef.current = null;
        }
      }
    } finally {
      setIsRunning(false);
      setStopRequested(false);
      stopRequestedRef.current = false;
    }
  }, [
    nodes,
    edges,
    runAgentNode,
    translateNode,
    confirmNode,
    searchDocumentsNode,
    ocrNode,
    classifyImageNode,
    textToSpeechNode,
    speechToTextNode,
    generateImageNode,
    generateVideoNode,
    generateMusicNode,
  ]);

  // Read inside the interval tick below instead of closing over `isRunning`
  // directly, so a long run in progress doesn't get a second one stacked on top.
  const isRunningRef = useRef(false);
  useEffect(() => {
    isRunningRef.current = isRunning;
  }, [isRunning]);
  // Stops the queue between nodes; the in-flight agent call itself only stops
  // early when the desktop bridge can actually abort it.
  const handleStop = useCallback(() => {
    if (!isRunning || stopRequestedRef.current) return;
    stopRequestedRef.current = true;
    setStopRequested(true);
    const requestId = pendingRequestIdRef.current;
    if (requestId) void window.academy?.chat?.stop?.(requestId).catch(() => undefined);
    void window.academy?.cancelGenerateVideo?.().catch(() => undefined);
    void window.academy?.cancelGenerateMusic?.().catch(() => undefined);
    if (runningKindRef.current && UNCANCELABLE_KINDS.has(runningKindRef.current)) {
      setEntries((prev) => [
        ...prev,
        {
          kind: 'run',
          id: nextEntryId(),
          lines: [{ stream: 'stdout', line: "This step can't be interrupted mid-run; it'll stop right after it finishes." }],
          status: 'ok',
        },
      ]);
    }
    if (confirmResolversRef.current.size > 0) {
      const pendingIds = new Set(confirmResolversRef.current.keys());
      for (const resolve of confirmResolversRef.current.values()) resolve(false);
      confirmResolversRef.current.clear();
      setEntries((prev) =>
        prev.map((e) => (e.kind === 'confirm' && pendingIds.has(e.id) ? { ...e, answer: 'no' } : e)),
      );
    }
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
    setWorkflowName('My Workflow');
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

  const handleExportCode = useCallback(async () => {
    const script = await generateStandaloneScript(buildWorkflow());
    downloadBlob(new Blob([script], { type: 'text/javascript' }), slugFilename(workflowName, 'cjs'));
  }, [buildWorkflow, workflowName]);

  const handleSaveWorkflow = useCallback(async () => {
    const workflow = buildWorkflow();
    if (!canPickFiles()) {
      downloadWorkflow(workflow);
      return;
    }
    if (!fileHandleRef.current) {
      const handle = await pickSaveHandle(`${workflow.name || 'workflow'}.json`);
      if (!handle) return; // user cancelled the picker
      fileHandleRef.current = handle;
    }
    await writeWorkflowToHandle(fileHandleRef.current, workflow);
  }, [buildWorkflow]);

  // Loaded nodes get fresh ids through the same nextId() every other node uses,
  // never the saved ones directly: those came from a different session's counter
  // and could collide with whatever's minted next in this one.
  const applyLoadedWorkflow = useCallback(
    (workflow: ReturnType<typeof parseWorkflowFile>, options?: { keepConsole?: boolean }) => {
      const idMap = new Map(workflow.nodes.map((n) => [n.id, nextId()]));
      setNodes(
        workflow.nodes.map((n) => ({
          id: idMap.get(n.id) ?? n.id,
          type: 'playgroundNode',
          position: { x: n.x, y: n.y },
          // A workflow saved before a field existed on this kind won't have
          // it in `n.fields`; back-filling with the kind's current default
          // keeps an old preset's select from landing on a blank value.
          data: { kind: n.kind, fields: { ...(PLAYGROUND_NODE_DEFS[n.kind]?.defaultFields?.() ?? {}), ...n.fields } },
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
      // A generated workflow's own console entries (the prompt, "Built...")
      // are worth keeping so the user can see which request produced it.
      if (!options?.keepConsole) setEntries([]);
      setNodeErrors(new Set());
      centerOnStart(0);
    },
    [setNodes, setEdges, centerOnStart],
  );

  // Reuses applyLoadedWorkflow, the same "replace the whole canvas" path a
  // file open or a preset already goes through: nothing about landing a
  // workflow on the canvas is new here, only where it comes from.
  const handleGenerateWorkflow = useCallback(
    async (prompt: string) => {
      const entryId = nextEntryId();
      setEntries((prev) => [
        ...prev,
        { kind: 'chat-user', id: nextEntryId(), content: prompt },
        { kind: 'chat-assistant', id: entryId, content: 'Building your workflow…', streaming: true },
      ]);
      if (typeof window.academy?.workflow?.generate !== 'function') {
        setAssistantEntry(entryId, (e) => ({
          ...e,
          content: 'Building a workflow from a prompt is only available in the desktop app.',
          streaming: false,
        }));
        return;
      }
      // Only sent when the canvas already has real content: an empty "just
      // start" graph is nothing worth describing, and omitting it keeps a
      // genuinely fresh request from being second-guessed against it.
      const existing = buildWorkflow();
      const currentWorkflow = existing.nodes.length > 1 ? summarizeCurrentWorkflow(existing) : undefined;
      const tryGenerate = async () => {
        const { text } = await window.academy!.workflow!.generate(prompt, buildNodeCatalogue(), currentWorkflow);
        return parseGeneratedWorkflow(text);
      };
      try {
        // A small local model occasionally emits a syntax slip (a missing
        // brace, a stray comma); one retry costs a few seconds and clears
        // most of those without bothering the user to re-type the request.
        let workflow;
        try {
          workflow = await tryGenerate();
        } catch {
          setAssistantEntry(entryId, (e) => ({ ...e, content: 'That attempt had a glitch, trying once more…' }));
          workflow = await tryGenerate();
        }
        applyLoadedWorkflow(workflow, { keepConsole: true });
        // Node cards need a render pass before React Flow knows their real size,
        // so fitView is scheduled a tick after the load rather than called inline.
        window.setTimeout(() => fitView({ padding: 0.2, duration: 300 }), 50);
        setAssistantEntry(entryId, (e) => ({
          ...e,
          content: `Built "${workflow.name}" with ${workflow.nodes.length} node(s). Review it, then Save when it looks right.`,
          streaming: false,
        }));
      } catch (err) {
        setAssistantEntry(entryId, (e) => ({
          ...e,
          content: err instanceof Error ? err.message : "Couldn't build that workflow. Try rephrasing the request.",
          streaming: false,
        }));
      }
    },
    [applyLoadedWorkflow, setAssistantEntry, fitView, buildWorkflow],
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

  const [showPresets, setShowPresets] = useState(false);
  const handleLoadPreset = useCallback(
    (entry: PresetEntry) => {
      fileHandleRef.current = null;
      applyLoadedWorkflow(entry.workflow);
      setShowPresets(false);
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
      (e.kind === 'run' && e.lines.some((l) => l.line.trim().length > 0)) ||
      e.kind === 'media',
  );

  // `hasError` is render-only (never saved with the workflow); only the errored
  // nodes get a new object, so the rest of the canvas doesn't re-render.
  const nodesForRender = useMemo(
    () => (nodeErrors.size === 0 ? nodes : nodes.map((n) => (nodeErrors.has(n.id) ? { ...n, data: { ...n.data, hasError: true } } : n))),
    [nodes, nodeErrors],
  );

  // Splits `edgeId` into source -> newNode -> target, dropping the old edge.
  // The new node lands at the midpoint between the two it now sits between.
  const handleInsertNode = useCallback(
    (edgeId: string, kind: string) => {
      const edge = edges.find((e) => e.id === edgeId);
      const def = PLAYGROUND_NODE_DEFS[kind];
      if (!edge || !def) return;
      const sourceNode = nodes.find((n) => n.id === edge.source);
      const targetNode = nodes.find((n) => n.id === edge.target);
      if (!sourceNode || !targetNode) return;
      const newId = nextId();
      setNodes((prev) => [
        ...prev,
        {
          id: newId,
          type: 'playgroundNode',
          position: {
            x: (sourceNode.position.x + targetNode.position.x) / 2,
            y: (sourceNode.position.y + targetNode.position.y) / 2,
          },
          data: { kind, fields: def.defaultFields() },
        },
      ]);
      setEdges((prev) => [
        ...prev.filter((e) => e.id !== edgeId),
        { id: nextId(), source: edge.source, target: newId, sourceHandle: edge.sourceHandle, targetHandle: null },
        { id: nextId(), source: newId, target: edge.target, sourceHandle: null, targetHandle: edge.targetHandle },
      ]);
    },
    [edges, nodes, setNodes, setEdges],
  );
  // A wire is colored by what's actually flowing through it: the branch
  // color for If's Yes/No, otherwise the source node's declared output type.
  const edgesForRender = useMemo(
    () =>
      edges.map((e) => {
        const branch = e.sourceHandle === 'true' || e.sourceHandle === 'false' ? e.sourceHandle : null;
        const outputType = PLAYGROUND_NODE_DEFS[nodes.find((n) => n.id === e.source)?.data.kind ?? '']?.output;
        const targetType = PLAYGROUND_NODE_DEFS[nodes.find((n) => n.id === e.target)?.data.kind ?? '']?.input ?? null;
        const dataType = branch ? 'bool' : (outputType ?? 'any');
        const color = branch ? BRANCH_COLOR[branch] : (outputType && PORT_COLOR[outputType]) || PORT_COLOR.flow;
        return {
          ...e,
          type: 'playgroundEdge',
          style: { stroke: color },
          data: { dataType, targetType, onInsert: handleInsertNode },
        };
      }),
    [edges, nodes, handleInsertNode],
  );
  const fileMenuGroups = useMemo(
    () => [
      {
        color: '#6ea8fe',
        items: [
          { label: 'Save', shortcut: '⌘S', icon: Save, disabled: isRunning, onSelect: () => void handleSaveWorkflow() },
          { label: 'Open', icon: FolderOpen, disabled: isRunning, onSelect: () => void handleOpenWorkflow() },
          { label: 'Rename', icon: Pencil, disabled: false, onSelect: () => setEditingName(true) },
        ],
      },
      {
        color: '#ff8fa3',
        items: [
          { label: 'Reset workflow', icon: RotateCcw, disabled: isRunning, onSelect: handleReset },
          {
            label: 'Export data',
            icon: Download,
            disabled: !hasExportableOutput || isRunning,
            onSelect: () =>
              setExportRequest({
                title: 'Export conversation',
                markdown: conversationMarkdown,
                formats: CONVERSATION_FORMATS,
                defaultName: workflowName,
              }),
          },
          { label: 'Export as project', icon: FileCode, disabled: isRunning, onSelect: () => void handleExportCode() },
        ],
      },
    ],
    [
      isRunning,
      handleSaveWorkflow,
      handleOpenWorkflow,
      handleReset,
      hasExportableOutput,
      conversationMarkdown,
      workflowName,
      handleExportCode,
    ],
  );

  return (
    <div className="relative flex h-full min-h-0 flex-1 flex-col">
      <div className="flex h-11 shrink-0 items-center justify-between gap-2 border-b border-canvas-border bg-canvas px-3 py-2 sm:px-4">
        <div className="flex min-w-0 items-center gap-2 text-sm">
          <div className="relative shrink-0" ref={fileMenuRef}>
            <button
              type="button"
              onClick={() => setShowFileMenu((prev) => !prev)}
              className={`inline-flex items-center gap-1 rounded-md border border-canvas-border px-2 py-1 text-xs text-canvas-muted-foreground outline-none transition-colors hover:text-canvas-foreground focus-visible:border-emerald-500/60 focus-visible:ring-1 focus-visible:ring-emerald-500/30 ${showFileMenu ? 'text-canvas-foreground' : ''}`}
              title="File"
              aria-label="File menu"
            >
              <FileText className="size-3.5" />
              File
              <ChevronDown className={`size-3 transition-transform ${showFileMenu ? 'rotate-180' : ''}`} />
            </button>
            {showFileMenu && (
              <div className="absolute left-0 top-full z-10 mt-1 w-60 rounded-md border border-canvas-border bg-canvas p-1.5 shadow-lg">
                {fileMenuGroups.map((group, groupIndex) => (
                  <div key={group.items.map((item) => item.label).join('|')}>
                    {groupIndex > 0 && <div className="my-1.5 h-px bg-canvas-border" />}
                    {group.items.map((item) => (
                      <button
                        key={item.label}
                        type="button"
                        onClick={() => {
                          setShowFileMenu(false);
                          item.onSelect();
                        }}
                        disabled={item.disabled}
                        className="flex w-full items-center gap-2.5 rounded px-1.5 py-1.5 text-left text-xs text-canvas-foreground hover:bg-canvas-muted disabled:cursor-not-allowed disabled:opacity-40"
                      >
                        <span
                          className="flex size-6 shrink-0 items-center justify-center rounded-md"
                          style={{ color: group.color, backgroundColor: `color-mix(in oklab, ${group.color} 16%, var(--color-canvas-muted))` }}
                        >
                          <item.icon className="size-3.5" />
                        </span>
                        <span className="flex-1">{item.label}</span>
                        {item.shortcut && (
                          <span className="text-[10px] text-canvas-muted-foreground">{item.shortcut}</span>
                        )}
                      </button>
                    ))}
                  </div>
                ))}
              </div>
            )}
          </div>
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
            onClick={() => setShowPresets(true)}
            disabled={isRunning}
            className="shrink-0 rounded p-1.5 text-canvas-muted-foreground transition-colors hover:bg-canvas-muted hover:text-canvas-foreground disabled:cursor-not-allowed disabled:opacity-40"
            title="Presets"
            aria-label="Presets"
          >
            <Sparkles className="size-4" />
          </button>
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
            edgeTypes={EDGE_TYPES}
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
          className="group relative flex w-3 shrink-0 cursor-col-resize items-center justify-center bg-transparent"
        >
          <span className="absolute inset-y-0 left-1/2 w-px -translate-x-1/2 bg-canvas-border" />
          <GripVertical className="relative z-10 size-3 text-canvas-muted-foreground transition-colors group-hover:text-canvas-foreground" />
        </button>

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
            onConfirm={handleConfirmAnswer}
            // onBuildWorkflow intentionally not wired up: chat-driven workflow
            // building isn't ready to ship yet. Leaving handleGenerateWorkflow
            // itself in place (unused) so this is a one-line re-enable later.
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
      {showPresets && <PlaygroundPresetsModal onClose={() => setShowPresets(false)} onSelect={handleLoadPreset} />}
    </div>
  );
}

export function Playground() {
  const [workflowName, setWorkflowName] = useState(heldState?.workflowName ?? 'My Workflow');
  const [editingName, setEditingName] = useState(false);
  const commitWorkflowName = useCallback(() => {
    setWorkflowName((prev) => prev.trim() || 'My Workflow');
    setEditingName(false);
  }, []);
  return (
    <div className="flex h-[calc(100vh-56px)] w-full bg-canvas">
      <PlaygroundPalette
        workflowName={workflowName}
        editingName={editingName}
        onStartEditing={() => setEditingName(true)}
        onNameChange={setWorkflowName}
        onCommitName={commitWorkflowName}
      />
      <ReactFlowProvider>
        <PlaygroundCanvas
          workflowName={workflowName}
          setWorkflowName={setWorkflowName}
          setEditingName={setEditingName}
        />
      </ReactFlowProvider>
    </div>
  );
}
