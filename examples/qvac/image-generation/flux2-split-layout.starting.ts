import {
  loadModel,
  FLUX_2_KLEIN_4B_Q4_0,
  QWEN3_4B_Q4_K_M,
  FLUX_2_KLEIN_4B_VAE,
  diffusion,
  unloadModel,
} from "@qvac/sdk";
import fs from "node:fs";

async function main() {
  // 1: load the FLUX.2-klein split-layout model

  // 2: call diffusion() and await result.outputs

  // 3: write outputs[0] to disk and log the count

  await unloadModel({ modelId });
}

main().catch(console.error);