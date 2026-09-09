import fs from "node:fs";
import { loadModel, worldCreateScene, worldStep, unloadModel } from "@qvac/sdk";

async function main() {
  // 1: load the ABot-World model with mode: "world"

  // 2: build the scene from the first frame

  // 3: walk the tape, writing each block's frames to disk

  await unloadModel({ modelId });
}

main().catch(console.error);
