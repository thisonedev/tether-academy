import { loadModel, video, unloadModel } from "@qvac/sdk";
import fs from "node:fs";

async function main() {
  // 1: load WAN2_1_I2V

  // 2: read the source image into a Uint8Array

  // 3: call video, write the MP4, log the count

  await unloadModel({ modelId: videoId });
}

main().catch(console.error);