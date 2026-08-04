'use strict';

// Zod schemas guarding the academy:identity:* IPC surface. The renderer is the
// untrusted side of that boundary, so these run on every payload.

const test = require('brittle');

const UUID = '123e4567-e89b-12d3-a456-426614174000';
const HEX_KEY = 'a'.repeat(64);

// @academy/validation is ESM, so require() cannot load it; memoised so each test can await it independently of run order.
let pending;
const validation = () => (pending ||= import('@academy/validation'));

test('identity-schemas - devicePublicKeyHex requires 64 hex chars', async (t) => {
  const v = await validation();
  t.is(v.devicePublicKeyHexSchema.parse(HEX_KEY), HEX_KEY);
  t.exception(() => v.devicePublicKeyHexSchema.parse('not-hex'));
  t.exception(() => v.devicePublicKeyHexSchema.parse('a'.repeat(63)), 'one char short');
});

test('identity-schemas - mnemonic requires at least 12 words', async (t) => {
  const v = await validation();
  const words12 = Array(12).fill('word').join(' ');
  t.is(v.identityMnemonicSchema.parse(words12), words12);
  t.exception(() => v.identityMnemonicSchema.parse('too few words'));
});

// The device-link IPC is gone until the flow ships with a challenge-bound proof.
test('identity-schemas - no schema is exported for the device-link IPC', async (t) => {
  const v = await validation();
  t.absent(v.identityBeginLinkOptsSchema);
  t.absent(v.identityCompleteLinkPayloadSchema);
});

test('identity-schemas - beginAttest validates the device key', async (t) => {
  const v = await validation();
  t.execution(() => v.identityBeginAttestPayloadSchema.parse({ devicePublicKey: HEX_KEY }));
  t.exception(() => v.identityBeginAttestPayloadSchema.parse({ devicePublicKey: 'bad' }));
});

test('identity-schemas - finishAttest demands confirm:true', async (t) => {
  const v = await validation();
  t.execution(() => v.identityFinishAttestPayloadSchema.parse({ sessionId: UUID, confirm: true }));
  t.exception(() => v.identityFinishAttestPayloadSchema.parse({ sessionId: UUID, confirm: false }));
});

test('identity-schemas - sessionId must be a UUID', async (t) => {
  const v = await validation();
  t.is(v.identitySessionIdSchema.parse(UUID), UUID);
  t.exception(() => v.identitySessionIdSchema.parse('not-a-uuid'));
});
