import { loadModel, classify, unloadModel } from "@qvac/sdk";
import fs from "node:fs";

async function main() {
  const modelId = await loadModel({
    modelType: "ggml-classification",
  });

  // 1: read the image with fs.readFileSync

  // 2: call classify({ modelId, image }) and log each label and confidence

  await unloadModel({ modelId });
}

main().catch(console.error);