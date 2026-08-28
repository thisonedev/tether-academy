import fs from "node:fs";
import { loadModel, classify, unloadModel } from "@qvac/sdk";

async function main() {
  const modelId = await loadModel({
    modelType: "ggml-classification",
  });

  const image = fs.readFileSync("./examples/qvac/image-classification/input/basic_test.jpg");
  const results = await classify({ modelId, image });

  console.log("Classification results:");
  for (const { label, confidence } of results) {
    console.log(`  ${label}: ${(confidence * 100).toFixed(1)}%`);
  }

  await unloadModel({ modelId });
}

main().catch(console.error);
