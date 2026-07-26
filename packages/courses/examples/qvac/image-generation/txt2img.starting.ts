import { loadModel, FLUX_2_KLEIN_4B_Q4_0, QWEN3_4B_Q4_K_M, FLUX_2_KLEIN_4B_VAE, diffusion, unloadModel } from "@qvac/sdk";
import fs from "node:fs";

async function main() {
  // 1: load FLUX.2-klein split-layout

  // 2: call diffusion

  // 3: write the PNG and log the count

  await unloadModel({ modelId });
}

main().catch(console.error);