const Hyperswarm = require('hyperswarm');
const BlindPairing = require('blind-pairing');
const createTestnet = require('hyperdht/testnet.js');

function toHex(buf) {
  return Buffer.from(buf).toString('hex');
}

function fromHex(hex) {
  return Buffer.from(hex, 'hex');
}

async function main() {
  console.log('[test] creating in-process hyperdht testnet (3 nodes)');
  const testnet = await createTestnet(3);

  const bootstrap = testnet.bootstrap;
  console.log('[test] testnet bootstrap:', bootstrap[0]);

  const hostSwarm = new Hyperswarm({ bootstrap });
  const guestSwarm = new Hyperswarm({ bootstrap });

  console.log('[test] waiting for DHT bootstrap on both swarms');
  await Promise.all([
    hostSwarm.dht.fullyBootstrapped(),
    guestSwarm.dht.fullyBootstrapped(),
  ]);
  console.log('[test] DHT ready, host pubkey:', toHex(hostSwarm.keyPair.publicKey).slice(0, 16) + '...');
  console.log('[test] DHT ready, guest pubkey:', toHex(guestSwarm.keyPair.publicKey).slice(0, 16) + '...');

  const host = new BlindPairing(hostSwarm, { poll: 1000 });
  const guest = new BlindPairing(guestSwarm, { poll: 1000 });

  const autobaseKey = require('crypto').randomBytes(32);
  const { invite, publicKey, discoveryKey } = BlindPairing.createInvite(autobaseKey);
  console.log('[test] host created invite');
  console.log('[test]   invite (base64):', invite.toString('base64').slice(0, 40) + '...');
  console.log('[test]   publicKey:    ', toHex(publicKey).slice(0, 16) + '...');
  console.log('[test]   discoveryKey: ', toHex(discoveryKey).slice(0, 16) + '...');

  let hostPaired = null;
  let guestPaired = null;

  const member = host.addMember({
    discoveryKey,
    async onadd(candidate) {
      console.log('[test] host onadd: candidate inviteId =', candidate.inviteId?.toString('hex').slice(0, 16) || '<unknown>');
      candidate.open(publicKey);
      const userDataStr = candidate.userData ? Buffer.from(candidate.userData).toString('utf8') : '';
      console.log('[test] host onadd: userData =', userDataStr);
      candidate.confirm({ key: autobaseKey });
      hostPaired = {
        when: Date.now(),
        userData: userDataStr,
      };
    },
  });
  await member.flushed();
  console.log('[test] host member flushed, listening on discovery key');

  const userData = Buffer.from(JSON.stringify({
    name: 'guest-cli',
    app: 'tether-academy-test',
  }), 'utf8');

  const candidate = guest.addCandidate({
    invite,
    userData,
    async onadd(result) {
      console.log('[test] guest onadd: paired, result type =', typeof result, 'isBuffer =', Buffer.isBuffer(result));
      const keyBuf = result?.key ?? result;
      const resultHex = Buffer.isBuffer(keyBuf) ? keyBuf.toString('hex') : String(keyBuf);
      console.log('[test] guest onadd: paired, key =', resultHex.slice(0, 16) + '...');
      guestPaired = {
        when: Date.now(),
        key: resultHex,
      };
    },
  });

  console.log('[test] guest candidate created, awaiting pairing');
  await candidate.pairing;
  console.log('[test] candidate.pairing resolved');

  // Give the host's onadd a tick to fire after the DHT response lands.
  await new Promise((r) => setTimeout(r, 500));

  if (!hostPaired) {
    console.error('[test] FAIL: host onadd never fired');
    process.exit(1);
  }
  if (!guestPaired) {
    console.error('[test] FAIL: guest onadd never fired');
    process.exit(1);
  }

  console.log('[test] PASS: both sides paired');
  console.log('[test]   hostPaired:', hostPaired);
  console.log('[test]   guestPaired:', { ...guestPaired, key: guestPaired.key.slice(0, 16) + '...' });

  await member.close();
  await candidate.close().catch(() => {});
  await host.close();
  await guest.close();
  await hostSwarm.destroy();
  await guestSwarm.destroy();
  await testnet.destroy();

  console.log('[test] clean shutdown complete');
}

main().catch((err) => {
  console.error('[test] ERR:', err);
  process.exit(1);
});
