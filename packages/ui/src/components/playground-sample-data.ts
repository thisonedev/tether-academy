import type { PickedFile } from './playground-files.js';

/** A bundled sample as the picker lists it: enough to filter and name it,
 *  before any of its bytes load. */
export interface SampleRef {
  name: string;
  mime: string;
}

/** Filters the bundled samples down to whichever match a field's `accept`
 *  string. The index carries no base64, so opening a picker no longer pulls
 *  every sample image and audio clip along with it. */
export async function samplesFor(accept: string | undefined): Promise<SampleRef[]> {
  const { default: index } = await import('@academy/workflows/sample-index.json');
  const samples = index as unknown as SampleRef[];
  if (!accept) return samples;
  const patterns = accept.split(',').map((p) => p.trim().toLowerCase());
  return samples.filter((f) => {
    const ext = f.name.slice(f.name.lastIndexOf('.')).toLowerCase();
    const mime = f.mime.toLowerCase();
    return patterns.some((p) => (p.endsWith('/*') ? mime.startsWith(p.slice(0, -1)) : p === ext || p === mime));
  });
}

/** Loads one sample's bytes, from its own chunk, at the moment it is chosen. */
export async function loadSample(name: string): Promise<PickedFile> {
  const { SAMPLE_LOADERS } = await import('@academy/workflows/sample-loaders.js');
  const load = (SAMPLE_LOADERS as Record<string, (() => Promise<{ default: unknown }>) | undefined>)[name];
  if (!load) throw new Error(`Unknown sample: ${name}`);
  const { default: sample } = await load();
  return sample as PickedFile;
}
