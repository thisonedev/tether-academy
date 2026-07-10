import { loadModel, LLAMA_3_2_1B_INST_Q4_0 } from "@qvac/sdk";

async function main() {
  const modelId = await loadModel({
    modelSrc: LLAMA_3_2_1B_INST_Q4_0,
  });
  console.log("modelId:", modelId);
}

main().catch(console.error);