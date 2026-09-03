export type PlaygroundDataType = 'table' | 'value' | 'bool' | 'flow';

export type PlaygroundCategory =
  | 'trigger'
  | 'conditions'
  | 'agent'
  | 'ai-text'
  | 'ai-media'
  | 'ai-voice'
  | 'data'
  | 'transform'
  | 'interface';

export interface PlaygroundFieldDef {
  key: string;
  label: string;
  type: 'text' | 'select' | 'textarea';
  options?: string[];
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
}

export interface PlaygroundNodeData extends Record<string, unknown> {
  kind: string;
  fields: Record<string, string>;
  stepNumber: number | null;
}
