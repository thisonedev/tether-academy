import { loadModel, GTE_LARGE_FP16, embed } from "@qvac/sdk";

function cosineSimilarity(a: number[], b: number[]) {
  let dot = 0;
  for (let i = 0; i < a.length; i++) dot += (a[i] ?? 0) * (b[i] ?? 0);
  return dot;
}

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

  const { embedding: corpusVectors } = await embed({ modelId, text: corpus });

  const { embedding: [queryEmbedding] } = await embed({ modelId, text: query });

  let bestIdx = 0;
  let bestScore = -Infinity;
  for (let i = 0; i < corpusVectors.length; i++) {
    const score = cosineSimilarity(queryEmbedding, corpusVectors[i]!);
    if (score > bestScore) {
      bestScore = score;
      bestIdx = i;
    }
  }

  console.log(`Query: ${query}`);
  console.log(`Best match: ${titles[bestIdx]} (score ${bestScore.toFixed(4)})`);
}

main().catch(console.error);
