import { loadModel, GTE_LARGE_FP16, ragIngest, ragReindex, ragCloseWorkspace } from "@qvac/sdk";

async function main() {
  const modelId = await loadModel({ modelSrc: GTE_LARGE_FP16 });
  const workspace = "tiny";

  const recipes = [
    "classic peanut butter and jelly sandwich on white bread",
    "fluffy scrambled eggs with butter and chives",
    "miso soup with tofu and wakame seaweed",
    "chicken tikka masala with basmati rice",
  ];

  await ragIngest({
    modelId,
    workspace,
    documents: recipes,
    chunk: false,
  });

  // 1: call ragReindex() and log the result (with reason when reindexed is false)

  await ragCloseWorkspace({ workspace });
}

main().catch(console.error);