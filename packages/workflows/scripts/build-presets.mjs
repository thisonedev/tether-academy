import { readFile, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('..', import.meta.url));
const manifest = JSON.parse(await readFile(`${root}/manifest.json`, 'utf8'));

const presets = await Promise.all(
  manifest.map(async (entry) => {
    const workflow = JSON.parse(await readFile(`${root}/presets/${entry.file}`, 'utf8'));
    return { ...entry, workflow };
  }),
);

await writeFile(`${root}/all-presets.json`, `${JSON.stringify(presets, null, 2)}\n`);
console.log(`build-presets: wrote ${presets.length} presets to all-presets.json`);
