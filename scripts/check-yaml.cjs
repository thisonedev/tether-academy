const yaml = require('js-yaml');
const fs = require('node:fs');
const path = require('node:path');

async function* walk(dir) {
  for (const e of await fs.promises.readdir(dir, { withFileTypes: true })) {
    const full = path.join(dir, e.name);
    if (e.isDirectory()) yield* walk(full);
    else if (e.isFile() && e.name.endsWith('.mdx')) yield full;
  }
}

(async () => {
  const failures = [];
  for await (const f of walk('courses')) {
    const raw = fs.readFileSync(f, 'utf-8');
    const m = raw.match(/^---\r?\n([\s\S]*?)\r?\n---/);
    if (!m) continue;
    try { yaml.load(m[1]); } catch (e) {
      failures.push({ file: f, msg: e.message.split('\n')[0] });
    }
  }
  console.log('failures:', failures.length);
  for (const x of failures) console.log(x.file, '->', x.msg);
})();