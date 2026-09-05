// Run from apps/desktop (node ../../packages/workflows/scripts/gen-meeting-audio.mjs):
// @qvac/sdk is a dependency there, not of this package, and ESM resolves
// package imports from the importing file's own location, not cwd.
import { writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import * as sdk from '@qvac/sdk';

const SAMPLE_RATE = 44100;
const TEXT = `Thanks everyone for joining. Quick recap of today's sync.
First, the onboarding flow redesign is on track for next Friday's release.
Sarah's team finished the new signup form and it's already in staging.
Second, we're still waiting on the vendor contract for the analytics integration, so that's blocked until legal signs off.
Third, support tickets dropped by twenty percent this week after the documentation update, which is great news.
Action items: Mike will follow up with legal by Wednesday, and Priya will schedule the staging demo for the whole team.
That's everything. Thanks all, talk next week.`;

function wavFromInt16(samples, sampleRate) {
  const dataBytes = samples.length * 2;
  const buf = Buffer.alloc(44 + dataBytes);
  buf.write('RIFF', 0);
  buf.writeUInt32LE(36 + dataBytes, 4);
  buf.write('WAVE', 8);
  buf.write('fmt ', 12);
  buf.writeUInt32LE(16, 16);
  buf.writeUInt16LE(1, 20);
  buf.writeUInt16LE(1, 22);
  buf.writeUInt32LE(sampleRate, 24);
  buf.writeUInt32LE(sampleRate * 2, 28);
  buf.writeUInt16LE(2, 32);
  buf.writeUInt16LE(16, 34);
  buf.write('data', 36);
  buf.writeUInt32LE(dataBytes, 40);
  for (let i = 0; i < samples.length; i++) {
    const v = Math.max(-32768, Math.min(32767, Math.round(samples[i] ?? 0)));
    buf.writeInt16LE(v, 44 + i * 2);
  }
  return buf;
}

const modelId = await sdk.loadModel({
  modelSrc: sdk.TTS_MULTILINGUAL_SUPERTONIC3_Q8_0,
  modelConfig: { ttsEngine: 'supertonic', language: 'en', voice: 'F1', ttsSpeed: 1.0 },
});

const result = sdk.textToSpeech({ modelId, text: TEXT, inputType: 'text', stream: false });
const audioBuffer = await result.buffer;
const wav = wavFromInt16(audioBuffer, SAMPLE_RATE);

const outPath = fileURLToPath(new URL('../data/speech-team-sync-notes.wav', import.meta.url));
await writeFile(outPath, wav);
console.log(`wrote ${outPath} (${(wav.length / 1024).toFixed(0)} KB, ${(audioBuffer.length / SAMPLE_RATE).toFixed(1)}s)`);

await sdk.unloadModel({ modelId, clearStorage: false });
process.exit(0);
