import { loadModel, unloadModel, transcribe, PARAKEET_TDT_0_6B_V3_Q8_0 } from "@qvac/sdk";

async function main() {
  const modelId = await loadModel({
    modelSrc: PARAKEET_TDT_0_6B_V3_Q8_0,
    modelType: "parakeet-transcription",
  });

  const text = await transcribe({
    modelId,
    audioChunk: "./examples/audio/sample-16khz.wav",
  });

  console.log(text);

  await unloadModel({ modelId });
}

main().catch(console.error);
