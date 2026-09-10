import { loadModel, translate, unloadModel, BERGAMOT_EN_FR } from "@qvac/sdk";

async function main() {
  const modelId = await loadModel({
    modelSrc: BERGAMOT_EN_FR,
    modelConfig: { engine: "Bergamot", from: "en", to: "fr" },
  });

  const texts = [
    "Hello world",
    "How are you today?",
    "This is a test of batch translation",
  ];

  // 1: start the batch with streaming turned on

  // 2: iterate the stream, logging each translation with its source

  await unloadModel({ modelId });
}

main().catch(console.error);
