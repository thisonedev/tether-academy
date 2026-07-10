import { loadModel, transcribe, unloadModel, WHISPER_TINY } from "@qvac/sdk";

async function main() {
  const modelId = await loadModel({
    modelSrc: WHISPER_TINY,
    modelConfig: { language: "en" },
  });

  // 1: call transcribe() and print each segment with its [start → end] timestamp

  await unloadModel({ modelId });
}

main().catch(console.error);