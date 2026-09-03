// 'any' accepts (and forwards) whichever of the others actually arrives at
// runtime; only If needs it so far, since it has to work on a table row or
// on a plain string equally.
export type PlaygroundDataType = 'table' | 'value' | 'bool' | 'flow' | 'any';

// Exactly 7, one per chakra (root to crown, red to violet): trigger, data, logic,
// ai-text, ai-voice, ai-media, interface. See CATEGORY_CLASSES for the color map.
export type PlaygroundCategory = 'trigger' | 'data' | 'logic' | 'ai-text' | 'ai-voice' | 'ai-media' | 'interface';

export interface PlaygroundFieldDef {
  key: string;
  label: string;
  type: 'text' | 'select' | 'textarea';
  options?: string[];
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
}

export interface PlaygroundNodeData extends Record<string, unknown> {
  kind: string;
  fields: Record<string, string>;
}
