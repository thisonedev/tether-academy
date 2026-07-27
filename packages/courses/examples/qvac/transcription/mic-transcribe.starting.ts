import { spawn, spawnSync } from "node:child_process";
import { platform } from "node:os";
import { loadModel, unloadModel, transcribeStream, WHISPER_TINY, VAD_SILERO_5_1_2 } from "@qvac/sdk";

const MIC_SAMPLE_RATE = 16000;

async function main() {
  const modelId = await loadModel({
    modelSrc: WHISPER_TINY,
    modelConfig: {
      vadModelSrc: VAD_SILERO_5_1_2,
      audio_format: "f32le",
      language: "en",
    },
  });

  await unloadModel({ modelId });
}

main().catch(console.error);
