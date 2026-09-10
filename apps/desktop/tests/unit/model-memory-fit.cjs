'use strict';

// assessModelFit is advisory: unknown or a failed assessment must never
// block a load, only a real likely-too-large verdict does.

const test = require('brittle');

const { checkMemoryFit } = require('../../shared/model-memory-fit.cjs');

test('model-memory-fit - blocks on a likely-too-large verdict', async (t) => {
  const assess = async () => ({
    models: [{ name: 'BIG_MODEL', verdict: 'likely-too-large', reasons: ['needs 32.0 GiB, 8.0 GiB free'] }],
  });
  const result = await checkMemoryFit([{ model: {}, workload: { kind: 'llm', contextTokens: 8192 } }], assess);
  t.is(result.ok, false);
  t.is(result.name, 'BIG_MODEL');
  t.ok(/needs 32.0 GiB/.test(result.message));
});

test('model-memory-fit - allows a likely-fits verdict', async (t) => {
  const assess = async () => ({
    models: [{ name: 'SMALL_MODEL', verdict: 'likely-fits', reasons: [] }],
  });
  const result = await checkMemoryFit([{ model: {}, workload: { kind: 'llm', contextTokens: 8192 } }], assess);
  t.is(result.ok, true);
});

test('model-memory-fit - unknown is not a block', async (t) => {
  const assess = async () => ({
    models: [{ name: 'UNCALIBRATED_MODEL', verdict: 'unknown', reasons: ['no validated calibration on this platform'] }],
  });
  const result = await checkMemoryFit([{ model: {}, workload: { kind: 'llm', contextTokens: 8192 } }], assess);
  t.is(result.ok, true, 'can\'t say is not the same as no');
});

test('model-memory-fit - a failed assessment does not block the load', async (t) => {
  const assess = async () => {
    throw new Error('assessModelFit unavailable in this build');
  };
  const result = await checkMemoryFit([{ model: {}, workload: { kind: 'llm', contextTokens: 8192 } }], assess);
  t.is(result.ok, true);
});

test('model-memory-fit - no candidates is a no-op', async (t) => {
  const result = await checkMemoryFit([]);
  t.is(result.ok, true);
});

// Confirms the real fallback: without @qvac/sdk installed, this degrades to
// not blocking rather than throwing.
test('model-memory-fit - degrades gracefully with no assessModelFit available', async (t) => {
  const result = await checkMemoryFit([{ model: {}, workload: { kind: 'llm', contextTokens: 8192 } }]);
  t.is(result.ok, true);
});
