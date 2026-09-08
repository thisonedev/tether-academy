import type { PlaygroundTable } from './playground-table.js';

// 'any' accepts (and forwards) whichever of the others actually arrives at
// runtime; only If needs it so far, since it has to work on a table row or
// on a plain string equally.
export type PlaygroundDataType = 'table' | 'value' | 'bool' | 'flow' | 'any';

/** Everything a node kind's `run` needs from the engine, injected fresh per
 *  node per run: reading what's wired in, writing what's wired out, and the
 *  two shared side effects (posting to the output feed, calling the AI bridge). */
export interface PlaygroundRunContext {
  fields: Record<string, string>;
  /** What's wired into this node's input, or undefined if nothing is connected. */
  readInput: () => PlaygroundTable | string | undefined;
  /** The field named `manualFieldKey`, unless "Upstream input" is the chosen
   *  source and produced non-empty text, in which case that text wins. */
  resolveContent: (manualFieldKey: string) => string | undefined;
  /** Appends a rendered table/text result to the output feed. */
  pushResult: (content: string, opts?: { raw?: boolean }) => void;
  /** Appends a structured status line (stdout on success, stderr on failure). */
  pushRunLine: (status: 'ok' | 'err', line: string) => void;
  /** Sends one prompt through the desktop chat bridge and returns the reply. */
  runAgent: (task: string) => Promise<string>;
  /** Dedicated per-language Bergamot NMT translation when the language and the
   *  desktop bridge are both available; falls back to `runAgent` otherwise. */
  translate: (text: string, language: string) => Promise<string>;
  /** Posts a Yes/No entry to the output feed and resolves once the user answers
   *  (or the run is stopped, which resolves every pending one as `false`). */
  confirm: (message: string) => Promise<boolean>;
  /** Real chunk + embed + vector search over `documents`, not the whole-document-
   *  in-prompt approach `ask-doc` uses. Returns the results already formatted. */
  search: (documents: string[], query: string) => Promise<string>;
  /** Records this node's output for whatever's wired downstream. `handle`
   *  selects the output port for dual-output kinds (If's "true"/"false"). */
  setOutput: (value: PlaygroundTable | string, handle?: string) => void;
  /** Appends a media or document result to the output feed. `dataUrl` is a
   *  full `data:` URL (already carries its own MIME type). */
  pushMedia: (mediaType: 'image' | 'audio' | 'video' | 'pdf' | 'zip', dataUrl: string, caption?: string) => void;
  /** Speaks a clip without adding anything to the output feed. */
  playAudio: (dataUrl: string) => void;
  /** `image` is a data: URL. All six below throw when the desktop bridge isn't available (web). */
  ocr: (image: string) => Promise<string>;
  classifyImage: (image: string) => Promise<string>;
  textToSpeech: (text: string) => Promise<string>;
  speechToText: (audio: string) => Promise<string>;
  /** Resolves with one spoken turn: the first utterance VAD commits, the
   *  stop phrase, or `maxDurationMs`. `record: true` instead keeps listening
   *  across pauses and also returns a playable recording of the session. */
  recordVoice: (opts: {
    stopPhrase?: string;
    maxDurationMs?: number;
    record?: boolean;
  }) => Promise<{ transcript: string; stoppedByPhrase: boolean; audioDataUrl: string | null; error: string | null }>;
  /** One session for the whole multi-turn conversation, not one per turn:
   *  matches the SDK's own voice-assistant lessons, which open transcribeStream
   *  once and iterate it for the entire loop instead of reopening it turn to
   *  turn. Yields one result per turn until the conversation ends. */
  voiceConversationTurns: (opts?: {
    endOfTurnSilenceMs?: number;
  }) => AsyncGenerator<{ transcript: string; error: string | null }, void, void>;
  /** Loads the voice model without opening the mic, so a conversation node
   *  can get every model it needs ready before recording starts. */
  ensureVoiceModelReady: () => Promise<void>;
  /** Loads the configured chat model (if any) without sending a message. */
  ensureChatModelReady: () => Promise<void>;
  generateImage: (prompt: string, model?: string) => Promise<string>;
  generateVideo: (prompt: string, model?: string, frames?: number, steps?: number) => Promise<string>;
  generateMusic: (caption: string, durationSec?: number) => Promise<string>;
  stopRequested: () => boolean;
}

// Exactly 7, one per chakra (root to crown, red to violet): trigger, data, logic,
// ai-text, ai-voice, ai-media, interface. See CATEGORY_CLASSES for the color map.
export type PlaygroundCategory = 'trigger' | 'data' | 'logic' | 'ai-text' | 'ai-voice' | 'ai-media' | 'interface';

export interface PlaygroundFieldDef {
  key: string;
  label: string;
  /** Both show a text field over a filmstrip of the PDF in this node's `file`
   *  field. 'page-spec' makes the pages clickable and writes "1-3, 7" back;
   *  'page-ranges' leaves the strip as a read-only preview. */
  type: 'text' | 'select' | 'textarea' | 'file' | 'page-spec' | 'page-ranges';
  /** A plain string is both the stored value and the shown label; use
   *  `{ value, label }` when the stored value (a model key, say) shouldn't
   *  be what the user reads in the dropdown. */
  options?: (string | { value: string; label: string })[];
  /** A fresh (non-preset) node's starting value for this field. Defaults to
   *  `options[0]` for a select, or `''` otherwise, when omitted. */
  default?: string;
  /** `type: 'file'` only: the `<input accept>` filter, and whether more than
   *  one file can be picked at once (stored as a JSON-encoded array). */
  accept?: string;
  multiple?: boolean;
  /** Hides this field from the config popup when it doesn't apply: either based
   *  on another field's value (a value input for a unary operator), or on what's
   *  actually wired into this node (a table's "Column" picker, given plain text). */
  hiddenWhen?: (fields: Record<string, string>, inputKind: PlaygroundDataType | null) => boolean;
}

/** One node kind's full contract: how it looks, what it plugs into, what it's configured with.
 *  Adding a node kind means adding one of these; the canvas and engine never change. */
export interface PlaygroundNodeKindDef {
  kind: string;
  label: string;
  category: PlaygroundCategory;
  input: PlaygroundDataType | null;
  output: PlaygroundDataType | null;
  dualOutput?: boolean;
  fields: PlaygroundFieldDef[];
  defaultFields: () => Record<string, string>;
  /** Shows in the palette (dimmed, for real color coverage) but can't be dragged
   *  onto the canvas: a placeholder for a category with no working node yet. */
  inactive?: boolean;
  /** Absent only for `start` (skipped before the engine ever calls a handler)
   *  and the inactive placeholders (can't reach the canvas, so never run). */
  run?: (ctx: PlaygroundRunContext) => Promise<void>;
  /** Runs (and must finish) before `run`, for a node that uses more than one
   *  model and would otherwise start visible work (e.g. opening the mic) on
   *  the first model while the second is still downloading mid-stream. The
   *  engine always awaits this first; a node that needs no upfront model
   *  readiness (most of them) just omits it. */
  preload?: (ctx: PlaygroundRunContext) => Promise<void>;
  /** Present and past pair ("Reading text from the image" / "Read text from
   *  the image"). The engine opens a stage line from the first and closes it
   *  with the second, on the rail the model loading lines use. */
  activity?: { doing: string; done: string };
}

export interface PlaygroundNodeData extends Record<string, unknown> {
  kind: string;
  fields: Record<string, string>;
  /** Set for render only (never saved): this node's `run` reported an error
   *  on the run currently shown in the output feed. */
  hasError?: boolean;
}
