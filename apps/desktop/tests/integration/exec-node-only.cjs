'use strict';

// A lesson whose dependency needs Node builtins runs on the app's own Electron
// binary instead of the bare one, under the same profile.

const test = require('brittle');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { pairForExec, runExec, waitFor } = require('../helpers/index.cjs');
const { buildLesson } = require('../../electron/runner-process.cjs');
const { appStateDir } = require('../../workers/sandbox/capabilities.cjs');

const skip = process.platform === 'win32';
// GTE_LARGE_FP16 and the MCP lesson's model resolve via `registry://`, fetched
// over a real Hyperswarm/Hypercore swarm rather than a plain HTTPS download.
// Hosted GitHub Actions runners can't reliably do the UDP hole-punching a
// swarm connection needs, so a cold model pull there is an environment gap,
// not a test bug.
const skipSwarmDownload = skip || process.env.GITHUB_ACTIONS === 'true';
const COURSES = path.resolve(__dirname, '../../../../packages/courses');
const read = (rel) => fs.readFileSync(path.join(COURSES, rel), 'utf8');

// run-tests.mjs only keeps lines matching /^\s*not ok/ in its CI summary;
// a raw newline in a failure message would drop everything after it.
const oneLine = (s) => s.replace(/\s*\n\s*/g, ' | ');

// Loads a model and builds an index, so it needs room well past brittle's default.
const SQLITE_TIMEOUT_MS = 180_000;

// A node_modules path the host reads as node-only, so it picks that runtime.
const NODE_MARKER = `// from "${path.resolve(
  COURSES,
  '../../node_modules/@sqliteai/sqlite-wasm/node.mjs',
)}"`;

const CONFINEMENT_PROBE = `
  const fs = require('fs');
  const out = {};
  const t = (k, f) => { try { f(); out[k] = 'ALLOWED'; } catch (e) { out[k] = e.code || 'blocked'; } };
  t('ssh', () => fs.readdirSync(${JSON.stringify(path.join(os.homedir(), '.ssh'))}));
  t('appState', () => fs.readdirSync(${JSON.stringify(appStateDir())}));
  t('usr', () => fs.writeFileSync('/usr/x-node-probe', 'x'));
  t('electron', () => { const e = require('electron'); if (!e || !e.safeStorage) throw new Error('noapi'); });
  console.log('PROBE:' + JSON.stringify(out));
`;

const probeOf = (stdout) => JSON.parse(stdout.match(/PROBE:(\{.*\})/)[1]);

test('node-only - a node-only lesson runs on a peer via the node runtime', { skip: skipSwarmDownload }, async (t) => {
  t.timeout(SQLITE_TIMEOUT_MS + 60_000);
  const { host, guest, discoveryKey } = await pairForExec(t, 'node-runtime-sqlite');
  const before = host.getAudit().length;

  // A cold model cache means GTE_LARGE_FP16 has to be fetched, which asks for
  // network like any other run; a warm cache skips the prompt entirely.
  const off = host.on((event, payload) => {
    if (event === 'peer:exec:device-request') host.resolveDeviceRequest(payload.requestId, true);
  });
  t.teardown(off);

  const result = await runExec(
    guest,
    {
      peerId: discoveryKey,
      // Built for Node, which is what the host picks for this source.
      code: buildLesson({
        source: read('examples/qvac/rag/external-vector-db.answer.ts'),
        cwd: COURSES,
        runtime: 'node',
      }),
      mode: 'file',
      fileName: 'snippet.mts',
    },
    SQLITE_TIMEOUT_MS,
  );

  t.absent(
    /MODULE_NOT_FOUND/.test(result.stderr),
    `no resolver error; got: ${result.stderr.slice(-300)}`,
  );
  t.ok(
    /distance:/.test(result.stdout),
    oneLine(
      `the lesson produced results; stdout: ${result.stdout.slice(-300)}; stderr: ${result.stderr.slice(-500)}`,
    ),
  );

  const entry = host.getAudit().slice(before).find((e) => e.type === 'peer:exec:sandboxed');
  t.is(entry?.runtime, 'node', 'the host recorded which interpreter it used');
  t.is(entry?.sandboxed, true, 'and it was still sandboxed');
});

