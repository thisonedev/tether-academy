import { loadModel, GTE_LARGE_FP16, embed } from "@qvac/sdk";

async function main() {
  const modelId = await loadModel({ modelSrc: GTE_LARGE_FP16 });

  const texts = [
    "The quick brown fox jumps over the lazy dog",
    "A fast auburn fox leaps over a sleepy canine",
    "Python is a programming language",
  ];

  // 1: embed the three texts and destructure as emb1, emb2, emb3

  // 2: define the cosineSimilarity helper

  // 3: compute similarity for the similar pair (emb1, emb2) and the unrelated pair (emb1, emb3)
  // and log both with .toFixed(4)
}

main().catch(console.error);