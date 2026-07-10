import fs from "node:fs";
import {
  loadModel,
  FLUX_2_KLEIN_4B_Q4_0,
  QWEN3_4B_Q4_K_M,
  FLUX_2_KLEIN_4B_VAE,
  diffusion,
  unloadModel,
} from "@qvac/sdk";

async function main() {
  const modelId = await loadModel({
    modelSrc: FLUX_2_KLEIN_4B_Q4_0,
    modelType: "sdcpp-generation",
    modelConfig: {
      llmModelSrc: QWEN3_4B_Q4_K_M,
      vaeModelSrc: FLUX_2_KLEIN_4B_VAE,
    },
  });

  const result = diffusion({ modelId, prompt: "a quiet harbor at dawn" });
  const outputs = await result.outputs;
  const first = outputs[0];
  if (!first) throw new Error("No image returned from diffusion");
  fs.writeFileSync("harbor.png", first);
  console.log(`Generated ${outputs.length} image`);

  await unloadModel({ modelId });
}

main().catch(console.error);
