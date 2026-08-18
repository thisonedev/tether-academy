'use strict';

// The ordering in createInvite is the whole fix and has no runtime observable
// (both orders pair fine on a fast link), so this reads the source instead.

const test = require('brittle');
const fs = require('node:fs');
const path = require('node:path');

const SOURCE = path.resolve(__dirname, '../../workers/peer/index.cjs');

test('invite-member-order - members is populated before the flush is awaited', (t) => {
  const src = fs.readFileSync(SOURCE, 'utf8');

  const addMember = src.indexOf('pairing.addMember(');
  const membersSet = src.indexOf('members.set(discoveryKeyHex, member)');
  const flushed = src.indexOf('await member.flushed()');

  t.ok(addMember > 0 && membersSet > 0 && flushed > 0, 'all three still exist to order');
  t.ok(membersSet > addMember, 'the member is recorded after it is created');
  t.ok(
    membersSet < flushed,
    'and before the flush, or a guest connecting during it never gets an exec channel',
  );
});
