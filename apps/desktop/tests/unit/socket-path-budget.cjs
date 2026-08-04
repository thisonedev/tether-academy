'use strict';

// QVAC opens its worker socket in the child's TMPDIR (the run directory), and
// sun_path caps the whole path at 104 bytes; a run directory named
// `academy-exec-XXXXXX` once left only 7 spare bytes, and every paired lesson
// that loaded a model died with EINVAL. This canary reads the SDK's dist so an
// upgrade that lengthens the socket name fails here rather than in a lesson.

const test = require('brittle');
const fs = require('node:fs');
const net = require('node:net');
const path = require('node:path');
const { createRequire } = require('node:module');

const {
  makeRunDir,
  assertSocketRoom,
  SOCKET_PATH_MAX,
  SOCKET_NAME_RESERVE,
} = require('../../workers/sandbox/index.cjs');

const DESKTOP_ROOT = path.resolve(__dirname, '..', '..');

/** The SDK's own dist file, wherever pnpm put it. */
function sdkRpcSource() {
  const req = createRequire(path.join(DESKTOP_ROOT, 'package.json'));
  const dist = path.dirname(req.resolve('@qvac/sdk'));
  return fs.readFileSync(path.join(dist, 'client', 'rpc', 'node-rpc-client.js'), 'utf8');
}

// Widest each field in the template can render.
const FIELD_WIDTH = {
  'process.pid': 7, // Linux pid_max allows 7 digits
  timestamp: 9, // Date.now().toString(36) until the year 4000
  randomSuffix: 4, // randomBytes(2).toString('hex')
};

test('socket-budget - a worst-case worker socket fits in the run directory', { skip: process.platform === 'win32' }, async (t) => {
  const runDir = makeRunDir();
  t.teardown(() => fs.rmSync(runDir, { recursive: true, force: true }));

  const socketName = `qvac-worker-${'9'.repeat(7)}-${'m'.repeat(9)}-abcd.sock`;
  const socketPath = path.join(runDir, socketName);
  t.ok(socketName.length <= SOCKET_NAME_RESERVE, `${socketName.length} bytes within the reserve`);
  t.ok(Buffer.byteLength(socketPath) <= SOCKET_PATH_MAX, `${Buffer.byteLength(socketPath)} bytes fits sun_path`);

  const server = net.createServer();
  t.teardown(() => server.close());
  await t.execution(
    new Promise((resolve, reject) => {
      server.once('error', reject);
      server.listen(socketPath, resolve);
    }),
    'and the kernel accepts it',
  );
});

test('socket-budget - a run directory with no room is refused up front', { skip: process.platform === 'win32' }, (t) => {
  t.execution(() => assertSocketRoom(makeRunDir()), 'a real run directory passes');
  t.exception(
    () => assertSocketRoom(`/tmp/${'x'.repeat(SOCKET_PATH_MAX)}`),
    /leaves .* bytes for a unix socket/,
    'a long one throws where the path is still nameable',
  );
});

// Reads the SDK rather than trusting our copy of its behaviour; if this fails after an upgrade, remeasure and move SOCKET_NAME_RESERVE.
test('socket-budget - the installed SDK still builds the socket name we reserved for', (t) => {
  const src = sdkRpcSource();

  t.ok(
    /path\.join\(os\.tmpdir\(\)/.test(src),
    'the socket still lands in the child TMPDIR (if not, this budget may be moot)',
  );

  const template = src.match(/const socketName = `([^`]+)`/)?.[1];
  t.ok(template, 'socket name template found in the SDK dist');

  let width = template.replace(/\$\{([^}]+)\}/g, (_, expr) => {
    const known = FIELD_WIDTH[expr.trim()];
    t.ok(known, `field ${expr.trim()} has a known width`);
    return 'x'.repeat(known ?? 0);
  }).length + '.sock'.length;

  t.ok(
    width <= SOCKET_NAME_RESERVE,
    `worst-case socket name is ${width} bytes, reserve is ${SOCKET_NAME_RESERVE}`,
  );
});
