import { loadModel, unloadModel, TTS_MULTILINGUAL_SUPERTONIC3_Q8_0 } from "@qvac/sdk";

async function main() {
  // 1: load the multilingual Supertonic model

  // 2: call textToSpeech() and await result.buffer

  // 3: log the sample count

  await unloadModel({ modelId });
}

main().catch(console.error);