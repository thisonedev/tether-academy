import { loadModel, unloadModel, transcribe, PARAKEET_CTC_0_6B_Q8_0 } from "@qvac/sdk";

async function main() {
  const modelId = await loadModel({
    modelSrc: PARAKEET_CTC_0_6B_Q8_0,
    modelType: "parakeet-transcription",
  });

  // 1: call transcribe() and console.log the text

  await unloadModel({ modelId });
}

main().catch(console.error);