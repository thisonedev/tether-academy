import { loadModel, GTE_LARGE_FP16, embed } from "@qvac/sdk";

async function main() {
  const modelId = await loadModel({ modelSrc: GTE_LARGE_FP16 });

  // 1: call embed() and destructure embedding

  // 2: log the input, the dimensions, and the first 10 values
}

main().catch(console.error);