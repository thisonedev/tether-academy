import { loadModel, ocr, unloadModel, OCR_LATIN } from "@qvac/sdk";

async function main() {
  const modelId = await loadModel({
    modelSrc: OCR_LATIN,
    modelConfig: { langList: ["en"] },
  });

  // 1: call ocr() and await the blocks

  // 2: loop through the blocks and log text, bbox, and confidence

  await unloadModel({ modelId });
}

main().catch(console.error);