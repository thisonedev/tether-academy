import fs from "node:fs";
import { loadModel, FLUX_2_KLEIN_4B_Q4_0, QWEN3_4B_Q4_K_M, FLUX_2_KLEIN_4B_VAE, diffusion, unloadModel } from "@qvac/sdk";

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

  if (result.progressStream) {
    for await (const progress of result.progressStream) {
      console.log(`${progress.step}/${progress.totalSteps}`);
    }
  }

  const outputs = await result.outputs;
  const firstImage = outputs[0];
  if (!firstImage) throw new Error("No image returned from diffusion");
  fs.writeFileSync("skyline.png", firstImage);
  console.log(`Generated ${outputs.length} image`);

  await unloadModel({ modelId });
}

main().catch(console.error);
