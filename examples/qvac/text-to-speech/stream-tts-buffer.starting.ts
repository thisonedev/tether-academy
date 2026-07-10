import {
  loadModel,
  unloadModel,
  textToSpeech,
  TTS_MULTILINGUAL_SUPERTONIC3_Q8_0,
} from "@qvac/sdk";

async function main() {
  const modelId = await loadModel({
    modelSrc: TTS_MULTILINGUAL_SUPERTONIC3_Q8_0,
    modelConfig: {
      ttsEngine: "supertonic",
      language: "en",
      voice: "F1",
    },
  });

  // 1: call textToSpeech() with stream: true

  // 2: iterate result.bufferStream and count samples

  // 3: log the total sample count

  await unloadModel({ modelId });
}

main().catch(console.error);