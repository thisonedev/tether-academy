import { loadModel, GTE_LARGE_FP16, embed } from "@qvac/sdk";

async function main() {
  const modelId = await loadModel({ modelSrc: GTE_LARGE_FP16 });

  const { embedding } = await embed({
    modelId,
    text: "Hello, world!",
  });

  console.log("Input: 'Hello, world!'");
  console.log("Embedding dimensions:", embedding.length);
  console.log("First 10 values:", embedding.slice(0, 10));
}

main().catch(console.error);
