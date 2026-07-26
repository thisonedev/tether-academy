import {
  completion,
  LLAMA_3_2_1B_INST_Q4_0,
  loadModel,
  downloadAsset,
  unloadModel,
} from "@qvac/sdk";

async function main() {
  // 1: call downloadAsset() to pre-cache the model

  // 2: call loadModel(), stream a small completion, then unloadModel

  await unloadModel({ modelId: "" }).catch(() => {});
}

main().catch(console.error);