import fs from "node:fs";
import { loadModel, FLUX_2_KLEIN_4B_Q4_0, QWEN3_4B_Q4_K_M, FLUX_2_KLEIN_4B_VAE, diffusion, unloadModel } from "@qvac/sdk";

async function main() {
  const lastLogged = new Map();
  const modelId = await loadModel({
    modelSrc: FLUX_2_KLEIN_4B_Q4_0,
    modelType: "sdcpp-generation",
    modelConfig: {
      llmModelSrc: QWEN3_4B_Q4_K_M,
      vaeModelSrc: FLUX_2_KLEIN_4B_VAE,
    },
    onProgress: ({ percentage, downloaded, total, downloadKey }) => {
      const bucket = Math.floor(percentage / 10) * 10;
      if (lastLogged.get(downloadKey) === bucket) return;
      lastLogged.set(downloadKey, bucket);
      const mb = (n) => (n / 1e6).toFixed(1);
      console.log(`▸ Downloading ${bucket}% (${mb(downloaded)}/${mb(total)} MB)`);
    },
  });

  const result = diffusion({ modelId, prompt: "a cat sitting on a sofa" });
  if (result.progressStream) {
    for await (const step of result.progressStream) {
      console.log(`▸ step ${step.step}/${step.totalSteps}`);
    }
  }
  const outputs = await result.outputs;
  const firstImage = outputs[0];
  if (!firstImage) throw new Error("No image returned from diffusion");
  fs.writeFileSync("output/image-generation/cat.png", firstImage);

  console.log(`Generated ${outputs.length} image`);
  await unloadModel({ modelId });
}

main().catch(console.error);
