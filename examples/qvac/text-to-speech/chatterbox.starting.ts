import {
  loadModel,
  unloadModel,
  TTS_T3_TURBO_EN_CHATTERBOX_Q8_0,
  TTS_S3GEN_EN_CHATTERBOX,
} from "@qvac/sdk";

async function main() {
  // 1: load the Chatterbox T3 + S3Gen pair

  // 2: call textToSpeech() and await result.buffer

  // 3: log the sample count

  await unloadModel({ modelId });
}

main().catch(console.error);