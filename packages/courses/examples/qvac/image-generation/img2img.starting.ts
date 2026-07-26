import { loadModel, SD_V2_1_1B_Q8_0, diffusion, unloadModel } from "@qvac/sdk";
import fs from "node:fs";

async function main() {
  const modelId = await loadModel({
    modelSrc: SD_V2_1_1B_Q8_0,
    modelType: "sdcpp-generation",
  });

  // 1: read the source image into a Uint8Array

  // 2: call diffusion

  // 3: write the PNG and log the count

  await unloadModel({ modelId });
}

main().catch(console.error);