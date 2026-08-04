'use strict';

// What each platform's sandbox is claimed to enforce, in one table; every row
// is asserted against a real kernel by integration/sandbox-conformance.cjs.
//
// `expect` values:
//   'denied'      the platform stops it, and the test fails if the run succeeds
//   'allowed'     the platform permits it on purpose, asserted so a change shows
//   'not-claimed' the platform cannot enforce it; the row records the gap and
//                 names what refuses the run instead

const os = require('node:os');
const path = require('node:path');

const { appStateDir } = require('../../workers/sandbox/capabilities.cjs');

// Reports 'blocked: <errno>' or 'leaked', never throws, so a denial and a crash cannot be read as the same thing.
const attempt = (body) =>
  `try { ${body} } catch (e) { process.stdout.write('blocked: ' + e.code + '\\n'); process.exit(0); }`;

const readFile = (file) =>
  attempt(
    `const d = require('fs').readFileSync(${JSON.stringify(file)}, 'utf8');`
      + `process.stdout.write('leaked ' + d.length + '\\n');`,
  );

// A host that resolves but is not loopback; the timeout branch counts as reached, since the connection was permitted.
const connectTo = (host) =>
  `const req = require('http').get('http://${host}/', () => { process.stdout.write('reached\\n'); process.exit(0); });`
  + `req.on('error', (e) => { process.stdout.write('blocked: ' + e.code + '\\n'); process.exit(0); });`
  + `req.setTimeout(6000, () => { process.stdout.write('reached: timeout\\n'); process.exit(0); });`;

/**
 * @typedef {object} ConformanceRow
 * @property {string} id
 * @property {string} claim what the sandbox is said to guarantee
 * @property {string[]} grants run grants to apply
 * @property {(ctx: { runDir: string }) => string} code snippet to run inside the sandbox
 * @property {{ darwin: string, linux: string }} expect
 * @property {string} [note] why a platform does not claim it
 */

/** @type {ConformanceRow[]} */
const CONFORMANCE = [
  {
    id: 'network-none',
    claim: "with no network grant, connect() fails",
    grants: [],
    code: () => connectTo('example.com'),
    expect: { darwin: 'denied', linux: 'denied' },
  },
  {
    id: 'network-loopback-is-not-egress',
    claim: "with a loopback grant, a non-loopback connect() fails",
    grants: ['network-loopback'],
    code: () => connectTo('example.com'),
    expect: { darwin: 'denied', linux: 'not-claimed' },
    note:
      'bwrap has no address filter, so a loopback grant there is full egress. '
      + 'exec-host compares the requested scope against enforcedNetworkScope() '
      + 'and refuses the run before it starts.',
  },
  {
    id: 'network-granted-is-unfiltered',
    claim: 'with a full network grant, any host is reachable',
    grants: ['network'],
    code: () => connectTo('example.com'),
    expect: { darwin: 'allowed', linux: 'allowed' },
    note: 'Neither backend filters by domain. Asserted so it stays a known gap.',
  },
  {
    id: 'write-outside-run-dir',
    claim: 'writes outside the run directory fail',
    grants: [],
    code: () =>
      attempt(
        `require('fs').writeFileSync('/usr/ta-conformance-${process.pid}.txt', 'x');`
          + `process.stdout.write('leaked\\n');`,
      ),
    expect: { darwin: 'denied', linux: 'denied' },
  },
  {
    id: 'write-inside-run-dir',
    claim: 'the run directory is writable',
    grants: [],
    code: ({ runDir }) =>
      attempt(
        `require('fs').writeFileSync(${JSON.stringify(path.join('RUNDIR', 'ok.txt'))}.replace('RUNDIR', ${JSON.stringify(runDir)}), 'x');`
          + `process.stdout.write('leaked\\n');`,
      ),
    expect: { darwin: 'allowed', linux: 'allowed' },
    note: 'The one place a run may write. "leaked" is the success token here.',
  },
  {
    id: 'app-state-unreadable',
    claim: "the app's own state directory is unreadable",
    grants: [],
    // The path is the resolved userData when supplied to wrapSpawn, otherwise the home-default.
    code: (ctx) => {
      const target = ctx.userData
        ? path.join(ctx.userData, 'identity-v3.json')
        : path.join(appStateDir(), 'identity-v3.json');
      return readFile(target);
    },
    expect: { darwin: 'denied', linux: 'denied' },
  },
  {
    id: 'secrets-dir-unreadable',
    claim: 'the local encryption key is unreadable',
    grants: [],
    code: () => readFile(path.join(os.homedir(), '.tether-academy', 'keys', 'local-key')),
    expect: { darwin: 'denied', linux: 'denied' },
  },
  {
    id: 'symlink-escape',
    claim: 'a run cannot create a symlink inside its writable area',
    grants: [],
    code: ({ runDir }) =>
      attempt(
        `require('fs').symlinkSync('/etc/passwd', ${JSON.stringify(runDir)} + '/escape');`
          + `process.stdout.write('leaked\\n');`,
      ),
    expect: { darwin: 'denied', linux: 'denied' },
    note:
      'macOS denies file-write-create on vnode-type SYMLINK; Linux denies the '
      + 'symlink syscalls in seccomp-filter.cjs. Without it a link planted in a '
      + 'writable bind is followed back out of it.',
  },
];

module.exports = { CONFORMANCE, attempt };
