import { loadModel, FLUX_2_KLEIN_4B_Q4_0, QWEN3_4B_Q4_K_M, FLUX_2_KLEIN_4B_VAE, diffusion, unloadModel } from "@qvac/sdk";
import fs from "node:fs";

async function main() {
  const modelId = await loadModel({
    modelSrc: FLUX_2_KLEIN_4B_Q4_0,
    modelType: "sdcpp-generation",
    modelConfig: {
      llmModelSrc: QWEN3_4B_Q4_K_M,
      vaeModelSrc: FLUX_2_KLEIN_4B_VAE,
    },
  });

  const result = diffusion({
    modelId,
    prompt: "a city skyline at sunset",
    width: 512,
    height: 512,
    steps: 20,
  });

  // 1: iterate result.progressStream and log each step

  // 2: await result.outputs and write outputs[0] to disk

  await unloadModel({ modelId });
}

main().catch(console.error);