import { loadModel, video, unloadModel } from "@qvac/sdk";
import fs from "node:fs";

async function main() {
  // 1: load WAN2_1_T2V with video mode

  // 2: call video

  // 3: write the AVI and log the count

  await unloadModel({ modelId: videoId });
}

main().catch(console.error);