import { loadModel, GTE_LARGE_FP16, ragIngest } from "@qvac/sdk";

async function main() {
  const modelId = await loadModel({ modelSrc: GTE_LARGE_FP16 });

  const samples = [
    "Machine learning is a subset of artificial intelligence that focuses on algorithms that can learn from data.",
    "Deep learning uses neural networks with multiple layers to process complex data patterns.",
    "Natural language processing combines computational linguistics with machine learning.",
  ];

  const workspace = "recipes";

  // 1: call ragIngest() with the workspace and chunk: false

  // 2: log the processed length and inspect the first entry
}

main().catch(console.error);