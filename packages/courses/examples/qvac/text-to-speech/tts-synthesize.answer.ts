import { loadModel, textToSpeech, unloadModel, TTS_MULTILINGUAL_SUPERTONIC3_Q8_0 } from "@qvac/sdk";

async function main() {
  const modelId = await loadModel({
    modelSrc: TTS_MULTILINGUAL_SUPERTONIC3_Q8_0,
    modelConfig: {
      ttsEngine: "supertonic",
      language: "en",
      voice: "F1",
    },
  });

  const result = textToSpeech({
    modelId,
    text: "Hello, world.",
    inputType: "text",
    stream: false,
  });

  const audioBuffer = await result.buffer;
  console.log(`▸ TTS complete. Total samples: ${audioBuffer.length}`);

  await unloadModel({ modelId });
}

main().catch(console.error);