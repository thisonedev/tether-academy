import { loadModel, REALESRGAN_X4PLUS_ANIME_6B, upscale, unloadModel } from "@qvac/sdk";
import fs from "node:fs";

async function main() {
  // 1: load the ESRGAN upscaler

  // 2: read the PNG into a Uint8Array

  // 3: call upscale, write the PNG, log the count

  await unloadModel({ modelId });
}

main().catch(console.error);