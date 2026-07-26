import { loadModel, translate, unloadModel, BERGAMOT_EN_FR } from "@qvac/sdk";

async function main() {
  const modelId = await loadModel({
    modelSrc: BERGAMOT_EN_FR,
    modelConfig: { engine: "Bergamot", from: "en", to: "fr", beamsize: 1 },
  });

  const text = "This is a test of the Bergamot translation model.";
  const result = translate({
    modelId,
    text,
    modelType: "nmtcpp-translation",
    stream: false,
  });

  const translatedText = await result.text;
  console.log(`Translated text EN -> FR: ${text} -> "${translatedText}"`);

  await unloadModel({ modelId });
}

main().catch(console.error);