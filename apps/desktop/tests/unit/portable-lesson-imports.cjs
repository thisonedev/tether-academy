'use strict';

const test = require('brittle');
const fs = require('fs');
const os = require('os');
const path = require('path');
const {
  qvacSdkToken,
  qvacSdkPluginToken,
  bareBuiltinToken,
  npmPackageToken,
  courseAssetToken,
  isPortableToken,
  resolvePortableToken,
  substitutePortableImports,
  substitutePortableAssets,
} = require('../../shared/portable-lesson-imports.cjs');

const resolvers = {
  resolveSdk: () => '/receiver/node_modules/@qvac/sdk/dist/index.js',
  resolveBuiltin: (pkg) => `/receiver/node_modules/${pkg}/index.js`,
};

test('portable-lesson-imports - isPortableToken only matches our own prefix', (t) => {
  t.ok(isPortableToken(qvacSdkToken()));
  t.ok(isPortableToken(bareBuiltinToken('bare-process')));
  t.absent(isPortableToken('/Users/x/node_modules/bare-process/index.js'));
  t.absent(isPortableToken('bare-process'));
  t.absent(isPortableToken(''));
});

test('portable-lesson-imports - resolves the sdk token to the receiver path', (t) => {
  t.is(resolvePortableToken(qvacSdkToken(), resolvers), '/receiver/node_modules/@qvac/sdk/dist/index.js');
});

test('portable-lesson-imports - resolves a known builtin, refuses an unknown one', (t) => {
  t.is(resolvePortableToken(bareBuiltinToken('bare-process'), resolvers), '/receiver/node_modules/bare-process/index.js');
  t.is(resolvePortableToken(`academy-portable:bare-builtin:not-a-real-package`, resolvers), null);
});

test('portable-lesson-imports - resolves a known plugin, refuses an unknown one', (t) => {
  const resolved = resolvePortableToken(qvacSdkPluginToken('llamacpp-completion'), resolvers);
  t.ok(resolved.endsWith('dist/server/bare/plugins/llamacpp-completion/plugin.js'));
  t.is(resolvePortableToken(qvacSdkPluginToken('not-a-real-plugin'), resolvers), null);
});

// @modelcontextprotocol/sdk is a real dependency in apps/desktop/package.json;
// this checks the allowlist against that actual file, not a stub.
test('portable-lesson-imports - resolves a declared npm dependency with its subpath, refuses an undeclared one', (t) => {
  const resolved = resolvePortableToken(
    npmPackageToken('@modelcontextprotocol/sdk/client/index.js'),
    resolvers,
  );
  t.is(resolved, '/receiver/node_modules/@modelcontextprotocol/sdk/client/index.js/index.js');
  t.is(resolvePortableToken(npmPackageToken('left-pad'), resolvers), null);
});

test('portable-lesson-imports - non-token specifiers pass through unresolved', (t) => {
  t.is(resolvePortableToken('/already/a/real/path.js', resolvers), null);
});

test('portable-lesson-imports - substitutePortableImports rewrites only import/export specifiers', (t) => {
  const code = [
    `import process from ${JSON.stringify(bareBuiltinToken('bare-process'))};`,
    `import { loadModel } from ${JSON.stringify(qvacSdkToken())};`,
    `console.log("${bareBuiltinToken('bare-process')} in a string is not an import, left alone");`,
  ].join('\n');
  const { code: out, unresolved } = substitutePortableImports(code, resolvers);
  t.is(unresolved.length, 0);
  t.ok(out.includes('from "/receiver/node_modules/bare-process/index.js"'));
  t.ok(out.includes('from "/receiver/node_modules/@qvac/sdk/dist/index.js"'));
  t.ok(out.includes(`console.log("${bareBuiltinToken('bare-process')} in a string is not an import, left alone");`));
});

test('portable-lesson-imports - substitutePortableImports reports what it could not resolve', (t) => {
  const code = `import x from "academy-portable:bare-builtin:not-a-real-package";`;
  const { unresolved } = substitutePortableImports(code, resolvers);
  t.alike(unresolved, ['academy-portable:bare-builtin:not-a-real-package']);
});

// The fixture half of the same problem: a lesson's input file lives in the
// courses checkout, and on a peer run that checkout is the receiver's.
test('portable-lesson-imports - substitutePortableAssets resolves against the receiver checkout', (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'academy-assets-'));
  t.teardown(() => fs.rmSync(dir, { recursive: true, force: true }));
  fs.mkdirSync(path.join(dir, 'examples', 'qvac', 'transcription', 'input'), { recursive: true });
  const rel = 'examples/qvac/transcription/input/sample-16khz.wav';
  fs.writeFileSync(path.join(dir, rel), 'x');

  const code = `const p = ${JSON.stringify(courseAssetToken(rel))};`;
  const { code: out, missing, refused } = substitutePortableAssets(code, { coursesDir: dir });
  t.is(missing.length, 0);
  t.is(refused.length, 0);
  t.ok(out.includes(JSON.stringify(path.join(dir, rel)).slice(1, -1)));
});

test('portable-lesson-imports - substitutePortableAssets reports a fixture this device lacks', (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'academy-assets-'));
  t.teardown(() => fs.rmSync(dir, { recursive: true, force: true }));
  const rel = 'examples/qvac/fine-tuning/input/small_train_HF.jsonl';
  const code = `const p = ${JSON.stringify(courseAssetToken(rel))};`;
  const { code: out, missing } = substitutePortableAssets(code, { coursesDir: dir });
  t.alike(missing, [rel]);
  t.is(out, code, 'left untouched, so nothing spawns with a half-resolved path');
});

test('portable-lesson-imports - substitutePortableAssets refuses a path outside the checkout', (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'academy-assets-'));
  t.teardown(() => fs.rmSync(dir, { recursive: true, force: true }));
  const code = `const p = ${JSON.stringify(courseAssetToken('../../../etc/passwd'))};`;
  const { refused } = substitutePortableAssets(code, { coursesDir: dir });
  t.alike(refused, ['../../../etc/passwd']);
});
