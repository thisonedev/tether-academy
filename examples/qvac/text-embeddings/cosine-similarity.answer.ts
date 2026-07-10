import { loadModel, GTE_LARGE_FP16, embed } from "@qvac/sdk";

function cosineSimilarity(vecA: number[], vecB: number[]) {
  let dotProduct = 0;
  for (let i = 0; i < vecA.length; i++) {
    dotProduct += (vecA[i] ?? 0) * (vecB[i] ?? 0);
  }
  return dotProduct;
}

async function main() {
  const modelId = await loadModel({ modelSrc: GTE_LARGE_FP16 });

  const texts = [
    "The quick brown fox jumps over the lazy dog",
    "A fast auburn fox leaps over a sleepy canine",
    "Python is a programming language",
  ];

  const { embedding: batchEmbeddings } = await embed({ modelId, text: texts });

  const [emb1, emb2, emb3] = batchEmbeddings;
  if (!emb1 || !emb2 || !emb3) throw new Error("Expected 3 embeddings");

  const similarity1 = cosineSimilarity(emb1, emb2);
  const similarity2 = cosineSimilarity(emb1, emb3);

  console.log(
    "Similarity between texts 1 and 2 (similar meaning):",
    similarity1.toFixed(4),
  );
  console.log(
    "Similarity between texts 1 and 3 (different topics):",
    similarity2.toFixed(4),
  );
}

main().catch(console.error);
