import { loadModel, transcribe, unloadModel, WHISPER_TINY } from "@qvac/sdk";

async function audioStream(): AsyncIterable<Float32Array> {
  yield new Float32Array(16000);
}

async function main() {
  const modelId = await loadModel({
    modelSrc: WHISPER_TINY,
    modelConfig: { language: "en" },
  });

  // 1: call transcribe() with the audioStream and metadata: true

  // 2: iterate the segments and log text + timestamps

  await unloadModel({ modelId });
}

main().catch(console.error);