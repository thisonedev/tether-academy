'use strict';

// Which runs need a device prompt. Decided host-side from the source, so a
// peer cannot ask for the microphone, only send code that wants it.

const test = require('brittle');

const { detectDeviceNeeds, detectNodeOnly } = require('../../workers/peer/exec-validate.cjs');

test('device-consent - ffmpeg capture backends are detected on every platform', (t) => {
  t.alike(detectDeviceNeeds('spawn("ffmpeg", ["-f", "avfoundation", "-i", ":0"])'), ['microphone']);
  t.alike(detectDeviceNeeds('spawn("ffmpeg", ["-f", "pulse", "-i", "default"])'), ['microphone']);
  t.alike(detectDeviceNeeds('spawn("ffmpeg", ["-f", "alsa", "-i", "default"])'), ['microphone']);
  t.alike(detectDeviceNeeds('spawn("ffmpeg", ["-f", "dshow", "-i", `audio=${d}`])'), ['microphone']);
});

// What the voice-assistant lessons actually call.
test('device-consent - the course helper is detected', (t) => {
  t.alike(
    detectDeviceNeeds('const ffmpeg = startMicrophone({ sampleRate: 16000, format: "f32le" });'),
    ['microphone'],
  );
});

test('device-consent - ordinary lessons are not prompted', (t) => {
  t.alike(detectDeviceNeeds('console.log("hello")'), []);
  t.alike(detectDeviceNeeds('const r = await completion({ prompt: "hi" });'), []);
  // ffmpeg alone is not capture; the diffusion lessons use it to encode.
  t.alike(detectDeviceNeeds('spawnSync("ffmpeg", ["-i", "in.wav", "out.mp3"])'), []);
});

test('device-consent - non-strings are not a prompt', (t) => {
  t.alike(detectDeviceNeeds(''), []);
  t.alike(detectDeviceNeeds(null), []);
  t.alike(detectDeviceNeeds(undefined), []);
});

// A dependency's own requires are out of buildLesson's reach, so a lesson that
// pulls one in is refused up front instead of dying with a module error from
// inside node_modules.
test('exec-validate - a lesson with a node-only dependency is refused', (t) => {
  const mcp = require('node:fs').readFileSync(
    require('node:path').resolve(
      __dirname,
      '../../../../packages/courses/examples/qvac/text-generation/mcp.answer.ts',
    ),
    'utf8',
  );

  const { buildLesson } = require('../../electron/runner-process.cjs');
  const built = buildLesson({
    source: mcp,
    cwd: require('node:path').resolve(__dirname, '../../../../packages/courses'),
    runtime: 'bare',
  });

  t.ok(detectNodeOnly(built), 'the real course sample is caught');
  t.ok(detectNodeOnly(built).includes('@modelcontextprotocol/sdk'), 'the refusal names the package');
  t.is(detectNodeOnly('console.log(1);'), null, 'an ordinary lesson still runs');
  t.is(detectNodeOnly(''), null);
});
