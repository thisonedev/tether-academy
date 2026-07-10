import { loadModel, ocr, unloadModel, OCR_LATIN } from "@qvac/sdk";

async function main() {
  const modelId = await loadModel({
    modelSrc: OCR_LATIN,
    modelConfig: { langList: ["en"], magRatio: 1.5 },
  });

  const { blocks } = ocr({
    modelId,
    image: "./examples/image/basic_test.bmp",
    options: { paragraph: false },
  });

  const result = await blocks;

  for (const block of result) {
    console.log(block.text);
    if (block.bbox) console.log(`BBox: [${block.bbox.join(", ")}]`);
    if (block.confidence !== undefined) {
      console.log(`Confidence: ${block.confidence.toFixed(4)}`);
    }
  }

  await unloadModel({ modelId });
}

main().catch(console.error);