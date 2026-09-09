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

  const result = translate({
    modelId,
    text: texts,
    modelType: "nmtcpp-translation",
    stream: false,
  });

  const translations = await result.translations;
  translations.forEach((translation, i) => {
    console.log(`${i + 1}. ${texts[i]} -> "${translation}"`);
  });

  await unloadModel({ modelId });
}

main().catch(console.error);
