import {
  loadModel,
  unloadModel,
  textToSpeech,
  TTS_T3_TURBO_EN_CHATTERBOX_Q8_0,
  TTS_S3GEN_EN_CHATTERBOX,
} from "@qvac/sdk";

async function main() {
  const modelId = await loadModel({
    modelSrc: TTS_T3_TURBO_EN_CHATTERBOX_Q8_0,
    modelConfig: {
      ttsEngine: "chatterbox",
      language: "en",
      s3genModelSrc: TTS_S3GEN_EN_CHATTERBOX.src,
      streamChunkTokens: 25,
      streamFirstChunkTokens: 10,
      cfmSteps: 1,
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
