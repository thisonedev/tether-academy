import { loadModel, translate, unloadModel, BERGAMOT_EN_FR } from "@qvac/sdk";

async function main() {
  const modelId = await loadModel({
    modelSrc: BERGAMOT_EN_FR,
    modelConfig: { engine: "Bergamot", from: "en", to: "fr", beamsize: 1 },
  });

  const texts = [
    "Hello world",
    "How are you today?",
    "This is a test of batch translation",
  ];

  // 1: translate the whole array in one call

  // 2: await the translations and log each with its source

  await unloadModel({ modelId });
}

main().catch(console.error);
