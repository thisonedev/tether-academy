import {
  loadModel,
  unloadModel,
  textToSpeech,
  TTS_MULTILINGUAL_SUPERTONIC3_Q8_0,
} from "@qvac/sdk";

const SUPERTONIC_SAMPLE_RATE = 44100;

async function main() {
  const modelId = await loadModel({
    modelSrc: TTS_MULTILINGUAL_SUPERTONIC3_Q8_0,
    modelConfig: {
      ttsEngine: "supertonic",
      language: "en",
      voice: "F1",
    },
  });

  const result = textToSpeech({
    modelId,
    text: "Streaming chunks as they arrive is the right shape for low-latency voice.",
    inputType: "text",
    stream: true,
  });

  let totalSamples = 0;
  let chunks = 0;
  for await (const sample of result.bufferStream) {
    void sample;
    chunks += 1;
    if (chunks % 4096 === 0) totalSamples = chunks;
  }
  totalSamples = chunks;
  console.log(`▸ Streamed ${totalSamples} samples in chunks`);

  await unloadModel({ modelId });
}

main().catch(console.error);
