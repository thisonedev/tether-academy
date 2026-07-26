import { loadModel, GTE_LARGE_FP16, embed } from "@qvac/sdk";

async function main() {
  const modelId = await loadModel({ modelSrc: GTE_LARGE_FP16 });

  const texts = [
    "The quick brown fox jumps over the lazy dog",
    "A fast auburn fox leaps over a sleepy canine",
    "Python is a programming language",
  ];

  // 1: call embed() with text: texts and destructure batchEmbeddings

  // 2: log the input, output, and dimension counts
}

main().catch(console.error);