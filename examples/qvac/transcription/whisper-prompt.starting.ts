import { loadModel, unloadModel, transcribe, WHISPER_TINY } from "@qvac/sdk";

async function main() {
  const modelId = await loadModel({
    modelSrc: WHISPER_TINY,
    modelConfig: { language: "en" },
  });

  // 1: call transcribe() with a prompt and log the text

  await unloadModel({ modelId });
}

main().catch(console.error);