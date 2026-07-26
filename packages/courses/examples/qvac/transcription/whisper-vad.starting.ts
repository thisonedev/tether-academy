import { loadModel, unloadModel, transcribeStream, WHISPER_TINY, VAD_SILERO_5_1_2 } from "@qvac/sdk";

async function audioStream(): AsyncIterable<Float32Array> {
  yield new Float32Array(16000);
}

async function main() {
  const modelId = await loadModel({
    modelSrc: WHISPER_TINY,
    modelConfig: {
      vadModelSrc: VAD_SILERO_5_1_2,
      language: "en",
    },
  });

  // 1: open a transcribeStream session, pipe audioStream into session.write, iterate

  // 2: switch on event.type for text, vad, endOfTurn

  await unloadModel({ modelId });
}

main().catch(console.error);