import { loadModel, GTE_LARGE_FP16, ragIngest } from "@qvac/sdk";

async function main() {
  const modelId = await loadModel({ modelSrc: GTE_LARGE_FP16 });

  const samples = [
    "Take two slices of bread, spread peanut butter on one, jelly on the other, then press them together.",
    "Heat water to 205°F, pour 30g of water for the bloom, wait 30s, then pour in slow circles.",
    "Generics let you write a function once and let callers pick the type at the call site.",
  ];

  const workspace = "recipes";

  const result = await ragIngest({
    modelId,
    workspace,
    documents: samples,
    chunk: false,
  });

  console.log(`Ingested ${result.processed.length} documents`);
}

main().catch(console.error);
