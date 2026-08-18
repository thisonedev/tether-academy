'use strict';

// What a run may reach, decided from the code before it starts; the default is nothing, so the cases that matter raise it.

const test = require('brittle');

const {
  detectNetworkNeed,
  referencedModels,
  modelRegistry,
} = require('../../workers/peer/exec-network.cjs');

// Resolved through the SDK's own table, so a rename there fails here rather than quietly turning every run into a prompt.
const registry = modelRegistry();
const cached = 'QWEN3_600M_INST_Q4';
const huge = 'WAN2_1_T2V_14B_Q8_0';

test('exec-network - the SDK model table parses', (t) => {
  t.ok(registry.size > 100, `expected a populated table, got ${registry.size}`);
  t.is(registry.get(cached)?.modelId, 'Qwen3-0.6B-Q4_0.gguf');
  t.ok(registry.get(huge)?.expectedSize > 0);
});

test('exec-network - a plain run reaches nothing', (t) => {
  const need = detectNetworkNeed('console.log(1 + 1);');
  t.is(need.mode, 'none');
  t.is(need.reason, null);
});

test('exec-network - model constants are found after the import rewrite', (t) => {
  // Imports arrive already resolved to absolute paths, so only the constants
  // are left to match on.
  const code = `import { loadModel, ${cached} } from "/abs/path/@qvac/sdk/dist/index.js";
    await loadModel({ modelSrc: ${cached} });`;
  t.alike(referencedModels(code), [cached]);
});

test('exec-network - a model that is not downloaded asks', (t) => {
  const need = detectNetworkNeed(`await loadModel({ modelSrc: ${huge} });`);
  t.is(need.mode, 'all');
  t.ok(need.missingModels.includes(huge));
  t.ok(need.reason.includes(huge), 'the prompt names what it wants to fetch');
});

test('exec-network - naming a host asks, whatever the models say', (t) => {
  for (const code of [
    'await fetch("https://example.com");',
    'const src = "registry://hf/org/model";',
    'new StdioClientTransport({ command: "npx" });',
    'spawnSync("npx", ["-y", "@scope/server"]);',
  ]) {
    const need = detectNetworkNeed(code);
    t.is(need.mode, 'all', code);
    t.ok(need.reason, 'a prompt always says what it is for');
  }
});

// Not egress, and asking would train the user to click through the real prompt.
test('exec-network - running an installed tool does not ask', (t) => {
  t.is(detectNetworkNeed('spawnSync("npx", ["--version"]);').mode, 'none');
});

// Loopback still reaches services bound on this machine, so it is asked for.
test('exec-network - loopback asks', (t) => {
  const need = detectNetworkNeed('await startQVACProvider({ port: 8080 });');
  t.is(need.mode, 'localhost');
  t.ok(need.reason, 'a prompt always says what it is for');
});

test('exec-network - a non-string source is treated as reaching nothing', (t) => {
  t.is(detectNetworkNeed(null).mode, 'none');
  t.is(detectNetworkNeed('').mode, 'none');
});

// The percentage is only as good as the total it divides by, which comes from
// the registry rather than anything the run reports.
test('exec-network - download progress totals what the run named', (t) => {
  const { modelDownloadProgress } = require('../../workers/peer/exec-network.cjs');

  t.is(modelDownloadProgress([]), null, 'a run naming no model has nothing to report');
  t.is(modelDownloadProgress(['NOT_A_REAL_MODEL']), null, 'an unknown name contributes no total');

  const one = modelDownloadProgress([cached]);
  t.is(one.total, registry.get(cached).expectedSize, 'total comes from the registry');
  t.ok(one.downloaded >= 0 && one.downloaded <= one.total, 'a partial file never exceeds the whole');

  const two = modelDownloadProgress([cached, huge]);
  t.is(two.total, registry.get(cached).expectedSize + registry.get(huge).expectedSize,
    'several models sum into one bar');
});
