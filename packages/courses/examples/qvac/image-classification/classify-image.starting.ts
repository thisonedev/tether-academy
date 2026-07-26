import {
  startQVACProvider,
  stopQVACProvider,
  loadModel,
  classify,
  unloadModel,
} from "@qvac/sdk";
import fs from "node:fs";

async function main() {
  // 1: start the provider and load the classification model

  // 2: read the image, call classify, log each label

  // 3: unload the model and stop the provider

  await unloadModel({ modelId: "" });
  await stopQVACProvider();
}

main().catch(console.error);