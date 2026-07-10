import { loadModel, GTE_LARGE_FP16, embed } from "@qvac/sdk";

async function main() {
  const modelId = await loadModel({ modelSrc: GTE_LARGE_FP16 });

  const corpus = [
    "Take two slices of bread, spread peanut butter on one, jelly on the other, then press them together.",
    "Heat water to 205°F, pour 30g of water for the bloom, wait 30s, then pour in slow circles.",
    "Generics let you write a function once and let callers pick the type at the call site.",
  ];
  const titles = [
    "How to assemble a peanut butter and jelly sandwich",
    "Brewing the perfect pour-over coffee",
    "Introduction to TypeScript generics",
  ];
  const query = "How do I make a peanut butter sandwich?";

  // 1: embed the corpus as a single batch call

  // 2: embed the query as a separate call

  // 3: score each corpus vector against the query and track the highest

  // 4: print the best match's title and score
}

main().catch(console.error);