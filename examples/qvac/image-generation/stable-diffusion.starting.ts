import { loadModel, SD_V2_1_1B_Q8_0, diffusion, unloadModel } from "@qvac/sdk";
import fs from "node:fs";

async function main() {
  // 1: load SD 2.1 with prediction: "v"

  // 2: call diffusion

  // 3: write the PNG and log the count

  await unloadModel({ modelId });
}

main().catch(console.error);