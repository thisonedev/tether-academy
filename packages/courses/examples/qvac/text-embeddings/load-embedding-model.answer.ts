import { loadModel, GTE_LARGE_FP16 } from "@qvac/sdk";

async function main() {
  const modelId = await loadModel({
    modelSrc: GTE_LARGE_FP16,
  });

  console.log("modelId:", modelId);
}

main().catch(console.error);
