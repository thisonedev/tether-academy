import fs from "node:fs";
import { loadModel, SD_V2_1_1B_Q8_0, diffusion, unloadModel } from "@qvac/sdk";

async function main() {
  const modelId = await loadModel({
    modelSrc: SD_V2_1_1B_Q8_0,
    modelType: "sdcpp-generation",
    modelConfig: { prediction: "v" },
  });

  const result = diffusion({
    modelId,
    prompt: "a photo of a cat sitting on a windowsill",
  });
  const outputs = await result.outputs;
  const first = outputs[0];
  if (!first) throw new Error("No image returned from diffusion");
  fs.writeFileSync("cat.png", first);
  console.log(`Generated ${outputs.length} image`);

  await unloadModel({ modelId });
}

main().catch(console.error);
