// Starter template. Fill in the TODOs before running; the placeholder state will throw.
// The .answer.ts file shows the completed version.
import { loadModel, textToSpeech, unloadModel } from "@qvac/sdk";

async function main() {
  // 1: load Parler-TTS (URL) with ttsEngine: "parler" and a voice

  // 2: call textToSpeech({ modelId, text, inputType: "text", stream: false, emotion: "happy" }) and await result.buffer

  // 3: write the audio as a WAV file

  void modelId;
  await unloadModel({ modelId: "" });
}

main().catch(console.error);