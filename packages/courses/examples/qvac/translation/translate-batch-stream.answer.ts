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

  const result = translate({
    modelId,
    text: texts,
    modelType: "nmtcpp-translation",
    stream: true,
  });

  let index = 0;
  for await (const translation of result.tokenStream) {
    console.log(`${index + 1}. ${texts[index]} -> "${translation}"`);
    index++;
  }

  console.log(`Translated ${index} texts`);

  await unloadModel({ modelId });
}

main().catch(console.error);