test('node-only - the node child is confined exactly like the bare one', { skip }, async (t) => {
  const { host, guest, discoveryKey } = await pairForExec(t, 'node-runtime-confined');
  const before = host.getAudit().length;

  // A dev machine already has this from real app use, so a denied read comes
  // back EPERM; on a fresh CI runner nothing else creates it, and the probe
  // would see ENOENT instead and pass for the wrong reason.
  fs.mkdirSync(appStateDir(), { recursive: true });

  const result = await runExec(
    guest,
    { peerId: discoveryKey, code: `${NODE_MARKER}\n${CONFINEMENT_PROBE}`, mode: 'inline' },
    40_000,
  );

  const entry = host.getAudit().slice(before).find((e) => e.type === 'peer:exec:sandboxed');
  t.is(entry?.runtime, 'node', 'the marker selected the node runtime');

  const probe = probeOf(result.stdout);
  t.is(probe.ssh, 'EPERM', 'the generated home deny-list still applies');
  t.is(probe.appState, 'EPERM', 'the app state directory is still refused');
  t.is(probe.usr, 'EPERM', 'the write allowlist still applies');
  t.not(probe.electron, 'ALLOWED', 'require("electron") reaches no API');
});

test('node-only - an MCP lesson runs on a peer from the pre-warmed cache', { skip: skipSwarmDownload }, async (t) => {
  t.timeout(SQLITE_TIMEOUT_MS + 300_000);
  const { host, guest, discoveryKey } = await pairForExec(t, 'node-runtime-mcp');
  const before = host.getAudit().length;

  // The server searches the web, so the run asks for egress like any other.
  const requested = waitFor(host, 'peer:exec:device-request', null, 60_000);
  const run = runExec(
    guest,
    {
      peerId: discoveryKey,
      code: buildLesson({
        source: read('examples/qvac/text-generation/mcp.answer.ts'),
        cwd: COURSES,
        runtime: 'node',
      }),
      mode: 'file',
      fileName: 'snippet.mts',
    },
    // A cold cache installs the server tree before the run starts.
    300_000,
  );
  const request = await requested;
  t.ok(request.network, 'the prompt says why the run wants the network');
  await host.resolveDeviceRequest(request.requestId, true);
  const result = await run;

  const audit = host.getAudit().slice(before);
  t.ok(
    audit.some((e) => e.type === 'peer:exec:mcp-warmed'),
    'the host prepared the server itself',
  );
  t.absent(/Connection closed/.test(result.stderr), `the server started; got: ${result.stderr.slice(-300)}`);
  t.ok(
    /Tool:|weather/i.test(result.stdout),
    oneLine(
      `the tool call ran; stdout: ${result.stdout.slice(-300)}; stderr: ${result.stderr.slice(-500)}`,
    ),
  );
});

// A peer must not get this machine to npm-install a package of its choosing.
test('node-only - an MCP server outside the allowlist is refused', { skip }, async (t) => {
  const { host, guest, discoveryKey } = await pairForExec(t, 'node-runtime-badpkg');
  const before = host.getAudit().length;

  const outcome = await runExec(
    guest,
    {
      peerId: discoveryKey,
      code: `${NODE_MARKER}\nconst t = ["-y", "@evil/not-on-the-list"];\nconsole.log(t);`,
      mode: 'inline',
    },
    30_000,
  ).then((ok) => ({ ok }), (err) => ({ err }));

  const message = outcome.err ? outcome.err.message : outcome.ok.stderr + outcome.ok.stdout;
  t.ok(/@evil\/not-on-the-list/.test(message), `the refusal names it; got: ${message}`);
  t.ok(/allowlist/.test(message), 'and says why');
  t.absent(
    host.getAudit().slice(before).some((e) => e.type === 'peer:exec:mcp-warmed'),
    'nothing was installed',
  );
});
