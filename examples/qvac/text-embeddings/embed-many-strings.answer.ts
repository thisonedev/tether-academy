import { loadModel, GTE_LARGE_FP16, embed } from "@qvac/sdk";

async function main() {
  const modelId = await loadModel({ modelSrc: GTE_LARGE_FP16 });

  const texts = [
    "The quick brown fox jumps over the lazy dog",
    "A fast auburn fox leaps over a sleepy canine",
    "Python is a programming language",
  ];

  const { embedding: batchEmbeddings } = await embed({
    modelId,
    text: texts,
  });

  console.log("Input:", texts.length, "texts");
  console.log("Output:", batchEmbeddings.length, "embeddings");
  console.log("Each embedding dimensions:", batchEmbeddings[0]?.length ?? 0);
}

main().catch(console.error);
