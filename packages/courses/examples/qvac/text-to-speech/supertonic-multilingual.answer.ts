import {
  loadModel,
  unloadModel,
  textToSpeech,
  TTS_MULTILINGUAL_SUPERTONIC3_Q8_0,
} from "@qvac/sdk";

async function main() {
  const modelId = await loadModel({
    modelSrc: TTS_MULTILINGUAL_SUPERTONIC3_Q8_0,
    modelConfig: {
      ttsEngine: "supertonic",
      language: "es",
      voice: "F1",
      ttsSpeed: 1.05,
      ttsNumInferenceSteps: 5,
    },
  });

  const result = textToSpeech({
    modelId,
    text: "Hola mundo. Esta es una demostración de síntesis de voz con Supertonic en español.",
    inputType: "text",
    stream: false,
  });

  const audioBuffer = await result.buffer;
  console.log(`▸ TTS complete. Total samples: ${audioBuffer.length}`);

  await unloadModel({ modelId });
}

main().catch(console.error);
