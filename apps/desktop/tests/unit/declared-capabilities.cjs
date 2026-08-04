'use strict';

// Declared capabilities widening. The host's detector stays the trust
// boundary; a lesson's frontmatter declaration can only widen the consent
// prompt, never narrow it. A network union takes the wider of (declared,
// detected) on the scale none < localhost < all; a device union concatenates unique entries.

const test = require('brittle');
const { detectNetworkNeed, referencedModels } = require('../../workers/peer/exec-network.cjs');
const { detectDeviceNeeds } = require('../../workers/peer/exec-validate.cjs');

function unionNetwork(detected, declared) {
  const order = { none: 0, localhost: 1, all: 2 };
  const detectedRank = order[detected.mode] ?? 0;
  const declaredRank = order[declared?.network ?? 'none'] ?? 0;
  return declaredRank > detectedRank
    ? (declared.network ?? detected.mode)
    : detected.mode;
}

function unionDevices(detected, declared) {
  const set = new Set([...detected, ...(declared?.device ?? [])]);
  return Array.from(set);
}

const SOURCE_NO_NETWORK = "const x = 1; console.log(x);";
const SOURCE_FETCH = "const r = await fetch('https://example.com');";
// startQVACProvider matches the first LOOPBACK_PATTERN; no fetch() to flip it to all.
const SOURCE_LOOPBACK = 'startQVACProvider({ port: 8080 });';

test('declared - no declaration, detection drives', (t) => {
  const detected = detectNetworkNeed(SOURCE_FETCH);
  t.is(unionNetwork(detected, undefined), 'all');
  t.alike(unionDevices(detectDeviceNeeds(''), undefined), []);
});

test('declared - declaration widens network', (t) => {
  const detected = detectNetworkNeed(SOURCE_NO_NETWORK);
  t.is(detected.mode, 'none');
  t.is(unionNetwork(detected, { network: 'all' }), 'all');
});

test('declared - declaration cannot narrow network', (t) => {
  const detected = detectNetworkNeed(SOURCE_FETCH);
  t.is(detected.mode, 'all');
  t.is(unionNetwork(detected, { network: 'none' }), 'all');
});

test('declared - union takes the wider of localhost vs all', (t) => {
  const detected = detectNetworkNeed(SOURCE_LOOPBACK);
  t.is(detected.mode, 'localhost');
  t.is(unionNetwork(detected, { network: 'all' }), 'all');
  t.is(unionNetwork(detected, { network: 'localhost' }), 'localhost');
});

test('declared - device union dedupes and adds declared entries', (t) => {
  const detected = ['microphone'];
  t.alike(unionDevices(detected, { device: ['microphone'] }), ['microphone']);
  t.alike(unionDevices(detected, { device: ['camera'] }),
    ['microphone', 'camera']);
  t.alike(unionDevices([], { device: ['camera'] }), ['camera']);
  t.alike(unionDevices([], undefined), []);
});

test('declared - referenced models unchanged', (t) => {
  // Pin the detector side; the union logic depends on these shapes.
  t.is(referencedModels(SOURCE_NO_NETWORK).length, 0);
  t.ok(referencedModels(SOURCE_FETCH).length === 0,
    'fetch URL is not a model constant');
});