import { loadModel, unloadModel, transcribe, WHISPER_TINY } from "@qvac/sdk";

async function main() {
  const modelId = await loadModel({
    modelSrc: WHISPER_TINY,
    modelConfig: { language: "en" },
  });

  const segments = await transcribe({
    modelId,
    audioChunk: "./examples/audio/sample-16khz.wav",
    metadata: true,
  });

  for (const segment of segments) {
    const start = (segment.startMs / 1000).toFixed(2);
    const end = (segment.endMs / 1000).toFixed(2);
    console.log(`[${start}s → ${end}s] ${segment.text}`);
  }

  await unloadModel({ modelId });
}

main().catch(console.error);