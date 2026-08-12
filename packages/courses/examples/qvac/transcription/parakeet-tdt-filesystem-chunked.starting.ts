import { loadModel, unloadModel, transcribe, PARAKEET_TDT_0_6B_V3_Q8_0 } from "@qvac/sdk";

async function main() {
  // 1: load the Parakeet TDT model

  // 2: detect silence and split audio into <=60s segments

  // 3: transcribe each segment and concatenate the results

  void modelId;
  await unloadModel({ modelId: "" });
}

main().catch(console.error);