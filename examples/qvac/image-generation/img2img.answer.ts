import fs from "node:fs";
import { loadModel, SD_V2_1_1B_Q8_0, diffusion, unloadModel } from "@qvac/sdk";

async function main() {
  const modelId = await loadModel({
    modelSrc: SD_V2_1_1B_Q8_0,
    modelType: "sdcpp-generation",
  });

  const initImage = fs.readFileSync("./examples/diffusion/input/sketch.png");

  const result = diffusion({
    modelId,
    prompt: "an oil painting of a fox in a snowy forest",
    init_image: initImage,
    strength: 0.6,
    width: 512,
    height: 512,
    steps: 25,
  });

  const outputs = await result.outputs;
  const firstImage = outputs[0];
  if (!firstImage) throw new Error("No image returned from diffusion");
  fs.writeFileSync("fox-painting.png", firstImage);
  console.log(`Generated ${outputs.length} image`);

  await unloadModel({ modelId });
}

main().catch(console.error);
