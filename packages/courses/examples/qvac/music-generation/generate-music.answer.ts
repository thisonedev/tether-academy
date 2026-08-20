import { writeFileSync } from "node:fs";
import {
  AUDIOGEN_ACESTEP_5HZ_LM_0_6B_Q8_0,
  AUDIOGEN_ACESTEP_V15_TURBO_Q4_K_M,
  AUDIOGEN_QWEN3_EMBEDDING_0_6B_Q8_0,
  AUDIOGEN_VAE_BF16,
  audioGen,
  loadModel,
  unloadModel,
} from "@qvac/sdk";

const caption =
  process.argv[2] ??
  "Lo-fi hip hop with mellow piano, soft drums, and a warm bass line";

const modelId = await loadModel({
  modelType: "audiogen",
  modelConfig: {
    textEncModelSrc: AUDIOGEN_QWEN3_EMBEDDING_0_6B_Q8_0,
    lmModelSrc: AUDIOGEN_ACESTEP_5HZ_LM_0_6B_Q8_0,
    ditModelSrc: AUDIOGEN_ACESTEP_V15_TURBO_Q4_K_M,
    vaeModelSrc: AUDIOGEN_VAE_BF16,
    useGPU: true,
    inferenceSteps: 8,
  },
});

const run = audioGen({
  modelId,
  caption,
  lyrics: "[Instrumental]",
  seed: 42,
  duration: 10,
});

for await (const progress of run.progressStream) {
  console.log(`▸ ${progress.stage}: ${progress.step}/${progress.total}`);
}

const [audio, stats] = await Promise.all([run.audio, run.stats]);
const wav = createWav(audio.pcm, audio.sampleRate, audio.channels, audio.bitsPerSample);
writeFileSync("output/music-generation/audiogen-output.wav", wav);

const samplesPerChannel =
  audio.pcm.byteLength / (audio.bitsPerSample / 8) / audio.channels;
console.log(
  `▸ Generated ${samplesPerChannel} samples per channel at ` +
    `${audio.sampleRate} Hz (${audio.channels} channels)`,
);
if (stats) console.log(`▸ Stats: ${JSON.stringify(stats)}`);
console.log(`▸ Saved output/music-generation/audiogen-output.wav`);

await unloadModel({ modelId });
console.log("▸ Model unloaded");

function createWav(
  pcm: Uint8Array,
  sampleRate: number,
  channels: number,
  bitsPerSample: number,
): Uint8Array {
  const header = new ArrayBuffer(44);
  const view = new DataView(header);
  const blockAlign = channels * (bitsPerSample / 8);

  writeAscii(view, 0, "RIFF");
  view.setUint32(4, 36 + pcm.byteLength, true);
  writeAscii(view, 8, "WAVE");
  writeAscii(view, 12, "fmt ");
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);
  view.setUint16(22, channels, true);
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * blockAlign, true);
  view.setUint16(32, blockAlign, true);
  view.setUint16(34, bitsPerSample, true);
  writeAscii(view, 36, "data");
  view.setUint32(40, pcm.byteLength, true);

  const wav = new Uint8Array(44 + pcm.byteLength);
  wav.set(new Uint8Array(header), 0);
  wav.set(pcm, 44);
  return wav;
}

function writeAscii(view: DataView, offset: number, value: string) {
  for (let index = 0; index < value.length; index++) {
    view.setUint8(offset + index, value.charCodeAt(index));
  }
}