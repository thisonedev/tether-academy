import type { SavedWorkflow } from './playground-workflow.js';

export interface PresetEntry {
  file: string;
  category: string;
  description: string;
  workflow: SavedWorkflow;
}

/** Dynamically imported: bundles all 22 preset workflows (~300KB, several
 *  embed sample audio/images), so it only loads when the Presets modal opens. */
export async function loadPresets(): Promise<PresetEntry[]> {
  const { default: presets } = await import('@academy/workflows/all-presets.json');
  return presets as unknown as PresetEntry[];
}
