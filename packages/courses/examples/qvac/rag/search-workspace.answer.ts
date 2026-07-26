import { loadModel, GTE_LARGE_FP16, ragIngest, ragSearch } from "@qvac/sdk";

async function main() {
  const modelId = await loadModel({ modelSrc: GTE_LARGE_FP16 });

  const workspace = "recipes";

  await ragIngest({
    modelId,
    workspace,
    documents: [
      "Take two slices of bread, spread peanut butter on one, jelly on the other, then press them together.",
      "Heat water to 205°F, pour 30g of water for the bloom, wait 30s, then pour in slow circles.",
      "Generics let you write a function once and let callers pick the type at the call site.",
    ],
    chunk: false,
  });

  const results = await ragSearch({
    modelId,
    workspace,
    query: "How do I make a peanut butter sandwich?",
    topK: 3,
  });

  results.forEach((result, index) => {
    console.log(`${index + 1}. (Score: ${result.score.toFixed(4)})`);
    console.log(`   ${result.content}`);
  });
}

main().catch(console.error);
