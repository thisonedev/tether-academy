import type { PickedFile } from './playground-files.js';

/** Filters @academy/workflows' bundled sample files down to whichever match a
 *  field's `accept` string. Dynamically imported: the JSON embeds base64
 *  image/audio data, so eagerly bundling it would bloat every page's shared chunk. */
export async function samplesFor(accept: string | undefined): Promise<PickedFile[]> {
  const { default: sampleFiles } = await import('@academy/workflows/sample-files.json');
  if (!accept) return sampleFiles;
  const patterns = accept.split(',').map((p) => p.trim().toLowerCase());
  return sampleFiles.filter((f) => {
    const ext = f.name.slice(f.name.lastIndexOf('.')).toLowerCase();
    const mime = f.dataUrl.slice(5, f.dataUrl.indexOf(';')).toLowerCase();
    return patterns.some((p) => (p.endsWith('/*') ? mime.startsWith(p.slice(0, -1)) : p === ext || p === mime));
  });
}
