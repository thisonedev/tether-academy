import { loadModel, unloadModel, transcribe, WHISPER_TINY } from "@qvac/sdk";

async function main() {
  const modelId = await loadModel({
    modelSrc: WHISPER_TINY,
    modelConfig: { language: "en" },
  });

  const text = await transcribe({
    modelId,
    audioChunk: "./examples/audio/sample-16khz.wav",
    prompt: "This is a test recording with clear speech and proper punctuation.",
  });

  console.log("▸ Transcription result:");
  console.log(text);

  await unloadModel({ modelId });
}

main().catch(console.error);
