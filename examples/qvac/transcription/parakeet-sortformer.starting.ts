import {
  loadModel,
  unloadModel,
  transcribe,
  PARAKEET_TDT_0_6B_V3_Q8_0,
  PARAKEET_SORTFORMER_4SPK_V2_1_Q8_0,
} from "@qvac/sdk";

const audioFilePath = "./examples/audio/diarization-sample-16k.wav";

async function main() {
  // 1: load Sortformer, transcribe, parse into segments

  // 2: load TDT and transcribe each segment

  // 3: console.log one line per result

  await unloadModel({ modelId: "" }).catch(() => {});
}

main().catch(console.error);