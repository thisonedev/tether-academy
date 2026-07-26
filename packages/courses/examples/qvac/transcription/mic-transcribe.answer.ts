import { loadModel, transcribe, unloadModel, WHISPER_TINY } from "@qvac/sdk";

async function* audioStream(): AsyncIterable<Float32Array> {
  for (let i = 0; i < 5; i++) {
    await new Promise((r) => setTimeout(r, 100));
    yield new Float32Array(16000);
  }
}

async function main() {
  const modelId = await loadModel({
    modelSrc: WHISPER_TINY,
    modelConfig: { language: "en" },
  });

  console.log("▸ Listening...");
  const segments = transcribe({
    modelId,
    audioStream: audioStream(),
    metadata: true,
  });

  for await (const segment of segments) {
    const start = (segment.startMs / 1000).toFixed(2);
    const end = (segment.endMs / 1000).toFixed(2);
    console.log(`[${start}s → ${end}s] ${segment.text}`);
  }

  await unloadModel({ modelId });
}

main().catch(console.error);