import type { SavedWorkflow } from './playground-workflow.js';

export interface PresetEntry {
  file: string;
  category: string;
  /** Plain-language name shown on the card, e.g. "Meeting Notes Taker": what the
   *  workflow does, not its filename. */
  title: string;
  /** Lucide icon name (a key in PRESET_ICON, playground-presets-modal.tsx). */
  icon: string;
  description: string;
  workflow: SavedWorkflow;
}

/** Dynamically imported: bundles all preset workflows (~300KB, several
 *  embed sample audio/images), so it only loads when the Presets modal opens. */
export async function loadPresets(): Promise<PresetEntry[]> {
  const { default: presets } = await import('@academy/workflows/all-presets.json');
  return presets as unknown as PresetEntry[];
}
