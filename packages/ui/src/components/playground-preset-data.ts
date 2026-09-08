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
}

/** Card metadata only, a few KB. The workflows themselves stay out of it: each
 *  embeds its sample file as base64, so listing them all eagerly would download
 *  every sample to render a grid of titles. */
export async function loadPresetIndex(): Promise<PresetEntry[]> {
  const { default: index } = await import('@academy/workflows/preset-index.json');
  return index as unknown as PresetEntry[];
}

/** Fetches one preset's workflow, which the bundler has put in its own chunk,
 *  so picking a preset downloads only that preset. */
export async function loadPresetWorkflow(file: string): Promise<SavedWorkflow> {
  const { PRESET_LOADERS } = await import('@academy/workflows/preset-loaders.js');
  const load = (PRESET_LOADERS as Record<string, (() => Promise<{ default: unknown }>) | undefined>)[file];
  if (!load) throw new Error(`Unknown preset: ${file}`);
  const { default: workflow } = await load();
  return workflow as SavedWorkflow;
}
