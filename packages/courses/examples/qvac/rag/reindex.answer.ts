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

  const result = await ragReindex({ workspace });

  console.log("Reindexed:", result.reindexed);
  if (!result.reindexed) {
    console.log("Reason:", result.details?.reason ?? "unknown");
  }

  await ragCloseWorkspace({ workspace });
}

main().catch(console.error);
