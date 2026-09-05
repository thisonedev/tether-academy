import { downloadBlob, slugFilename } from './playground-export.js';

// Not yet in TS's bundled DOM lib; only the slice of the File System Access API
// (Chromium/Electron) this module actually calls.
declare global {
  interface FileSystemFileHandle {
    getFile(): Promise<File>;
    createWritable(): Promise<FileSystemWritableFileStream>;
  }
  interface FileSystemWritableFileStream {
    write(data: string | BufferSource | Blob): Promise<void>;
    close(): Promise<void>;
  }
  interface Window {
    showSaveFilePicker(options?: {
      suggestedName?: string;
      types?: { description: string; accept: Record<string, string[]> }[];
    }): Promise<FileSystemFileHandle>;
    showOpenFilePicker(options?: {
      types?: { description: string; accept: Record<string, string[]> }[];
    }): Promise<FileSystemFileHandle[]>;
  }
}

export interface SavedWorkflowNode {
  id: string;
  kind: string;
  x: number;
  y: number;
  fields: Record<string, string>;
}

export interface SavedWorkflowEdge {
  source: string;
  target: string;
  sourceHandle: string | null;
  targetHandle: string | null;
}

export interface SavedWorkflow {
  version: 1;
  name: string;
  nodes: SavedWorkflowNode[];
  edges: SavedWorkflowEdge[];
}

function serializeWorkflow(workflow: SavedWorkflow): string {
  return `${JSON.stringify(workflow, null, 2)}\n`;
}

/** Plain JSON, versioned, human-diffable: a saved workflow is just data, not a
 *  black-box binary, so it can be repeated, hand-edited, or run as a test later. */
export function downloadWorkflow(workflow: SavedWorkflow): void {
  downloadBlob(
    new Blob([serializeWorkflow(workflow)], { type: 'application/json' }),
    slugFilename(workflow.name, 'json'),
  );
}

// The File System Access API (Chromium/Electron; no effect elsewhere) is what makes
// a real "Save" possible: a kept FileSystemFileHandle can be written to again with
// no picker, the same way every desktop app's Ctrl+S doesn't ask "save as" twice.
export function canPickFiles(): boolean {
  return typeof window !== 'undefined' && 'showSaveFilePicker' in window;
}

export async function pickSaveHandle(suggestedName: string): Promise<FileSystemFileHandle | null> {
  try {
    return await window.showSaveFilePicker({
      suggestedName,
      types: [{ description: 'Workflow', accept: { 'application/json': ['.json'] } }],
    });
  } catch (err) {
    if (err instanceof DOMException && err.name === 'AbortError') return null;
    throw err;
  }
}

const MEDIA_EXT: Partial<Record<string, string>> = {
  'image/png': 'png',
  'image/jpeg': 'jpg',
  'audio/wav': 'wav',
  'video/avi': 'avi',
  'video/mp4': 'mp4',
};

function dataUrlToBlob(dataUrl: string): Blob {
  const comma = dataUrl.indexOf(',');
  const mime = /^data:(.*?);base64$/.exec(dataUrl.slice(0, comma))?.[1] ?? 'application/octet-stream';
  const binary = atob(dataUrl.slice(comma + 1));
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return new Blob([bytes], { type: mime });
}

/** Saves a generated image/audio/video: a real file picker when the API is
 *  there, a plain browser download otherwise. Never written to disk on its
 *  own, so this is the only way a generation outlives the console. */
export async function saveMediaFile(dataUrl: string, suggestedBaseName: string): Promise<void> {
  const blob = dataUrlToBlob(dataUrl);
  const ext = MEDIA_EXT[blob.type] ?? blob.type.split('/')[1] ?? 'bin';
  const filename = slugFilename(suggestedBaseName, ext);
  if (canPickFiles()) {
    let handle: FileSystemFileHandle;
    try {
      handle = await window.showSaveFilePicker({
        suggestedName: filename,
        types: [{ description: 'Generated file', accept: { [blob.type]: [`.${ext}`] } }],
      });
    } catch (err) {
      if (err instanceof DOMException && err.name === 'AbortError') return;
      throw err;
    }
    const writable = await handle.createWritable();
    await writable.write(blob);
    await writable.close();
    return;
  }
  downloadBlob(blob, filename);
}

export async function pickOpenHandle(): Promise<FileSystemFileHandle | null> {
  try {
    const [handle] = await window.showOpenFilePicker({
      types: [{ description: 'Workflow', accept: { 'application/json': ['.json'] } }],
    });
    return handle ?? null;
  } catch (err) {
    if (err instanceof DOMException && err.name === 'AbortError') return null;
    throw err;
  }
}

export async function writeWorkflowToHandle(handle: FileSystemFileHandle, workflow: SavedWorkflow): Promise<void> {
  const writable = await handle.createWritable();
  await writable.write(serializeWorkflow(workflow));
  await writable.close();
}

/** Coerces already-parsed JSON into a `SavedWorkflow`, shared by `parseWorkflowFile`
 *  (a file the user opened) and the prompt-generated workflow parser in
 *  `playground-generate.ts`. Throws with a message meant to be shown to the user directly. */
export function parseWorkflowShape(data: unknown): SavedWorkflow {
  if (typeof data !== 'object' || data === null) throw new Error('Not a workflow file.');
  const obj = data as Record<string, unknown>;
  if (!Array.isArray(obj.nodes) || !Array.isArray(obj.edges)) {
    throw new Error('Missing nodes or edges.');
  }
  const nodes: SavedWorkflowNode[] = obj.nodes.map((n) => {
    const node = n as Record<string, unknown>;
    return {
      id: String(node.id),
      kind: String(node.kind),
      x: typeof node.x === 'number' ? node.x : 0,
      y: typeof node.y === 'number' ? node.y : 0,
      fields:
        typeof node.fields === 'object' && node.fields !== null
          ? (node.fields as Record<string, string>)
          : {},
    };
  });
  const edges: SavedWorkflowEdge[] = obj.edges.map((e) => {
    const edge = e as Record<string, unknown>;
    return {
      source: String(edge.source),
      target: String(edge.target),
      sourceHandle: typeof edge.sourceHandle === 'string' ? edge.sourceHandle : null,
      targetHandle: typeof edge.targetHandle === 'string' ? edge.targetHandle : null,
    };
  });
  return { version: 1, name: typeof obj.name === 'string' ? obj.name : 'My Workflow', nodes, edges };
}

/** Throws with a message meant to be shown to the user directly, not logged. */
export function parseWorkflowFile(text: string): SavedWorkflow {
  let data: unknown;
  try {
    data = JSON.parse(text);
  } catch {
    throw new Error('Not valid JSON.');
  }
  return parseWorkflowShape(data);
}
