import { loadModel, unloadModel, transcribe, PARAKEET_TDT_0_6B_V3_Q8_0 } from "@qvac/sdk";

async function main() {
  // 1: load the model and call transcribe()

  // 2: console.log the returned text

  await unloadModel({ modelId });
}

main().catch(console.error);