import fs from "node:fs";
import {
  startQVACProvider,
  stopQVACProvider,
  loadModel,
  classify,
  unloadModel,
} from "@qvac/sdk";

async function main() {
  await startQVACProvider({});

  const modelId = await loadModel({
    modelType: "ggml-classification",
  });

  const image = fs.readFileSync("./examples/image/basic_test.jpg");
  const results = await classify({ modelId, image });

  console.log("Classification results:");
  for (const { label, confidence } of results) {
    console.log(`  ${label}: ${(confidence * 100).toFixed(1)}%`);
  }

  await unloadModel({ modelId });
  await stopQVACProvider();
}

main().catch(console.error);
